import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../store/memory";
import { Repo, seedRepo } from "../../server/repo";
import { emailRuntime, gmailThreadToDocs, importThreads, ingestEmail, listThreads, makeEmailDoc, parseRawEmail, type GmailThread } from ".";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function repo() {
  const r = new Repo({ store: new MemoryStore() });
  await seedRepo(r);
  return r;
}

describe("parseRawEmail", () => {
  it("parses headers, folded lines and body", () => {
    const p = parseRawEmail(
      "From: Priya Sharma <priya@acmerobotics.com>\nTo: joel@gitcrm.dev, Dana <dana@x.com>\nSubject: Seats for the\n rollout\nDate: Thu, 29 Oct 2026 10:00:00 -0700\n\nHi Joel,\n\nWe'd like 60 seats, total $60,000.\n\nPriya",
    );
    expect(p.from).toBe("Priya Sharma <priya@acmerobotics.com>");
    expect(p.to).toEqual(["joel@gitcrm.dev", "Dana <dana@x.com>"]);
    expect(p.subject).toBe("Seats for the rollout");
    expect(p.ts).toBe(Date.parse("2026-10-29T17:00:00Z"));
    expect(p.body.startsWith("Hi Joel,")).toBe(true);
  });
  it("treats header-less text as body", () => {
    const p = parseRawEmail("just a note about Acme", 123);
    expect(p).toMatchObject({ from: "", body: "just a note about Acme", ts: 123 });
  });
});

describe("entity inference + ingest", () => {
  it("matches sender to contact/company/deal", async () => {
    const r = await repo();
    const doc = makeEmailDoc(await r.state(), parseRawEmail("From: priya@acmerobotics.com\nSubject: hi\n\nhello"), "email_user_1");
    expect(doc.kind).toBe("email");
    expect(doc.entities).toContain("company:acme");
    expect(doc.entities).toContain("contact:priya-acme");
  });
  it("pasted email opens a PR via the inbox agent", async () => {
    const r = await repo();
    const { doc, prs } = await ingestEmail(r, {
      raw: "From: Priya Sharma <priya@acmerobotics.com>\nSubject: Seats\n\nHi Joel,\n\nWe'd like 60 seats, total $60,000.\n\nPriya",
    });
    expect(doc.id).toMatch(/^email_user_/);
    expect(prs.length).toBeGreaterThanOrEqual(1);
    expect((await r.deps.store.listDocs()).some((d) => d.id === doc.id)).toBe(true);
  });
});

const THREAD: GmailThread = {
  id: "t1",
  messages: [
    {
      id: "m1", internalDate: "1793300000000", snippet: "we'd like 60 seats",
      payload: {
        mimeType: "multipart/alternative",
        headers: [{ name: "From", value: "Priya <priya@acmerobotics.com>" }, { name: "To", value: "joel@gitcrm.dev" }, { name: "Subject", value: "Seats" }],
        parts: [
          { mimeType: "text/plain", body: { data: b64("Hi Joel,\n\nWe'd like 60 seats, total $60,000.\n\nPriya") } },
          { mimeType: "text/html", body: { data: b64("<p>ignored</p>") } },
        ],
      },
    },
    {
      id: "m2", internalDate: "1793300100000",
      payload: { mimeType: "text/html", headers: [{ name: "From", value: "joel@gitcrm.dev" }, { name: "Subject", value: "Re: Seats" }], body: { data: b64("<div>Great&nbsp;news<br>Joel</div>") } },
    },
  ],
};

describe("Gmail", () => {
  it("converts a thread to EvidenceDocs (plain parts, HTML fallback)", async () => {
    const r = await repo();
    const docs = gmailThreadToDocs(await r.state(), THREAD);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ id: "email_gmail_m1", kind: "email", title: "Seats", ts: 1793300000000, to: ["joel@gitcrm.dev"] });
    expect(docs[0]!.body).toContain("60 seats");
    expect(docs[0]!.entities).toContain("company:acme");
    expect(docs[1]!.body).toBe("Great news\nJoel");
  });

  it("lists + imports threads with a fake fetch", async () => {
    const r = await repo();
    emailRuntime().gmail = { tokens: { access_token: "tok", expires_at: Date.now() + 60_000 }, account: "me@x.com", connectedAt: 0 };
    const calls: string[] = [];
    const fake = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
      if (u.includes("/threads?")) return new Response(JSON.stringify({ threads: [{ id: "t1" }] }));
      if (u.includes("/threads/t1")) return new Response(JSON.stringify(THREAD));
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const list = await listThreads(r, undefined, fake);
    expect(calls[0]).toContain("q=newer_than%3A30d");
    expect(list[0]).toMatchObject({ id: "t1", subject: "Seats", messages: 2 });
    expect(list[0]!.match?.entity).toMatch(/acme/);
    const res = await importThreads(r, ["t1"], fake);
    expect(res.imported).toBe(2);
    expect(res.prs.length).toBeGreaterThanOrEqual(1);
    emailRuntime().gmail = undefined;
  });
});

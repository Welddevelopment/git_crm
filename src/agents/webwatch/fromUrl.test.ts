import { afterEach, describe, expect, it, vi } from "vitest";
import type { CRMState, EntityRecord, EvidenceDoc, FieldValue, Op } from "../../core/types";
import { cleanCompanyName, guessIndustry, proposeFromUrl, slugFromHost } from "./fromUrl";
import { crawlCompany, scrapeUrl, type ScrapedPage } from "./firecrawl";

const TS = Date.parse("2026-10-30T17:00:00-07:00");

function makeState(recs: EntityRecord[]): CRMState {
  return { schema: {}, entities: Object.fromEntries(recs.map((r) => [r.id, r])), aliases: {}, evidence: {}, provenance: {}, versions: { "company:acme::signals": 7 }, headSeq: 10 };
}
const company = (slug: string, attrs: Record<string, FieldValue>): EntityRecord => ({ id: `company:${slug}`, type: "company", attrs });

const page = (path: string, title: string, body: string, extra: Partial<ScrapedPage> = {}): ScrapedPage => ({
  id: `web_live_ferrolabs.io${path === "/" ? "" : `_${path.slice(1)}`}_${TS}`,
  kind: "web",
  ts: TS,
  title,
  url: `https://ferrolabs.io${path}`,
  body,
  ...extra,
});

const HOME = page("/", "Ferro Labs | Payments infrastructure for platforms", "# Ferro Labs\nPayments infrastructure for vertical SaaS platforms. Card issuing, payouts and treasury in one API.\nTrusted by 300 platforms. SOC 2 Type II certified.", {
  siteName: "Ferro Labs",
  description: "Payments infrastructure for vertical SaaS platforms.",
});
const CAREERS = page("/careers", "Careers — Ferro Labs", "# Join us\n## Open roles\n- Account Executive, Mid-Market\n- Sales Development Representative\n- Senior Data Engineer\n");
const ABOUT = page("/about", "About — Ferro Labs", "# About\nFounded in 2019. Today our team of 85 employees works from Lisbon and New York.");
const DOCS = [HOME, CAREERS, ABOUT];
const URL0 = "https://ferrolabs.io/";

type Create = Extract<Op, { type: "entity.create" }>;
type FieldSet = Extract<Op, { type: "field.set" }>;
const words = (s: string) => s.trim().split(/\s+/).length;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("proposeFromUrl — new account", () => {
  it("one entity.create with name/domain/stage/watchUrl/signals/employees + evidence.attach per page", async () => {
    const p = await proposeFromUrl(makeState([]), DOCS, URL0);
    expect(p.title).toBe("New account from web: Ferro Labs (+2 signals)");
    const attaches = p.events.filter((e) => e.op.type === "evidence.attach");
    expect(attaches).toHaveLength(3);
    for (const a of attaches) {
      const doc = (a.op as Extract<Op, { type: "evidence.attach" }>).doc;
      expect(doc.entities).toEqual(["company:ferrolabs"]);
      expect("siteName" in doc).toBe(false); // stored in contract shape
    }
    const creates = p.events.filter((e) => e.op.type === "entity.create");
    expect(creates).toHaveLength(1);
    const c = creates[0]!.op as Create;
    expect(c.entity).toBe("company:ferrolabs");
    expect(c.entityType).toBe("company");
    expect(c.attrs).toEqual({
      name: "Ferro Labs",
      domain: "ferrolabs.io",
      stage: "lead",
      watchUrl: URL0,
      industry: "Fintech",
      employees: 85,
      signals: ["hiring:sales", "security:soc2"],
    });
    // evidence refs: verbatim quotes from the pages they cite
    const bodies = new Map(DOCS.map((d) => [d.id, d.body]));
    const refs = creates[0]!.evidence!;
    expect(refs.length).toBeGreaterThanOrEqual(4);
    for (const r of refs) {
      expect(bodies.has(r.docId)).toBe(true);
      if (r.quote) {
        expect(bodies.get(r.docId)).toContain(r.quote);
        expect(words(r.quote)).toBeLessThan(25);
      }
    }
    expect(p.events.every((e) => e.actor?.kind === "agent" && e.actor.id === "webwatch")).toBe(true);
    expect(p.description).toMatch(/Payments infrastructure/);
  });

  it("works with a single bare homepage (no signals)", async () => {
    const bare = page("/", "ferrolabs.io", "Hello world.");
    const p = await proposeFromUrl(makeState([]), [bare], URL0);
    expect(p.title).toBe("New account from web: Ferrolabs (+0 signals)");
    const c = p.events.find((e) => e.op.type === "entity.create")!.op as Create;
    expect(c.attrs.signals).toEqual([]);
    expect(c.attrs.employees).toBeUndefined();
  });

  it("avoids id collisions with an unrelated company of the same slug", async () => {
    const state = makeState([company("ferrolabs", { name: "Ferro Labs GmbH", domain: "ferrolabs.de" })]);
    const p = await proposeFromUrl(state, DOCS, URL0);
    const c = p.events.find((e) => e.op.type === "entity.create")!.op as Create;
    expect(c.entity).toBe("company:ferrolabs-io");
  });
});

describe("proposeFromUrl — existing account (matched by domain)", () => {
  it("emits field.set for new signals / employees / watchUrl instead of create", async () => {
    const state = makeState([company("ferro", { name: "Ferro", domain: "www.ferrolabs.io", employees: 60, signals: ["security:soc2"], stage: "customer" })]);
    const p = await proposeFromUrl(state, DOCS, URL0);
    expect(p.events.some((e) => e.op.type === "entity.create")).toBe(false);
    expect(p.title).toBe("Web update: Ferro (+1 signal)");
    const sets = p.events.map((e) => e.op).filter((o): o is FieldSet => o.type === "field.set");
    expect(sets.find((s) => s.field === "signals")).toMatchObject({ entity: "company:ferro", value: ["hiring:sales", "security:soc2"], prev: ["security:soc2"] });
    expect(sets.find((s) => s.field === "employees")).toMatchObject({ value: 85, prev: 60 });
    expect(sets.find((s) => s.field === "watchUrl")).toMatchObject({ value: URL0 });
    expect(p.readSet).toEqual({ "company:ferro::signals": 0, "company:ferro::employees": 0 });
  });

  it("no field changes when nothing is new (still attaches evidence)", async () => {
    const state = makeState([company("ferro", { name: "Ferro", domain: "ferrolabs.io", employees: 85, signals: ["hiring:sales", "security:soc2"], watchUrl: URL0 })]);
    const p = await proposeFromUrl(state, DOCS, URL0);
    expect(p.events.every((e) => e.op.type === "evidence.attach")).toBe(true);
  });
});

describe("proposeFromUrl — LLM enrichment", () => {
  it("uses description + industry and keeps only signals whose quotes are verbatim", async () => {
    const llm = vi.fn(async () =>
      "```json\n" +
      JSON.stringify({
        description: "Embedded payments API for vertical SaaS.",
        industry: "Payments",
        signals: [
          { signal: "product:card-issuing", quote: "Card issuing, payouts and treasury in one API.", docId: HOME.id, claim: "Sells card issuing" },
          { signal: "expansion:us", quote: "works from Lisbon and New York", docId: "wrong-id", claim: "US presence" },
          { signal: "funding:series-b", quote: "Raised a $40M Series B", claim: "Hallucinated" },
          { signal: "hiring:sales", quote: "Account Executive, Mid-Market", claim: "dup of detector" },
          { signal: "Not A Slug", quote: "Founded in 2019.", claim: "bad slug" },
        ],
      }) +
      "\n```",
    );
    const p = await proposeFromUrl(makeState([]), DOCS, URL0, llm);
    expect(llm).toHaveBeenCalledOnce();
    const c = p.events.find((e) => e.op.type === "entity.create")!;
    const attrs = (c.op as Create).attrs;
    expect(attrs.industry).toBe("Payments");
    expect(attrs.signals).toEqual(["expansion:us", "hiring:sales", "product:card-issuing", "security:soc2"]);
    expect(p.title).toBe("New account from web: Ferro Labs (+4 signals)");
    expect(p.description.startsWith("Embedded payments API for vertical SaaS.")).toBe(true);
    // the misattributed quote is re-pointed at the page that actually contains it
    const us = c.evidence!.find((r) => r.claim === "US presence")!;
    expect(us.docId).toBe(ABOUT.id);
    expect(c.evidence!.some((r) => r.claim === "Hallucinated")).toBe(false);
  });

  it("LLM garbage / throw → deterministic result", async () => {
    const a = await proposeFromUrl(makeState([]), DOCS, URL0, async () => "sorry, I can't");
    const b = await proposeFromUrl(makeState([]), DOCS, URL0, async () => { throw new Error("boom"); });
    const base = await proposeFromUrl(makeState([]), DOCS, URL0);
    expect(a.events).toEqual(base.events);
    expect(b.events).toEqual(base.events);
  });
});

describe("naming helpers", () => {
  it("slugFromHost", () => {
    expect(slugFromHost("www.acmerobotics.com")).toBe("acmerobotics");
    expect(slugFromHost("foo.co.uk")).toBe("foo");
    expect(slugFromHost("app.linear.app")).toBe("linear");
  });
  it("cleanCompanyName prefers og:site_name, then the brand segment of the title", () => {
    expect(cleanCompanyName({ siteName: "Linear", title: "x", host: "linear.app" })).toBe("Linear");
    expect(cleanCompanyName({ title: "Plan and build products – Linear", host: "linear.app" })).toBe("Linear");
    expect(cleanCompanyName({ title: "Home | Acme Robotics", host: "acmerobotics.com" })).toBe("Acme Robotics");
    expect(cleanCompanyName({ title: "stripe.com", host: "stripe.com" })).toBe("Stripe");
  });
  it("guessIndustry needs ≥2 hits", () => {
    expect(guessIndustry("Freight and logistics for the midwest")).toBe("Logistics");
    expect(guessIndustry("We make things")).toBeUndefined();
  });
});

describe("firecrawl client", () => {
  const ok = (url: string, markdown: string, metadata: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ success: true, data: { markdown, metadata: { sourceURL: url, ...metadata } } }));

  it("returns null without a key and makes no request", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "");
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await scrapeUrl("https://x.io")).toBeNull();
    expect(await crawlCompany("https://x.io")).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("scrapeUrl posts the v1 body and maps the response (truncates at 20k)", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    const f = vi.fn(async (_u: string, _init?: RequestInit) => ok("https://x.io", "a".repeat(25_000), { title: "X — home", ogSiteName: "X Inc", description: "We do X" }));
    vi.stubGlobal("fetch", f);
    const d = await scrapeUrl("https://www.x.io/", { now: TS });
    expect(f.mock.calls[0]![0]).toBe("https://api.firecrawl.dev/v1/scrape");
    const init = f.mock.calls[0]![1]!;
    expect(JSON.parse(String(init.body))).toEqual({ url: "https://www.x.io/", formats: ["markdown"], onlyMainContent: true });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer fc-test");
    expect(d).toMatchObject({ id: `web_live_x.io_${TS}`, kind: "web", ts: TS, title: "X — home", url: "https://www.x.io/", siteName: "X Inc", description: "We do X" });
    expect(d!.body).toHaveLength(20_000);
  });

  it("scrapeUrl → null on HTTP error, success:false, empty markdown, throw", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    for (const r of [
      async () => new Response("no", { status: 402 }),
      async () => new Response(JSON.stringify({ success: false, error: "blocked" })),
      async () => ok("https://x.io", "   "),
      async () => { throw new Error("ECONNRESET"); },
    ]) {
      vi.stubGlobal("fetch", vi.fn(r));
      expect(await scrapeUrl("https://x.io")).toBeNull();
    }
  });

  it("crawlCompany scrapes home + /careers /pricing /about in parallel, drops failures and duplicate bodies", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    const f = vi.fn(async (_u: string, init?: RequestInit) => {
      const { url } = JSON.parse(String(init!.body)) as { url: string };
      if (url.endsWith("/careers")) return ok(url, "- Data Engineer\n- Data Engineer");
      if (url.endsWith("/pricing")) return new Response("x", { status: 500 });
      if (url.endsWith("/about")) return ok(url, "# Home"); // redirected to homepage
      return ok(url, "# Home", { title: "Home" });
    });
    vi.stubGlobal("fetch", f);
    const docs = await crawlCompany("https://x.io", { now: TS });
    expect(f).toHaveBeenCalledTimes(4);
    expect(docs.map((d) => d.id)).toEqual([`web_live_x.io_${TS}`, `web_live_x.io_careers_${TS}`]);
  });
});

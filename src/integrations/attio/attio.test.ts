import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../store/memory";
import { Repo } from "../../server/repo";
import { seedMainEvents } from "../../seed";
import { createAttioAdapter } from "../../adapters/attio";
import { AttioClient } from "./client";
import { fakeAttio } from "./fake";
import { fromAttioStage, mapAttioRecord, toAttioStage, toAttioValues, type AttioRecord } from "./map";
import { handleAttioProxy } from "./proxy";
import { seedAttio, seedWorldState } from "./seed";
import { importFromAttio, markEcho, resetAttioRuntime, resolveAttioRecord } from "./index";

async function makeRepo() {
  const repo = new Repo({ store: new MemoryStore() });
  await repo.commitToMain(seedMainEvents());
  return repo;
}
const old = { active_from: "2025-01-01T00:00:00Z", active_until: "2026-01-01T00:00:00Z" };
const live = { active_from: "2026-01-01T00:00:00Z", active_until: null };
const proxy = (repo: Repo, method: string, object: string, rest: string[], body?: unknown, agent?: string) =>
  handleAttioProxy(repo, { method, object, rest, body, agent: agent ?? "enrich-bot", reason: "test", origin: "https://mainline.test" });

beforeEach(() => resetAttioRuntime());

describe("mapAttioRecord", () => {
  it("reads the active entry of each value array and ignores history", () => {
    const rec: AttioRecord = {
      id: { record_id: "r1" },
      values: {
        name: [{ ...old, full_name: "Priya S.", first_name: "Priya", last_name: "S." }, { ...live, full_name: "Priya Sharma", first_name: "Priya", last_name: "Sharma" }],
        email_addresses: [{ ...live, email_address: "priya@acmerobotics.com" }],
        job_title: [{ ...old, value: "Engineer" }, { ...live, value: "Engineering Manager" }],
        company: [{ ...live, target_object: "companies", target_record_id: "co_1" }],
      },
    };
    const m = mapAttioRecord("people", rec, { resolveRef: (_o, id) => (id === "co_1" ? "company:acme" : null) });
    expect(m.attrs).toEqual({ name: "Priya Sharma", email: "priya@acmerobotics.com", title: "Engineering Manager", company: "company:acme" });
  });

  it("maps companies (domains, employee_range, categories) and deals (currency, status, ref)", () => {
    const co = mapAttioRecord("companies", {
      id: { record_id: "c" },
      values: {
        name: [{ ...live, value: "Acme Robotics" }], domains: [{ ...live, domain: "acmerobotics.com" }],
        employee_range: [{ ...live, option: { title: "51-250" } }], categories: [{ ...live, option: { title: "Robotics" } }],
      },
    });
    expect(co.attrs).toEqual({ name: "Acme Robotics", domain: "acmerobotics.com", employees: 51, industry: "Robotics" });
    const deal = mapAttioRecord("deals", {
      id: { record_id: "d" },
      values: {
        name: [{ ...live, value: "Acme — Platform rollout" }],
        value: [{ ...old, currency_value: 10000 }, { ...live, currency_value: 45000, currency_code: "USD" }],
        stage: [{ ...old, status: { title: "Lead" } }, { ...live, status: { title: "Won 🎉" } }],
        associated_company: [{ ...live, target_record_id: "c" }],
      },
    }, { resolveRef: () => "company:acme" });
    expect(deal.attrs).toEqual({ name: "Acme — Platform rollout", amount: 45000, stage: "closed_won", company: "company:acme" });
  });

  it("maps deal stages both ways; unknown titles pass through", () => {
    expect(fromAttioStage("Lead")).toBe("discovery");
    expect(fromAttioStage("In Progress")).toBe("demo");
    expect(fromAttioStage("Won 🎉")).toBe("closed_won");
    expect(fromAttioStage("Won")).toBe("closed_won");
    expect(fromAttioStage("Lost")).toBe("closed_lost");
    expect(fromAttioStage("Negotiation")).toBe("negotiation");
    expect(fromAttioStage("Security Review")).toBe("Security Review");
    expect(toAttioStage("closed_won")).toBe("Won 🎉");
    expect(toAttioValues("deal", { amount: 30000, stage: "discovery" })).toEqual({ value: 30000, stage: "Lead" });
  });
});

describe("Attio proxy", () => {
  it("PATCH with a Mainline slug opens a PR held for review and answers 202 in Attio shape", async () => {
    const repo = await makeRepo();
    const r = await proxy(repo, "PATCH", "deals", ["acme-platform"], { data: { values: { value: 45000 } } });
    expect(r.status).toBe(202);
    const body = r.body as { data: AttioRecord; mainline: { status: string; pr: string; prUrl: string; tier: string; reasons: string[] } };
    expect(body.mainline.status).toBe("pending_review");
    expect(body.mainline.tier).toBe("review");
    expect(body.mainline.prUrl).toBe(`https://mainline.test/prs/${body.mainline.pr}`);
    expect(body.data.values.value).toEqual([expect.objectContaining({ currency_value: 45000, active_until: null })]);
    const pr = (await repo.listPRs("open")).find((p) => p.id === body.mainline.pr)!;
    expect(pr.author).toEqual({ kind: "agent", id: "enrich-bot" });
    expect(pr.changes).toContainEqual(expect.objectContaining({ kind: "field.changed", entity: "deal:acme-platform", field: "amount", after: 45000 }));
    expect((await repo.state()).entities["deal:acme-platform"]!.attrs.amount).toBe(20000); // main untouched
  });

  it("PATCH by Attio record id resolves via attrs.attioId; low-risk change auto-merges", async () => {
    const repo = await makeRepo();
    await repo.commitToMain([{ actor: { kind: "system", id: "attio" }, op: { type: "field.set", entity: "contact:tom-becker", field: "attioId", value: "rec_tom" } }]);
    const r = await proxy(repo, "PATCH", "people", ["rec_tom"], { data: { values: { job_title: "VP of IT" } } }, "");
    expect(r.status).toBe(202);
    const meta = (r.body as { mainline: { status: string; tier: string } }).mainline;
    expect(meta).toMatchObject({ status: "auto_merged", tier: "auto" });
    expect((await repo.state()).entities["contact:tom-becker"]!.attrs.title).toBe("VP of IT");
    expect((await repo.listPRs("merged"))[0]!.author.id).toBe("external-agent");
  });

  it("POST create maps values, resolves the company ref and opens a create PR", async () => {
    const repo = await makeRepo();
    const r = await proxy(repo, "POST", "people", [], {
      data: { values: { name: [{ first_name: "Jo", last_name: "Lee", full_name: "Jo Lee" }], email_addresses: ["jo@acmerobotics.com"], company: [{ target_object: "companies", target_record_id: "acme" }] } },
    });
    expect(r.status).toBe(202);
    const meta = (r.body as { mainline: { entity: string } }).mainline;
    expect(meta.entity).toBe("contact:jo-lee");
    const pr = (await repo.listPRs())[0]!;
    expect(pr.changes).toContainEqual(expect.objectContaining({ kind: "entity.added", entity: "contact:jo-lee", attrs: { name: "Jo Lee", email: "jo@acmerobotics.com", company: "company:acme" } }));
  });

  it("404s unknown records, 400s bad bodies, and no-ops identical values", async () => {
    const repo = await makeRepo();
    expect((await proxy(repo, "PATCH", "deals", ["nope"], { data: { values: { value: 1 } } })).status).toBe(404);
    expect((await proxy(repo, "PATCH", "deals", ["acme-platform"], { foo: 1 })).status).toBe(400);
    expect((await proxy(repo, "PATCH", "widgets", ["x"], {})).status).toBe(404);
    const same = await proxy(repo, "PATCH", "deals", ["acme-platform"], { data: { values: { value: 20000 } } });
    expect(same.status).toBe(200);
    expect(await repo.listPRs()).toHaveLength(0);
  });
});

describe("importFromAttio", () => {
  it("creates new records, links existing ones by natural key, then imports only Attio-side changes", async () => {
    const repo = await makeRepo();
    const fake = fakeAttio();
    const client = new AttioClient({ token: "t", fetchImpl: fake.fetch });
    const acme = await client.create("companies", { name: "Acme Robotics", domains: ["acmerobotics.com"] });
    const zen = await client.create("companies", { name: "Zenith Labs", domains: ["zenith.dev"] });
    await client.create("people", { name: [{ first_name: "Zara", last_name: "Q", full_name: "Zara Q" }], email_addresses: ["zara@zenith.dev"], company: [{ target_record_id: zen.id.record_id }] });
    await client.create("deals", { name: "Acme — Platform rollout", value: 20000, stage: "Lead", associated_company: [{ target_record_id: acme.id.record_id }] });

    const r1 = await importFromAttio(repo, { client, mode: "full" });
    expect(r1.ok).toBe(true);
    const s1 = await repo.state();
    const zenId = `company:at-${zen.id.record_id}`;
    expect(s1.entities[zenId]!.attrs).toMatchObject({ name: "Zenith Labs", domain: "zenith.dev", attioId: zen.id.record_id });
    expect(r1.created).toHaveLength(2);
    expect(r1.created.some((id) => s1.entities[id]?.attrs.company === zenId)).toBe(true);
    expect(s1.entities["company:acme"]!.attrs.attioId).toBe(acme.id.record_id);
    expect(r1.linked).toEqual(expect.arrayContaining(["company:acme", "deal:acme-platform"]));
    expect(r1.updated).toEqual([]); // Lead ≈ discovery, same amount
    expect(resolveAttioRecord(s1, "companies", acme.id.record_id)).toBe("company:acme");
    expect(resolveAttioRecord(s1, "company", "acme")).toBe("company:acme");
    expect(resolveAttioRecord(s1, "deals", "acme-platform")).toBe("deal:acme-platform");
    expect(resolveAttioRecord(s1, "people", "nope")).toBeNull();

    // A human edits headcount in Attio -> field.set on main by "Attio"
    fake.edit("companies", acme.id.record_id, "name", { value: "Acme Robotics Inc" });
    const r2 = await importFromAttio(repo, { client, mode: "changes" });
    expect(r2.updated).toEqual([{ entity: "company:acme", fields: ["name"] }]);
    const blame = await repo.blame("company:acme", "name");
    expect(blame.at(-1)!.actor).toEqual({ kind: "human", id: "attio", name: "Attio" });

    // An echo of our own write is skipped
    markEcho(acme.id.record_id, ["name"]);
    fake.edit("companies", acme.id.record_id, "name", { value: "Acme (echo)" });
    const r3 = await importFromAttio(repo, { client, mode: "changes" });
    expect(r3.events).toBe(0);
  });

  it("handles a workspace without a deals object", async () => {
    const repo = await makeRepo();
    const fake = fakeAttio({ deals: false });
    const r = await importFromAttio(repo, { client: new AttioClient({ token: "t", fetchImpl: fake.fetch }) });
    expect(r.ok).toBe(true);
    expect(r.objects.deals).toBe("missing");
  });
});

describe("Attio adapter + seed", () => {
  it("pushes merged field.set as a coalesced PATCH and creates new records, recording attioId", async () => {
    const repo = await makeRepo();
    const fake = fakeAttio();
    const client = new AttioClient({ token: "t", fetchImpl: fake.fetch });
    const acme = await client.create("companies", { name: "Acme Robotics", domains: ["acmerobotics.com"] });
    await repo.commitToMain([{ actor: { kind: "system", id: "attio" }, op: { type: "field.set", entity: "company:acme", field: "attioId", value: acme.id.record_id } }]);
    const merged = await repo.commitToMain([
      { actor: { kind: "system", id: "merge" }, op: { type: "field.set", entity: "company:acme", field: "industry", value: "Robotics" } },
      { actor: { kind: "system", id: "merge" }, op: { type: "field.set", entity: "company:acme", field: "name", value: "Acme" } },
      { actor: { kind: "system", id: "merge" }, op: { type: "entity.create", entity: "contact:jo-lee", entityType: "contact", attrs: { name: "Jo Lee", email: "jo@acmerobotics.com", company: "company:acme" } } },
    ]);
    const adapter = createAttioAdapter({ token: "t", fetchImpl: fake.fetch, commit: (evs) => repo.commitToMain(evs) });
    const r = await adapter.push(merged, await repo.state());
    expect(r).toEqual({ ok: true, pushed: 2 });
    const patches = fake.calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ data: { values: { categories: ["Robotics"], name: "Acme" } } });
    const person = fake.records.people[0]!;
    expect(person.values.company).toEqual([expect.objectContaining({ target_record_id: acme.id.record_id })]);
    expect((await repo.state()).entities["contact:jo-lee"]!.attrs.attioId).toBe(person.id.record_id);
  });

  it("is a no-op without a token", async () => {
    const r = await createAttioAdapter({ fetchImpl: (() => { throw new Error("no"); }) as typeof fetch, token: "" }).push([], seedWorldState());
    expect(r.pushed).toBe(0);
  });

  it("seedAttio is idempotent", async () => {
    const fake = fakeAttio();
    const client = new AttioClient({ token: "t", fetchImpl: fake.fetch });
    const r1 = await seedAttio({ client });
    expect(r1.ok).toBe(true);
    expect(r1.created).toHaveLength(10 + 25 + 10);
    expect(fake.records.deals[0]!.values.owner).toEqual([expect.objectContaining({ referenced_actor_id: "wm_1" })]);
    const r2 = await seedAttio({ client });
    expect(r2.created).toHaveLength(0);
    expect(r2.updated).toEqual([]);
    expect(r2.unchanged).toBe(45);
    expect(r2.ids).toEqual(r1.ids);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../store/memory";
import { Repo } from "../../server/repo";
import { seedMainEvents } from "../../seed";
import type { Actor, Event, NewEvent } from "../../core/types";
import { handleHubSpotProxy } from "./proxy";
import { lookupRecord } from "./lookup";
import {
  attrsToProperties, dateFromHubSpot, normalizeObject, propertiesToAttrs, resolveHubSpotRecord, stageFromHubSpot, stageToHubSpot,
} from "./map";
import { HubSpotClient } from "./client";
import { importFromHubSpot } from "./index";
import { markEcho, resetHubSpotRuntime } from "./runtime";
import { createHubSpotAdapter } from "../../adapters/hubspot";
import { seedHubSpot } from "./seed";

const SYS: Actor = { kind: "system", id: "hubspot" };
const ORIGIN = "https://mainline.test";

async function makeRepo() {
  const repo = new Repo({ store: new MemoryStore() });
  await repo.commitToMain(seedMainEvents());
  await repo.commitToMain([
    { actor: SYS, op: { type: "field.set", entity: "deal:acme-platform", field: "hubspotId", value: "9001" } },
    { actor: SYS, op: { type: "field.set", entity: "company:acme", field: "hubspotId", value: "5001" } },
    { actor: SYS, op: { type: "field.set", entity: "contact:priya-acme", field: "hubspotId", value: "7001" } },
  ]);
  return repo;
}

const proxy = (repo: Repo, method: string, objectType: string, rest: string[], body?: unknown, agent?: string, reason?: string) =>
  handleHubSpotProxy(repo, { method, objectType, rest, body, agent: agent ?? null, reason: reason ?? null, origin: ORIGIN });

type Body = { id: string; properties: Record<string, string>; mainline: { status: string; pr: string; prUrl: string; tier: string; reasons: string[]; fields: string[] } };

beforeEach(() => resetHubSpotRuntime());

describe("mapping", () => {
  it("normalizes object types", () => {
    expect(normalizeObject("0-3")).toBe("deals");
    expect(normalizeObject("deal")).toBe("deals");
    expect(normalizeObject("0-1")).toBe("contacts");
    expect(normalizeObject("companies")).toBe("companies");
    expect(normalizeObject("tickets")).toBeNull();
  });

  it("maps HubSpot default pipeline stages and back", () => {
    expect(stageFromHubSpot("appointmentscheduled")).toBe("demo");
    expect(stageFromHubSpot("qualifiedtobuy")).toBe("discovery");
    expect(stageFromHubSpot("presentationscheduled")).toBe("demo");
    expect(stageFromHubSpot("decisionmakerboughtin")).toBe("proposal");
    expect(stageFromHubSpot("contractsent")).toBe("negotiation");
    expect(stageFromHubSpot("closedwon")).toBe("closed_won");
    expect(stageFromHubSpot("closedlost")).toBe("closed_lost");
    expect(stageFromHubSpot("Contract Sent")).toBe("negotiation");
    expect(stageFromHubSpot("negotiation")).toBe("negotiation");
    expect(stageFromHubSpot("bogus")).toBeNull();
    for (const s of ["discovery", "demo", "proposal", "negotiation", "closed_won", "closed_lost"]) {
      expect(stageFromHubSpot(stageToHubSpot(s))).toBe(s);
    }
  });

  it("round-trips deal / contact / company attrs through HubSpot properties", () => {
    const deal = { name: "Acme — Platform rollout", amount: 45000, stage: "negotiation", closeDate: "2026-12-15", nextStep: "Send MSA" };
    const props = attrsToProperties("deal", deal);
    expect(props).toEqual({ dealname: "Acme — Platform rollout", amount: "45000", dealstage: "contractsent", closedate: "2026-12-15T12:00:00.000Z", hs_next_step: "Send MSA" });
    expect(propertiesToAttrs("deal", props).attrs).toEqual(deal);

    const contact = { name: "Priya Sharma", email: "priya@acmerobotics.com", title: "VP Engineering", phone: "+1 415" };
    const cp = attrsToProperties("contact", contact);
    expect(cp).toMatchObject({ firstname: "Priya", lastname: "Sharma", jobtitle: "VP Engineering" });
    expect(propertiesToAttrs("contact", cp).attrs).toEqual(contact);

    const company = { name: "Northwind Freight", domain: "northwindfreight.com", employees: 250 };
    expect(propertiesToAttrs("company", attrsToProperties("company", company)).attrs).toEqual(company);
  });

  it("parses HubSpot dates (date-only, ISO, epoch ms, local-midnight)", () => {
    expect(dateFromHubSpot("2026-12-15")).toBe("2026-12-15");
    expect(dateFromHubSpot("2026-12-15T12:00:00Z")).toBe("2026-12-15");
    expect(dateFromHubSpot(String(Date.UTC(2026, 11, 15)))).toBe("2026-12-15");
    expect(dateFromHubSpot("2026-12-15T08:00:00.000Z")).toBe("2026-12-15"); // PST midnight
    expect(dateFromHubSpot("nope")).toBeNull();
  });

  it("flags invalid values instead of guessing", () => {
    const m = propertiesToAttrs("deal", { amount: "lots", dealstage: "whatever", foo: "x" });
    expect(m.attrs).toEqual({});
    expect(m.invalid.map((i) => i.property).sort()).toEqual(["amount", "dealstage"]);
    expect(m.ignored).toEqual(["foo"]);
  });
});

describe("HubSpot-compatible proxy", () => {
  it("PATCH deals/{hubspotId} -> PR with mapped fields, 202 HubSpot-like body", async () => {
    const repo = await makeRepo();
    const r = await proxy(repo, "PATCH", "deals", ["9001"], {
      properties: { amount: "45000", dealstage: "contractsent", closedate: "2026-12-01" },
      mainline: { reason: "Priya asked for the MSA", evidence: [{ docId: "email_7", quote: "please send over the MSA", claim: "Acme → Negotiation" }] },
    }, "sdr-bot");
    expect(r.status).toBe(202);
    const body = r.body as Body;
    expect(body.id).toBe("9001");
    expect(body.properties).toMatchObject({ amount: "45000", dealstage: "contractsent", dealname: "Acme — Platform rollout" });
    expect(body.mainline).toMatchObject({ status: "pending_review", tier: "review", prUrl: `${ORIGIN}/prs/${body.mainline.pr}` });
    expect(body.mainline.fields.sort()).toEqual(["amount", "closeDate", "stage"]);
    expect(body.mainline.reasons.length).toBeGreaterThan(0);

    const detail = await repo.prDetail(body.mainline.pr);
    expect(detail.pr.title).toBe("Sdr Bot via HubSpot API: Acme — Platform rollout amount, stage, closeDate");
    expect(detail.pr.author).toEqual({ kind: "agent", id: "sdr-bot" });
    const sets = detail.events.map((e) => e.op).filter((o) => o.type === "field.set");
    expect(sets).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: "deal:acme-platform", field: "amount", value: 45000, prev: 20000 }),
      expect.objectContaining({ entity: "deal:acme-platform", field: "stage", value: "negotiation", prev: "discovery" }),
      expect.objectContaining({ entity: "deal:acme-platform", field: "closeDate", value: "2026-12-01" }),
    ]));
    expect(detail.events[0]!.reason).toBe("Priya asked for the MSA");
    expect(detail.events[0]!.evidence?.[0]).toMatchObject({ docId: "email_7", claim: "Acme → Negotiation" });
    expect(detail.branch.readSet?.["deal:acme-platform::amount"]).toBeGreaterThan(0);
    // main is untouched
    expect((await repo.state()).entities["deal:acme-platform"]!.attrs.amount).toBe(20000);
  });

  it("accepts a Mainline slug as the id and defaults the agent", async () => {
    const repo = await makeRepo();
    const r = await proxy(repo, "PATCH", "0-3", ["northwind-fleet"], { properties: { amount: "65000" } }, undefined, "Dana confirmed 12 more trucks");
    expect(r.status).toBe(202);
    const pr = await repo.prDetail((r.body as Body).mainline.pr);
    expect(pr.pr.author.id).toBe("external-agent");
    expect(pr.events[0]!.op).toMatchObject({ entity: "deal:northwind-fleet", field: "amount", value: 65000 });
    expect(pr.events[0]!.reason).toBe("Dana confirmed 12 more trucks");
  });

  it("auto-merges low-risk enrichment (contact title)", async () => {
    const repo = await makeRepo();
    const r = await proxy(repo, "PATCH", "contacts", ["7001"], { properties: { jobtitle: "VP Engineering" } }, "enricher");
    expect(r.status).toBe(202);
    expect((r.body as Body).mainline.status).toBe("auto_merged");
    expect((await repo.state()).entities["contact:priya-acme"]!.attrs.title).toBe("VP Engineering");
  });

  it("no-op PATCH returns 200 no_change; unknown record -> HubSpot-style 404; bad stage -> 400", async () => {
    const repo = await makeRepo();
    const same = await proxy(repo, "PATCH", "deals", ["9001"], { properties: { amount: "20000" } });
    expect(same.status).toBe(200);
    expect((same.body as Body).mainline.status).toBe("no_change");
    const missing = await proxy(repo, "PATCH", "deals", ["424242"], { properties: { amount: "1" } });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ status: "error", category: "OBJECT_NOT_FOUND" });
    const bad = await proxy(repo, "PATCH", "deals", ["9001"], { properties: { dealstage: "wat" } });
    expect(bad.status).toBe(400);
    expect((await repo.listPRs("open")).length).toBe(0);
  });

  it("POST create -> entity.create PR with company association", async () => {
    const repo = await makeRepo();
    const r = await proxy(repo, "POST", "deals", [], {
      properties: { dealname: "Acme — Data platform", amount: "30000", dealstage: "qualifiedtobuy" },
      associations: [{ to: { id: "5001" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 5 }] }],
    }, "sdr-bot");
    expect(r.status).toBe(202);
    const body = r.body as Body;
    expect(body.mainline.tier).toBe("review"); // new deals need a human
    const d = await repo.prDetail(body.mainline.pr);
    expect(d.events[0]!.op).toMatchObject({
      type: "entity.create", entity: "deal:acme-data-platform", entityType: "deal",
      attrs: { name: "Acme — Data platform", amount: 30000, stage: "discovery", company: "company:acme" },
    });
  });

  it("POST batch/update -> one PR across records", async () => {
    const repo = await makeRepo();
    const r = await proxy(repo, "POST", "deals", ["batch", "update"], {
      inputs: [{ id: "9001", properties: { amount: "45000" } }, { id: "kestrel-security", properties: { closedate: "2027-01-15" } }],
    }, "forecast-bot");
    expect(r.status).toBe(202);
    const body = r.body as { status: string; results: { id: string }[]; mainline: Body["mainline"] };
    expect(body.results.map((x) => x.id)).toEqual(["9001", "deal:kestrel-security"]);
    const d = await repo.prDetail(body.mainline.pr);
    expect(d.events).toHaveLength(2);
    expect(d.pr.title).toBe("Forecast Bot via HubSpot API: 2 deals (amount, closeDate)");
  });

  it("GET reads from main", async () => {
    const repo = await makeRepo();
    const r = await proxy(repo, "GET", "deals", ["9001"]);
    expect(r.status).toBe(200);
    expect((r.body as Body).properties).toMatchObject({ amount: "20000", dealstage: "qualifiedtobuy" });
  });
});

describe("record lookup", () => {
  it("by HubSpot id (0-3) and by Mainline id, with pending PRs and history", async () => {
    const repo = await makeRepo();
    const pr = (await proxy(repo, "PATCH", "deals", ["9001"], { properties: { amount: "45000" } }, "sdr-bot")).body as Body;

    const byHs = await lookupRecord(repo, { crm: "hubspot", objectType: "0-3", id: "9001", origin: ORIGIN });
    expect(byHs.entityId).toBe("deal:acme-platform");
    expect(byHs.displayName).toBe("Acme — Platform rollout");
    expect(byHs.pendingPRs.map((p) => p.id)).toEqual([pr.mainline.pr]);
    expect(byHs.mainlineUrl).toBe(`${ORIGIN}/crm?entity=deal%3Aacme-platform`);
    expect(byHs.history.nextStep!.length).toBeGreaterThanOrEqual(2);
    expect(byHs.history.nextStep![0]!.actor).toMatchObject({ kind: "human", name: "Joel" }); // newest first
    expect(byHs.history.nextStep!.length).toBeLessThanOrEqual(5);

    const byMl = await lookupRecord(repo, { crm: "mainline", objectType: null, id: "deal:acme-platform", origin: ORIGIN });
    expect(byMl.entityId).toBe("deal:acme-platform");
    expect(byMl.pendingPRs).toHaveLength(1);

    const other = await lookupRecord(repo, { crm: "hubspot", objectType: "deals", id: "nope", origin: ORIGIN });
    expect(other).toMatchObject({ entityId: null, entity: null, pendingPRs: [], mainlineUrl: `${ORIGIN}/crm` });
  });

  it("includes PRs that touch a duplicate merged into the record", async () => {
    const repo = await makeRepo();
    const ev: NewEvent = { actor: { kind: "agent", id: "inbox" }, op: { type: "field.set", entity: "contact:priya-sharma", field: "title", value: "VP Engineering" } };
    const pr = await repo.propose("inbox", { title: "title", description: "", events: [ev] });
    await repo.commitToMain([{ actor: { kind: "human", id: "joel" }, op: { type: "entity.merge", from: "contact:priya-sharma", into: "contact:priya-acme" } }]);
    const lk = await lookupRecord(repo, { crm: "hubspot", objectType: "0-1", id: "7001", origin: ORIGIN });
    expect(lk.entityId).toBe("contact:priya-acme");
    expect(lk.pendingPRs.map((p) => p.id)).toContain(pr.id);
    // the merged-away id resolves to the survivor
    expect(resolveHubSpotRecord(await repo.state(), "contacts", "priya-sharma")).toBe("contact:priya-acme");
  });
});

// ---------- fake HubSpot ----------
type Rec = { id: string; properties: Record<string, string>; associations?: Record<string, { results: { id: string; type: string }[] }> };
function fakeHubSpot(data: Record<string, Rec[]>) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let nextId = 100;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });
    const u = new URL(url);
    const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/account-info/v3/details") return ok({ portalId: 4242 });
    let m = u.pathname.match(/^\/crm\/v3\/objects\/(\w+)$/);
    if (m && method === "GET") return ok({ results: data[m[1]!] ?? [] });
    if (m && method === "POST") {
      const rec = { id: String(nextId++), properties: body.properties };
      (data[m[1]!] ??= []).push(rec);
      return new Response(JSON.stringify(rec), { status: 201 });
    }
    m = u.pathname.match(/^\/crm\/v3\/objects\/(\w+)\/search$/);
    if (m) {
      const f = body.filterGroups?.[0]?.filters?.[0];
      const all = data[m[1]!] ?? [];
      return ok({ results: f?.operator === "EQ" ? all.filter((r) => String(r.properties[f.propertyName] ?? "").toLowerCase() === String(f.value).toLowerCase()) : all });
    }
    m = u.pathname.match(/^\/crm\/v3\/objects\/(\w+)\/(\w+)$/);
    if (m && method === "PATCH") return ok({ id: m[2], properties: body.properties });
    if (u.pathname.startsWith("/crm/v4/associations/")) return ok({ results: [] });
    if (u.pathname.startsWith("/crm/v4/objects/")) return ok({});
    return new Response("{}", { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, client: new HubSpotClient({ token: "t", fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} }) };
}

describe("importFromHubSpot", () => {
  afterEach(() => resetHubSpotRuntime());

  it("updates linked records, links by natural key, creates unknown ones (full), then imports only HubSpot-side changes", async () => {
    const repo = await makeRepo();
    const data: Record<string, Rec[]> = {
      companies: [
        { id: "5001", properties: { name: "Acme Robotics", domain: "acmerobotics.com", numberofemployees: "155" } },
        { id: "5002", properties: { name: "Northwind Freight", domain: "northwindfreight.com", numberofemployees: "999" } },
        { id: "5099", properties: { name: "Zephyr Air", domain: "zephyr.aero", numberofemployees: "40" } },
      ],
      contacts: [
        { id: "7050", properties: { firstname: "Zoe", lastname: "Park", email: "zoe@zephyr.aero", jobtitle: "COO" }, associations: { companies: { results: [{ id: "5099", type: "contact_to_company" }] } } },
      ],
      deals: [
        { id: "9001", properties: { dealname: "Acme — Platform rollout", amount: "20000", dealstage: "decisionmakerboughtin", closedate: "2026-12-15T12:00:00Z" } },
      ],
    };
    const hs = fakeHubSpot(data);
    const r = await importFromHubSpot(repo, { client: hs.client, mode: "full" });
    expect(r.ok).toBe(true);
    const s = await repo.state();
    // known hubspotId: diffs applied as HubSpot human edits
    expect(s.entities["company:acme"]!.attrs.employees).toBe(155);
    expect(s.entities["deal:acme-platform"]!.attrs.stage).toBe("proposal");
    expect(s.provenance["deal:acme-platform"]!.stage!.actor).toEqual({ kind: "human", id: "hubspot", name: "HubSpot" });
    // natural key: linked (hubspotId recorded), values left alone
    expect(s.entities["company:northwind"]!.attrs.hubspotId).toBe("5002");
    expect(s.entities["company:northwind"]!.attrs.employees).toBe(180);
    // unknown: created with hs- ids and company association resolved
    expect(s.entities["company:hs-5099"]!.attrs).toMatchObject({ name: "Zephyr Air", hubspotId: "5099" });
    expect(s.entities["contact:hs-7050"]!.attrs).toMatchObject({ name: "Zoe Park", company: "company:hs-5099", hubspotId: "7050" });
    expect(r.created.sort()).toEqual(["company:hs-5099", "contact:hs-7050"]);

    // changes mode: a human edits Northwind in HubSpot; Acme's amount comes back as an echo of our own push
    data.companies![1]!.properties.numberofemployees = "260";
    data.deals![0]!.properties.amount = "45000";
    markEcho("deals", "9001", { amount: 45000 });
    const r2 = await importFromHubSpot(repo, { client: hs.client, mode: "changes" });
    const s2 = await repo.state();
    expect(s2.entities["company:northwind"]!.attrs.employees).toBe(260);
    expect(s2.entities["deal:acme-platform"]!.attrs.amount).toBe(20000);
    expect(r2.skippedEchoes).toBe(1);
    expect(hs.calls.some((c) => c.url.includes("/crm/v3/objects/companies/search") && JSON.stringify(c.body).includes("hs_lastmodifieddate"))).toBe(true);
    // unchanged records produce no events
    const r3 = await importFromHubSpot(repo, { client: hs.client, mode: "changes" });
    expect(r3.events).toBe(0);
  });
});

describe("HubSpot adapter write-back", () => {
  it("PATCHes with HubSpot stage ids and creates new entities, recording their hubspotId", async () => {
    const repo = await makeRepo();
    const hs = fakeHubSpot({});
    const committed: NewEvent[] = [];
    const adapter = createHubSpotAdapter({ token: "t", fetchImpl: hs.fetchImpl, commit: async (evs) => { committed.push(...evs); } });
    await repo.commitToMain([
      { actor: SYS, op: { type: "entity.create", entity: "contact:new-person", entityType: "contact", attrs: { name: "New Person", email: "new@acmerobotics.com", company: "company:acme" } } },
    ]);
    const state = await repo.state();
    const mk = (op: Event["op"], seq: number): Event => ({ id: `e${seq}`, branch: "main", seq, ts: seq, actor: SYS, op });
    const r = await adapter.push([
      mk({ type: "field.set", entity: "deal:acme-platform", field: "stage", value: "negotiation" }, 1),
      mk({ type: "field.set", entity: "deal:acme-platform", field: "amount", value: 45000 }, 2),
      mk({ type: "entity.create", entity: "contact:new-person", entityType: "contact", attrs: {} }, 3),
    ], state);
    expect(r.ok).toBe(true);
    const patch = hs.calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe("https://api.hubapi.com/crm/v3/objects/deals/9001");
    expect(patch.body).toEqual({ properties: { dealstage: "contractsent", amount: "45000" } });
    const create = hs.calls.find((c) => c.method === "POST" && c.url.endsWith("/crm/v3/objects/contacts"))!;
    expect(create.body).toMatchObject({
      properties: { firstname: "New", lastname: "Person", email: "new@acmerobotics.com" },
      associations: [{ to: { id: "5001" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 1 }] }],
    });
    expect(committed[0]!.op).toMatchObject({ type: "field.set", entity: "contact:new-person", field: "hubspotId", value: "100" });
  });
});

describe("seedHubSpot", () => {
  it("creates the seed world with associations, and is idempotent", async () => {
    const data: Record<string, Rec[]> = {};
    const hs = fakeHubSpot(data);
    const r = await seedHubSpot({ client: hs.client, delayMs: 0 });
    expect(r.ok).toBe(true);
    expect(r.portalId).toBe(4242);
    expect(r.created.length).toBe(45);
    expect(data.deals!.length).toBe(10);
    const acmeDeal = hs.calls.find((c) => c.method === "POST" && c.url.endsWith("/deals") && c.body && (c.body as { properties: { dealname: string } }).properties.dealname === "Acme — Platform rollout")!;
    expect(acmeDeal.body).toMatchObject({ properties: { dealstage: "qualifiedtobuy", amount: "20000", pipeline: "default" }, associations: [{ to: { id: r.ids["company:acme"] } }] });
    const again = await seedHubSpot({ client: hs.client, delayMs: 0 });
    expect(again.created).toHaveLength(0);
    expect(again.ids).toEqual(r.ids);
  });
});

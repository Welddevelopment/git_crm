import { describe, expect, it } from "vitest";
import type { AgentContext, CRMState, EntityRecord, EvidenceDoc, FieldDef, Op } from "../../core/types";
import { schemaAgent, validateLLMField } from "./index";

// ---------- fixtures (hand-built, no other worker's implementation) ----------
const NOW = Date.parse("2026-10-30T17:00:00-07:00");
const DAY = 86_400_000;

const BASE_SCHEMA: Record<string, FieldDef[]> = {
  company: ["name", "domain", "industry", "employees", "stage", "signals"].map((f) => ({ field: f, fieldType: "string" })),
  contact: ["name", "email", "title", "company", "phone"].map((f) => ({ field: f, fieldType: "string" })),
  deal: ["name", "company", "amount", "stage", "closeDate", "owner", "nextStep"].map((f) => ({ field: f, fieldType: "string" })),
};

function ent(id: string, attrs: EntityRecord["attrs"]): EntityRecord {
  return { id, type: id.split(":")[0], attrs };
}

function makeState(schema = BASE_SCHEMA): CRMState {
  const list: EntityRecord[] = [
    ent("company:acme", { name: "Acme Robotics", domain: "acmerobotics.com" }),
    ent("company:northwind", { name: "Northwind Freight", domain: "northwindfreight.com" }),
    ent("company:orbital", { name: "Orbital Foods", domain: "orbitalfoods.com" }),
    ent("company:harbor", { name: "Harbor Analytics", domain: "harboranalytics.com" }),
    ent("contact:priya-acme", { name: "Priya Sharma", email: "priya@acmerobotics.com", company: "company:acme" }),
    ent("contact:dana-northwind", { name: "Dana Ortiz", email: "dana@northwindfreight.com", company: "company:northwind" }),
    ent("contact:omar-orbital", { name: "Omar Haddad", email: "omar@orbitalfoods.com", company: "company:orbital" }),
    ent("deal:acme-platform", { name: "Acme — Platform rollout", company: "company:acme", amount: 20000 }),
    ent("deal:northwind-fleet", { name: "Northwind — Fleet", company: "company:northwind", amount: 60000 }),
    ent("deal:orbital-pilot", { name: "Orbital — Pilot", company: "company:orbital", amount: 15000 }),
    ent("deal:harbor-analytics", { name: "Harbor — Analytics", company: "company:harbor", amount: 30000 }),
  ];
  return {
    schema,
    entities: Object.fromEntries(list.map((e) => [e.id, e])),
    aliases: {},
    evidence: {},
    provenance: {},
    versions: {},
    headSeq: 40,
  };
}

function email(id: string, from: string, entities: string[], body: string, daysAgo = 3): EvidenceDoc {
  return { id, kind: "email", ts: NOW - daysAgo * DAY, title: `Re: ${id}`, from, to: ["joel@mainline.dev"], body, entities };
}

const ACME = email(
  "email_acme_proc",
  "priya@acmerobotics.com",
  ["company:acme", "contact:priya-acme", "deal:acme-platform"],
  "Hi Joel,\nThanks for the call. Please loop in our procurement contact, Sam Lee (sam@acmerobotics.com) for the paperwork.\nPriya Sharma — Engineering Manager\nAcme Robotics",
  4,
);
const NORTHWIND = email(
  "email_nw_proc",
  "dana@northwindfreight.com",
  ["company:northwind", "contact:dana-northwind", "deal:northwind-fleet"],
  "Joel — happy with the proposal. Our procurement contact, Maria Gomez (maria.gomez@northwindfreight.com) will reach out about terms.\nDana Ortiz — Head of Logistics\nNorthwind Freight",
  3,
);
// Two deals in doc.entities: sender domain (orbitalfoods.com) must pick the Orbital deal.
const ORBITAL = email(
  "email_orbital_proc",
  "omar@orbitalfoods.com",
  ["company:orbital", "contact:omar-orbital", "deal:acme-platform", "deal:orbital-pilot"],
  "Hey Joel, we spoke to Acme about you. For the pilot, please cc our procurement contact, Lina Park (lina@orbitalfoods.com).\nOmar Haddad — COO\nOrbital Foods",
  2,
);
const NOISE = email(
  "email_noise",
  "priya@acmerobotics.com",
  ["company:acme", "deal:acme-platform"],
  "Can we book a demo next week? We're also evaluating Salesforce for this.",
  1,
);

function ctx(state: CRMState, docs: EvidenceDoc[], llmText: string | null = null): AgentContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    agent: "schema",
    state,
    docs,
    llm: async () => llmText,
    now: () => NOW,
    log: (m) => logs.push(m),
    logs,
  };
}

const procurementProposal = (ps: Awaited<ReturnType<typeof schemaAgent.run>>) =>
  ps.find((p) => p.events.some((e) => e.op.type === "schema.addField" && e.op.field === "procurementContact"));

// ---------- tests ----------
describe("schemaAgent", () => {
  it("has the contract id/name", () => {
    expect(schemaAgent.id).toBe("schema");
    expect(schemaAgent.name).toBe("Schema agent");
  });

  it("proposes deal.procurementContact: addField first, then 3 backfills with evidence", async () => {
    const out = await schemaAgent.run(ctx(makeState(), [ACME, NORTHWIND, ORBITAL, NOISE]));
    const p = procurementProposal(out)!;
    expect(p).toBeDefined();
    expect(p.title).toBe("Schema: add deal.procurementContact (+3 backfilled)");
    expect(p.description).toContain("Mentioned in 3 deals' emails, no field exists today.");

    const [first, ...rest] = p.events;
    expect(first.op).toMatchObject({ type: "schema.addField", entityType: "deal", field: "procurementContact", fieldType: "string" });
    expect(rest).toHaveLength(3);
    const sets = rest.map((e) => e.op as Extract<Op, { type: "field.set" }>);
    expect(sets.every((o) => o.type === "field.set" && o.field === "procurementContact")).toBe(true);
    const byEntity = Object.fromEntries(sets.map((o) => [o.entity, o.value]));
    expect(byEntity).toEqual({
      "deal:acme-platform": "Sam Lee <sam@acmerobotics.com>",
      "deal:northwind-fleet": "Maria Gomez <maria.gomez@northwindfreight.com>",
      "deal:orbital-pilot": "Lina Park <lina@orbitalfoods.com>", // sender-domain disambiguation
    });

    const docs = new Map([ACME, NORTHWIND, ORBITAL].map((d) => [d.id, d]));
    for (const e of rest) {
      expect(e.actor).toMatchObject({ kind: "agent", id: "schema" });
      expect(e.evidence?.length).toBeGreaterThan(0);
      const ev = e.evidence![0];
      expect(ev.claim).toMatch(/Procurement contact is/);
      expect(docs.get(ev.docId)!.body).toContain(ev.quote!);
      expect(ev.quote!.split(/\s+/).length).toBeLessThan(25);
    }
    expect(Object.keys(p.readSet ?? {})).toHaveLength(3);
  });

  it("does not propose when the field already exists in the schema", async () => {
    const schema = { ...BASE_SCHEMA, deal: [...BASE_SCHEMA.deal, { field: "procurementContact", fieldType: "string" as const }] };
    const out = await schemaAgent.run(ctx(makeState(schema), [ACME, NORTHWIND, ORBITAL]));
    expect(procurementProposal(out)).toBeUndefined();
  });

  it("does not propose with only 2 distinct deals mentioned", async () => {
    const dup = { ...ACME, id: "email_acme_proc_2", ts: ACME.ts + DAY }; // same deal twice = still 1 entity
    const c = ctx(makeState(), [ACME, dup, NORTHWIND]);
    const out = await schemaAgent.run(c);
    expect(procurementProposal(out)).toBeUndefined();
    expect(c.logs.some((l) => l.includes("procurementContact seen on 2"))).toBe(true);
  });

  it("detects competitors / security review / fiscal year when they recur on 3 entities", async () => {
    const docs = [
      email("c1", "priya@acmerobotics.com", ["deal:acme-platform"], "We're also evaluating Salesforce and HubSpot. Security review has started on our side. Our fiscal year starts in February."),
      email("c2", "dana@northwindfreight.com", ["deal:northwind-fleet"], "Heads up: we're also evaluating Attio. The security review passed last week. Fiscal year starts in February too."),
      email("c3", "omar@orbitalfoods.com", ["deal:orbital-pilot"], "We are also considering Pipedrive. A security review is required before signing. Our budget cycle starts in July."),
    ];
    const out = await schemaAgent.run(ctx(makeState(), docs));
    const titles = out.map((p) => p.title).sort();
    expect(titles).toEqual([
      "Schema: add company.fiscalYearStart (+3 backfilled)",
      "Schema: add deal.competitors (+3 backfilled)",
      "Schema: add deal.securityReview (+3 backfilled)",
    ]);
    const comp = out.find((p) => p.title.includes("competitors"))!;
    const acme = comp.events.find((e) => e.op.type === "field.set" && e.op.entity === "deal:acme-platform")!;
    expect((acme.op as Extract<Op, { type: "field.set" }>).value).toEqual(["Salesforce", "HubSpot"]);
    const sec = out.find((p) => p.title.includes("securityReview"))!;
    const vals = sec.events.slice(1).map((e) => (e.op as Extract<Op, { type: "field.set" }>).value).sort();
    expect(vals).toEqual(["in_progress", "passed", "required"]);
    const fy = out.find((p) => p.title.includes("fiscalYearStart"))!;
    expect(fy.events.slice(1).map((e) => (e.op as Extract<Op, { type: "field.set" }>).entity).sort()).toEqual([
      "company:acme",
      "company:northwind",
      "company:orbital",
    ]);
  });

  it("works deterministically with no LLM and returns [] with no docs", async () => {
    expect(await schemaAgent.run(ctx(makeState(), []))).toEqual([]);
  });

  it("LLM mode: proposes a validated field; rejects bad ids, non-verbatim quotes, <3 entities", async () => {
    const docs = [
      email("l1", "priya@acmerobotics.com", ["deal:acme-platform"], "We need SSO via Okta before rollout."),
      email("l2", "dana@northwindfreight.com", ["deal:northwind-fleet"], "Our IdP is Azure AD, so SSO there please."),
      email("l3", "omar@orbitalfoods.com", ["deal:orbital-pilot"], "We use Google Workspace for SSO."),
    ];
    const good = {
      entityType: "deal",
      field: "ssoProvider",
      fieldType: "string",
      description: "Identity provider the buyer needs SSO with",
      values: [
        { entity: "deal:acme-platform", value: "Okta", docId: "l1", quote: "SSO via Okta" },
        { entity: "deal:northwind-fleet", value: "Azure AD", docId: "l2", quote: "Our IdP is Azure AD" },
        { entity: "deal:orbital-pilot", value: "Google Workspace", docId: "l3", quote: "We use Google Workspace for SSO." },
      ],
    };
    const bad = {
      entityType: "deal",
      field: "renewalRisk",
      fieldType: "string",
      values: [
        { entity: "deal:acme-platform", value: "high", docId: "l1", quote: "they are unhappy" }, // not verbatim
        { entity: "deal:ghost", value: "low", docId: "l2", quote: "Our IdP is Azure AD" }, // unknown id
        { entity: "deal:orbital-pilot", value: "low", docId: "l3", quote: "We use Google Workspace" },
      ],
    };
    const out = await schemaAgent.run(ctx(makeState(), docs, "```json\n" + JSON.stringify([good, bad]) + "\n```"));
    expect(out.map((p) => p.title)).toEqual(["Schema: add deal.ssoProvider (+3 backfilled)"]);
    expect(out[0].events[0].op).toMatchObject({ type: "schema.addField", field: "ssoProvider" });

    // a field already in schema is rejected by validation
    const state = makeState({ ...BASE_SCHEMA, deal: [...BASE_SCHEMA.deal, { field: "ssoProvider", fieldType: "string" }] });
    expect(validateLLMField(state, docs, good, new Set())).toBeNull();
  });

  it("LLM garbage output is ignored", async () => {
    const out = await schemaAgent.run(ctx(makeState(), [ACME, NORTHWIND, ORBITAL], "sorry, I can't help"));
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Schema: add deal.procurementContact (+3 backfilled)");
  });
});

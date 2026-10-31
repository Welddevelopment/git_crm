import { describe, expect, it } from "vitest";
import type { AgentContext, AgentProposal, CRMState, EvidenceDoc, NewEvent } from "../../core/types";
import { inboxAgent } from "./index";
import { findAmount, findCloseDate, findEmployees, findSignature, findStage } from "./extract";
import { ALL_EMAILS, EMAIL_DANA_HEADCOUNT, EMAIL_PRIYA_MSA, EMAIL_PSHARMA_SIG, NOW, fixtureState } from "./fixtures";
import * as seed from "../../seed";

function ctx(state: CRMState, docs: EvidenceDoc[], llm: AgentContext["llm"] = async () => null): AgentContext {
  return { agent: "inbox", state, docs, llm, now: () => NOW, log: () => {} };
}
const events = (ps: AgentProposal[]) => ps.flatMap((p) => p.events);
function fieldSet(ps: AgentProposal[], entity: string, field: string): NewEvent | undefined {
  return events(ps).find((e) => e.op.type === "field.set" && e.op.entity === entity && e.op.field === field);
}
const valueOf = (e: NewEvent | undefined) => (e && e.op.type === "field.set" ? e.op.value : undefined);

describe("extractors", () => {
  it("parses STORY phrase conventions", () => {
    expect(findStage("please send over the MSA")?.value).toBe("negotiation");
    expect(findStage("can we book a demo next week")?.value).toBe("demo");
    expect(findStage("once it's signed we start")).toBeNull();
    expect(findStage("The contract is signed!")?.value).toBe("closed_won");
    expect(findAmount("45 seats, total $45,000")?.value).toBe(45000);
    expect(findAmount("about $45k")?.value).toBe(45000);
    expect(findAmount("$1,000 per seat, total $45,000")?.value).toBe(45000);
    expect(findAmount("we'd like 45 seats")).toBeNull();
    expect(findCloseDate("we want to close by November 15")?.value).toBe("2026-11-15");
    expect(findCloseDate("target 2026-11-15 for signature")?.value).toBe("2026-11-15");
    expect(findEmployees("we're now 250 people")?.value).toBe(250);
    expect(findEmployees("we have 250 employees")?.value).toBe(250);
    expect(findSignature("Thanks,\nPriya Sharma — VP Engineering\nAcme Robotics")?.title).toBe("VP Engineering");
  });
});

describe("inboxAgent (deterministic)", () => {
  it("has the contract metadata", () => {
    expect(inboxAgent.id).toBe("inbox");
    expect(inboxAgent.name).toBe("Inbox agent");
  });

  it("collision #1: Acme deal → negotiation, $45,000, with evidence", async () => {
    const ps = await inboxAgent.run(ctx(fixtureState(), ALL_EMAILS));
    const stage = fieldSet(ps, "deal:acme-platform", "stage");
    const amount = fieldSet(ps, "deal:acme-platform", "amount");
    expect(valueOf(stage)).toBe("negotiation");
    expect(valueOf(amount)).toBe(45000); // latest email wins over older $30k
    expect(stage!.op.type === "field.set" && stage!.op.prev).toBe("discovery");
    expect(stage!.evidence![0].docId).toBe(EMAIL_PRIYA_MSA.id);
    expect(stage!.evidence![0].claim).toContain("MSA");
    expect(stage!.evidence![0].claim).toContain("45 seats");
    expect(valueOf(fieldSet(ps, "deal:acme-platform", "closeDate"))).toBe("2026-11-15");
    expect(valueOf(fieldSet(ps, "deal:acme-platform", "nextStep"))).toMatch(/send MSA/);
    const acme = ps.find((p) => p.events.some((e) => e.op.type === "field.set" && e.op.entity === "deal:acme-platform"))!;
    expect(acme.title).toMatch(/^Acme — Platform rollout: Discovery → Negotiation, \$20k → \$45k/);
    expect(acme.description).toMatch(/Evidence: \d+ emails?/);
  });

  it("collision #2: title set on the exact sender entity contact:priya-sharma (not alias-resolved)", async () => {
    const s = fixtureState();
    // even if hygiene already merged the dup, the inbox agent targets the exact email match
    s.aliases["contact:priya-sharma"] = "contact:priya-acme";
    s.entities["contact:priya-sharma"].mergedInto = "contact:priya-acme";
    for (const state of [fixtureState(), s]) {
      const ps = await inboxAgent.run(ctx(state, [EMAIL_PSHARMA_SIG]));
      const e = fieldSet(ps, "contact:priya-sharma", "title");
      expect(valueOf(e)).toBe("VP Engineering");
      expect(fieldSet(ps, "contact:priya-acme", "title")).toBeUndefined();
    }
  });

  it("collision #3: company:northwind employees 180 → 250", async () => {
    const ps = await inboxAgent.run(ctx(fixtureState(), [EMAIL_DANA_HEADCOUNT]));
    const e = fieldSet(ps, "company:northwind", "employees");
    expect(valueOf(e)).toBe(250);
    expect(e!.evidence![0].quote).toContain("we're now 250 people");
  });

  it("creates a contact for an unknown sender at a known domain and ignores quoted replies", async () => {
    const ps = await inboxAgent.run(ctx(fixtureState(), ALL_EMAILS));
    const create = events(ps).find((e) => e.op.type === "entity.create");
    expect(create?.op).toMatchObject({
      type: "entity.create", entity: "contact:marco-northwind", entityType: "contact",
      attrs: { name: "Marco Bellini", email: "marco@northwindfreight.com", title: "IT Director", company: "company:northwind" },
    });
    expect(valueOf(fieldSet(ps, "company:northwind", "employees"))).toBe(250); // quoted "999" ignored
  });

  it("one proposal per entity cluster", async () => {
    const ps = await inboxAgent.run(ctx(fixtureState(), ALL_EMAILS));
    expect(ps).toHaveLength(2); // Acme (deal + priya-sharma title) and Northwind
    for (const p of ps) expect(p.events.length).toBeGreaterThan(0);
  });

  it("no-op when values already equal", async () => {
    const s = fixtureState();
    Object.assign(s.entities["deal:acme-platform"].attrs, {
      stage: "negotiation", amount: 45000, closeDate: "2026-11-15", nextStep: "Joel to send MSA and order form by Friday",
    });
    s.entities["contact:priya-sharma"].attrs.title = "VP Engineering";
    s.entities["contact:priya-acme"].attrs.title = "Engineering Manager";
    s.entities["company:northwind"].attrs.employees = 250;
    s.entities["contact:marco-northwind"] = {
      id: "contact:marco-northwind", type: "contact",
      attrs: { name: "Marco Bellini", email: "marco@northwindfreight.com", title: "IT Director", company: "company:northwind" },
    };
    expect(await inboxAgent.run(ctx(s, ALL_EMAILS))).toEqual([]);
  });

  it("every evidence quote is a verbatim substring of its doc and < 25 words", async () => {
    const byId = new Map(ALL_EMAILS.map((d) => [d.id, d]));
    const ps = await inboxAgent.run(ctx(fixtureState(), ALL_EMAILS));
    const all = events(ps);
    expect(all.length).toBeGreaterThan(0);
    for (const e of all) {
      expect(e.reason).toBeTruthy();
      expect(e.reason).not.toContain("\n");
      expect(e.evidence?.length).toBeGreaterThan(0);
      for (const ev of e.evidence!) {
        expect(byId.get(ev.docId)!.body).toContain(ev.quote!);
        expect(ev.quote!.split(/\s+/).length).toBeLessThan(25);
        expect(ev.claim).toBeTruthy();
      }
    }
  });

  it("ignores non-email docs", async () => {
    const web = { ...EMAIL_DANA_HEADCOUNT, id: "web_1", kind: "web" as const };
    expect(await inboxAgent.run(ctx(fixtureState(), [web]))).toEqual([]);
  });
});

describe("inboxAgent (LLM mode)", () => {
  it("merges LLM fields, prefers deterministic, rejects invented ids and non-verbatim quotes", async () => {
    const doc: EvidenceDoc = {
      id: "email_vague", kind: "email", ts: NOW - 86_400_000, title: "Update", from: "dana@northwindfreight.com",
      body: "Hi Joel, procurement approved the budget. We'd like to wrap things up before Thanksgiving.\n\nDana",
      entities: ["company:northwind", "deal:northwind-fleet"],
    };
    const llm: AgentContext["llm"] = async () =>
      "```json\n" + JSON.stringify({
        deal: {
          stage: { value: "negotiation", docId: "email_vague", quote: "procurement approved the budget" },
          closeDate: { value: "2026-11-25", docId: "email_vague", quote: "wrap things up before Thanksgiving" },
          amount: { value: 99000, docId: "email_vague", quote: "this text is not in the email" },
        },
        company: { employees: { value: 251, docId: "email_dana_headcount", quote: "we're now 250 people" } },
        contacts: [{ email: "ghost@northwindfreight.com", title: { value: "CEO", docId: "email_vague", quote: "Dana" } }],
      }) + "\n```";
    const ps = await inboxAgent.run(ctx(fixtureState(), [doc, EMAIL_DANA_HEADCOUNT], llm));
    expect(valueOf(fieldSet(ps, "deal:northwind-fleet", "stage"))).toBe("negotiation");
    expect(valueOf(fieldSet(ps, "deal:northwind-fleet", "closeDate"))).toBe("2026-11-25");
    expect(fieldSet(ps, "deal:northwind-fleet", "amount")).toBeUndefined(); // quote not verbatim
    expect(valueOf(fieldSet(ps, "company:northwind", "employees"))).toBe(250); // deterministic wins
    expect(events(ps).some((e) => JSON.stringify(e.op).includes("ghost"))).toBe(false);
  });

  it("falls back to rules when the LLM returns garbage", async () => {
    const ps = await inboxAgent.run(ctx(fixtureState(), [EMAIL_DANA_HEADCOUNT], async () => "sorry, no"));
    expect(valueOf(fieldSet(ps, "company:northwind", "employees"))).toBe(250);
  });
});

describe("against W8 seed (when available)", () => {
  it("produces STORY collisions #1–#3 from the seed inbox", async () => {
    const inbox = seed.seedInbox();
    const mainEvents = seed.seedMainEvents();
    if (!inbox.length || !mainEvents.length) return; // seed not written yet
    // Minimal local fold (no engine import): entity.create + field.set + merge aliases.
    const s: CRMState = { schema: {}, entities: {}, aliases: {}, evidence: {}, provenance: {}, versions: {}, headSeq: 0 };
    for (const e of mainEvents) {
      const op = e.op;
      if (op.type === "entity.create") s.entities[op.entity] = { id: op.entity, type: op.entityType, attrs: { ...op.attrs } };
      else if (op.type === "field.set" && s.entities[op.entity]) s.entities[op.entity].attrs[op.field] = op.value;
      else if (op.type === "entity.merge") { s.aliases[op.from] = op.into; if (s.entities[op.from]) s.entities[op.from].mergedInto = op.into; }
    }
    const ps = await inboxAgent.run(ctx(s, inbox));
    expect(valueOf(fieldSet(ps, "deal:acme-platform", "stage"))).toBe("negotiation");
    expect(valueOf(fieldSet(ps, "deal:acme-platform", "amount"))).toBe(45000);
    expect(valueOf(fieldSet(ps, "contact:priya-sharma", "title"))).toBe("VP Engineering");
    expect(valueOf(fieldSet(ps, "company:northwind", "employees"))).toBe(250);
    const byId = new Map(inbox.map((d) => [d.id, d]));
    for (const e of events(ps)) for (const ev of e.evidence ?? []) expect(byId.get(ev.docId)!.body).toContain(ev.quote!);
  });
});

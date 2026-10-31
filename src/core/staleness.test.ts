import { describe, expect, it, vi } from "vitest";
import type { Branch, CRMState, EntityRecord, Event, EvidenceDoc, PullRequest } from "./types";
import { checkStaleness, heuristicJudge, llmJudge, parseAmounts } from "./staleness";

// ---- hand-built fixtures (no dependency on W1's engine) ----
const NOW = Date.parse("2026-10-30T17:00:00-07:00");
const DAY = 86_400_000;
const agent = { kind: "agent" as const, id: "inbox" };
const sys = { kind: "system" as const, id: "seed" };

function ent(id: string, attrs: EntityRecord["attrs"]): EntityRecord {
  return { id, type: id.split(":")[0], attrs };
}

function baseState(): CRMState {
  return {
    schema: {},
    entities: {
      "company:acme": ent("company:acme", { name: "Acme Robotics" }),
      "company:northwind": ent("company:northwind", { name: "Northwind Freight", employees: 180 }),
      "deal:acme-platform": ent("deal:acme-platform", { name: "Acme — Platform rollout", company: "company:acme", amount: 20000, stage: "discovery" }),
      "contact:priya-acme": ent("contact:priya-acme", { name: "Priya Sharma", company: "company:acme" }),
      "contact:priya-sharma": { ...ent("contact:priya-sharma", { name: "Priya S.", company: "company:acme" }), mergedInto: "contact:priya-acme" },
    },
    aliases: { "contact:priya-sharma": "contact:priya-acme" },
    evidence: {},
    provenance: {},
    versions: { "deal:acme-platform::stage": 3, "deal:acme-platform::amount": 3, "company:northwind::employees": 4 },
    headSeq: 10,
  };
}

function mainEvt(s: number, ts: number, op: Event["op"]): Event {
  return { id: `evt_main_${s}`, branch: "main", seq: s, ts, actor: sys, op };
}
function attach(s: number, doc: EvidenceDoc): Event {
  return mainEvt(s, doc.ts, { type: "evidence.attach", doc });
}

const msaEmail: EvidenceDoc = {
  id: "email_msa",
  kind: "email",
  ts: NOW - 2 * DAY,
  title: "Re: Platform rollout",
  from: "priya@acmerobotics.com",
  body: "Please send over the MSA. We'd like 45 seats, total $45,000.",
  entities: ["company:acme", "deal:acme-platform", "contact:priya-acme"],
};

const pausingEmail: EvidenceDoc = {
  id: "email_pause",
  kind: "email",
  ts: NOW,
  title: "Platform rollout on hold",
  from: "priya@acmerobotics.com",
  body: "Hi Joel — we're pausing the platform rollout until Q1. Budget freeze across engineering. Sorry!",
  entities: ["company:acme", "deal:acme-platform", "contact:priya-acme"],
};

const northwindEmail: EvidenceDoc = {
  id: "email_nw_pause",
  kind: "email",
  ts: NOW,
  title: "Fleet project on hold",
  from: "dana@northwindfreight.com",
  body: "We're pausing the fleet project — budget freeze.",
  entities: ["company:northwind", "contact:dana-northwind"],
};

function acmeBranch(readSet?: Branch["readSet"]): { branch: Branch; events: Event[]; pr: PullRequest } {
  const branch: Branch = { name: "agent/inbox/1", parent: "main", forkSeq: 10, headSeq: 2, createdBy: agent, createdAt: NOW - DAY, readSet };
  const evidence = [{ docId: "email_msa", quote: "send over the MSA … 45 seats, total $45,000", claim: "Acme asked for an MSA → move to Negotiation, $45k" }];
  const events: Event[] = [
    { id: "evt_b1", branch: branch.name, seq: 1, ts: NOW - DAY, actor: agent, op: { type: "field.set", entity: "deal:acme-platform", field: "stage", value: "negotiation", prev: "discovery" }, reason: "Customer asked for the MSA", evidence },
    { id: "evt_b2", branch: branch.name, seq: 2, ts: NOW - DAY, actor: agent, op: { type: "field.set", entity: "deal:acme-platform", field: "amount", value: 45000, prev: 20000 }, reason: "45 seats, total $45,000", evidence },
  ];
  const pr: PullRequest = { id: "pr_1", title: "Acme → Negotiation, $45k", description: "", branch: branch.name, author: agent, status: "open", createdAt: NOW - DAY, updatedAt: NOW - DAY };
  return { branch, events, pr };
}

function mainLog(extra: Event[] = []): Event[] {
  const base = [mainEvt(1, NOW - 10 * DAY, { type: "entity.create", entity: "company:acme", entityType: "company", attrs: { name: "Acme Robotics" } }), attach(9, msaEmail)];
  return [...base, ...extra];
}

describe("checkStaleness", () => {
  it("is fresh when nothing changed on main since fork", async () => {
    const { branch, events, pr } = acmeBranch({ "deal:acme-platform::stage": 3 });
    const report = await checkStaleness({ pr, branch, branchEvents: events, mainEvents: mainLog(), mainState: baseState() });
    expect(report.status).toBe("fresh");
    expect(report.changedReads).toEqual([]);
    expect(report.contradictions).toEqual([]);
    expect(report.checkedAt).toBe(NOW - 2 * DAY);
  });

  it("reports a version-conflict when a read field moved on main", async () => {
    const { branch, events, pr } = acmeBranch({ "deal:acme-platform::stage": 3, "company:northwind::employees": 2 });
    const report = await checkStaleness({ pr, branch, branchEvents: events, mainEvents: mainLog(), mainState: baseState() });
    expect(report.status).toBe("version-conflict");
    expect(report.changedReads).toEqual([{ key: "company:northwind::employees", seenVersion: 2, currentVersion: 4 }]);
  });

  it("STORY #7: the injected 'pausing' email makes the open Acme PR stale", async () => {
    const { branch, events, pr } = acmeBranch();
    const mainEvents = mainLog([attach(11, pausingEmail)]);
    const state = baseState();
    state.headSeq = 11;
    const report = await checkStaleness({ pr, branch, branchEvents: events, mainEvents, mainState: state });
    expect(report.status).toBe("stale");
    expect(report.contradictions).toHaveLength(1);
    const c = report.contradictions[0];
    expect(c.docId).toBe("email_pause");
    expect(c.title).toBe("Platform rollout on hold");
    expect(c.affectsEvents.sort()).toEqual(["evt_b1", "evt_b2"]);
    expect(c.explanation).toContain('New email "Platform rollout on hold" (Oct 30)');
    expect(c.explanation.toLowerCase()).toContain("pausing");
    expect(c.explanation).toContain("Negotiation, $45k");
    expect(report.checkedAt).toBe(NOW);
  });

  it("stale beats version-conflict", async () => {
    const { branch, events, pr } = acmeBranch({ "company:northwind::employees": 2 });
    const report = await checkStaleness({ pr, branch, branchEvents: events, mainEvents: mainLog([attach(11, pausingEmail)]), mainState: baseState() });
    expect(report.status).toBe("stale");
    expect(report.changedReads).toHaveLength(1);
  });

  it("ignores an unrelated company's negative email", async () => {
    const { branch, events, pr } = acmeBranch();
    const report = await checkStaleness({ pr, branch, branchEvents: events, mainEvents: mainLog([attach(11, northwindEmail)]), mainState: baseState() });
    expect(report.status).toBe("fresh");
    expect(report.contradictions).toEqual([]);
  });

  it("ignores docs attached before the fork", async () => {
    const { branch, events, pr } = acmeBranch();
    const early = { ...pausingEmail, id: "email_old", ts: NOW - 5 * DAY };
    const report = await checkStaleness({ pr, branch, branchEvents: events, mainEvents: mainLog([attach(5, early)]), mainState: baseState() });
    expect(report.status).toBe("fresh");
  });

  it("matches docs via merged-away aliases and the deal's company", async () => {
    const { branch, events, pr } = acmeBranch();
    // doc only tagged with the merged-away contact id → resolves to priya-acme; the PR touches deal → company:acme
    const viaAlias = { ...pausingEmail, id: "email_alias", entities: ["contact:priya-sharma"] };
    const r1 = await checkStaleness({ pr, branch, branchEvents: events, mainEvents: mainLog([attach(11, viaAlias)]), mainState: baseState() });
    expect(r1.status).toBe("fresh"); // contact isn't touched by this PR, nor its company-only link
    const viaCompany = { ...pausingEmail, id: "email_company", entities: ["company:acme"] };
    const r2 = await checkStaleness({ pr, branch, branchEvents: events, mainEvents: mainLog([attach(11, viaCompany)]), mainState: baseState() });
    expect(r2.status).toBe("stale");

    // a PR that edits the merged-away contact touches priya-acme (resolved) + company:acme
    const contactEvt: Event = { id: "evt_c1", branch: "agent/inbox/2", seq: 1, ts: NOW - DAY, actor: agent, op: { type: "field.set", entity: "contact:priya-sharma", field: "title", value: "VP Engineering" }, reason: "Signature says VP Engineering" };
    const pr2 = { ...pr, id: "pr_2", title: "Priya title" };
    const r3 = await checkStaleness({ pr: pr2, branch: { ...branch, name: "agent/inbox/2" }, branchEvents: [contactEvt], mainEvents: mainLog([attach(11, { ...pausingEmail, entities: ["contact:priya-acme"] })]), mainState: baseState() });
    expect(r3.status).toBe("fresh"); // relevant doc, but a title change isn't forward-moving
  });

  it("uses the injected judge", async () => {
    const { branch, events, pr } = acmeBranch();
    const judge = vi.fn(async () => ({ contradicts: true, explanation: "nope", affectsEvents: ["evt_b2"] }));
    const unrelatedButAboutAcme = { ...pausingEmail, id: "email_x", body: "Thanks for the call!", title: "Thanks" };
    const report = await checkStaleness({ pr, branch, branchEvents: events, mainEvents: mainLog([attach(11, unrelatedButAboutAcme)]), mainState: baseState(), judge });
    expect(judge).toHaveBeenCalledTimes(1);
    const arg = (judge.mock.calls[0] as unknown as [Parameters<typeof heuristicJudge>[0]])[0];
    expect(arg.claims.map((c) => c.claim)).toEqual(["Acme asked for an MSA → move to Negotiation, $45k", "Acme asked for an MSA → move to Negotiation, $45k"]);
    expect(report.status).toBe("stale");
  });
});

describe("heuristicJudge", () => {
  const claims = [{ eventId: "e1", claim: "Acme asked for an MSA → Negotiation", reason: "MSA requested" }];

  it("flags a different dollar amount on the same deal", async () => {
    const doc: EvidenceDoc = { id: "d", kind: "email", ts: NOW, title: "Seat count", body: "Actually we'll start with 30 seats, so $30k total.", entities: ["deal:acme-platform"] };
    const r = await heuristicJudge({ prTitle: "x", claims: [{ eventId: "e2", claim: "45 seats → $45k", op: { type: "field.set", entity: "deal:acme-platform", field: "amount", value: 45000 } } as never], newDoc: doc });
    expect(r.contradicts).toBe(true);
    expect(r.affectsEvents).toEqual(["e2"]);
    expect(r.explanation).toContain("$30,000");
  });

  it("does not flag a matching amount or a positive email", async () => {
    const doc: EvidenceDoc = { id: "d", kind: "email", ts: NOW, title: "Confirming", body: "Confirming $45,000 for 45 seats at $1,000/seat. Excited!", entities: ["deal:acme-platform"] };
    const r = await heuristicJudge({ prTitle: "x", claims: [{ eventId: "e2", claim: "45 seats", op: { type: "field.set", entity: "deal:acme-platform", field: "amount", value: 45000 } } as never], newDoc: doc });
    expect(r.contradicts).toBe(false);
    const r2 = await heuristicJudge({ prTitle: "x", claims, newDoc: { ...doc, body: "Looking forward to the kickoff." } });
    expect(r2.contradicts).toBe(false);
  });

  it("text-only claims: negative cue vs forward-moving claim", async () => {
    const doc: EvidenceDoc = { id: "d", kind: "email", ts: NOW, title: "Update", body: "We are going with another vendor.", entities: ["company:acme"] };
    const r = await heuristicJudge({ prTitle: "x", claims, newDoc: doc });
    expect(r.contradicts).toBe(true);
    expect(r.affectsEvents).toEqual(["e1"]);
  });

  it("parses money", () => {
    expect(parseAmounts("$45,000 or $45k, $1.2m, $1,000/seat, $80 per seat")).toEqual([45000, 45000, 1200000]);
  });
});

describe("llmJudge", () => {
  const args = {
    prTitle: "Acme → Negotiation",
    claims: [{ eventId: "evt_b1", claim: "move to Negotiation, $45k" }],
    newDoc: pausingEmail,
  };

  it("falls back to the heuristic when llm returns null", async () => {
    const llm = vi.fn(async () => null);
    const r = await llmJudge(llm)(args);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(r.contradicts).toBe(true);
    expect(r.affectsEvents).toEqual(["evt_b1"]);
  });

  it("falls back on bad JSON or a throwing llm", async () => {
    expect((await llmJudge(async () => "I think yes!")(args)).contradicts).toBe(true);
    expect((await llmJudge(async () => { throw new Error("boom"); })(args)).contradicts).toBe(true);
  });

  it("parses fenced JSON and drops unknown event ids", async () => {
    const raw = '```json\n{"contradicts": true, "explanation": "Priya says they are pausing until Q1.", "affectsEvents": ["evt_b1", "evt_bogus"]}\n```';
    const r = await llmJudge(async () => raw)(args);
    expect(r).toEqual({ contradicts: true, explanation: expect.stringContaining("pausing until Q1"), affectsEvents: ["evt_b1"] });
  });

  it("respects an LLM 'no contradiction' verdict", async () => {
    const r = await llmJudge(async () => '{"contradicts": false, "explanation": "unrelated", "affectsEvents": []}')(args);
    expect(r.contradicts).toBe(false);
  });
});

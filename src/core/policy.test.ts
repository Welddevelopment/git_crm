import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, computeTrust, evaluatePolicy } from "./policy";
import type { Actor, AgentTrust, CRMState, Event, Op, PullRequest, PRStatus } from "./types";

// ---------- fixtures ----------
function baseState(): CRMState {
  return {
    schema: {},
    entities: {
      "company:acme": { id: "company:acme", type: "company", attrs: { name: "Acme Robotics", signals: [] } },
      "company:northwind": { id: "company:northwind", type: "company", attrs: { name: "Northwind Freight", employees: 180 } },
      "deal:acme-platform": {
        id: "deal:acme-platform",
        type: "deal",
        attrs: { name: "Acme — Platform rollout", amount: 20000, stage: "discovery", closeDate: "2026-12-15" },
      },
      "contact:priya-acme": { id: "contact:priya-acme", type: "contact", attrs: { name: "Priya Sharma", title: "Engineering Manager" } },
      "contact:priya-sharma": { id: "contact:priya-sharma", type: "contact", attrs: { name: "Priya S.", title: "" } },
      "contact:alex-chen-lumen": { id: "contact:alex-chen-lumen", type: "contact", attrs: { name: "Alex Chen" } },
    },
    aliases: {},
    evidence: {},
    provenance: {},
    versions: {},
    headSeq: 10,
  };
}

let n = 0;
function ev(op: Op, agent = "inbox"): Event {
  n++;
  const actor: Actor = { kind: "agent", id: agent };
  return { id: `evt_${n}`, branch: `agent/${agent}/1`, seq: n, ts: 1000 + n, actor, op };
}

function trust(level: AgentTrust["level"], agent = "inbox", extra: Partial<AgentTrust> = {}): AgentTrust {
  return { agent, prsOpened: 5, prsMerged: 4, prsReverted: 0, prsClosed: 0, staleCount: 0, score: 0.7, level, ...extra };
}

function pr(i: number, status: PRStatus, agent = "hygiene", stale = false): PullRequest {
  return {
    id: `pr_${i}`,
    title: "t",
    description: "d",
    branch: `agent/${agent}/${i}`,
    author: { kind: "agent", id: agent },
    status,
    createdAt: i,
    updatedAt: i,
    staleness: stale ? { status: "stale", checkedAt: i, changedReads: [], contradictions: [] } : undefined,
  };
}

const run = (events: Event[], t?: AgentTrust) =>
  evaluatePolicy({ branchEvents: events, baseState: baseState(), rules: DEFAULT_RULES, trust: t });

// ---------- tests ----------
describe("DEFAULT_RULES", () => {
  it("every rule has an id and a human description", () => {
    for (const r of DEFAULT_RULES) {
      expect(r.id).toBeTruthy();
      expect(r.description.length).toBeGreaterThan(10);
    }
    expect(new Set(DEFAULT_RULES.map((r) => r.id)).size).toBe(DEFAULT_RULES.length);
  });
});

describe("evaluatePolicy — STORY collisions", () => {
  it("Acme amount 20000→45000 + stage → review with both reasons", () => {
    const amount = ev({ type: "field.set", entity: "deal:acme-platform", field: "amount", value: 45000 });
    const stage = ev({ type: "field.set", entity: "deal:acme-platform", field: "stage", value: "negotiation" });
    const attach = ev({
      type: "evidence.attach",
      doc: { id: "email_7", kind: "email", ts: 1, title: "MSA + 45 seats", body: "please send over the MSA" },
    });
    const d = run([attach, amount, stage], trust("trusted"));
    expect(d.tier).toBe("review");
    expect(d.perEvent[amount.id]).toEqual({ tier: "review", rule: "deal-amount-large" });
    expect(d.perEvent[stage.id].tier).toBe("review");
    expect(d.perEvent[stage.id].rule).toBe("deal-stage");
    expect(d.perEvent[attach.id].tier).toBe("auto");
    expect(d.reasons).toContain("deal.amount $20,000 → $45,000 (+$25,000) exceeds $10k threshold");
    expect(d.reasons.some((r) => r.startsWith("deal.stage discovery → negotiation"))).toBe(true);
  });

  it("small amount change auto for trusted, review for probation", () => {
    const small = ev({ type: "field.set", entity: "deal:acme-platform", field: "amount", value: 25000 });
    expect(run([small], trust("trusted")).tier).toBe("auto");
    const d = run([small], trust("probation", "inbox", { prsMerged: 2, prsReverted: 1 }));
    expect(d.tier).toBe("review");
    expect(d.reasons).toContain("Agent inbox is on probation (2 merged, 1 reverted)");
  });

  it("Northwind employee count → auto for trusted agent", () => {
    const e = ev({ type: "field.set", entity: "company:northwind", field: "employees", value: 250 });
    const d = run([e], trust("trusted"));
    expect(d.tier).toBe("auto");
    expect(d.perEvent[e.id].rule).toBe("company-employees");
    expect(d.reasons[0]).toContain("company.employees 180 → 250");
  });

  it("contact title + signals auto for trusted", () => {
    const a = ev({ type: "field.set", entity: "contact:priya-sharma", field: "title", value: "VP Engineering" });
    const b = ev({ type: "field.set", entity: "company:acme", field: "signals", value: ["hiring:data-engineering"] }, "webwatch");
    expect(run([a], trust("trusted")).tier).toBe("auto");
    expect(run([b], trust("trusted", "webwatch")).tier).toBe("auto");
  });

  it("entity.merge → review (dedup)", () => {
    const e = ev({ type: "entity.merge", from: "contact:alex-chen-lumen", into: "contact:alex-chen-kestrel" }, "hygiene");
    const d = run([e], trust("trusted", "hygiene"));
    expect(d.tier).toBe("review");
    expect(d.perEvent[e.id].rule).toBe("entity-merge");
  });

  it("entity.delete → block, even when autonomous", () => {
    const e = ev({ type: "entity.delete", entity: "contact:priya-sharma" }, "hygiene");
    const other = ev({ type: "field.set", entity: "company:northwind", field: "employees", value: 200 }, "hygiene");
    expect(run([other, e], trust("autonomous", "hygiene")).tier).toBe("block");
    expect(run([e]).reasons.some((r) => r.includes("never delete"))).toBe(true);
  });

  it("schema ops → review; backfills of unknown field → review (no rule)", () => {
    const s = ev({ type: "schema.addField", entityType: "deal", field: "procurementContact", fieldType: "string" }, "schema");
    const b = ev({ type: "field.set", entity: "deal:acme-platform", field: "procurementContact", value: "Sam Lee" }, "schema");
    const d = run([s, b], trust("trusted", "schema"));
    expect(d.tier).toBe("review");
    expect(d.perEvent[s.id].rule).toBe("schema-add-field");
    expect(d.perEvent[b.id]).toEqual({ tier: "review", rule: "default" });
  });

  it("entity.create: contact auto, deal review", () => {
    const c = ev({ type: "entity.create", entity: "contact:sam-lee", entityType: "contact", attrs: { name: "Sam Lee" } });
    const dl = ev({ type: "entity.create", entity: "deal:new", entityType: "deal", attrs: { amount: 5000 } });
    expect(run([c], trust("trusted")).tier).toBe("auto");
    expect(run([dl], trust("trusted")).tier).toBe("review");
  });

  it("resolves entity type through aliases and newly created entities", () => {
    const st = baseState();
    st.aliases["contact:priya-sharma"] = "contact:priya-acme";
    delete st.entities["contact:priya-sharma"];
    const e = ev({ type: "field.set", entity: "contact:priya-sharma", field: "title", value: "VP Engineering" });
    const d = evaluatePolicy({ branchEvents: [e], baseState: st, rules: DEFAULT_RULES, trust: trust("trusted") });
    expect(d.tier).toBe("auto");
    expect(d.reasons[0]).toContain("Engineering Manager → VP Engineering");
  });

  it("empty branch → auto", () => {
    expect(run([]).tier).toBe("auto");
  });
});

describe("evaluatePolicy — trust adjustment", () => {
  it("autonomous can't auto-merge money or stage", () => {
    const amount = ev({ type: "field.set", entity: "deal:acme-platform", field: "amount", value: 45000 });
    const stage = ev({ type: "field.set", entity: "deal:acme-platform", field: "stage", value: "negotiation" });
    const d = run([amount, stage], trust("autonomous", "inbox", { score: 0.9 }));
    expect(d.tier).toBe("review");
    expect(d.perEvent[amount.id].tier).toBe("review");
    expect(d.perEvent[stage.id].tier).toBe("review");
    expect(d.reasons).toContain("Agent inbox is autonomous, but money changes always need a human");
    expect(d.reasons).toContain("Agent inbox is autonomous, but pipeline stage changes always need a human");
  });

  it("autonomous can't auto-merge merges or schema, but can auto-merge close date", () => {
    const m = ev({ type: "entity.merge", from: "contact:priya-sharma", into: "contact:priya-acme" }, "hygiene");
    const s = ev({ type: "schema.removeField", entityType: "deal", field: "nextStep" }, "hygiene");
    const cd = ev({ type: "field.set", entity: "deal:acme-platform", field: "closeDate", value: "2026-11-15" }, "hygiene");
    const t = trust("autonomous", "hygiene", { score: 0.9 });
    expect(run([m], t).tier).toBe("review");
    expect(run([s], t).tier).toBe("review");
    const d = run([cd], t);
    expect(d.tier).toBe("auto");
    expect(d.perEvent[cd.id].rule).toBe("deal-close-date+trust:autonomous");
  });

  it("new agents (no reverts) follow rules as written", () => {
    const t = trust("probation", "webwatch", { prsMerged: 0, prsReverted: 0 });
    const sig = ev({ type: "field.set", entity: "company:acme", field: "signals", value: ["x"] }, "webwatch");
    expect(run([sig], t).tier).toBe("auto");
  });

  it("probation (after a revert) upgrades auto → review except evidence.attach", () => {
    const t = trust("probation", "webwatch", { prsMerged: 0, prsReverted: 1 });
    const sig = ev({ type: "field.set", entity: "company:acme", field: "signals", value: ["x"] }, "webwatch");
    const att = ev({ type: "evidence.attach", doc: { id: "w1", kind: "web", ts: 1, title: "Careers", body: "" } }, "webwatch");
    const d = run([att, sig], t);
    expect(d.tier).toBe("review");
    expect(d.perEvent[att.id].tier).toBe("auto");
    expect(d.perEvent[sig.id]).toEqual({ tier: "review", rule: "company-signals+trust:probation" });
    expect(run([att], t).tier).toBe("auto");
  });

  it("reasons are deduped", () => {
    const a = ev({ type: "schema.addField", entityType: "deal", field: "a", fieldType: "string" }, "schema");
    const b = ev({ type: "schema.addField", entityType: "deal", field: "a", fieldType: "string" }, "schema");
    const d = run([a, b], trust("trusted", "schema"));
    expect(d.reasons.length).toBe(new Set(d.reasons).size);
    expect(d.reasons.length).toBe(1);
  });

  it("absDeltaGt uses running branch value for consecutive edits", () => {
    const a = ev({ type: "field.set", entity: "deal:acme-platform", field: "amount", value: 25000 });
    const b = ev({ type: "field.set", entity: "deal:acme-platform", field: "amount", value: 29000 });
    const d = run([a, b], trust("trusted"));
    expect(d.tier).toBe("auto");
  });
});

describe("computeTrust", () => {
  it("no history → probation with Laplace prior 0.5", () => {
    const t = computeTrust("hygiene", []);
    expect(t).toMatchObject({ prsOpened: 0, prsMerged: 0, score: 0.5, level: "probation" });
  });

  it("2 merged, 1 reverted → probation; counts only that agent", () => {
    const prs = [pr(1, "merged"), pr(2, "merged"), pr(3, "reverted"), pr(4, "merged", "inbox")];
    const t = computeTrust("hygiene", prs);
    expect(t.prsOpened).toBe(3);
    expect(t.prsMerged).toBe(2);
    expect(t.prsReverted).toBe(1);
    // (2+1)/(3+2) - 0.25 = 0.35
    expect(t.score).toBeCloseTo(0.35);
    expect(t.level).toBe("probation");
  });

  it("3 merged of 4 → trusted", () => {
    const t = computeTrust("inbox", [pr(1, "merged", "inbox"), pr(2, "merged", "inbox"), pr(3, "merged", "inbox"), pr(4, "closed", "inbox")]);
    // 4/6 = 0.667
    expect(t.score).toBeCloseTo(4 / 6);
    expect(t.prsClosed).toBe(1);
    expect(t.level).toBe("trusted");
  });

  it("10 clean merges → autonomous; a revert drops it", () => {
    const prs = Array.from({ length: 10 }, (_, i) => pr(i, "merged", "webwatch"));
    const t = computeTrust("webwatch", prs);
    expect(t.score).toBeCloseTo(11 / 12);
    expect(t.level).toBe("autonomous");
    const t2 = computeTrust("webwatch", [...prs, pr(99, "reverted", "webwatch")]);
    // 11/13 - 0.25 = 0.596 < 0.6 → one revert costs a lot
    expect(t2.score).toBeCloseTo(11 / 13 - 0.25);
    expect(t2.level).toBe("probation");
  });

  it("stale PRs penalize; score clamped to [0,1]", () => {
    const prs = [pr(1, "open", "inbox", true), pr(2, "open", "inbox", true)];
    const t = computeTrust("inbox", prs);
    expect(t.staleCount).toBe(2);
    expect(t.score).toBeCloseTo(0.25 - 0.2);
    const bad = computeTrust("hygiene", [pr(1, "reverted"), pr(2, "reverted"), pr(3, "reverted")]);
    expect(bad.score).toBe(0);
  });
});

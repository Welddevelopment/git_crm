import { describe, expect, it } from "vitest";
import type { Actor, Branch, Event, Op } from "../types";
import { applyEvent, blame, branchState, diffStates, emptyState, fold, resolveId, stateAt, vkey } from "./state";

const agent: Actor = { kind: "agent", id: "inbox" };
const human: Actor = { kind: "human", id: "joel" };

/** Build a contiguous main log. ts = 1000 * seq unless overridden. */
function log(ops: (Op | { op: Op; actor?: Actor; ts?: number; reason?: string })[], branch = "main"): Event[] {
  return ops.map((o, i) => {
    const x = "type" in o ? { op: o } : o;
    return {
      id: `${branch}_evt_${i + 1}`,
      branch,
      seq: i + 1,
      ts: x.ts ?? 1000 * (i + 1),
      actor: x.actor ?? agent,
      op: x.op,
      reason: x.reason,
    };
  });
}

const createAcme: Op = { type: "entity.create", entity: "company:acme", entityType: "company", attrs: { name: "Acme", employees: 100 } };
const createPriya: Op = {
  type: "entity.create",
  entity: "contact:priya-acme",
  entityType: "contact",
  attrs: { name: "Priya Sharma", email: "priya@acmerobotics.com", title: "Engineering Manager", phone: "" },
};
const createPriyaDup: Op = {
  type: "entity.create",
  entity: "contact:priya-sharma",
  entityType: "contact",
  attrs: { name: "Priya S.", email: "p.sharma@acmerobotics.com", title: "", phone: "555-0100" },
};

describe("applyEvent / fold", () => {
  it("creates and sets fields; is pure", () => {
    const evs = log([createAcme, { type: "field.set", entity: "company:acme", field: "employees", value: 250 }]);
    const s1 = applyEvent(emptyState(), evs[0]!);
    const s2 = applyEvent(s1, evs[1]!);
    expect(s1.entities["company:acme"]!.attrs.employees).toBe(100);
    expect(s2.entities["company:acme"]!.attrs.employees).toBe(250);
    expect(s2.headSeq).toBe(2);
    expect(fold(evs)).toEqual(s2);
  });

  it("field.set on unknown entity is a no-op", () => {
    const s = fold(log([{ type: "field.set", entity: "company:nope", field: "x", value: 1 }]));
    expect(s.entities).toEqual({});
    expect(s.headSeq).toBe(1);
  });

  it("records provenance and versions", () => {
    const evs = log([
      createAcme,
      { op: { type: "field.set", entity: "company:acme", field: "employees", value: 250 }, actor: human, reason: "email" },
    ]);
    const s = fold(evs);
    expect(s.versions[vkey("company:acme", "employees")]).toBe(2);
    expect(s.versions[vkey("company:acme", "name")]).toBe(1);
    expect(s.provenance["company:acme"]!.employees).toMatchObject({ eventId: "main_evt_2", actor: human, seq: 2, reason: "email", branch: "main" });
    expect(s.provenance["company:acme"]!.name!.eventId).toBe("main_evt_1");
  });

  it("delete keeps the record", () => {
    const s = fold(log([createAcme, { type: "entity.delete", entity: "company:acme" }]));
    expect(s.entities["company:acme"]!.deleted).toBe(true);
  });

  it("branch events increment headSeq", () => {
    const s = fold(log([createAcme, createPriya], "agent/x"));
    expect(s.headSeq).toBe(2);
  });

  it("evidence.attach", () => {
    const doc = { id: "email_1", kind: "email" as const, ts: 5, title: "hi", body: "b" };
    expect(fold(log([{ type: "evidence.attach", doc }])).evidence.email_1).toEqual(doc);
  });
});

describe("merge + aliases", () => {
  const base: Op[] = [
    createPriya,
    createPriyaDup,
    { type: "entity.merge", from: "contact:priya-sharma", into: "contact:priya-acme", fieldChoices: { title: "VP Engineering" } },
  ];

  it("fills empty fields, applies fieldChoices, aliases from→into", () => {
    const s = fold(log(base));
    const into = s.entities["contact:priya-acme"]!;
    expect(into.attrs.name).toBe("Priya Sharma"); // into keeps its own
    expect(into.attrs.phone).toBe("555-0100"); // filled from `from`
    expect(into.attrs.title).toBe("VP Engineering"); // fieldChoice
    expect(s.entities["contact:priya-sharma"]!.mergedInto).toBe("contact:priya-acme");
    expect(s.aliases["contact:priya-sharma"]).toBe("contact:priya-acme");
    expect(resolveId(s, "contact:priya-sharma")).toBe("contact:priya-acme");
    expect(s.versions[vkey("contact:priya-acme", "phone")]).toBe(3);
    expect(s.versions[vkey("contact:priya-acme", "title")]).toBe(3);
    expect(s.versions[vkey("contact:priya-acme", "name")]).toBe(1);
    expect(s.versions[vkey("contact:priya-acme", "__entity")]).toBe(3);
    expect(s.versions[vkey("contact:priya-sharma", "__entity")]).toBe(3);
  });

  it("subsequent set through alias lands on the survivor", () => {
    const s = fold(log([...base, { type: "field.set", entity: "contact:priya-sharma", field: "title", value: "CTO" }]));
    expect(s.entities["contact:priya-acme"]!.attrs.title).toBe("CTO");
    expect(s.entities["contact:priya-sharma"]!.attrs.title).toBe("");
  });

  it("resolveId follows chains transitively", () => {
    const s = fold(
      log([
        createPriya,
        createPriyaDup,
        { type: "entity.create", entity: "contact:c", entityType: "contact", attrs: { name: "C" } },
        { type: "entity.merge", from: "contact:priya-sharma", into: "contact:c" },
        { type: "entity.merge", from: "contact:c", into: "contact:priya-acme" },
      ]),
    );
    expect(resolveId(s, "contact:priya-sharma")).toBe("contact:priya-acme");
    expect(resolveId(s, "contact:unknown")).toBe("contact:unknown");
  });

  it("re-create resurrects a merged-away entity (revert of dedup)", () => {
    const s = fold(log([...base, createPriyaDup]));
    const r = s.entities["contact:priya-sharma"]!;
    expect(r.mergedInto).toBeUndefined();
    expect(r.deleted).toBeUndefined();
    expect(r.attrs.name).toBe("Priya S.");
    expect(s.aliases["contact:priya-sharma"]).toBeUndefined();
    expect(resolveId(s, "contact:priya-sharma")).toBe("contact:priya-sharma");
  });

  it("re-create resurrects a deleted entity", () => {
    const s = fold(log([createAcme, { type: "entity.delete", entity: "company:acme" }, createAcme]));
    expect(s.entities["company:acme"]!.deleted).toBeUndefined();
  });
});

describe("schema ops", () => {
  it("add / rename / remove", () => {
    const evs = log([
      createAcme,
      { type: "schema.addField", entityType: "company", field: "hq", fieldType: "string", description: "Head office" },
      { type: "field.set", entity: "company:acme", field: "hq", value: "SF" },
      { type: "schema.renameField", entityType: "company", from: "hq", to: "headquarters" },
    ]);
    const s = fold(evs);
    expect(s.schema.company).toEqual([{ field: "headquarters", fieldType: "string", description: "Head office" }]);
    expect(s.entities["company:acme"]!.attrs.headquarters).toBe("SF");
    expect("hq" in s.entities["company:acme"]!.attrs).toBe(false);
    expect(s.provenance["company:acme"]!.headquarters!.eventId).toBe("main_evt_3");
    const s2 = applyEvent(s, { ...evs[0]!, id: "x", seq: 5, op: { type: "schema.removeField", entityType: "company", field: "headquarters" } });
    expect(s2.schema.company).toEqual([]);
  });
});

describe("stateAt / branchState", () => {
  const main = log([
    createAcme,
    { type: "field.set", entity: "company:acme", field: "employees", value: 200 },
    { type: "field.set", entity: "company:acme", field: "employees", value: 300 },
  ]);

  it("stateAt folds by ts", () => {
    expect(stateAt(main, 2500).entities["company:acme"]!.attrs.employees).toBe(200);
    expect(stateAt(main, 0).entities).toEqual({});
    expect(stateAt(main, 99999).entities["company:acme"]!.attrs.employees).toBe(300);
  });

  it("branchState = main@forkSeq + branch events", () => {
    const branch: Branch = { name: "agent/inbox/1", parent: "main", forkSeq: 2, headSeq: 1, createdBy: agent, createdAt: 0 };
    const bevs = log([{ type: "field.set", entity: "company:acme", field: "name", value: "Acme Robotics" }], branch.name);
    const s = branchState(main, branch, bevs);
    expect(s.entities["company:acme"]!.attrs).toEqual({ name: "Acme Robotics", employees: 200 });
    expect(s.provenance["company:acme"]!.name!.branch).toBe(branch.name);
  });
});

describe("blame", () => {
  it("lists every write oldest first, including writes via merged-away entities", () => {
    const evs = log([
      createPriya,
      createPriyaDup,
      { type: "field.set", entity: "contact:priya-sharma", field: "phone", value: "555-0199" },
      { type: "field.set", entity: "contact:priya-acme", field: "title", value: "Director" },
      { type: "entity.merge", from: "contact:priya-sharma", into: "contact:priya-acme" },
      { type: "field.set", entity: "contact:priya-sharma", field: "phone", value: "555-0200" },
    ]);
    const phone = blame(evs, "contact:priya-acme", "phone");
    expect(phone.map((p) => p.eventId)).toEqual(["main_evt_1", "main_evt_2", "main_evt_3", "main_evt_5", "main_evt_6"]);
    const title = blame(evs, "contact:priya-acme", "title");
    expect(title.map((p) => p.eventId)).toEqual(["main_evt_1", "main_evt_2", "main_evt_4"]);
    // asking via the alias resolves to the same survivor
    expect(blame(evs, "contact:priya-sharma", "phone")).toEqual(phone);
  });

  it("ignores other entities and fields", () => {
    const evs = log([createAcme, createPriya, { type: "field.set", entity: "company:acme", field: "name", value: "X" }]);
    expect(blame(evs, "company:acme", "employees").map((p) => p.eventId)).toEqual(["main_evt_1"]);
  });
});

describe("diffStates", () => {
  it("reports adds, removes, merges, field changes, schema, evidence in deterministic order", () => {
    const a = fold(log([createAcme, createPriya, createPriyaDup]));
    const b = fold(
      [
        { type: "entity.create", entity: "deal:acme-platform", entityType: "deal", attrs: { amount: 20000 } },
        { type: "field.set", entity: "company:acme", field: "employees", value: 250 },
        { type: "entity.merge", from: "contact:priya-sharma", into: "contact:priya-acme" },
        { type: "schema.addField", entityType: "deal", field: "procurementContact", fieldType: "string" },
        { type: "evidence.attach", doc: { id: "email_1", kind: "email", ts: 1, title: "t", body: "b" } },
      ].map((op, i) => ({ id: `b${i}`, branch: "main", seq: 4 + i, ts: 4000 + i, actor: agent, op }) as Event),
      a,
    );
    expect(diffStates(a, b)).toEqual([
      { kind: "field.changed", entity: "company:acme", field: "employees", before: 100, after: 250 },
      { kind: "field.changed", entity: "contact:priya-acme", field: "phone", before: "", after: "555-0100" },
      { kind: "entity.merged", from: "contact:priya-sharma", into: "contact:priya-acme" },
      { kind: "entity.added", entity: "deal:acme-platform", entityType: "deal", attrs: { amount: 20000 } },
      { kind: "schema.changed", entityType: "deal", description: "added field procurementContact (string)" },
      { kind: "evidence.added", docId: "email_1" },
    ]);
    expect(diffStates(b, b)).toEqual([]);
  });

  it("delete → entity.removed; resurrect → entity.added", () => {
    const a = fold(log([createAcme]));
    const b = applyEvent(a, { id: "d", branch: "main", seq: 2, ts: 2, actor: human, op: { type: "entity.delete", entity: "company:acme" } });
    expect(diffStates(a, b)).toEqual([{ kind: "entity.removed", entity: "company:acme" }]);
    expect(diffStates(b, a)).toEqual([{ kind: "entity.added", entity: "company:acme", entityType: "company", attrs: { name: "Acme", employees: 100 } }]);
  });

  it("array values compare by content", () => {
    const mk = (sig: string[]) =>
      fold(log([{ type: "entity.create", entity: "company:acme", entityType: "company", attrs: { signals: sig } }]));
    expect(diffStates(mk(["a"]), mk(["a"]))).toEqual([]);
    expect(diffStates(mk(["a"]), mk(["a", "b"]))).toHaveLength(1);
  });
});

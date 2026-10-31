import { describe, expect, it } from "vitest";
import type { Actor, Branch, Event, NewEvent, Op } from "../types";
import { fold } from "./state";
import { previewMerge, revertEvents, threeWayMerge } from "./merge";

// ---------- fixtures (hand-built events; no seed import) ----------
const SEED: Actor = { kind: "system", id: "seed" };
const INBOX: Actor = { kind: "agent", id: "inbox" };
const HYGIENE: Actor = { kind: "agent", id: "hygiene" };
const WEB: Actor = { kind: "agent", id: "webwatch" };

class Log {
  events: Event[] = [];
  constructor(public branch: string) {}
  add(op: Op, actor: Actor = SEED, reason?: string): Event {
    const seq = this.events.length + 1;
    const e: Event = { id: `${this.branch}_${seq}`, branch: this.branch, seq, ts: 1000 + seq, actor, op };
    if (reason) e.reason = reason;
    this.events.push(e);
    return e;
  }
  get head() {
    return this.events.length;
  }
}

function seedMain(): Log {
  const m = new Log("main");
  m.add({ type: "schema.addField", entityType: "company", field: "name", fieldType: "string" });
  m.add({ type: "schema.addField", entityType: "company", field: "employees", fieldType: "number" });
  m.add({ type: "schema.addField", entityType: "contact", field: "name", fieldType: "string" });
  m.add({ type: "schema.addField", entityType: "contact", field: "title", fieldType: "string" });
  m.add({ type: "schema.addField", entityType: "contact", field: "email", fieldType: "string" });
  m.add({ type: "entity.create", entity: "company:northwind", entityType: "company", attrs: { name: "Northwind Freight", employees: 180 } });
  m.add({ type: "entity.create", entity: "contact:priya-acme", entityType: "contact", attrs: { name: "Priya Sharma", email: "priya@acmerobotics.com", title: "Engineering Manager" } });
  m.add({ type: "entity.create", entity: "contact:priya-sharma", entityType: "contact", attrs: { name: "Priya S.", email: "p.sharma@acmerobotics.com", title: "" } });
  m.add({ type: "entity.create", entity: "contact:alex-chen-kestrel", entityType: "contact", attrs: { name: "Alex Chen", email: "alex.chen@kestrelbank.com", title: "CISO" } });
  m.add({ type: "entity.create", entity: "contact:alex-chen-lumen", entityType: "contact", attrs: { name: "Alex Chen", email: "achen@lumengrid.io", title: "Founder & CEO" } });
  return m;
}

function branchOf(name: string, forkSeq: number, headSeq: number): Branch {
  return { name, parent: "main", forkSeq, headSeq, createdBy: INBOX, createdAt: 0 };
}

/** Append merge output to main as real events, like the repo would. */
function appendAll(m: Log, evs: NewEvent[]) {
  for (const ne of evs) {
    const e = m.add(ne.op, ne.actor, ne.reason);
    if (ne.origin) e.origin = ne.origin;
  }
}

// ---------- tests ----------
describe("threeWayMerge", () => {
  it("clean merge: emits rebased events with merge origin and a diff", () => {
    const main = seedMain();
    const fork = main.head;
    const b = new Log("agent/inbox/1");
    const src = b.add({ type: "field.set", entity: "contact:priya-acme", field: "title", value: "VP Engineering" }, INBOX, "signature");
    b.events[0]!.evidence = [{ docId: "email_1", claim: "signature says VP" }];
    main.add({ type: "field.set", entity: "company:northwind", field: "name", value: "Northwind" }); // unrelated main change

    const r = threeWayMerge({ mainEvents: main.events, branch: branchOf(b.branch, fork, b.head), branchEvents: b.events, pr: "pr_1" });
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.toAppend).toHaveLength(1);
    expect(r.toAppend[0]).toMatchObject({
      actor: INBOX,
      reason: "signature",
      evidence: [{ docId: "email_1", claim: "signature says VP" }],
      origin: { kind: "merge", pr: "pr_1", sourceEvent: src.id },
      op: { type: "field.set", entity: "contact:priya-acme", field: "title", value: "VP Engineering" },
    });
    expect(r.changes).toEqual([
      { kind: "field.changed", entity: "contact:priya-acme", field: "title", before: "Engineering Manager", after: "VP Engineering" },
    ]);
    expect(previewMerge({ mainEvents: main.events, branch: branchOf(b.branch, fork, b.head), branchEvents: b.events, pr: "pr_1" }).ok).toBe(true);
  });

  describe("field conflict (STORY #3: Northwind employees 250 vs 220)", () => {
    const setup = () => {
      const main = seedMain();
      const fork = main.head;
      const b = new Log("agent/webwatch/1");
      b.add({ type: "field.set", entity: "company:northwind", field: "employees", value: 220 }, WEB, "careers page");
      const oursEv = main.add({ type: "field.set", entity: "company:northwind", field: "employees", value: 250 }, INBOX, "Dana email");
      const input = { mainEvents: main.events, branch: branchOf(b.branch, fork, b.head), branchEvents: b.events, pr: "pr_2" };
      return { input, oursEv, theirsEv: b.events[0]! };
    };
    const ID = "field:company:northwind:employees";

    it("detects conflict with base/ours/theirs and provenance", () => {
      const { input, oursEv, theirsEv } = setup();
      const r = threeWayMerge(input);
      expect(r.ok).toBe(false);
      expect(r.conflicts).toEqual([
        { id: ID, kind: "field", entity: "company:northwind", field: "employees", base: 180, ours: 250, theirs: 220, oursEvent: oursEv.id, theirsEvent: theirsEv.id },
      ]);
      expect(r.toAppend).toEqual([]);
    });

    it("resolution ours → drop", () => {
      const { input } = setup();
      const r = threeWayMerge({ ...input, resolutions: { [ID]: "ours" } });
      expect(r.ok).toBe(true);
      expect(r.conflicts[0]!.resolution).toBe("ours");
      expect(r.toAppend).toEqual([]);
      expect(r.changes).toEqual([]);
    });

    it("resolution theirs → keep branch value", () => {
      const { input } = setup();
      const r = threeWayMerge({ ...input, resolutions: { [ID]: "theirs" } });
      expect(r.ok).toBe(true);
      expect(r.toAppend.map((e) => e.op)).toEqual([{ type: "field.set", entity: "company:northwind", field: "employees", value: 220, prev: 250 }]);
      expect(r.changes).toEqual([{ kind: "field.changed", entity: "company:northwind", field: "employees", before: 250, after: 220 }]);
    });

    it("resolution {value} → set custom value", () => {
      const { input } = setup();
      const r = threeWayMerge({ ...input, resolutions: { [ID]: { value: 240 } } });
      expect(r.ok).toBe(true);
      expect(r.toAppend.map((e) => e.op)).toMatchObject([{ type: "field.set", entity: "company:northwind", field: "employees", value: 240 }]);
    });
  });

  it("merged-away auto-rebase (STORY #2: title on priya-sharma after dedup into priya-acme)", () => {
    const main = seedMain();
    const fork = main.head;
    const b = new Log("agent/inbox/2");
    const src = b.add({ type: "field.set", entity: "contact:priya-sharma", field: "title", value: "VP Engineering" }, INBOX, "signature");
    main.add({ type: "entity.merge", from: "contact:priya-sharma", into: "contact:priya-acme" }, HYGIENE, "dedup");

    const r = threeWayMerge({ mainEvents: main.events, branch: branchOf(b.branch, fork, b.head), branchEvents: b.events, pr: "pr_3" });
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([
      {
        id: "merged-away:contact:priya-sharma:title",
        kind: "merged-away",
        entity: "contact:priya-sharma",
        field: "title",
        theirs: "VP Engineering",
        theirsEvent: src.id,
        autoResolved: { to: "contact:priya-acme", note: "rebased onto merge survivor" },
      },
    ]);
    expect(r.toAppend.map((e) => e.op)).toEqual([
      { type: "field.set", entity: "contact:priya-acme", field: "title", value: "VP Engineering", prev: "Engineering Manager" },
    ]);
    appendAll(main, r.toAppend);
    expect(fold(main.events).entities["contact:priya-acme"]!.attrs.title).toBe("VP Engineering");
  });

  it("entity.merge whose `from` was already merged on main → dropped with note", () => {
    const main = seedMain();
    const fork = main.head;
    const b = new Log("agent/hygiene/2");
    b.add({ type: "entity.merge", from: "contact:priya-sharma", into: "contact:priya-acme" }, HYGIENE);
    main.add({ type: "entity.merge", from: "contact:priya-sharma", into: "contact:priya-acme" }, HYGIENE);
    const r = threeWayMerge({ mainEvents: main.events, branch: branchOf(b.branch, fork, b.head), branchEvents: b.events, pr: "pr_4" });
    expect(r.ok).toBe(true);
    expect(r.toAppend).toEqual([]);
    expect(r.conflicts[0]).toMatchObject({ kind: "merged-away", entity: "contact:priya-sharma", autoResolved: { to: "contact:priya-acme" } });
  });

  it("entity.merge inverse of main's merge → unresolved merged-away", () => {
    const main = seedMain();
    const fork = main.head;
    const b = new Log("agent/hygiene/3");
    b.add({ type: "entity.merge", from: "contact:priya-acme", into: "contact:priya-sharma" }, HYGIENE);
    main.add({ type: "entity.merge", from: "contact:priya-sharma", into: "contact:priya-acme" }, HYGIENE);
    const r = threeWayMerge({ mainEvents: main.events, branch: branchOf(b.branch, fork, b.head), branchEvents: b.events, pr: "pr_5" });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([{ id: "merged-away:contact:priya-acme:", kind: "merged-away", entity: "contact:priya-acme", theirsEvent: b.events[0]!.id }]);
    expect(r.toAppend).toEqual([]);
  });

  describe("deleted conflict", () => {
    const setup = () => {
      const main = seedMain();
      const fork = main.head;
      const b = new Log("agent/inbox/3");
      b.add({ type: "field.set", entity: "company:northwind", field: "employees", value: 250 }, INBOX);
      main.add({ type: "entity.delete", entity: "company:northwind" });
      return { main, input: { mainEvents: main.events, branch: branchOf(b.branch, fork, b.head), branchEvents: b.events, pr: "pr_6" } };
    };
    const ID = "deleted:company:northwind:";

    it("unresolved by default", () => {
      const r = threeWayMerge(setup().input);
      expect(r.ok).toBe(false);
      expect(r.conflicts).toEqual([{ id: ID, kind: "deleted", entity: "company:northwind", theirsEvent: "agent/inbox/3_1" }]);
      expect(r.toAppend).toEqual([]);
    });

    it("ours → drop", () => {
      const r = threeWayMerge({ ...setup().input, resolutions: { [ID]: "ours" } });
      expect(r.ok).toBe(true);
      expect(r.toAppend).toEqual([]);
    });

    it("theirs → resurrect then apply", () => {
      const { main, input } = setup();
      const r = threeWayMerge({ ...input, resolutions: { [ID]: "theirs" } });
      expect(r.ok).toBe(true);
      expect(r.toAppend.map((e) => e.op.type)).toEqual(["entity.create", "field.set"]);
      appendAll(main, r.toAppend);
      const n = fold(main.events).entities["company:northwind"]!;
      expect(n.deleted).toBeFalsy();
      expect(n.attrs).toEqual({ name: "Northwind Freight", employees: 250 });
    });
  });

  it("no-op: main already has theirs value → dropped silently", () => {
    const main = seedMain();
    const fork = main.head;
    const b = new Log("agent/webwatch/2");
    b.add({ type: "field.set", entity: "company:northwind", field: "employees", value: 250 }, WEB);
    main.add({ type: "field.set", entity: "company:northwind", field: "employees", value: 250 }, INBOX);
    const r = threeWayMerge({ mainEvents: main.events, branch: branchOf(b.branch, fork, b.head), branchEvents: b.events, pr: "pr_7" });
    expect(r).toEqual({ ok: true, conflicts: [], toAppend: [], changes: [] });
  });

  it("schema conflict: main removed a field the branch writes", () => {
    const main = seedMain();
    const fork = main.head;
    const b = new Log("agent/inbox/4");
    b.add({ type: "field.set", entity: "company:northwind", field: "employees", value: 250 }, INBOX);
    main.add({ type: "schema.removeField", entityType: "company", field: "employees" });
    const r = threeWayMerge({ mainEvents: main.events, branch: branchOf(b.branch, fork, b.head), branchEvents: b.events, pr: "pr_8" });
    expect(r.ok).toBe(false);
    expect(r.conflicts.map((c) => c.id)).toEqual(["schema:company:northwind:employees"]);
  });

  it("partial: non-conflicting parts still returned when !ok; create/schema/evidence pass through", () => {
    const main = seedMain();
    const fork = main.head;
    const b = new Log("agent/schema/1");
    b.add({ type: "schema.addField", entityType: "contact", field: "phone", fieldType: "string" });
    b.add({ type: "field.set", entity: "company:northwind", field: "employees", value: 220 }, WEB);
    b.add({ type: "entity.create", entity: "contact:sam-lee", entityType: "contact", attrs: { name: "Sam Lee" } });
    b.add({ type: "entity.create", entity: "company:northwind", entityType: "company", attrs: { name: "dup" } }); // live on ours → drop
    b.add({ type: "evidence.attach", doc: { id: "web_1", kind: "web", ts: 1, title: "Careers", body: "220 employees" } });
    main.add({ type: "field.set", entity: "company:northwind", field: "employees", value: 250 }, INBOX);
    const r = threeWayMerge({ mainEvents: main.events, branch: branchOf(b.branch, fork, b.head), branchEvents: b.events, pr: "pr_9" });
    expect(r.ok).toBe(false);
    expect(r.toAppend.map((e) => e.op.type)).toEqual(["schema.addField", "entity.create", "evidence.attach"]);
    expect(r.changes.map((c) => c.kind).sort()).toEqual(["entity.added", "evidence.added", "schema.changed"]);
  });
});

describe("revertEvents", () => {
  it("reverts a field.set to its previous value", () => {
    const main = seedMain();
    const bad = main.add({ type: "field.set", entity: "company:northwind", field: "employees", value: 9999 }, WEB, "bad scrape");
    const inv = revertEvents(main.events, [bad.id], fold(main.events));
    expect(inv).toEqual([
      {
        actor: { kind: "system", id: "revert" },
        op: { type: "field.set", entity: "company:northwind", field: "employees", value: 180 },
        reason: "Revert: bad scrape",
        origin: { kind: "revert", revertOf: bad.id },
      },
    ]);
    appendAll(main, inv);
    expect(fold(main.events).entities["company:northwind"]!.attrs.employees).toBe(180);
  });

  it("skips a field.set inverse when a later event changed the field, noting it", () => {
    const main = seedMain();
    const bad = main.add({ type: "field.set", entity: "company:northwind", field: "employees", value: 9999 }, WEB, "bad scrape");
    const later = main.add({ type: "field.set", entity: "company:northwind", field: "employees", value: 250 }, INBOX);
    const inv = revertEvents(main.events, [bad.id], fold(main.events));
    expect(inv).toEqual([]);
    // when reverted together, both undo cleanly (newest first)
    const both = revertEvents(main.events, [bad.id, later.id], fold(main.events));
    expect(both.map((e) => (e.op as { value: unknown }).value)).toEqual([9999, 180]);
    expect(both.map((e) => e.origin)).toEqual([
      { kind: "revert", revertOf: later.id },
      { kind: "revert", revertOf: bad.id },
    ]);
  });

  it("reverts the bad Alex Chen dedup (STORY #4): both contacts restored", () => {
    const main = seedMain();
    const before = fold(main.events);
    // kestrel has no phone, so the merge fills it from lumen; the revert must undo that too
    main.add({ type: "field.set", entity: "contact:alex-chen-lumen", field: "phone", value: "+1-555-0100" });
    const pre = fold(main.events);
    const merge = main.add({ type: "entity.merge", from: "contact:alex-chen-lumen", into: "contact:alex-chen-kestrel" }, HYGIENE, "exact name match");
    main.add({ type: "field.set", entity: "company:northwind", field: "employees", value: 250 }, INBOX); // unrelated later event
    const cur = fold(main.events);
    expect(cur.aliases["contact:alex-chen-lumen"]).toBe("contact:alex-chen-kestrel");
    expect(cur.entities["contact:alex-chen-kestrel"]!.attrs.phone).toBe("+1-555-0100");

    const inv = revertEvents(main.events, [merge.id], cur);
    expect(inv.map((e) => e.op.type)).toEqual(["entity.create", "field.set"]);
    expect(inv.every((e) => e.reason === "Revert: exact name match" && e.actor.id === "revert")).toBe(true);
    appendAll(main, inv);

    const after = fold(main.events);
    expect(after.aliases["contact:alex-chen-lumen"]).toBeUndefined();
    const lumen = after.entities["contact:alex-chen-lumen"]!;
    const kestrel = after.entities["contact:alex-chen-kestrel"]!;
    expect(lumen.mergedInto).toBeUndefined();
    expect(lumen.attrs).toEqual(pre.entities["contact:alex-chen-lumen"]!.attrs);
    expect(lumen.attrs.email).toBe("achen@lumengrid.io");
    expect(kestrel.attrs).toMatchObject({ ...before.entities["contact:alex-chen-kestrel"]!.attrs, phone: null });
    expect(kestrel.attrs.title).toBe("CISO");
    expect(after.entities["company:northwind"]!.attrs.employees).toBe(250);
  });

  it("reverts create / delete / schema ops", () => {
    const main = seedMain();
    const c = main.add({ type: "entity.create", entity: "contact:sam-lee", entityType: "contact", attrs: { name: "Sam Lee" } });
    const d = main.add({ type: "entity.delete", entity: "company:northwind" });
    const a = main.add({ type: "schema.addField", entityType: "deal", field: "procurementContact", fieldType: "string" });
    const rn = main.add({ type: "schema.renameField", entityType: "contact", from: "title", to: "jobTitle" });
    const rm = main.add({ type: "schema.removeField", entityType: "contact", field: "email" });
    const ev = main.add({ type: "evidence.attach", doc: { id: "e1", kind: "note", ts: 1, title: "n", body: "b" } });
    const inv = revertEvents(main.events, [c.id, d.id, a.id, rn.id, rm.id, ev.id], fold(main.events));
    expect(inv.map((e) => e.op)).toEqual([
      { type: "schema.addField", entityType: "contact", field: "email", fieldType: "string" },
      { type: "schema.renameField", entityType: "contact", from: "jobTitle", to: "title" },
      { type: "schema.removeField", entityType: "deal", field: "procurementContact" },
      { type: "entity.create", entity: "company:northwind", entityType: "company", attrs: { name: "Northwind Freight", employees: 180 } },
      { type: "entity.delete", entity: "contact:sam-lee" },
    ]);
    appendAll(main, inv);
    const s = fold(main.events);
    expect(s.entities["contact:sam-lee"]!.deleted).toBe(true);
    expect(s.entities["company:northwind"]!.deleted).toBeFalsy();
    expect(s.schema["contact"]!.map((d) => d.field).sort()).toEqual(["email", "name", "title"]);
    expect(s.schema["deal"]).toEqual([]);
    expect(s.entities["contact:priya-acme"]!.attrs.title).toBe("Engineering Manager");
  });
});

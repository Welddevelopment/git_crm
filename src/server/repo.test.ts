import { describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memory";
import { Repo, RepoError } from "./repo";
import type { Actor, EvidenceDoc, NewEvent, Notifier, PullRequest } from "../core/types";

const SEED: Actor = { kind: "system", id: "seed" };
const JOEL: Actor = { kind: "human", id: "joel", name: "Joel" };
const DAY = 86_400_000;
const T0 = Date.now() - 10 * DAY;

function seedEvents(t0: number): NewEvent[] {
  const ev = (op: NewEvent["op"], dt: number): NewEvent => ({ actor: SEED, op, ts: t0 + dt });
  return [
    ev({ type: "schema.addField", entityType: "company", field: "name", fieldType: "string" }, 0),
    ev({ type: "schema.addField", entityType: "company", field: "employees", fieldType: "number" }, 0),
    ev({ type: "schema.addField", entityType: "contact", field: "name", fieldType: "string" }, 0),
    ev({ type: "schema.addField", entityType: "contact", field: "title", fieldType: "string" }, 0),
    ev({ type: "schema.addField", entityType: "deal", field: "amount", fieldType: "number" }, 0),
    ev({ type: "schema.addField", entityType: "deal", field: "stage", fieldType: "enum" }, 0),
    ev({ type: "entity.create", entity: "company:acme", entityType: "company", attrs: { name: "Acme Robotics", employees: 100 } }, 1),
    ev({ type: "entity.create", entity: "company:northwind", entityType: "company", attrs: { name: "Northwind Freight", employees: 180 } }, 2),
    ev({ type: "entity.create", entity: "deal:acme-platform", entityType: "deal", attrs: { name: "Acme — Platform", company: "company:acme", amount: 20000, stage: "discovery" } }, 3),
    ev({ type: "entity.create", entity: "contact:alex-chen-kestrel", entityType: "contact", attrs: { name: "Alex Chen", title: "CISO" } }, 4),
    ev({ type: "entity.create", entity: "contact:alex-chen-lumen", entityType: "contact", attrs: { name: "Alex Chen", title: "Founder & CEO", phone: "555-0100" } }, 5),
  ];
}

const setField = (entity: string, field: string, value: number | string, reason = "agent saw it"): NewEvent =>
  ({ actor: { kind: "agent", id: "x" }, op: { type: "field.set", entity, field, value }, reason });

async function makeRepo(notifiers: Notifier[] = []) {
  const store = new MemoryStore();
  const repo = new Repo({ store, notifiers });
  await repo.commitToMain(seedEvents(T0));
  return { store, repo };
}

describe("Repo end-to-end", () => {
  it("reads main state, time travel and timeline", async () => {
    const { repo } = await makeRepo();
    const s = await repo.state();
    expect(s.entities["company:acme"]?.attrs.employees).toBe(100);
    const early = await repo.state({ at: T0 + 2 });
    expect(early.entities["company:acme"]).toBeDefined();
    expect(early.entities["deal:acme-platform"]).toBeUndefined();
    const tl = await repo.timeline();
    expect(tl.length).toBe(11);
    expect(tl[0]!.seq).toBe(1);
  });

  it("propose → analyze → merge → state + blame", async () => {
    const { repo } = await makeRepo();
    const pr = await repo.propose("webwatch", {
      title: "Northwind headcount", description: "careers page",
      events: [setField("company:northwind", "employees", 220)],
      readSet: { "company:northwind::employees": 8 },
    });
    expect(pr.status).toBe("open");
    expect(pr.branch).toBe("agent/webwatch/1");
    expect(pr.author).toEqual({ kind: "agent", id: "webwatch" });
    expect(pr.policy).toBeDefined();
    expect(pr.staleness?.status).toBe("fresh");
    expect(pr.changes?.some((c) => c.kind === "field.changed" && c.field === "employees")).toBe(true);

    // branch state differs from main
    expect((await repo.state({ branch: pr.branch })).entities["company:northwind"]?.attrs.employees).toBe(220);
    expect((await repo.state()).entities["company:northwind"]?.attrs.employees).toBe(180);

    const { pr: merged, events } = await repo.merge(pr.id, JOEL);
    expect(merged.status).toBe("merged");
    expect(merged.mergedBy).toEqual(JOEL);
    expect(merged.mergeEvents).toEqual(events.map((e) => e.id));
    expect((await repo.state()).entities["company:northwind"]?.attrs.employees).toBe(220);

    const history = await repo.blame("company:northwind", "employees");
    expect(history.length).toBe(2);
    const tl = await repo.timeline();
    expect(tl[tl.length - 1]!.pr).toBe(pr.id);

    await expect(repo.merge(pr.id, JOEL)).rejects.toMatchObject({ status: 409 });
  });

  it("refuses to merge a field conflict until resolved; other PRs refresh after a merge", async () => {
    const { repo } = await makeRepo();
    const a = await repo.propose("inbox", { title: "Northwind 250", description: "", events: [setField("company:northwind", "employees", 250)] });
    const b = await repo.propose("webwatch", { title: "Northwind 220", description: "", events: [setField("company:northwind", "employees", 220)] });
    await repo.merge(a.id, JOEL);

    const bNow = (await repo.listPRs("open")).find((p) => p.id === b.id)!;
    const fieldConflict = bNow.conflicts?.find((c) => c.kind === "field");
    expect(fieldConflict).toBeDefined();

    const err = await repo.merge(b.id, JOEL).catch((e) => e);
    expect(err).toBeInstanceOf(RepoError);
    expect(err.status).toBe(409);
    expect((await repo.state()).entities["company:northwind"]?.attrs.employees).toBe(250);

    const res = await repo.merge(b.id, JOEL, { [fieldConflict!.id]: "theirs" });
    expect(res.pr.status).toBe("merged");
    expect((await repo.state()).entities["company:northwind"]?.attrs.employees).toBe(220);
  });

  it("refuses block-tier PRs and unknown/closed PRs", async () => {
    const { repo } = await makeRepo();
    const del = await repo.propose("hygiene", {
      title: "Delete Acme", description: "",
      events: [{ actor: { kind: "agent", id: "hygiene" }, op: { type: "entity.delete", entity: "company:acme" } }],
    });
    expect(del.policy?.tier).toBe("block");
    await expect(repo.merge(del.id, JOEL)).rejects.toMatchObject({ status: 409 });
    await expect(repo.merge("pr_999", JOEL)).rejects.toMatchObject({ status: 404 });
    const closed = await repo.close(del.id, JOEL, "nope");
    expect(closed.status).toBe("closed");
    await expect(repo.merge(del.id, JOEL)).rejects.toMatchObject({ status: 409 });
  });

  it("reverts a bad dedup with a merged revert PR", async () => {
    const { repo } = await makeRepo();
    const pr = await repo.propose("hygiene", {
      title: "Merge Alex Chen duplicates", description: "exact name match",
      events: [{ actor: { kind: "agent", id: "hygiene" }, op: { type: "entity.merge", from: "contact:alex-chen-lumen", into: "contact:alex-chen-kestrel" } }],
    });
    await repo.merge(pr.id, JOEL);
    let s = await repo.state();
    expect(s.aliases["contact:alex-chen-lumen"]).toBe("contact:alex-chen-kestrel");
    expect(s.entities["contact:alex-chen-kestrel"]?.attrs.phone).toBe("555-0100");

    const { revertPr, events } = await repo.revert(pr.id, JOEL);
    expect(revertPr.title).toBe('Revert "Merge Alex Chen duplicates"');
    expect(revertPr.status).toBe("merged");
    expect(revertPr.author).toEqual({ kind: "system", id: "revert" });
    expect(events.length).toBeGreaterThan(0);
    const original = (await repo.listPRs()).find((p) => p.id === pr.id)!;
    expect(original.status).toBe("reverted");
    expect(original.revertedBy).toBe(revertPr.id);

    s = await repo.state();
    expect(s.aliases["contact:alex-chen-lumen"]).toBeUndefined();
    expect(s.entities["contact:alex-chen-lumen"]?.mergedInto).toBeUndefined();
    expect(s.entities["contact:alex-chen-lumen"]?.attrs.title).toBe("Founder & CEO");
    expect(s.entities["contact:alex-chen-kestrel"]?.attrs.phone ?? null).toBeNull();
    // history is preserved: nothing deleted from main
    expect((await repo.mainEvents()).length).toBeGreaterThan(12);
    await expect(repo.revert(pr.id, JOEL)).rejects.toMatchObject({ status: 409 });
  });

  it("holds large amount changes for review, notifies, and goes stale on contradicting evidence", async () => {
    const notified: PullRequest[] = [];
    const { repo } = await makeRepo([{ id: "test", notify: async (pr) => { notified.push(pr); } }]);
    const pr = await repo.propose("inbox", {
      title: "Acme → negotiation, $45k", description: "Priya asked for the MSA",
      events: [
        { ...setField("deal:acme-platform", "stage", "negotiation", "Priya asked for the MSA"), evidence: [{ docId: "email_1", claim: "Acme asked for an MSA → negotiation" }] },
        { ...setField("deal:acme-platform", "amount", 45000, "45 seats, $45,000"), evidence: [{ docId: "email_1", claim: "45 seats at $45,000" }] },
      ],
    });
    expect(pr.policy?.tier).toBe("review");
    await new Promise((r) => setTimeout(r, 0));
    expect(notified.map((p) => p.id)).toEqual([pr.id]);

    // auto-merge leaves review PRs alone
    expect(await repo.autoMerge()).toEqual([]);

    const pausing: EvidenceDoc = {
      id: "email_pause", kind: "email", ts: Date.now(), title: "Pausing the rollout",
      body: "Hi Joel, we're pausing the platform rollout until Q1 — budget freeze.",
      entities: ["company:acme", "deal:acme-platform"],
    };
    await repo.addDocs([pausing], true);
    const after = (await repo.listPRs("open")).find((p) => p.id === pr.id)!;
    expect(after.staleness?.status).toBe("stale");
    expect(after.staleness?.contradictions[0]?.docId).toBe("email_pause");

    const detail = await repo.prDetail(pr.id);
    expect(detail.events.length).toBe(2);
    expect(detail.docs.map((d) => d.id)).toContain("email_pause");
    expect(detail.baseState.entities["deal:acme-platform"]?.attrs.amount).toBe(20000);
  });

  it("auto-merges auto-tier PRs and skips stale ones", async () => {
    const { repo } = await makeRepo();
    const pr = await repo.propose("webwatch", { title: "Acme headcount", description: "", events: [setField("company:acme", "employees", 120)] });
    expect(pr.policy?.tier).toBe("auto");
    const merged = await repo.autoMerge();
    expect(merged.map((p) => p.id)).toEqual([pr.id]);
    expect(merged[0]!.mergedBy).toEqual({ kind: "system", id: "merge" });
    expect((await repo.state()).entities["company:acme"]?.attrs.employees).toBe(120);
  });

  it("trust + rules", async () => {
    const { repo } = await makeRepo();
    expect((await repo.rules()).length).toBeGreaterThan(0);
    await repo.setRules([]);
    expect(await repo.rules()).toEqual([]);
    const t = await repo.trust("inbox");
    expect(t.agent).toBe("inbox");
    expect(t.prsOpened).toBe(0);
  });
});

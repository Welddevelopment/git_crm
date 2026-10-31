import { describe, expect, it, vi } from "vitest";
import type { NewEvent, PullRequest } from "../core/types";
import { MemoryStore } from "./memory";

const actor = { kind: "agent", id: "inbox" } as const;
const ev = (field: string, value: number, ts?: number): NewEvent => ({
  actor,
  op: { type: "field.set", entity: "deal:acme", field, value },
  reason: "test",
  ...(ts !== undefined ? { ts } : {}),
});
const prInput = (title: string, createdAt: number): Omit<PullRequest, "id"> => ({
  title,
  description: "",
  branch: "agent/inbox/1",
  author: actor,
  status: "open",
  createdAt,
  updatedAt: createdAt,
});

describe("MemoryStore", () => {
  it("assigns contiguous per-branch seqs, ids, ts", async () => {
    const s = new MemoryStore();
    const a = await s.append("main", [ev("amount", 1, 100), ev("amount", 2)]);
    const b = await s.append("main", [ev("amount", 3)]);
    const c = await s.append("agent/x", [ev("amount", 4)]);
    expect([...a, ...b].map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(c[0]!.seq).toBe(1);
    expect(a[0]!.ts).toBe(100);
    expect(typeof a[1]!.ts).toBe("number");
    expect(a[0]!.branch).toBe("main");
    const ids = new Set([...a, ...b, ...c].map((e) => e.id));
    expect(ids.size).toBe(4);
    for (const id of ids) expect(id.startsWith("evt_")).toBe(true);
    expect((await s.getEvent(b[0]!.id))?.seq).toBe(3);
    expect(await s.append("main", [])).toEqual([]);
  });

  it("filters events by seq range", async () => {
    const s = new MemoryStore();
    await s.append("main", [1, 2, 3, 4, 5].map((n) => ev("amount", n)));
    expect((await s.events("main")).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect((await s.events("main", { fromSeq: 2, toSeq: 4 })).map((e) => e.seq)).toEqual([2, 3, 4]);
    expect((await s.events("main", { toSeq: 0 })).length).toBe(0);
    expect((await s.events("main", { fromSeq: 5 })).map((e) => e.seq)).toEqual([5]);
    expect(await s.events("nope")).toEqual([]);
  });

  it("tracks branch headSeq", async () => {
    const s = new MemoryStore();
    const b = await s.createBranch({ name: "agent/x", parent: "main", forkSeq: 0, createdBy: actor, createdAt: 1 });
    expect(b.headSeq).toBe(0);
    await s.append("agent/x", [ev("amount", 1), ev("amount", 2)]);
    expect((await s.getBranch("agent/x"))?.headSeq).toBe(2);
    const u = await s.updateBranch("agent/x", { readSet: { "deal:acme::amount": 3 } });
    expect(u.readSet).toEqual({ "deal:acme::amount": 3 });
    expect(u.headSeq).toBe(2);
    expect((await s.listBranches()).length).toBe(1);
    // main without a record is fine
    await s.append("main", [ev("amount", 9)]);
    expect(await s.getBranch("main")).toBeUndefined();
  });

  it("assigns PR ids pr_1.. and lists newest first with filter", async () => {
    const s = new MemoryStore();
    const p1 = await s.createPR(prInput("a", 10));
    const p2 = await s.createPR(prInput("b", 20));
    const p3 = await s.createPR(prInput("c", 20));
    expect([p1.id, p2.id, p3.id]).toEqual(["pr_1", "pr_2", "pr_3"]);
    expect((await s.listPRs()).map((p) => p.id)).toEqual(["pr_3", "pr_2", "pr_1"]);
    await s.updatePR("pr_2", { status: "merged" });
    expect((await s.listPRs({ status: "open" })).map((p) => p.id)).toEqual(["pr_3", "pr_1"]);
    expect((await s.getPR("pr_2"))?.status).toBe("merged");
  });

  it("returns copies, not internal references", async () => {
    const s = new MemoryStore();
    const [e] = await s.append("main", [ev("amount", 1)]);
    (e!.op as { value: number }).value = 999;
    const got = (await s.events("main"))[0]!;
    expect((got.op as { value: number }).value).toBe(1);
    const pr = await s.createPR(prInput("a", 1));
    pr.title = "mutated";
    expect((await s.getPR(pr.id))?.title).toBe("a");
  });

  it("notifies subscribers on every mutation and supports unsubscribe", async () => {
    const s = new MemoryStore();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    await s.append("main", [ev("amount", 1)]);
    await s.createBranch({ name: "b", parent: "main", forkSeq: 1, createdBy: actor, createdAt: 1 });
    await s.updateBranch("b", { forkSeq: 1 });
    await s.createPR(prInput("a", 1));
    await s.updatePR("pr_1", { title: "x" });
    await s.putDocs([{ id: "d1", kind: "email", ts: 1, title: "t", body: "b" }]);
    expect(fn.mock.calls.map((c) => c[0])).toEqual([
      { kind: "events", key: "main" },
      { kind: "branch", key: "b" },
      { kind: "branch", key: "b" },
      { kind: "pr", key: "pr_1" },
      { kind: "pr", key: "pr_1" },
      { kind: "docs" },
    ]);
    off();
    await s.append("main", [ev("amount", 2)]);
    expect(fn).toHaveBeenCalledTimes(6);
  });

  it("filters docs by kind and sinceTs", async () => {
    const s = new MemoryStore();
    await s.putDocs([
      { id: "e1", kind: "email", ts: 5, title: "t", body: "" },
      { id: "w1", kind: "web", ts: 10, title: "t", body: "" },
      { id: "e2", kind: "email", ts: 20, title: "t", body: "" },
    ]);
    expect((await s.listDocs({ kind: "email" })).map((d) => d.id)).toEqual(["e1", "e2"]);
    expect((await s.listDocs({ sinceTs: 10 })).map((d) => d.id)).toEqual(["w1", "e2"]);
  });

  it("reset wipes everything, restarts counters, notifies", async () => {
    const s = new MemoryStore();
    await s.append("main", [ev("amount", 1)]);
    await s.createPR(prInput("a", 1));
    await s.putDocs([{ id: "d1", kind: "email", ts: 1, title: "t", body: "b" }]);
    const fn = vi.fn();
    s.subscribe(fn);
    await s.reset();
    expect(fn).toHaveBeenCalled();
    expect(await s.events("main")).toEqual([]);
    expect(await s.listPRs()).toEqual([]);
    expect(await s.listDocs()).toEqual([]);
    expect((await s.createPR(prInput("b", 2))).id).toBe("pr_1");
    expect((await s.append("main", [ev("amount", 1)]))[0]!.seq).toBe(1);
  });

  it("round-trips through JSON", async () => {
    const s = new MemoryStore();
    const [e1] = await s.append("main", [ev("amount", 1)]);
    await s.createBranch({ name: "b", parent: "main", forkSeq: 1, createdBy: actor, createdAt: 1 });
    await s.append("b", [ev("stage", 2)]);
    await s.createPR(prInput("a", 1));
    await s.putDocs([{ id: "d1", kind: "email", ts: 1, title: "t", body: "b" }]);
    const json = JSON.parse(JSON.stringify(s));
    const r = MemoryStore.fromJSON(json);
    expect(await r.events("main")).toEqual(await s.events("main"));
    expect(await r.events("b")).toEqual(await s.events("b"));
    expect(await r.getBranch("b")).toEqual(await s.getBranch("b"));
    expect(await r.listPRs()).toEqual(await s.listPRs());
    expect(await r.listDocs()).toEqual(await s.listDocs());
    expect((await r.getEvent(e1!.id))?.seq).toBe(1);
    // counters continue
    expect((await r.createPR(prInput("z", 5))).id).toBe("pr_2");
    const [next] = await r.append("main", [ev("amount", 2)]);
    expect(next!.seq).toBe(2);
    expect(next!.id).not.toBe(e1!.id);
  });
});

import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/store/memory";
import { Repo, seedRepo } from "@/server/repo";
import { AGENTS } from "@/agents";
import { runChaos, runGoverned } from "@/agents/runtime";
import { fold, stateAt } from "./state";
import type { CRMState } from "../types";

const HUMAN = { kind: "human", id: "joel", name: "Joel" } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Live entities with attrs, nulls dropped, for comparison. */
function snapshot(s: CRMState) {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, r] of Object.entries(s.entities)) {
    if (r.deleted || r.mergedInto) continue;
    out[id] = Object.fromEntries(Object.entries(r.attrs).filter(([, v]) => v !== null && v !== undefined));
  }
  return out;
}

describe("restore to a point in time", () => {
  it("undoes chaos-mode direct writes, and the restore itself can be reverted", async () => {
    const repo = new Repo({ store: new MemoryStore() });
    await seedRepo(repo);
    await sleep(5);
    const t = Date.now();
    await sleep(5);
    await runChaos(repo, AGENTS, { staggerMs: 0 });
    const afterChaos = snapshot(fold(await repo.mainEvents()));
    const before = snapshot(stateAt(await repo.mainEvents(), t));
    expect(afterChaos).not.toEqual(before);

    const { pr } = await repo.restore(t, HUMAN);
    expect(pr.status).toBe("merged");
    expect(snapshot(fold(await repo.mainEvents()))).toEqual(before);

    await repo.revert(pr.id, HUMAN);
    expect(snapshot(fold(await repo.mainEvents()))).toEqual(afterChaos);
  });

  it("rolls back merged agent PRs too, including a dedup merge", async () => {
    const repo = new Repo({ store: new MemoryStore() });
    await seedRepo(repo);
    await sleep(5);
    const t = Date.now();
    await sleep(5);
    await runGoverned(repo, AGENTS, { staggerMs: 0 });
    const dedup = (await repo.listPRs()).find((p) => p.status === "open" && p.title.startsWith("Merge duplicate contact"));
    expect(dedup).toBeTruthy();
    await repo.merge(dedup!.id, HUMAN);
    const before = snapshot(stateAt(await repo.mainEvents(), t));
    await repo.restore(t, HUMAN);
    expect(snapshot(fold(await repo.mainEvents()))).toEqual(before);
  });

  it("refuses when nothing changed", async () => {
    const repo = new Repo({ store: new MemoryStore() });
    await seedRepo(repo);
    await expect(repo.restore(Date.now() + 1000, HUMAN)).rejects.toThrow(/already matches/);
  });
});

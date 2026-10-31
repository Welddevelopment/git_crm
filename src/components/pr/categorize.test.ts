import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/store/memory";
import { Repo, seedRepo } from "@/server/repo";
import { AGENTS } from "@/agents";
import { runGoverned } from "@/agents/runtime";
import type { PullRequest } from "@/core/types";
import { bulkSafe, categorize, groupPRs, needsYou } from "./categorize";

const pr = (over: Partial<PullRequest>): PullRequest => ({
  id: "pr_1", title: "t", description: "", branch: "agent/x", author: { kind: "agent", id: "inbox" },
  status: "open", createdAt: 1, updatedAt: 1, changes: [], conflicts: [], ...over,
});

describe("categorize", () => {
  it("routes by what changed", () => {
    expect(categorize(pr({ changes: [{ kind: "schema.changed", entityType: "deal", description: "add x" }] }))).toBe("schema");
    expect(categorize(pr({ changes: [{ kind: "entity.merged", from: "contact:a", into: "contact:b" }] }))).toBe("identity");
    expect(categorize(pr({ changes: [{ kind: "field.changed", entity: "deal:acme", field: "amount", before: 1, after: 2 }] }))).toBe("pipeline");
    expect(categorize(pr({ changes: [{ kind: "field.changed", entity: "deal:acme", field: "nextStep", before: "a", after: "b" }] }))).toBe("deals");
    expect(categorize(pr({ changes: [{ kind: "field.changed", entity: "contact:a", field: "title", before: "a", after: "b" }] }))).toBe("cleanup");
    expect(categorize(pr({ changes: [{ kind: "field.changed", entity: "company:n", field: "employees", before: 1, after: 2 }] }))).toBe("enrichment");
  });

  it("only bulk-approves fresh, conflict-free, unblocked PRs", () => {
    const ok = pr({ policy: { tier: "review", reasons: [], perEvent: {} } });
    expect(bulkSafe(ok)).toBe(true);
    expect(needsYou(ok)).toBe(true);
    expect(bulkSafe({ ...ok, policy: { tier: "block", reasons: [], perEvent: {} } })).toBe(false);
    expect(bulkSafe({ ...ok, staleness: { status: "stale", checkedAt: 1, changedReads: [], contradictions: [] } })).toBe(false);
    expect(bulkSafe({ ...ok, conflicts: [{ id: "c", kind: "field" } as never] })).toBe(false);
    expect(bulkSafe({ ...ok, status: "merged" })).toBe(false);
    expect(bulkSafe({ ...ok, changes: [{ kind: "entity.merged", from: "contact:a", into: "contact:b" }] })).toBe(false);
    expect(bulkSafe({ ...ok, changes: [{ kind: "schema.changed", entityType: "deal", description: "x" }] })).toBe(false);
  });

  it("puts every PR from the real fleet into exactly one group", async () => {
    const repo = new Repo({ store: new MemoryStore() });
    await seedRepo(repo);
    await runGoverned(repo, AGENTS, { staggerMs: 0 });
    const prs = await repo.listPRs();
    const groups = groupPRs(prs, "category");
    expect(groups.reduce((n, g) => n + g.prs.length, 0)).toBe(prs.length);
  });
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** OWNER: graph worker. GET /api/graph -> GraphData (main collapsed into commits + one branch per PR). */
import { getRepo } from "@/server/repo";
import { handle, json } from "@/server/http";
import type { Actor, Event, PullRequest } from "@/core/types";
import type { TimelineEntry } from "@/core/api-contract";
import type { GraphBranch, GraphData, GraphMainNode, MainNodeKind } from "@/components/graph/types";

const MAX_NODES = 60;

const actorName = (a: Actor) => (a.kind !== "system" && a.name ? a.name : a.id);
const isRevertPR = (p: PullRequest | undefined) => !!p && (p.branch.startsWith("revert/") || (p.author.kind === "system" && p.author.id === "revert"));

function opSummary(e: Event): string {
  const op = e.op;
  switch (op.type) {
    case "field.set": return `${op.entity.split(":").pop()}.${op.field}`;
    case "entity.create": return `+${op.entity}`;
    case "entity.delete": return `−${op.entity}`;
    case "entity.merge": return `${op.from} → ${op.into}`;
    case "schema.addField": return `schema +${op.entityType}.${op.field}`;
    case "schema.renameField": return `schema ${op.entityType}.${op.from}→${op.to}`;
    case "schema.removeField": return `schema −${op.entityType}.${op.field}`;
    case "evidence.attach": return `evidence: ${op.doc.title}`;
  }
}

export const GET = handle(async () => {
  const repo = await getRepo();
  const [timeline, prs, branches] = await Promise.all([repo.timeline(), repo.listPRs(), repo.deps.store.listBranches()]);
  const prById = new Map(prs.map((p) => [p.id, p]));
  const branchByName = new Map(branches.map((b) => [b.name, b]));

  // ---- collapse main into commits ----
  const groups: TimelineEntry[][] = [];
  let lastKey = "";
  for (const t of timeline) {
    const a = t.event.actor;
    const key = t.pr
      ? `pr:${t.pr}`
      : a.kind === "system" && a.id === "seed"
        ? `seed:${new Date(t.ts).toDateString()}`
        : `${a.kind}:${a.id}:${Math.floor(t.ts / 1000)}`;
    if (key === lastKey && groups.length) groups[groups.length - 1]!.push(t);
    else groups.push([t]);
    lastKey = key;
  }
  const allNodes: GraphMainNode[] = groups.map((g) => {
    const first = g[0]!;
    const last = g[g.length - 1]!;
    const a = first.event.actor;
    const pr = first.pr ? prById.get(first.pr) : undefined;
    let kind: MainNodeKind;
    if (a.kind === "system" && a.id === "revert") kind = "revert";
    else if (first.pr && isRevertPR(pr)) kind = "revert";
    else if (first.pr) kind = "merge";
    else if (a.kind === "system") kind = a.id === "seed" ? "seed" : "system";
    else if (a.kind === "agent") kind = "direct";
    else kind = "human";
    let label: string;
    if (kind === "seed") label = `Seed: ${g.length} events`;
    else if (pr) label = kind === "revert" ? pr.title : `Merge #${pr.id.replace(/^pr_/, "")}: ${pr.title}`;
    else label = `${actorName(a)}: ${opSummary(first.event)}${g.length > 1 ? ` (+${g.length - 1})` : ""}`;
    const node: GraphMainNode = {
      seq: last.seq, firstSeq: first.seq, ts: last.ts, actorKind: a.kind, actorId: a.id, label, count: g.length, kind,
    };
    if (a.kind !== "system" && a.name) node.actorName = a.name;
    if (first.pr) node.pr = first.pr;
    return node;
  });
  const main = allNodes.slice(-MAX_NODES);

  // ---- branches (one per PR, excluding revert PRs which are drawn on main) ----
  const firstMergeSeq = new Map<string, number>();
  for (const t of timeline) if (t.pr && !firstMergeSeq.has(t.pr)) firstMergeSeq.set(t.pr, t.seq);
  const tsOfSeq = (seq: number) => timeline.find((t) => t.seq === seq)?.ts ?? timeline[0]?.ts ?? 0;

  const out: GraphBranch[] = [];
  for (const p of prs) {
    if (isRevertPR(p)) continue;
    const b = branchByName.get(p.branch);
    const forkSeq = b?.forkSeq ?? 0;
    const unresolved = (p.conflicts ?? []).filter((c) => !c.autoResolved && c.resolution === undefined).length;
    const g: GraphBranch = {
      name: p.branch, pr: p.id, title: p.title, author: p.author.id, authorKind: p.author.kind,
      forkSeq, forkTs: tsOfSeq(forkSeq), status: p.status, createdAt: p.createdAt, updatedAt: p.updatedAt,
      reasons: p.policy?.reasons.length ?? 0,
      stale: p.staleness?.status === "stale",
      versionConflict: p.staleness?.status === "version-conflict",
      conflicts: unresolved,
      events: b?.headSeq ?? 0,
    };
    if (p.policy) g.tier = p.policy.tier;
    if (p.mergedAt) g.mergedAt = p.mergedAt;
    if (p.mergedBy) g.mergedBy = actorName(p.mergedBy);
    const ms = firstMergeSeq.get(p.id);
    if (ms !== undefined) g.mergeSeq = ms;
    if (p.revertedBy) {
      g.revertedBy = p.revertedBy;
      const rs = firstMergeSeq.get(p.revertedBy);
      if (rs !== undefined) g.revertSeq = rs;
    }
    out.push(g);
  }
  out.sort((a, b) => a.createdAt - b.createdAt || a.pr.localeCompare(b.pr, undefined, { numeric: true }));

  const data: GraphData = { main, branches: out, headSeq: timeline[timeline.length - 1]?.seq ?? 0, now: Date.now() };
  return json(data);
});

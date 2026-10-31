/** OWNER: W6. Fleet status + run orchestration for /api/fleet and /api/fleet/run. */
import type { FleetStatus } from "../core/api-contract";
import type { AgentId, CRMAgent, PullRequest } from "../core/types";
import { AGENTS } from "../agents";
import { isRunning, runChaos, runGoverned } from "../agents/runtime";
import type { Repo } from "./repo";

type G = typeof globalThis & { __mainlineLastRun?: Map<AgentId, number> };
const g = globalThis as G;
const lastRun: Map<AgentId, number> = (g.__mainlineLastRun ??= new Map());

export async function fleetStatus(repo: Repo): Promise<FleetStatus> {
  const agents = await Promise.all(AGENTS.map(async (a) => {
    const entry: FleetStatus["agents"][number] = {
      id: a.id, name: a.name, description: a.description, running: isRunning(a.id), trust: await repo.trust(a.id),
    };
    const at = lastRun.get(a.id);
    if (at !== undefined) entry.lastRunAt = at;
    return entry;
  }));
  return { agents };
}

export async function runFleet(
  repo: Repo, ids: AgentId[] | undefined, mode: "governed" | "chaos",
): Promise<{ prs: PullRequest[]; directEvents: number }> {
  const selected: CRMAgent[] = ids?.length ? AGENTS.filter((a) => ids.includes(a.id)) : AGENTS;
  const unknown = (ids ?? []).filter((id) => !AGENTS.some((a) => a.id === id));
  if (unknown.length) throw Object.assign(new Error(`unknown agent(s): ${unknown.join(", ")}`), { status: 400 });
  const busy = selected.filter((a) => isRunning(a.id)).map((a) => a.id);
  if (busy.length) throw Object.assign(new Error(`already running: ${busy.join(", ")}`), { status: 409 });
  const now = Date.now();
  for (const a of selected) lastRun.set(a.id, now);
  if (mode === "chaos") return { prs: [], directEvents: await runChaos(repo, selected) };
  const opened = await runGoverned(repo, selected);
  // return the latest stored version (autoMerge may have merged some)
  const fresh = await Promise.all(opened.map(async (p) => (await repo.deps.store.getPR(p.id)) ?? p));
  return { prs: fresh, directEvents: 0 };
}

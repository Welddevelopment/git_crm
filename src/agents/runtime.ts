/** OWNER: W7 (agent runtime + fleet orchestration). */
import type { AgentContext, AgentId, AgentProposal, CRMAgent, CRMState, NewEvent, PullRequest } from "../core/types";
import type { Repo } from "../server/repo";
import { makeLLM } from "./llm";

export { makeLLM, extractJSON } from "./llm";

/** Same key format as engine/state.ts `vkey` (kept local so the runtime never depends on engine internals). */
const vkey = (entity: string, field: string) => `${entity}::${field}`;

/** Delay between consecutive proposals/commits so PRs and events stream into the UI visibly. */
export interface RunOptions {
  staggerMs?: number;
}
const DEFAULT_GOVERNED_STAGGER = 150;
const DEFAULT_CHAOS_STAGGER = 60;

// ---------- running state (survives Next.js module reloads) ----------
const g = globalThis as typeof globalThis & { __mainlineRunning?: Set<string> };
const running: Set<string> = (g.__mainlineRunning ??= new Set<string>());

export function isRunning(agent: AgentId): boolean {
  return running.has(agent);
}
/** All agent ids currently running (for the fleet panel). */
export function runningAgents(): AgentId[] {
  return [...running];
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/** readSet for a proposal = main version of every field it sets, as seen when the agent started. */
export function computeReadSet(proposal: AgentProposal, state: CRMState): Record<string, number> {
  const rs: Record<string, number> = {};
  for (const e of proposal.events) {
    if (e.op.type !== "field.set") continue;
    const k = vkey(e.op.entity, e.op.field);
    rs[k] = state.versions?.[k] ?? 0;
  }
  return rs;
}

/** Build a context from main, run one agent, never throw. Tracks running state. */
async function runAgent(
  repo: Repo,
  agent: CRMAgent,
  llm: AgentContext["llm"],
): Promise<{ state: CRMState | null; proposals: AgentProposal[] }> {
  running.add(agent.id);
  const log = (msg: string) => console.log(`[agent:${agent.id}] ${msg}`);
  try {
    const state = await repo.state();
    const docs = await repo.deps.store.listDocs();
    const ctx: AgentContext = { agent: agent.id, state, docs, llm, now: Date.now, log };
    let proposals: AgentProposal[] = [];
    try {
      proposals = (await agent.run(ctx)) ?? [];
    } catch (err) {
      log(`run failed: ${errMsg(err)}`);
      proposals = [];
    }
    log(`${proposals.length} proposal(s)`);
    return { state, proposals };
  } catch (err) {
    log(`setup failed: ${errMsg(err)}`);
    return { state: null, proposals: [] };
  }
}

/** Governed: agent reads main, each proposal => branch + PR via repo.propose. Then repo.autoMerge(). */
export async function runGoverned(repo: Repo, agents: CRMAgent[], opts: RunOptions = {}): Promise<PullRequest[]> {
  const stagger = opts.staggerMs ?? DEFAULT_GOVERNED_STAGGER;
  const llm = makeLLM();
  const opened: PullRequest[] = [];

  await Promise.all(
    agents.map(async (agent) => {
      try {
        const { state, proposals } = await runAgent(repo, agent, llm);
        for (let i = 0; i < proposals.length; i++) {
          const p = proposals[i];
          if (!p || !Array.isArray(p.events) || p.events.length === 0) continue;
          if (i > 0) await sleep(stagger);
          const readSet = p.readSet ?? (state ? computeReadSet(p, state) : {});
          try {
            const pr = await repo.propose(agent.id, { ...p, readSet });
            opened.push(pr);
          } catch (err) {
            console.log(`[agent:${agent.id}] propose "${p.title}" failed: ${errMsg(err)}`);
          }
        }
      } finally {
        running.delete(agent.id);
      }
    }),
  );

  try {
    await repo.autoMerge();
  } catch (err) {
    console.log(`[runtime] autoMerge failed: ${errMsg(err)}`);
  }
  return opened;
}

/** Chaos ("before" demo): same agents, but proposals are committed straight to main, last-write-wins. Returns #events written. */
export async function runChaos(repo: Repo, agents: CRMAgent[], opts: RunOptions = {}): Promise<number> {
  const stagger = opts.staggerMs ?? DEFAULT_CHAOS_STAGGER;
  const llm = makeLLM();

  const perAgent = await Promise.all(
    agents.map(async (agent) => {
      try {
        const { proposals } = await runAgent(repo, agent, llm);
        return proposals.flatMap((p) => (p && Array.isArray(p.events) ? p.events : []));
      } finally {
        running.delete(agent.id);
      }
    }),
  );

  // Round-robin interleave across agents: nobody coordinates, so writes land in arbitrary order.
  const queue: NewEvent[] = [];
  const longest = Math.max(0, ...perAgent.map((evs) => evs.length));
  for (let i = 0; i < longest; i++) for (const evs of perAgent) if (i < evs.length) queue.push(evs[i]);

  let written = 0;
  for (let i = 0; i < queue.length; i++) {
    if (i > 0) await sleep(stagger);
    try {
      const res = await repo.commitToMain([queue[i]]);
      written += res?.length ?? 1;
    } catch (err) {
      console.log(`[runtime] chaos commit failed (${queue[i].op.type}): ${errMsg(err)}`);
    }
  }
  return written;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

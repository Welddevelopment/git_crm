/** OWNER: W7 (agent runtime + fleet orchestration). */
import type { AgentContext, AgentId, CRMAgent, PullRequest } from "../core/types";
import type { Repo } from "../server/repo";
const TODO = (n: string): never => { throw new Error(`NOT_IMPLEMENTED: agents/runtime.${n} (W7)`); };

/** Claude call via @anthropic-ai/sdk; returns null when ANTHROPIC_API_KEY is missing or the call fails. Model from env MAINLINE_MODEL. */
export function makeLLM(): AgentContext["llm"] { return TODO("makeLLM"); }
/** Governed: agent reads main, each proposal => branch + PR via repo.propose. Then repo.autoMerge(). */
export async function runGoverned(repo: Repo, agents: CRMAgent[]): Promise<PullRequest[]> { return TODO("runGoverned"); }
/** Chaos ("before" demo): same agents, but proposals are committed straight to main, last-write-wins. Returns #events written. */
export async function runChaos(repo: Repo, agents: CRMAgent[]): Promise<number> { return TODO("runChaos"); }
export function isRunning(agent: AgentId): boolean { return false; }

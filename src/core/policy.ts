/** OWNER: W4 (policy + trust). */
import type { AgentId, AgentTrust, CRMState, Event, PolicyDecision, PolicyRule, PullRequest } from "./types";
const TODO = (n: string): never => { throw new Error(`NOT_IMPLEMENTED: policy.${n} (W4)`); };

export const DEFAULT_RULES: PolicyRule[] = []; // W4: fill with sensible defaults (deal amount/stage/close date need review, merges need review, enrichment auto, schema review)
export function evaluatePolicy(args: { branchEvents: Event[]; baseState: CRMState; rules: PolicyRule[]; trust?: AgentTrust }): PolicyDecision { return TODO("evaluatePolicy"); }
export function computeTrust(agent: AgentId, prs: PullRequest[]): AgentTrust { return TODO("computeTrust"); }

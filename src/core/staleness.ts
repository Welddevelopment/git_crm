/** OWNER: W3 (staleness / decision conflicts). */
import type { Branch, CRMState, Event, EvidenceDoc, PullRequest, StalenessReport } from "./types";
const TODO = (n: string): never => { throw new Error(`NOT_IMPLEMENTED: staleness.${n} (W3)`); };

/** Decides whether newer evidence invalidates a PR's reasoning. Heuristic default; LLM judge optional. */
export type Judge = (args: { prTitle: string; claims: { eventId: string; claim: string; reason?: string }[]; newDoc: EvidenceDoc }) =>
  Promise<{ contradicts: boolean; explanation: string; affectsEvents: string[] }>;

export interface StalenessInput {
  pr: PullRequest;
  branch: Branch;
  branchEvents: Event[];
  mainEvents: Event[];
  mainState: CRMState; // current main head
  judge?: Judge; // default: heuristicJudge
}
export function checkStaleness(input: StalenessInput): Promise<StalenessReport> { return TODO("checkStaleness"); }
export const heuristicJudge: Judge = async () => TODO("heuristicJudge");
export function llmJudge(llm: (a: { system: string; prompt: string; maxTokens?: number }) => Promise<string | null>): Judge { return TODO("llmJudge"); }

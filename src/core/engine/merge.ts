/** OWNER: W2 (merge + revert engine). Signatures are contract; bodies are yours. */
import type { Branch, CRMState, Change, Conflict, Event, NewEvent, PRId } from "../types";
const TODO = (n: string): never => { throw new Error(`NOT_IMPLEMENTED: engine/merge.${n} (W2)`); };

export interface MergeInput {
  mainEvents: Event[]; // full main log
  branch: Branch;
  branchEvents: Event[];
  pr: PRId;
  resolutions?: Record<string, Conflict["resolution"]>; // keyed by Conflict.id
}
export interface MergeResult {
  ok: boolean; // false if any conflict is unresolved
  conflicts: Conflict[]; // all detected (with autoResolved / resolution filled where applicable)
  /** events to append to main (already rebased: merged-away ids rewritten, origin set) */
  toAppend: NewEvent[];
  changes: Change[]; // semantic summary of what merging does to main
}
/** Three-way merge: base = main@forkSeq, ours = main head, theirs = branch head. Pure. */
export function threeWayMerge(input: MergeInput): MergeResult { return TODO("threeWayMerge"); }
/** Dry run for PR view (no resolutions). */
export function previewMerge(input: Omit<MergeInput, "resolutions">): MergeResult { return threeWayMerge(input); }
/** Inverse events that undo `eventIds` on top of current main state (keeps history; never deletes events). */
export function revertEvents(mainEvents: Event[], eventIds: string[], current: CRMState): NewEvent[] { return TODO("revertEvents"); }

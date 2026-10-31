/** OWNER: W1 (state engine). Signatures are contract; bodies are yours. */
import type { Branch, CRMState, Change, EntityId, Event, FieldProvenance } from "../types";
const TODO = (n: string): never => { throw new Error(`NOT_IMPLEMENTED: engine/state.${n} (W1)`); };

export function emptyState(): CRMState {
  return { schema: {}, entities: {}, aliases: {}, evidence: {}, provenance: {}, versions: {}, headSeq: 0 };
}
/** Pure: returns a NEW state with the event applied. Unknown entity on field.set => ignore + no throw. */
export function applyEvent(state: CRMState, e: Event): CRMState { return TODO("applyEvent"); }
/** Fold events in order onto a starting state (default empty). */
export function fold(events: Event[], start?: CRMState): CRMState { return TODO("fold"); }
/** Main state at wall-clock time `at` (events with ts <= at). */
export function stateAt(mainEvents: Event[], at: number): CRMState { return TODO("stateAt"); }
/** Branch head = fold(main[..forkSeq]) then branch events. */
export function branchState(mainEvents: Event[], branch: Branch, branchEvents: Event[]): CRMState { return TODO("branchState"); }
/** Follow alias chain to the surviving entity id. */
export function resolveId(state: CRMState, id: EntityId): EntityId { return TODO("resolveId"); }
/** Full write history of one field across the given log (oldest first). */
export function blame(events: Event[], entity: EntityId, field: string): FieldProvenance[] { return TODO("blame"); }
/** Semantic diff a → b. */
export function diffStates(a: CRMState, b: CRMState): Change[] { return TODO("diffStates"); }
/** Key helper for versions/readSet. */
export const vkey = (entity: EntityId, field: string) => `${entity}::${field}`;

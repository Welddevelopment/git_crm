/**
 * Point-in-time restore: the ops that turn `current` back into `target` (main as of an earlier moment).
 * Pure. History is never rewritten: the result is committed as ordinary events on a restore branch,
 * merged as one PR, and that PR is itself revertible.
 */
import type { CRMState, EntityRecord, FieldValue, Op } from "../types";

const live = (r?: EntityRecord) => !!r && !r.deleted && !r.mergedInto;
const same = (a: FieldValue | undefined, b: FieldValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export interface RestorePlan {
  ops: Op[];
  recreated: number;
  removed: number;
  fieldsReset: number;
  /** schema fields added since `target` (not rolled back: removing a field would destroy data) */
  schemaSkipped: string[];
}

export function restoreOps(current: CRMState, target: CRMState): RestorePlan {
  const creates: Op[] = [];
  const sets: Op[] = [];
  const tail: Op[] = [];
  const ids = [...new Set([...Object.keys(current.entities), ...Object.keys(target.entities)])].sort();
  for (const id of ids) {
    const t = target.entities[id];
    const c = current.entities[id];
    if (live(t) && !live(c)) {
      // created-then-deleted or merged away since: bring it back exactly as it was
      creates.push({ type: "entity.create", entity: id, entityType: t!.type, attrs: structuredClone(t!.attrs) });
    } else if (!live(t) && live(c)) {
      if (t?.mergedInto) tail.push({ type: "entity.merge", from: id, into: t.mergedInto });
      else tail.push({ type: "entity.delete", entity: id });
    } else if (live(t) && live(c)) {
      const fields = [...new Set([...Object.keys(t!.attrs), ...Object.keys(c!.attrs)])].sort();
      for (const f of fields) {
        if (!same(t!.attrs[f], c!.attrs[f])) sets.push({ type: "field.set", entity: id, field: f, value: t!.attrs[f] ?? null, prev: c!.attrs[f] });
      }
    }
  }
  const schemaSkipped: string[] = [];
  for (const [type, defs] of Object.entries(current.schema || {})) {
    const before = new Set((target.schema?.[type] || []).map((d) => d.field));
    for (const d of defs) if (!before.has(d.field)) schemaSkipped.push(`${type}.${d.field}`);
  }
  return {
    ops: [...creates, ...sets, ...tail],
    recreated: creates.length,
    removed: tail.length,
    fieldsReset: sets.length,
    schemaSkipped,
  };
}

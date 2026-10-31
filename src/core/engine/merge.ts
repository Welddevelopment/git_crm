/** OWNER: W2 (merge + revert engine). Signatures are contract; bodies are yours. */
import type { Branch, CRMState, Change, Conflict, EntityId, Event, FieldValue, NewEvent, Op, PRId } from "../types";
import { applyEvent, diffStates, fold, resolveId, vkey } from "./state";

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

// ---------- helpers ----------

function eq(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

function conflictId(kind: Conflict["kind"], entity?: EntityId, field?: string): string {
  return `${kind}:${entity ?? ""}:${field ?? ""}`;
}

function typeOf(s: CRMState, id: EntityId): string {
  return s.entities[id]?.type ?? id.split(":")[0] ?? "";
}

function hasField(s: CRMState, entityType: string, field: string): boolean {
  return (s.schema[entityType] ?? []).some((d) => d.field === field);
}

function isLive(s: CRMState, id: EntityId): boolean {
  const r = s.entities[id];
  return !!r && !r.deleted && !r.mergedInto;
}

function sortBySeq(events: Event[]): Event[] {
  return [...events].sort((a, b) => a.seq - b.seq);
}

// ---------- three-way merge ----------

/** Three-way merge: base = main@forkSeq, ours = main head, theirs = branch head. Pure. */
export function threeWayMerge(input: MergeInput): MergeResult {
  const { branch, pr } = input;
  const resolutions = input.resolutions ?? {};
  const main = sortBySeq(input.mainEvents);
  const forkSeq = branch.forkSeq;
  const base = fold(main.filter((e) => e.seq <= forkSeq));
  const ours = fold(main);

  const conflicts: Conflict[] = [];
  const byId = new Map<string, Conflict>();
  const toAppend: NewEvent[] = [];
  let work = ours; // ours + everything emitted so far
  let nextSeq = ours.headSeq;
  const resurrected = new Set<EntityId>();

  /** Register (or update) a conflict; returns the stored instance with resolution filled. */
  const addConflict = (c: Conflict): Conflict => {
    const existing = byId.get(c.id);
    if (existing) {
      if (c.theirs !== undefined) existing.theirs = c.theirs;
      if (c.theirsEvent !== undefined) existing.theirsEvent = c.theirsEvent;
      return existing;
    }
    const r = resolutions[c.id];
    if (r !== undefined && !c.autoResolved) c.resolution = r;
    byId.set(c.id, c);
    conflicts.push(c);
    return c;
  };

  const emit = (src: Event, op: Op, reasonSuffix?: string) => {
    const ne: NewEvent = { actor: src.actor, op, origin: { kind: "merge", pr, sourceEvent: src.id } };
    const reason = reasonSuffix ? `${src.reason ?? ""}${src.reason ? " " : ""}${reasonSuffix}` : src.reason;
    if (reason !== undefined) ne.reason = reason;
    if (src.evidence !== undefined) ne.evidence = src.evidence;
    toAppend.push(ne);
    nextSeq += 1;
    const pseudo: Event = {
      id: `pending_merge_${pr}_${nextSeq}`,
      branch: "main",
      seq: nextSeq,
      ts: src.ts,
      actor: ne.actor,
      op,
      ...(ne.reason !== undefined ? { reason: ne.reason } : {}),
      ...(ne.evidence !== undefined ? { evidence: ne.evidence } : {}),
      origin: ne.origin,
    };
    work = applyEvent(work, pseudo);
  };

  for (const ev of sortBySeq(input.branchEvents)) {
    const op = ev.op;
    switch (op.type) {
      case "field.set": {
        let target = resolveId(ours, op.entity);
        if (target !== op.entity) {
          addConflict({
            id: conflictId("merged-away", op.entity, op.field),
            kind: "merged-away",
            entity: op.entity,
            field: op.field,
            theirs: op.value,
            theirsEvent: ev.id,
            autoResolved: { to: target, note: "rebased onto merge survivor" },
          });
        }
        const oursRec = ours.entities[target];

        // Deleted on main?
        if (oursRec?.deleted && !resurrected.has(target)) {
          const c = addConflict({ id: conflictId("deleted", target), kind: "deleted", entity: target, theirsEvent: ev.id });
          if (c.resolution === "theirs") {
            emit(ev, { type: "entity.create", entity: target, entityType: oursRec.type, attrs: { ...oursRec.attrs } }, "(restored: deleted on main)");
            resurrected.add(target);
          } else break; // unresolved or "ours" → drop
        }

        // Schema: main removed a field the branch still writes.
        const et = typeOf(work, target);
        if (hasField(base, et, op.field) && !hasField(ours, et, op.field) && !hasField(work, et, op.field)) {
          const c = addConflict({
            id: conflictId("schema", target, op.field),
            kind: "schema",
            entity: target,
            field: op.field,
            theirs: op.value,
            theirsEvent: ev.id,
          });
          if (c.resolution !== "theirs" && (typeof c.resolution !== "object" || c.resolution === null)) break;
        }

        // Rebase target through work aliases (branch-local merges already emitted).
        target = resolveId(work, target);
        const workVal = work.entities[target]?.attrs[op.field];
        if (work.entities[target] && eq(workVal, op.value)) break; // no-op on main → drop silently

        // Field conflict: both sides changed since fork.
        const oursVal = ours.entities[target]?.attrs[op.field];
        const baseVal = base.entities[target]?.attrs[op.field];
        const ver = ours.versions[vkey(target, op.field)] ?? 0;
        const cid = conflictId("field", target, op.field);
        if (byId.has(cid) || (ver > forkSeq && !eq(oursVal, op.value) && !eq(baseVal, oursVal))) {
          const oursEvent = ours.provenance[target]?.[op.field]?.eventId;
          const c = addConflict({
            id: cid,
            kind: "field",
            entity: target,
            field: op.field,
            ...(baseVal !== undefined ? { base: baseVal } : {}),
            ...(oursVal !== undefined ? { ours: oursVal } : {}),
            theirs: op.value,
            ...(oursEvent !== undefined ? { oursEvent } : {}),
            theirsEvent: ev.id,
          });
          const r = c.resolution;
          if (r === undefined || r === "ours") break;
          if (r !== "theirs") {
            if (eq(workVal, r.value)) break;
            emit(ev, { type: "field.set", entity: target, field: op.field, value: r.value, prev: workVal ?? null }, "(conflict resolved manually)");
            break;
          }
        }
        emit(ev, { type: "field.set", entity: target, field: op.field, value: op.value, prev: workVal ?? null });
        break;
      }

      case "entity.merge": {
        const fromR = resolveId(ours, op.from);
        const intoR = resolveId(ours, op.into);
        const fromRec = ours.entities[op.from];
        // Inverse: main merged `into` → `from`.
        if (op.into !== op.from && intoR === op.from && isLive(ours, op.from)) {
          // Any resolution acknowledges it; nothing to emit (main already combined them the other way).
          addConflict({ id: conflictId("merged-away", op.from), kind: "merged-away", entity: op.from, theirsEvent: ev.id });
          break;
        }
        if (fromR !== op.from || fromRec?.deleted) {
          addConflict({
            id: conflictId("merged-away", op.from),
            kind: "merged-away",
            entity: op.from,
            theirsEvent: ev.id,
            autoResolved: {
              to: fromR,
              note: fromRec?.deleted ? "dropped: entity already deleted on main" : "dropped: already merged on main",
            },
          });
          break;
        }
        let into = op.into;
        if (intoR !== op.into) {
          addConflict({
            id: conflictId("merged-away", op.into),
            kind: "merged-away",
            entity: op.into,
            theirsEvent: ev.id,
            autoResolved: { to: intoR, note: "rebased onto merge survivor" },
          });
          into = intoR;
        }
        const intoRec = ours.entities[into];
        if (intoRec?.deleted && !resurrected.has(into)) {
          const c = addConflict({ id: conflictId("deleted", into), kind: "deleted", entity: into, theirsEvent: ev.id });
          if (c.resolution !== "theirs") break;
          emit(ev, { type: "entity.create", entity: into, entityType: intoRec.type, attrs: { ...intoRec.attrs } }, "(restored: deleted on main)");
          resurrected.add(into);
        }
        emit(ev, { ...op, into });
        break;
      }

      case "entity.delete": {
        const target = resolveId(ours, op.entity);
        if (target !== op.entity) {
          // Deleting a merged-away id would delete the survivor: needs a human.
          const c = addConflict({ id: conflictId("merged-away", op.entity), kind: "merged-away", entity: op.entity, theirsEvent: ev.id });
          if (c.resolution === "theirs") emit(ev, { type: "entity.delete", entity: target });
          break;
        }
        if (ours.entities[target]?.deleted || work.entities[target]?.deleted) break; // already deleted
        emit(ev, op);
        break;
      }

      case "entity.create": {
        if (isLive(ours, op.entity)) break; // already exists on main
        emit(ev, op);
        break;
      }

      case "schema.addField":
      case "schema.renameField":
      case "schema.removeField":
      case "evidence.attach":
        emit(ev, op);
        break;
    }
  }

  const ok = conflicts.every((c) => c.autoResolved !== undefined || c.resolution !== undefined);
  return { ok, conflicts, toAppend, changes: diffStates(ours, work) };
}

/** Dry run for PR view (no resolutions). */
export function previewMerge(input: Omit<MergeInput, "resolutions">): MergeResult {
  return threeWayMerge(input);
}

// ---------- revert ----------

const REVERT_ACTOR = { kind: "system", id: "revert" } as const;

/** Inverse events that undo `eventIds` on top of current main state (keeps history; never deletes events). */
export function revertEvents(mainEvents: Event[], eventIds: string[], current: CRMState): NewEvent[] {
  const main = sortBySeq(mainEvents);
  const wanted = new Set(eventIds);
  const targets = main.filter((e) => wanted.has(e.id)).sort((a, b) => b.seq - a.seq); // newest first
  const out: NewEvent[] = [];
  const globalNotes: string[] = [];

  /** True if (entity, field) on current was last written by an event outside the revert set. */
  const changedSince = (entity: EntityId, field: string): string | null => {
    const id = resolveId(current, entity);
    const p = current.provenance[id]?.[field];
    if (!p || wanted.has(p.eventId)) return null;
    return p.eventId;
  };

  for (const e of targets) {
    const before = fold(main.filter((x) => x.seq < e.seq));
    const after = applyEvent(before, e);
    const ops: Op[] = [];
    const notes: string[] = [];
    const op = e.op;

    const setBack = (entity: EntityId, field: string) => {
      const by = changedSince(entity, field);
      if (by) {
        notes.push(`skipped ${entity}.${field}: changed since by ${by}`);
        return;
      }
      const prev = before.entities[entity]?.attrs[field];
      ops.push({ type: "field.set", entity, field, value: prev ?? null });
    };

    switch (op.type) {
      case "field.set": {
        const target = resolveId(before, op.entity);
        if (!before.entities[target]) break; // original was a no-op
        setBack(target, op.field);
        break;
      }
      case "entity.create": {
        const prior = before.entities[op.entity];
        if (prior && !prior.deleted && !prior.mergedInto) {
          ops.push({ type: "entity.create", entity: op.entity, entityType: prior.type, attrs: { ...prior.attrs } });
        } else {
          ops.push({ type: "entity.delete", entity: op.entity });
        }
        break;
      }
      case "entity.delete": {
        const target = resolveId(before, op.entity);
        const prior = before.entities[target];
        if (!prior || prior.deleted) break;
        ops.push({ type: "entity.create", entity: target, entityType: prior.type, attrs: { ...prior.attrs } });
        break;
      }
      case "entity.merge": {
        const from = resolveId(before, op.from);
        const into = resolveId(before, op.into);
        const rf = before.entities[from];
        const riBefore = before.entities[into];
        const riAfter = after.entities[into];
        if (!rf || !riBefore || !riAfter || from === into) break;
        ops.push({ type: "entity.create", entity: from, entityType: rf.type, attrs: { ...rf.attrs } });
        const fields = new Set([...Object.keys(riBefore.attrs), ...Object.keys(riAfter.attrs)]);
        for (const f of [...fields].sort()) {
          if (!eq(riBefore.attrs[f], riAfter.attrs[f])) setBack(into, f);
        }
        break;
      }
      case "schema.addField": {
        const prior = (before.schema[op.entityType] ?? []).find((d) => d.field === op.field);
        if (prior) {
          ops.push({
            type: "schema.addField",
            entityType: op.entityType,
            field: prior.field,
            fieldType: prior.fieldType,
            ...(prior.description !== undefined ? { description: prior.description } : {}),
          });
        } else {
          ops.push({ type: "schema.removeField", entityType: op.entityType, field: op.field });
        }
        break;
      }
      case "schema.renameField":
        ops.push({ type: "schema.renameField", entityType: op.entityType, from: op.to, to: op.from });
        break;
      case "schema.removeField": {
        const prior = (before.schema[op.entityType] ?? []).find((d) => d.field === op.field);
        if (prior) {
          ops.push({
            type: "schema.addField",
            entityType: op.entityType,
            field: prior.field,
            fieldType: prior.fieldType,
            ...(prior.description !== undefined ? { description: prior.description } : {}),
          });
        }
        break;
      }
      case "evidence.attach":
        break;
    }

    const baseReason = `Revert: ${e.reason ?? op.type}`;
    if (ops.length === 0) {
      globalNotes.push(...notes);
      continue;
    }
    ops.forEach((o, i) => {
      const reason = i === 0 && notes.length ? `${baseReason} (${notes.join("; ")})` : baseReason;
      out.push({ actor: REVERT_ACTOR, op: o, reason, origin: { kind: "revert", revertOf: e.id } });
    });
  }

  if (globalNotes.length && out.length) {
    out[0] = { ...out[0]!, reason: `${out[0]!.reason} (${globalNotes.join("; ")})` };
  }
  return out;
}

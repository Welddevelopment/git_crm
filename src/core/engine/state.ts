/** OWNER: W1 (state engine). Signatures are contract; bodies are yours. */
import type {
  Branch,
  CRMState,
  Change,
  EntityId,
  EntityRecord,
  Event,
  FieldDef,
  FieldProvenance,
  FieldValue,
  Op,
} from "../types";

export function emptyState(): CRMState {
  return { schema: {}, entities: {}, aliases: {}, evidence: {}, provenance: {}, versions: {}, headSeq: 0 };
}

// ---------- helpers ----------

function cloneValue(v: FieldValue): FieldValue {
  return Array.isArray(v) ? [...v] : v;
}

function cloneState(s: CRMState): CRMState {
  const entities: Record<EntityId, EntityRecord> = {};
  for (const [id, r] of Object.entries(s.entities)) {
    const attrs: Record<string, FieldValue> = {};
    for (const [k, v] of Object.entries(r.attrs)) attrs[k] = cloneValue(v);
    entities[id] = { ...r, attrs };
  }
  const schema: CRMState["schema"] = {};
  for (const [t, defs] of Object.entries(s.schema)) schema[t] = defs.map((d) => ({ ...d }));
  const provenance: CRMState["provenance"] = {};
  for (const [id, p] of Object.entries(s.provenance)) provenance[id] = { ...p };
  return {
    schema,
    entities,
    aliases: { ...s.aliases },
    evidence: { ...s.evidence },
    provenance,
    versions: { ...s.versions },
    headSeq: s.headSeq,
  };
}

function provOf(e: Event): FieldProvenance {
  const p: FieldProvenance = { eventId: e.id, actor: e.actor, ts: e.ts, seq: e.seq, branch: e.branch };
  if (e.reason !== undefined) p.reason = e.reason;
  if (e.evidence !== undefined) p.evidence = e.evidence;
  return p;
}

/** Records a write of `field` on `entity` (mutates s). */
function recordWrite(s: CRMState, e: Event, entity: EntityId, field: string): void {
  (s.provenance[entity] ??= {})[field] = provOf(e);
  s.versions[vkey(entity, field)] = e.seq;
}

function isEmpty(v: FieldValue | undefined): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

function valuesEqual(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

/** Fields an entity.merge writes onto `into` given the pre-merge state (resolved ids). */
function mergeWrites(
  s: CRMState,
  op: Extract<Op, { type: "entity.merge" }>,
): { from: EntityId; into: EntityId; writes: Record<string, FieldValue> } | null {
  const from = resolveId(s, op.from);
  const into = resolveId(s, op.into);
  const rf = s.entities[from];
  const ri = s.entities[into];
  if (!rf || !ri || from === into) return null;
  const writes: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(rf.attrs)) {
    if (isEmpty(ri.attrs[k]) && !isEmpty(v)) writes[k] = cloneValue(v);
  }
  for (const [k, v] of Object.entries(op.fieldChoices ?? {})) writes[k] = cloneValue(v);
  return { from, into, writes };
}

// ---------- core ----------

/** Pure: returns a NEW state with the event applied. Unknown entity on field.set => ignore + no throw. */
export function applyEvent(state: CRMState, e: Event): CRMState {
  const s = cloneState(state);
  s.headSeq = e.branch === "main" ? Math.max(s.headSeq, e.seq) : s.headSeq + 1;
  const op = e.op;
  switch (op.type) {
    case "entity.create": {
      const id = op.entity;
      const attrs: Record<string, FieldValue> = {};
      for (const [k, v] of Object.entries(op.attrs)) attrs[k] = cloneValue(v);
      // Fresh create or resurrection (revert of delete / dedup): clear tombstones + alias.
      s.entities[id] = { id, type: op.entityType, attrs };
      delete s.aliases[id];
      delete s.provenance[id]; // stale provenance for fields the new attrs don't have
      for (const k of Object.keys(attrs)) recordWrite(s, e, id, k);
      s.versions[vkey(id, "__entity")] = e.seq;
      break;
    }
    case "field.set": {
      const id = resolveId(s, op.entity);
      const r = s.entities[id];
      if (!r) break;
      r.attrs[op.field] = cloneValue(op.value);
      recordWrite(s, e, id, op.field);
      break;
    }
    case "entity.delete": {
      const id = resolveId(s, op.entity);
      const r = s.entities[id];
      if (!r) break;
      r.deleted = true;
      s.versions[vkey(id, "__entity")] = e.seq;
      break;
    }
    case "entity.merge": {
      const m = mergeWrites(s, op);
      if (!m) break;
      const ri = s.entities[m.into]!;
      const rf = s.entities[m.from]!;
      for (const [k, v] of Object.entries(m.writes)) {
        ri.attrs[k] = v;
        recordWrite(s, e, m.into, k);
      }
      rf.mergedInto = m.into;
      s.aliases[m.from] = m.into;
      s.versions[vkey(m.from, "__entity")] = e.seq;
      s.versions[vkey(m.into, "__entity")] = e.seq;
      break;
    }
    case "schema.addField": {
      const defs = (s.schema[op.entityType] ??= []);
      const def: FieldDef = { field: op.field, fieldType: op.fieldType };
      if (op.description !== undefined) def.description = op.description;
      const i = defs.findIndex((d) => d.field === op.field);
      if (i >= 0) defs[i] = def;
      else defs.push(def);
      break;
    }
    case "schema.renameField": {
      const defs = s.schema[op.entityType];
      if (defs) {
        const d = defs.find((x) => x.field === op.from);
        if (d) d.field = op.to;
      }
      for (const r of Object.values(s.entities)) {
        if (r.type !== op.entityType || !(op.from in r.attrs)) continue;
        r.attrs[op.to] = r.attrs[op.from]!;
        delete r.attrs[op.from];
        const p = s.provenance[r.id];
        if (p && p[op.from]) {
          p[op.to] = p[op.from]!;
          delete p[op.from];
        }
        s.versions[vkey(r.id, op.from)] = e.seq;
        s.versions[vkey(r.id, op.to)] = e.seq;
      }
      break;
    }
    case "schema.removeField": {
      const defs = s.schema[op.entityType];
      if (defs) s.schema[op.entityType] = defs.filter((d) => d.field !== op.field);
      break;
    }
    case "evidence.attach": {
      s.evidence[op.doc.id] = op.doc;
      break;
    }
  }
  return s;
}

/** Fold events in order onto a starting state (default empty). */
export function fold(events: Event[], start?: CRMState): CRMState {
  let s = start ?? emptyState();
  for (const e of events) s = applyEvent(s, e);
  return s;
}

/** Main state at wall-clock time `at` (events with ts <= at). */
export function stateAt(mainEvents: Event[], at: number): CRMState {
  return fold(mainEvents.filter((e) => e.ts <= at));
}

/** Branch head = fold(main[..forkSeq]) then branch events. */
export function branchState(mainEvents: Event[], branch: Branch, branchEvents: Event[]): CRMState {
  return fold(branchEvents, fold(mainEvents.filter((e) => e.seq <= branch.forkSeq)));
}

/** Follow alias chain to the surviving entity id. */
export function resolveId(state: CRMState, id: EntityId): EntityId {
  let cur = id;
  const seen = new Set<EntityId>();
  while (state.aliases[cur] !== undefined && !seen.has(cur)) {
    seen.add(cur);
    cur = state.aliases[cur]!;
  }
  return cur;
}

/** Full write history of one field across the given log (oldest first). */
export function blame(events: Event[], entity: EntityId, field: string): FieldProvenance[] {
  // Pass 1: walk the log recording (event, resolved-target-at-that-time) for every write to `field`.
  const writes: { e: Event; target: EntityId }[] = [];
  let s = emptyState();
  for (const e of events) {
    const op = e.op;
    if (op.type === "field.set" && op.field === field) {
      const t = resolveId(s, op.entity);
      if (s.entities[t]) writes.push({ e, target: t });
    } else if (op.type === "entity.create" && field in op.attrs) {
      writes.push({ e, target: op.entity });
    } else if (op.type === "entity.merge") {
      const m = mergeWrites(s, op);
      if (m && field in m.writes) writes.push({ e, target: m.into });
    }
    s = applyEvent(s, e);
  }
  // Pass 2: keep writes whose target resolves (in the final state) to the same survivor as `entity`.
  const want = resolveId(s, entity);
  return writes.filter((w) => resolveId(s, w.target) === want).map((w) => provOf(w.e));
}

function live(r: EntityRecord | undefined): r is EntityRecord {
  return !!r && !r.deleted && !r.mergedInto;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semantic diff a → b. */
export function diffStates(a: CRMState, b: CRMState): Change[] {
  const out: Change[] = [];
  const ids = [...new Set([...Object.keys(a.entities), ...Object.keys(b.entities)])].sort(cmp);
  for (const id of ids) {
    const ra = a.entities[id];
    const rb = b.entities[id];
    if (!live(ra) && live(rb)) {
      out.push({ kind: "entity.added", entity: id, entityType: rb.type, attrs: { ...rb.attrs } });
      continue;
    }
    if (!ra || !live(ra)) continue; // nothing live before → nothing else to report
    if (!rb) {
      out.push({ kind: "entity.removed", entity: id });
      continue;
    }
    if (rb.mergedInto) {
      out.push({ kind: "entity.merged", from: id, into: rb.mergedInto });
      continue;
    }
    if (rb.deleted) {
      out.push({ kind: "entity.removed", entity: id });
      continue;
    }
    const fields = [...new Set([...Object.keys(ra.attrs), ...Object.keys(rb.attrs)])].sort(cmp);
    for (const f of fields) {
      const before = ra.attrs[f];
      const after = rb.attrs[f];
      if (!valuesEqual(before, after)) out.push({ kind: "field.changed", entity: id, field: f, before, after });
    }
  }

  const types = [...new Set([...Object.keys(a.schema), ...Object.keys(b.schema)])].sort(cmp);
  for (const t of types) {
    const da = new Map((a.schema[t] ?? []).map((d) => [d.field, d] as const));
    const db = new Map((b.schema[t] ?? []).map((d) => [d.field, d] as const));
    const fields = [...new Set([...da.keys(), ...db.keys()])].sort(cmp);
    for (const f of fields) {
      const x = da.get(f);
      const y = db.get(f);
      if (!x && y) out.push({ kind: "schema.changed", entityType: t, description: `added field ${f} (${y.fieldType})` });
      else if (x && !y) out.push({ kind: "schema.changed", entityType: t, description: `removed field ${f}` });
      else if (x && y && x.fieldType !== y.fieldType)
        out.push({ kind: "schema.changed", entityType: t, description: `changed field ${f} type ${x.fieldType} → ${y.fieldType}` });
      else if (x && y && (x.description ?? "") !== (y.description ?? ""))
        out.push({ kind: "schema.changed", entityType: t, description: `updated description of field ${f}` });
    }
  }

  for (const docId of Object.keys(b.evidence).sort(cmp)) {
    if (!a.evidence[docId]) out.push({ kind: "evidence.added", docId });
  }
  return out;
}

/** Key helper for versions/readSet. */
export const vkey = (entity: EntityId, field: string) => `${entity}::${field}`;

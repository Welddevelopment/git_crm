/**
 * Attio connector: Attio is the system of record humans edit; Mainline mirrors it and governs agent writes.
 *
 *  - importFromAttio(repo): pull companies / people / deals, create `company:at-<record_id>` (etc.) for new ones,
 *    link existing Mainline entities by natural key (domain / email / name) and record `attrs.attioId`,
 *    and commit `field.set` for values that differ. Human edits made in Attio land on main as actor "Attio".
 *  - startAttioSync(repo): the same thing every 20s, but only for values that changed IN Attio since the last
 *    poll, skipping echoes of Mainline's own writes (see adapters/attio.ts) for 60s.
 *  - resolveAttioRecord(state, object, recordId): Attio record -> Mainline entity id (for /api/records/lookup).
 */
import type { Actor, CRMState, EntityId, FieldValue, NewEvent } from "../../core/types";
import type { Repo } from "../../server/repo";
import { AttioClient, AttioError, attioToken } from "./client";
import {
  ATTIO_OBJECTS, IMPORT_PREFIX, OBJECT_TYPE, mapAttioRecord, normalizeObject, resolveAlias, sameValue,
  type AttioObject, type AttioRecord, type MappedAttio,
} from "./map";
import { attioRuntime, isEcho, snapshotGet, snapshotSet, type AttioImportResult } from "./runtime";

export * from "./map";
export { AttioClient, AttioError, OPTION_SLUGS, attioToken, naturalKeyFilter, ownerResolver, writeWithOptionFallback, type AttioMember } from "./client";
export { markEcho, isEcho, attioRuntime, resetAttioRuntime, ECHO_TTL_MS, type AttioImportResult } from "./runtime";

export const ATTIO_ACTOR: Actor = { kind: "human", id: "attio", name: "Attio" };
const LINK_ACTOR: Actor = { kind: "system", id: "attio" };
export const ATTIO_POLL_MS = 20_000;

type RepoLike = Pick<Repo, "state" | "commitToMain" | "refreshOpenPRs">;

/** Fields we import into existing entities. `owner` is create-only (Attio owners are workspace members, ours are names). */
const SYNC_FIELDS: Record<string, string[]> = {
  company: ["name", "domain", "employees", "industry"],
  contact: ["name", "email", "title", "phone", "company"],
  deal: ["name", "amount", "stage", "company"],
};

// ---------- lookup ----------
/**
 * Attio record -> Mainline entity id. Matches `attrs.attioId` (preferring live entities), then falls back to a
 * Mainline id/slug (`deal:acme-platform`, `acme-platform`, `at-<record_id>`), so it works without a real Attio.
 * `objectSlug` may be companies|people|deals, Attio singulars, or our types (company|contact|deal); null = any.
 * Merged-away entities resolve to their survivor.
 */
export function resolveAttioRecord(state: CRMState, objectSlug: string | null | undefined, recordId: string): EntityId | null {
  if (!recordId) return null;
  const object = normalizeObject(objectSlug ?? null);
  const type = object ? OBJECT_TYPE[object] : null;
  let fallback: EntityId | null = null;
  for (const e of Object.values(state.entities)) {
    if (type && e.type !== type) continue;
    if (e.attrs.attioId === undefined || String(e.attrs.attioId) !== recordId) continue;
    if (!e.deleted && !e.mergedInto) return e.id;
    fallback ??= e.id;
  }
  if (fallback) return resolveAlias(state, fallback);
  const candidates = recordId.includes(":")
    ? [recordId]
    : type
      ? [`${type}:${recordId}`, `${type}:${IMPORT_PREFIX}${recordId}`]
      : ["company", "contact", "deal"].flatMap((t) => [`${t}:${recordId}`, `${t}:${IMPORT_PREFIX}${recordId}`]);
  for (const c of candidates) {
    if (!state.entities[c] && !state.aliases[c]) continue;
    const id = resolveAlias(state, c);
    const rec = state.entities[id];
    if (rec && (!type || rec.type === type)) return id;
  }
  return null;
}

// ---------- import ----------
export interface ImportOptions {
  client?: AttioClient;
  /** "full" = Attio wins every differing field (first import); "changes" = only values changed in Attio since last poll */
  mode?: "full" | "changes";
  now?: () => number;
}

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const naturalKey = (type: string, attrs: Record<string, FieldValue | undefined>): string =>
  type === "company" ? norm(attrs.domain) : type === "contact" ? norm(attrs.email) : norm(attrs.name);

export async function importFromAttio(repo: RepoLike, opts: ImportOptions = {}): Promise<AttioImportResult> {
  const rt = attioRuntime();
  if (rt.running) return rt.running; // one import at a time (poll + manual import share it)
  const run = doImport(repo, opts);
  rt.running = run;
  try {
    const r = await run;
    rt.lastRunAt = r.at;
    rt.lastResult = r;
    rt.lastError = r.ok ? undefined : r.errors.join("; ");
    if (r.ok) rt.importedOnce = true;
    return r;
  } catch (e) {
    rt.lastError = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    rt.running = undefined;
  }
}

async function doImport(repo: RepoLike, opts: ImportOptions): Promise<AttioImportResult> {
  const client = opts.client ?? new AttioClient();
  const now = opts.now ?? Date.now;
  const mode = opts.mode ?? "full";
  const rt = attioRuntime();
  const result: AttioImportResult = { ok: true, mode, at: now(), objects: {}, created: [], linked: [], updated: [], events: 0, errors: [] };

  const state = await repo.state();
  // attioId -> entity, natural key -> entity (for linking records that already exist on both sides)
  const byAttio = new Map<string, EntityId>();
  const byKey = new Map<string, EntityId>();
  for (const e of Object.values(state.entities)) {
    if (e.deleted || e.mergedInto) continue;
    if (e.attrs.attioId) byAttio.set(`${e.type}|${e.attrs.attioId}`, e.id);
    const k = naturalKey(e.type, e.attrs);
    if (k && !e.attrs.attioId && !byKey.has(`${e.type}|${k}`)) byKey.set(`${e.type}|${k}`, e.id);
  }

  // Fetch everything first (companies before people/deals so refs resolve).
  const fetched: { object: AttioObject; records: AttioRecord[] }[] = [];
  for (const object of ATTIO_OBJECTS) {
    try {
      const records = await client.listAll(object);
      fetched.push({ object, records });
      result.objects[object] = records.length;
      if (object === "deals") rt.hasDeals = true;
    } catch (e) {
      if (object === "deals" && e instanceof AttioError && (e.status === 404 || e.status === 400)) {
        result.objects.deals = "missing"; // deals object not enabled in this workspace
        rt.hasDeals = false;
        continue;
      }
      result.ok = false;
      result.errors.push(e instanceof Error ? e.message : String(e));
      if (object === "companies") return result; // can't do anything sensible without companies
    }
  }

  let memberNames = new Map<string, string>();
  if (fetched.some((f) => f.object === "deals" && f.records.length)) {
    const members = await client.members();
    memberNames = new Map(members.map((m) => [m.id.workspace_member_id, [m.first_name, m.last_name].filter(Boolean).join(" ")]));
  }

  const events: NewEvent[] = [];
  const ts = now();
  const resolveRef = (_o: AttioObject, rid: string) => byAttio.get(`company|${rid}`) ?? null;

  for (const { object, records } of fetched) {
    const type = OBJECT_TYPE[object];
    for (const rec of records) {
      const rid = rec.id?.record_id;
      if (!rid) continue;
      const m = mapAttioRecord(object, rec, { resolveRef, memberName: (id) => memberNames.get(id) || undefined });
      let entityId = byAttio.get(`${type}|${rid}`);

      if (!entityId) {
        const k = naturalKey(type, m.attrs);
        const linked = k ? byKey.get(`${type}|${k}`) : undefined;
        if (linked) {
          entityId = linked;
          byKey.delete(`${type}|${k}`);
          events.push({ actor: LINK_ACTOR, ts, op: { type: "field.set", entity: linked, field: "attioId", value: rid, prev: null }, reason: `Linked to Attio ${object} record ${rid}` });
          result.linked.push(linked);
        } else if (isEcho(rid, "__record")) {
          continue; // a record Mainline just created; the adapter is about to record its attioId
        } else {
          entityId = `${type}:${IMPORT_PREFIX}${rid}`;
          events.push({ actor: ATTIO_ACTOR, ts, op: { type: "entity.create", entity: entityId, entityType: type, attrs: { ...m.attrs, attioId: rid } }, reason: `Imported from Attio (${object})` });
          result.created.push(entityId);
          remember(rid, m);
        }
        byAttio.set(`${type}|${rid}`, entityId);
        if (result.created.includes(entityId)) continue;
      }

      const cur = state.entities[resolveAlias(state, entityId)];
      if (!cur) continue;
      const changed: string[] = [];
      for (const field of SYNC_FIELDS[type] ?? []) {
        if (!(field in m.attrs)) continue; // never clear a field because Attio is blank
        const seen = snapshotGet(rid, field);
        const value = JSON.stringify(m.attrs[field] ?? null);
        if (mode === "changes" && seen === value) continue; // unchanged in Attio since last poll
        if (isEcho(rid, field)) continue; // our own write coming back
        if (sameValue(m, field, cur.attrs[field])) continue;
        events.push({
          actor: ATTIO_ACTOR, ts,
          op: { type: "field.set", entity: cur.id, field, value: m.attrs[field]!, prev: cur.attrs[field] ?? null },
          reason: `Edited in Attio`,
        });
        changed.push(field);
      }
      if (changed.length) result.updated.push({ entity: cur.id, fields: changed });
      remember(rid, m);
    }
  }

  if (events.length) {
    await repo.commitToMain(events);
    result.events = events.length;
    try { await repo.refreshOpenPRs(); } catch { /* analysis refresh is best effort */ }
  }
  return result;
}

function remember(rid: string, m: MappedAttio) {
  for (const [f, v] of Object.entries(m.attrs)) snapshotSet(rid, f, v);
}

// ---------- polling ----------
export interface SyncStatus {
  started: boolean;
  reason?: string;
  intervalMs?: number;
}

/**
 * Start polling Attio (idempotent). Runs a full import immediately (unless one already succeeded), then a
 * "changes" import every `intervalMs`. No-op without ATTIO_TOKEN.
 */
export function startAttioSync(repo: RepoLike, opts: { intervalMs?: number; client?: AttioClient } = {}): SyncStatus {
  const rt = attioRuntime();
  if (!opts.client && !attioToken()) return { started: false, reason: "ATTIO_TOKEN not set" };
  if (rt.timer) return { started: true, intervalMs: rt.intervalMs };
  const intervalMs = opts.intervalMs ?? (Number(process.env.ATTIO_POLL_MS) || ATTIO_POLL_MS);
  const tick = async () => {
    try {
      await importFromAttio(repo, { client: opts.client, mode: rt.importedOnce ? "changes" : "full" });
    } catch (e) {
      console.warn(`[mainline] attio sync: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  void tick();
  rt.timer = setInterval(tick, intervalMs);
  (rt.timer as { unref?: () => void }).unref?.();
  rt.intervalMs = intervalMs;
  return { started: true, intervalMs };
}

export function stopAttioSync(): void {
  const rt = attioRuntime();
  if (rt.timer) clearInterval(rt.timer);
  rt.timer = undefined;
}

/** Count of mirrored entities per type (entities carrying attrs.attioId). */
export function mirroredCounts(state: CRMState): Record<string, number> {
  const out: Record<string, number> = { company: 0, contact: 0, deal: 0 };
  for (const e of Object.values(state.entities)) {
    if (e.deleted || e.mergedInto || !e.attrs.attioId) continue;
    out[e.type] = (out[e.type] ?? 0) + 1;
  }
  return out;
}

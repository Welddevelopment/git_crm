/**
 * HubSpot connector: HubSpot stays the system humans edit; Git CRM mirrors it and governs agent writes.
 *
 *  - importFromHubSpot(repo): pull companies / contacts / deals (CRM v3 list, associations to companies, 200 cap
 *    each). Records whose `hubspotId` is known get `field.set` for values that differ; unknown records are
 *    linked to an existing Git CRM entity by natural key (company domain / contact email / deal name) and get
 *    `attrs.hubspotId`, or else created as `company:hs-<id>` etc. Human edits land on main as actor "HubSpot".
 *  - startHubSpotSync(repo): the same every 20s, but only for records modified since the last sync (search API on
 *    hs_lastmodifieddate) and only for values that changed IN HubSpot, skipping echoes of Git CRM's own writes.
 *    Then repo.refreshOpenPRs(), so a human edit in HubSpot can make an open agent PR conflict or go stale.
 *  - Write-back (merged PRs -> HubSpot) lives in src/adapters/hubspot.ts and uses the same mapping (./map).
 */
import type { Actor, CRMState, EntityId, FieldValue, NewEvent } from "../../core/types";
import type { Repo } from "../../server/repo";
import { HubSpotClient, associatedCompanyId, hubspotToken, type HubSpotObjectRecord } from "./client";
import {
  HUBSPOT_OBJECTS, IMPORT_PREFIX, MODIFIED_PROPERTY, OBJECT_TYPE, READ_PROPERTIES, SYNC_FIELDS, naturalKey,
  propertiesToAttrs, resolveAlias, sameValue, type HubSpotObject,
} from "./map";
import { hubspotRuntime, isEcho, snapshotGet, snapshotSet, wasCreatedByUs, type HubSpotImportResult } from "./runtime";

export * from "./map";
export { HubSpotClient, HubSpotError, hubspotToken, associatedCompanyId, type HubSpotObjectRecord } from "./client";
export { markEcho, isEcho, markCreated, hubspotRuntime, resetHubSpotRuntime, ECHO_TTL_MS, type HubSpotImportResult } from "./runtime";

export const HUBSPOT_ACTOR: Actor = { kind: "human", id: "hubspot", name: "HubSpot" };
export const HUBSPOT_SYSTEM: Actor = { kind: "system", id: "hubspot" };
export const HUBSPOT_POLL_MS = 20_000;
export const IMPORT_CAP = 200;
/** Overlap between polls so edits landing during a poll aren't missed (HubSpot search is eventually consistent). */
const POLL_OVERLAP_MS = 60_000;

type RepoLike = Pick<Repo, "state" | "commitToMain" | "refreshOpenPRs">;

export interface ImportOptions {
  client?: HubSpotClient;
  /** "full" = HubSpot wins every differing field; "changes" = only records modified since lastSync, only changed values */
  mode?: "full" | "changes";
  now?: () => number;
  cap?: number;
}

/** One import at a time (poll + manual import share it). */
export async function importFromHubSpot(repo: RepoLike, opts: ImportOptions = {}): Promise<HubSpotImportResult> {
  const rt = hubspotRuntime();
  if (rt.running) return rt.running;
  const run = doImport(repo, opts);
  rt.running = run;
  try {
    const r = await run;
    rt.lastResult = r;
    rt.lastError = r.ok ? undefined : r.errors.join("; ");
    if (r.ok) {
      rt.importedOnce = true;
      rt.lastSync = r.at;
    }
    return r;
  } catch (e) {
    rt.lastError = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    rt.running = undefined;
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function doImport(repo: RepoLike, opts: ImportOptions): Promise<HubSpotImportResult> {
  const client = opts.client ?? new HubSpotClient();
  const now = opts.now ?? Date.now;
  const cap = opts.cap ?? IMPORT_CAP;
  const rt = hubspotRuntime();
  const startedAt = now();
  const state = await repo.state();
  // After a demo reset main has no hubspotIds again: relink everything with a full import.
  const anyLinked = Object.values(state.entities).some((e) => e.attrs.hubspotId);
  const mode: "full" | "changes" = opts.mode ?? (rt.importedOnce && anyLinked && rt.lastSync ? "changes" : "full");
  const result: HubSpotImportResult = { ok: true, mode, at: startedAt, fetched: {}, created: [], linked: [], updated: [], skippedEchoes: 0, events: 0, errors: [] };

  // hubspotId -> entity (live first), natural key -> unlinked entity
  const byHs = new Map<string, EntityId>();
  const byKey = new Map<string, EntityId>();
  for (const e of Object.values(state.entities)) {
    if (e.deleted) continue;
    const hs = e.attrs.hubspotId;
    if (hs !== undefined && hs !== null && hs !== "") {
      const k = `${e.type}|${hs}`;
      if (!e.mergedInto || !byHs.has(k)) byHs.set(k, resolveAlias(state, e.id));
      continue;
    }
    if (e.mergedInto) continue;
    const nk = naturalKey(e.type, e.attrs);
    if (nk && !byKey.has(`${e.type}|${nk}`)) byKey.set(`${e.type}|${nk}`, e.id);
  }

  // Fetch (companies first so contact/deal company refs resolve).
  const fetched: { object: HubSpotObject; records: HubSpotObjectRecord[]; companyOf: Map<string, string | null> }[] = [];
  for (const object of HUBSPOT_OBJECTS) {
    try {
      const props = READ_PROPERTIES[object];
      const companyOf = new Map<string, string | null>();
      let records: HubSpotObjectRecord[];
      if (mode === "full") {
        records = await client.list(object, props, { associations: object === "companies" ? [] : ["companies"], cap });
        for (const r of records) companyOf.set(r.id, associatedCompanyId(r));
      } else {
        const since = (rt.lastSync ?? startedAt) - POLL_OVERLAP_MS;
        records = await client.searchModifiedSince(object, MODIFIED_PROPERTY[object], since, props, cap);
        if (object !== "companies" && records.length) {
          try {
            const assoc = await client.companyAssociations(object, records.map((r) => r.id));
            for (const r of records) if (assoc.has(r.id)) companyOf.set(r.id, assoc.get(r.id)![0] ?? null);
          } catch (e) {
            result.errors.push(`associations ${object}: ${errText(e)}`); // non-fatal: company refs just don't update
          }
        }
      }
      fetched.push({ object, records, companyOf });
      result.fetched[object] = records.length;
    } catch (e) {
      result.ok = false;
      result.errors.push(errText(e));
      if (object === "companies") return result;
    }
  }
  if (result.errors.length && result.ok) result.errors = result.errors.filter(Boolean);

  const events: NewEvent[] = [];
  const ts = now();
  const createdInRun = new Set<EntityId>();

  for (const { object, records, companyOf } of fetched) {
    const type = OBJECT_TYPE[object];
    for (const rec of records) {
      const hsId = rec.id ? String(rec.id) : "";
      if (!hsId) continue;
      const m = propertiesToAttrs(type, rec.properties ?? {});
      if (type !== "company" && companyOf.has(hsId)) {
        const cid = companyOf.get(hsId);
        const ref = cid ? byHs.get(`company|${cid}`) : undefined;
        if (ref) m.attrs.company = ref;
      }
      let entityId = byHs.get(`${type}|${hsId}`);

      if (!entityId) {
        const nk = naturalKey(type, m.attrs);
        const linked = nk ? byKey.get(`${type}|${nk}`) : undefined;
        if (linked) {
          entityId = linked;
          byKey.delete(`${type}|${nk}`);
          events.push({ actor: HUBSPOT_SYSTEM, ts, op: { type: "field.set", entity: linked, field: "hubspotId", value: hsId, prev: null }, reason: `Linked to HubSpot ${object.slice(0, -1)} ${hsId}` });
          result.linked.push(linked);
          // Link only: don't let HubSpot overwrite a freshly (re)seeded main. Later polls import values that
          // change IN HubSpot (snapshot below). POST /api/integrations/hubspot/seed re-aligns HubSpot to main.
          byHs.set(`${type}|${hsId}`, entityId);
          remember(object, hsId, m.attrs);
          continue;
        } else if (wasCreatedByUs(object, hsId, ts)) {
          continue; // Git CRM just created this record; the adapter records its hubspotId itself
        } else {
          entityId = `${type}:${IMPORT_PREFIX}${hsId}`;
          if (state.entities[entityId] && !state.entities[entityId]!.deleted) {
            // re-created after a delete/reset race: treat as linked
          } else {
            events.push({ actor: HUBSPOT_ACTOR, ts, op: { type: "entity.create", entity: entityId, entityType: type, attrs: { ...m.attrs, hubspotId: hsId } }, reason: `Imported from HubSpot (${object})` });
            result.created.push(entityId);
            createdInRun.add(entityId);
            remember(object, hsId, m.attrs);
          }
        }
        byHs.set(`${type}|${hsId}`, entityId);
        if (createdInRun.has(entityId)) continue;
      }

      const cur = state.entities[resolveAlias(state, entityId)];
      if (!cur || cur.deleted) continue;
      const changed: string[] = [];
      for (const field of SYNC_FIELDS[type] ?? []) {
        if (!(field in m.attrs)) continue; // never clear a field because HubSpot is blank
        const value = m.attrs[field]!;
        const curVal = field === "company" && typeof cur.attrs.company === "string" ? resolveAlias(state, cur.attrs.company) : cur.attrs[field];
        if (mode === "changes" && snapshotGet(object, hsId, field) === JSON.stringify(value)) continue; // unchanged in HubSpot
        if (isEcho(object, hsId, field, value, ts)) { result.skippedEchoes++; continue; } // our own write coming back
        if (sameValue(field, value, curVal)) continue;
        events.push({
          actor: HUBSPOT_ACTOR, ts,
          op: { type: "field.set", entity: cur.id, field, value, prev: cur.attrs[field] ?? null },
          reason: mode === "full" ? "Synced from HubSpot" : "Edited in HubSpot",
        });
        changed.push(field);
      }
      if (changed.length) result.updated.push({ entity: cur.id, fields: changed });
      remember(object, hsId, m.attrs);
    }
  }

  if (events.length) {
    await repo.commitToMain(events);
    result.events = events.length;
    try { await repo.refreshOpenPRs(); } catch { /* analysis refresh is best effort */ }
  }
  return result;
}

function remember(object: HubSpotObject, hsId: string, attrs: Record<string, FieldValue>) {
  for (const [f, v] of Object.entries(attrs)) snapshotSet(object, hsId, f, v);
}

// ---------- polling ----------
export interface SyncStatus {
  started: boolean;
  reason?: string;
  intervalMs?: number;
}

/**
 * Start polling HubSpot (idempotent). Runs a full import immediately, then a "changes" import every
 * `intervalMs` (default 20s, HUBSPOT_POLL_MS). No-op without HUBSPOT_TOKEN.
 */
export function startHubSpotSync(repo: RepoLike, opts: { intervalMs?: number; client?: HubSpotClient } = {}): SyncStatus {
  const rt = hubspotRuntime();
  if (!opts.client && !hubspotToken()) return { started: false, reason: "HUBSPOT_TOKEN not set" };
  if (rt.timer) return { started: true, intervalMs: rt.intervalMs };
  const intervalMs = opts.intervalMs ?? (Number(process.env.HUBSPOT_POLL_MS) || HUBSPOT_POLL_MS);
  const tick = async () => {
    try {
      const r = await importFromHubSpot(repo, { client: opts.client });
      if (r.events) console.log(`[mainline] hubspot sync (${r.mode}): ${r.events} event(s), ${r.created.length} created, ${r.updated.length} updated`);
      if (!r.ok) console.warn(`[mainline] hubspot sync: ${r.errors.join("; ")}`);
    } catch (e) {
      console.warn(`[mainline] hubspot sync: ${errText(e)}`);
    }
  };
  rt.intervalMs = intervalMs;
  rt.timer = setInterval(tick, intervalMs);
  (rt.timer as { unref?: () => void }).unref?.();
  void tick();
  return { started: true, intervalMs };
}

export function stopHubSpotSync(): void {
  const rt = hubspotRuntime();
  if (rt.timer) clearInterval(rt.timer);
  rt.timer = undefined;
}

/** Entities per type that are mirrored to HubSpot (carry attrs.hubspotId). */
export function mirroredCounts(state: CRMState): Record<string, number> {
  const out: Record<string, number> = { company: 0, contact: 0, deal: 0 };
  for (const e of Object.values(state.entities)) {
    if (e.deleted || e.mergedInto || !e.attrs.hubspotId) continue;
    out[e.type] = (out[e.type] ?? 0) + 1;
  }
  return out;
}

/** portalId via /account-info/v3/details (cached). */
export async function portalInfo(client = new HubSpotClient()): Promise<{ portalId: number | null; uiDomain: string | null }> {
  const rt = hubspotRuntime();
  if (rt.portalId) return { portalId: rt.portalId, uiDomain: rt.uiDomain ?? null };
  const info = await client.accountInfo();
  rt.portalId = typeof info.portalId === "number" ? info.portalId : Number(info.portalId) || null;
  rt.uiDomain = typeof info.uiDomain === "string" ? info.uiDomain : null;
  return { portalId: rt.portalId, uiDomain: rt.uiDomain };
}

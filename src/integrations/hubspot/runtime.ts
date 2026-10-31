/**
 * Process-wide HubSpot sync state (survives Next.js module duplication via globalThis):
 *  - echoes: field values Mainline itself just pushed to HubSpot (60s), so the poller doesn't import them back
 *  - snapshot: last-seen HubSpot value per (record, field), so polls only import what changed IN HubSpot
 *  - poller handle, lastSync watermark, last result, portalId for /api/integrations/hubspot/status
 */
export const ECHO_TTL_MS = 60_000;

export interface HubSpotImportResult {
  ok: boolean;
  mode: "full" | "changes";
  at: number;
  fetched: Partial<Record<"companies" | "contacts" | "deals", number>>;
  created: string[];
  linked: string[];
  updated: { entity: string; fields: string[] }[];
  skippedEchoes: number;
  events: number;
  errors: string[];
}

interface HubSpotRuntime {
  echoes: Map<string, { value: string; until: number }>; // "<object>/<id>::<field>" -> pushed value
  createdIds: Map<string, number>; // "<object>/<id>" created by Mainline -> until
  snapshot: Map<string, string>; // "<object>/<id>::<field>" -> JSON of last-seen mapped value
  timer?: ReturnType<typeof setInterval>;
  intervalMs?: number;
  running?: Promise<HubSpotImportResult>;
  lastSync?: number; // watermark (ms) of the last successful import
  lastResult?: HubSpotImportResult;
  lastError?: string;
  importedOnce?: boolean;
  portalId?: number | null;
  uiDomain?: string | null;
}

type G = typeof globalThis & { __mainlineHubSpot?: HubSpotRuntime };
export function hubspotRuntime(): HubSpotRuntime {
  const g = globalThis as G;
  return (g.__mainlineHubSpot ??= { echoes: new Map(), createdIds: new Map(), snapshot: new Map() });
}

const k = (object: string, id: string, field: string) => `${object}/${id}::${field}`;
const norm = (v: unknown) => JSON.stringify(v === undefined ? null : v);

/** Called by the HubSpot adapter right before it writes these Mainline field values to a HubSpot record. */
export function markEcho(object: string, id: string, values: Record<string, unknown>, now = Date.now()): void {
  const rt = hubspotRuntime();
  for (const [f, v] of Object.entries(values)) rt.echoes.set(k(object, id, f), { value: norm(v), until: now + ECHO_TTL_MS });
}

/** True if `value` for this field is what Mainline pushed in the last 60s (i.e. our own write coming back). */
export function isEcho(object: string, id: string, field: string, value: unknown, now = Date.now()): boolean {
  const rt = hubspotRuntime();
  const key = k(object, id, field);
  const e = rt.echoes.get(key);
  if (!e) return false;
  if (e.until < now) {
    rt.echoes.delete(key);
    return false;
  }
  return e.value === norm(value);
}

export function markCreated(object: string, id: string, now = Date.now()): void {
  hubspotRuntime().createdIds.set(`${object}/${id}`, now + ECHO_TTL_MS);
}
export function wasCreatedByUs(object: string, id: string, now = Date.now()): boolean {
  const until = hubspotRuntime().createdIds.get(`${object}/${id}`);
  return until !== undefined && until >= now;
}

export function snapshotGet(object: string, id: string, field: string): string | undefined {
  return hubspotRuntime().snapshot.get(k(object, id, field));
}
export function snapshotSet(object: string, id: string, field: string, value: unknown): void {
  hubspotRuntime().snapshot.set(k(object, id, field), norm(value));
}

/** Tests only. */
export function resetHubSpotRuntime(): void {
  const rt = hubspotRuntime();
  if (rt.timer) clearInterval(rt.timer);
  (globalThis as G).__mainlineHubSpot = { echoes: new Map(), createdIds: new Map(), snapshot: new Map() };
}

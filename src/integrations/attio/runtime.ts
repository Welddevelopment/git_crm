/**
 * Process-wide Attio sync state (survives Next.js module duplication via globalThis):
 *  - echoes: fields Git CRM itself just wrote to Attio, so the poller doesn't import them back as "human" edits
 *  - snapshot: last-seen Attio value per (record, field), so polls only import what changed IN Attio
 *  - poller handle + last result for /api/integrations/attio/status
 */
export const ECHO_TTL_MS = 60_000;

export interface AttioImportResult {
  ok: boolean;
  mode: "full" | "changes";
  at: number;
  objects: Partial<Record<"companies" | "people" | "deals", number | "missing">>;
  created: string[];
  linked: string[];
  updated: { entity: string; fields: string[] }[];
  events: number;
  errors: string[];
}

interface AttioRuntime {
  echoes: Map<string, number>; // "<record_id>::<field>" -> expiresAt
  snapshot: Map<string, string>; // "<record_id>::<field>" -> JSON of last-seen mapped value
  timer?: ReturnType<typeof setInterval>;
  intervalMs?: number;
  running?: Promise<AttioImportResult>;
  lastRunAt?: number;
  lastResult?: AttioImportResult;
  lastError?: string;
  importedOnce?: boolean;
  /** whether the workspace has a deals object (cached; null = unknown) */
  hasDeals?: boolean | null;
}

type G = typeof globalThis & { __mainlineAttio?: AttioRuntime };
export function attioRuntime(): AttioRuntime {
  const g = globalThis as G;
  return (g.__mainlineAttio ??= { echoes: new Map(), snapshot: new Map(), hasDeals: null });
}

const k = (recordId: string, field: string) => `${recordId}::${field}`;

/** Called by the Attio adapter right before it writes these fields to an Attio record. */
export function markEcho(recordId: string, fields: string[], now = Date.now()): void {
  const rt = attioRuntime();
  for (const f of fields) rt.echoes.set(k(recordId, f), now + ECHO_TTL_MS);
}

export function isEcho(recordId: string, field: string, now = Date.now()): boolean {
  const rt = attioRuntime();
  const until = rt.echoes.get(k(recordId, field));
  if (until === undefined) return false;
  if (until < now) {
    rt.echoes.delete(k(recordId, field));
    return false;
  }
  return true;
}

export function snapshotGet(recordId: string, field: string): string | undefined {
  return attioRuntime().snapshot.get(k(recordId, field));
}
export function snapshotSet(recordId: string, field: string, value: unknown): void {
  attioRuntime().snapshot.set(k(recordId, field), JSON.stringify(value ?? null));
}

/** Tests only. */
export function resetAttioRuntime(): void {
  const rt = attioRuntime();
  if (rt.timer) clearInterval(rt.timer);
  (globalThis as G).__mainlineAttio = { echoes: new Map(), snapshot: new Map(), hasDeals: null };
}

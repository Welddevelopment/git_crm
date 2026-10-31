/**
 * Minimal HubSpot CRM v3 client (Bearer HUBSPOT_TOKEN, a private-app token). The token is read from the
 * environment at call time and is never logged or persisted. `fetchImpl` is injectable for tests.
 * Retries 429s (HubSpot: ~100 req/10s per private app, search API 5 req/s) with backoff.
 */
import type { HubSpotObject } from "./map";

export const HUBSPOT_BASE_URL = "https://api.hubapi.com";

export class HubSpotError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = "HubSpotError";
  }
}

export interface HubSpotClientOptions {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** sleep between 429 retries (tests pass a no-op) */
  sleep?: (ms: number) => Promise<void>;
}

export interface HubSpotAssociationRef { id: string; type?: string }
export interface HubSpotObjectRecord {
  id: string;
  properties: Record<string, string | null | undefined>;
  associations?: Record<string, { results: HubSpotAssociationRef[] }>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
}

export interface HubSpotCreateAssociation {
  to: { id: string };
  types: { associationCategory: "HUBSPOT_DEFINED" | "USER_DEFINED"; associationTypeId: number }[];
}

export function hubspotToken(): string | undefined {
  const t = process.env.HUBSPOT_TOKEN?.trim();
  return t ? t : undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HubSpotClient {
  readonly baseUrl: string;
  private token?: string;
  private doFetch: typeof fetch;
  private sleep: (ms: number) => Promise<void>;

  constructor(opts: HubSpotClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.HUBSPOT_BASE_URL ?? HUBSPOT_BASE_URL).replace(/\/+$/, "");
    this.token = opts.token;
    this.doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.sleep = opts.sleep ?? defaultSleep;
  }

  get configured(): boolean {
    return !!(this.token ?? hubspotToken());
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.token ?? hubspotToken();
    if (!token) throw new HubSpotError(401, "HUBSPOT_TOKEN not set");
    for (let attempt = 0; ; attempt++) {
      const res = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.status === 429 && attempt < 5) {
        const ra = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 600 * (attempt + 1));
        continue;
      }
      const text = await res.text().catch(() => "");
      let parsed: unknown = undefined;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
      if (!res.ok) {
        const msg = (parsed as { message?: unknown })?.message;
        throw new HubSpotError(res.status, `HubSpot ${method} ${path.split("?")[0]}: HTTP ${res.status}${typeof msg === "string" ? ` ${msg.slice(0, 300)}` : ""}`, parsed);
      }
      return parsed as T;
    }
  }

  /** GET /account-info/v3/details -> {portalId, timeZone, uiDomain, ...} */
  accountInfo(): Promise<{ portalId?: number; uiDomain?: string; timeZone?: string; [k: string]: unknown }> {
    return this.request("GET", "/account-info/v3/details");
  }

  /** Page through GET /crm/v3/objects/{object} (100 per page) up to `cap` records. */
  async list(object: HubSpotObject, properties: string[], opts: { associations?: string[]; cap?: number } = {}): Promise<HubSpotObjectRecord[]> {
    const cap = opts.cap ?? 200;
    const out: HubSpotObjectRecord[] = [];
    let after: string | undefined;
    do {
      const q = new URLSearchParams({ limit: String(Math.min(100, cap - out.length)), properties: properties.join(","), archived: "false" });
      if (opts.associations?.length) q.set("associations", opts.associations.join(","));
      if (after) q.set("after", after);
      const page = await this.request<{ results?: HubSpotObjectRecord[]; paging?: { next?: { after?: string } } }>("GET", `/crm/v3/objects/${object}?${q}`);
      out.push(...(page?.results ?? []));
      after = page?.paging?.next?.after;
    } while (after && out.length < cap);
    return out.slice(0, cap);
  }

  /** POST /crm/v3/objects/{object}/search for records modified at/after `sinceMs`. Paginates up to `cap`. */
  async searchModifiedSince(object: HubSpotObject, modifiedProperty: string, sinceMs: number, properties: string[], cap = 200): Promise<HubSpotObjectRecord[]> {
    const out: HubSpotObjectRecord[] = [];
    let after: string | undefined;
    do {
      const body: Record<string, unknown> = {
        filterGroups: [{ filters: [{ propertyName: modifiedProperty, operator: "GTE", value: String(Math.floor(sinceMs)) }] }],
        sorts: [{ propertyName: modifiedProperty, direction: "ASCENDING" }],
        properties,
        limit: Math.min(100, cap - out.length),
      };
      if (after) body.after = after;
      const page = await this.request<{ results?: HubSpotObjectRecord[]; paging?: { next?: { after?: string } } }>("POST", `/crm/v3/objects/${object}/search`, body);
      out.push(...(page?.results ?? []));
      after = page?.paging?.next?.after;
    } while (after && out.length < cap);
    return out.slice(0, cap);
  }

  /** v4 batch association read: record id -> associated company ids (primary first). Missing -> []. */
  async companyAssociations(object: "contacts" | "deals", ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const res = await this.request<{ results?: { from?: { id?: string | number }; to?: { toObjectId?: string | number; associationTypes?: { label?: string | null; typeId?: number }[] }[] }[] }>(
        "POST", `/crm/v4/associations/${object}/companies/batch/read`, { inputs: chunk.map((id) => ({ id })) },
      );
      for (const r of res?.results ?? []) {
        const from = r.from?.id;
        if (from === undefined) continue;
        const tos = [...(r.to ?? [])].sort((a, b) => Number((b.associationTypes ?? []).some((t) => t.label === "Primary")) - Number((a.associationTypes ?? []).some((t) => t.label === "Primary")));
        out.set(String(from), tos.map((t) => String(t.toObjectId)).filter((x) => x && x !== "undefined"));
      }
    }
    return out;
  }

  create(object: HubSpotObject, properties: Record<string, string>, associations?: HubSpotCreateAssociation[]): Promise<HubSpotObjectRecord> {
    return this.request("POST", `/crm/v3/objects/${object}`, { properties, ...(associations?.length ? { associations } : {}) });
  }

  update(object: HubSpotObject, id: string, properties: Record<string, string>): Promise<HubSpotObjectRecord> {
    return this.request("PATCH", `/crm/v3/objects/${object}/${encodeURIComponent(id)}`, { properties });
  }

  /** PUT the default (primary) association record -> company. */
  associateCompany(object: "contacts" | "deals", id: string, companyId: string): Promise<unknown> {
    return this.request("PUT", `/crm/v4/objects/${object}/${encodeURIComponent(id)}/associations/default/companies/${encodeURIComponent(companyId)}`);
  }
}

/** First company id from a v3 record's `associations.companies` (prefers the primary/labelled type). */
export function associatedCompanyId(rec: HubSpotObjectRecord): string | null {
  const results = rec.associations?.companies?.results ?? [];
  if (!results.length) return null;
  const primary = results.find((r) => r.type && !/unlabeled/i.test(r.type)) ?? results[0]!;
  return primary.id ? String(primary.id) : null;
}

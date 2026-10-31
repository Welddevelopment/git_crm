/**
 * Minimal Attio REST v2 client (Bearer ATTIO_TOKEN). Token is read from the environment at call time and is
 * never logged or persisted. `fetchImpl` is injectable for tests.
 */
import type { AttioObject, AttioRecord } from "./map";

export const ATTIO_BASE_URL = "https://api.attio.com/v2";

export class AttioError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = "AttioError";
  }
}

export interface AttioClientOptions {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface AttioSelf {
  active?: boolean;
  workspace_id?: string;
  workspace_name?: string;
  workspace_slug?: string;
  [k: string]: unknown;
}

export interface AttioMember {
  id: { workspace_id?: string; workspace_member_id: string };
  first_name?: string | null;
  last_name?: string | null;
  email_address?: string | null;
}

export function attioToken(): string | undefined {
  const t = process.env.ATTIO_TOKEN?.trim();
  return t ? t : undefined;
}

export class AttioClient {
  readonly baseUrl: string;
  private token?: string;
  private doFetch: typeof fetch;

  constructor(opts: AttioClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.ATTIO_BASE_URL ?? ATTIO_BASE_URL).replace(/\/+$/, "");
    this.token = opts.token;
    this.doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  get configured(): boolean {
    return !!(this.token ?? attioToken());
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.token ?? attioToken();
    if (!token) throw new AttioError(401, "ATTIO_TOKEN not set");
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.status !== 429 || attempt >= 3) break;
      const after = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 5000) : 500 * (attempt + 1)));
    }
    const text = await res.text().catch(() => "");
    let parsed: unknown = undefined;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    if (!res.ok) {
      const msg = (parsed && typeof parsed === "object" && "message" in parsed ? String((parsed as { message: unknown }).message) : text).slice(0, 300);
      throw new AttioError(res.status, `Attio ${method} ${path}: HTTP ${res.status}${msg ? ` ${msg}` : ""}`, parsed);
    }
    return parsed as T;
  }

  self(): Promise<AttioSelf> {
    return this.request<AttioSelf>("GET", "/self");
  }

  /** true if the object exists in this workspace (deals is optional in Attio). */
  async hasObject(object: AttioObject): Promise<boolean> {
    try {
      await this.request("GET", `/objects/${object}`);
      return true;
    } catch (e) {
      if (e instanceof AttioError && (e.status === 404 || e.status === 400)) return false;
      throw e;
    }
  }

  async query(object: AttioObject, body: { limit?: number; offset?: number; filter?: unknown; sorts?: unknown } = {}): Promise<AttioRecord[]> {
    const r = await this.request<{ data?: AttioRecord[] }>("POST", `/objects/${object}/records/query`, { limit: 500, offset: 0, ...body });
    return r?.data ?? [];
  }

  /** All records of an object (paginates; capped so a huge workspace can't stall the poll loop). */
  async listAll(object: AttioObject, max = 5000): Promise<AttioRecord[]> {
    const out: AttioRecord[] = [];
    const limit = 500;
    for (let offset = 0; offset < max; offset += limit) {
      const page = await this.query(object, { limit, offset });
      out.push(...page);
      if (page.length < limit) break;
    }
    return out;
  }

  async get(object: AttioObject, recordId: string): Promise<AttioRecord> {
    const r = await this.request<{ data: AttioRecord }>("GET", `/objects/${object}/records/${encodeURIComponent(recordId)}`);
    return r.data;
  }

  async create(object: AttioObject, values: Record<string, unknown>): Promise<AttioRecord> {
    const r = await this.request<{ data: AttioRecord }>("POST", `/objects/${object}/records`, { data: { values } });
    return r.data;
  }

  async update(object: AttioObject, recordId: string, values: Record<string, unknown>): Promise<AttioRecord> {
    const r = await this.request<{ data: AttioRecord }>("PATCH", `/objects/${object}/records/${encodeURIComponent(recordId)}`, { data: { values } });
    return r.data;
  }

  async members(): Promise<AttioMember[]> {
    try {
      const r = await this.request<{ data?: AttioMember[] }>("GET", "/workspace_members");
      return r?.data ?? [];
    } catch {
      return [];
    }
  }
}

/** Server-side filter for a natural key; used to find an existing record before creating one. */
export function naturalKeyFilter(object: AttioObject, key: string): unknown {
  if (object === "companies") return { domains: { domain: { $eq: key.toLowerCase() } } };
  if (object === "people") return { email_addresses: { email_address: { $eq: key.toLowerCase() } } };
  return { name: key };
}

/** Attribute slugs whose values must match pre-defined options in the workspace (dropped on a 400 retry). */
export const OPTION_SLUGS = ["categories", "employee_range", "stage"];

/** Write, retrying once without option-backed slugs if Attio rejects the values (e.g. unknown category title). */
export async function writeWithOptionFallback<T>(values: Record<string, unknown>, write: (v: Record<string, unknown>) => Promise<T>): Promise<T> {
  try {
    return await write(values);
  } catch (e) {
    const risky = OPTION_SLUGS.filter((s) => s in values);
    if (!(e instanceof AttioError) || e.status !== 400 || !risky.length) throw e;
    const rest = { ...values };
    for (const s of risky) delete rest[s];
    if (!Object.keys(rest).length) throw e;
    return write(rest);
  }
}

/** Deal owner name ("Joel") -> workspace member id; falls back to the first member (Attio deals need an owner). */
export function ownerResolver(members: AttioMember[]) {
  return (owner: string): string | undefined => {
    const o = owner.trim().toLowerCase();
    const hit = members.find((m) => {
      const full = [m.first_name, m.last_name].filter(Boolean).join(" ").toLowerCase();
      return full === o || (m.first_name ?? "").toLowerCase() === o || (m.email_address ?? "").toLowerCase().startsWith(`${o}@`);
    });
    return (hit ?? members[0])?.id.workspace_member_id;
  };
}

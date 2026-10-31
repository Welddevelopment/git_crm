/** In-memory fake of the Attio REST v2 endpoints we use. Tests only (no network). */
import type { AttioRecord } from "./map";

type Obj = "companies" | "people" | "deals";
export interface FakeAttio {
  fetch: typeof fetch;
  records: Record<Obj, AttioRecord[]>;
  calls: { method: string; path: string; body?: unknown }[];
  /** simulate a human editing a value in Attio (closes the active entry, appends a new one) */
  edit(object: Obj, recordId: string, slug: string, entry: Record<string, unknown>): void;
}

let n = 0;
const nowIso = () => new Date().toISOString();

/** Write shorthand -> stored entry shape. */
function toEntries(slug: string, raw: unknown): Record<string, unknown>[] {
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((v) => {
    const base = { active_from: nowIso(), active_until: null };
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (slug === "name" && ("first_name" in o || "full_name" in o)) return { ...base, ...o, full_name: o.full_name ?? [o.first_name, o.last_name].filter(Boolean).join(" ") };
      return { ...base, ...o };
    }
    if (slug === "domains") return { ...base, domain: v };
    if (slug === "email_addresses") return { ...base, email_address: v };
    if (slug === "value") return { ...base, currency_value: v };
    if (slug === "stage") return { ...base, status: { title: v } };
    if (slug === "employee_range" || slug === "categories") return { ...base, option: { title: v } };
    return { ...base, value: v };
  });
}

export function fakeAttio(opts: { deals?: boolean; members?: { id: string; first_name: string }[] } = {}): FakeAttio {
  const records: Record<Obj, AttioRecord[]> = { companies: [], people: [], deals: [] };
  const calls: FakeAttio["calls"] = [];
  const hasDeals = opts.deals !== false;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fake: FakeAttio = {
    records,
    calls,
    edit(object, recordId, slug, entry) {
      const r = records[object].find((x) => x.id.record_id === recordId)!;
      const prev = (r.values[slug] as Record<string, unknown>[] | undefined) ?? [];
      for (const p of prev) if (p.active_until == null) p.active_until = nowIso();
      r.values[slug] = [...prev, { active_from: nowIso(), active_until: null, ...entry }];
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/v2/, "");
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (path === "/self") return json(200, { active: true, workspace_id: "ws_1", workspace_name: "Test WS", workspace_slug: "test-ws" });
      if (path === "/workspace_members") return json(200, { data: (opts.members ?? [{ id: "wm_1", first_name: "Joel" }]).map((m) => ({ id: { workspace_member_id: m.id }, first_name: m.first_name, last_name: "" })) });
      const m = path.match(/^\/objects\/(companies|people|deals)(?:\/records(?:\/([^/]+))?)?$/);
      if (!m) return json(404, { message: "not found" });
      const object = m[1] as Obj;
      if (object === "deals" && !hasDeals) return json(404, { status_code: 404, message: "Object not found" });
      const list = records[object];
      if (!path.includes("/records")) return json(200, { data: { api_slug: object } });
      const id = m[2];
      if (method === "POST" && id === "query") {
        let out = list;
        const f = body?.filter as Record<string, unknown> | undefined;
        if (f?.domains) {
          const d = (f.domains as { domain: { $eq: string } }).domain.$eq;
          out = list.filter((r) => ((r.values.domains as { domain: string }[]) ?? []).some((e) => e.domain.toLowerCase() === d));
        } else if (f?.email_addresses) {
          const d = (f.email_addresses as { email_address: { $eq: string } }).email_address.$eq;
          out = list.filter((r) => ((r.values.email_addresses as { email_address: string }[]) ?? []).some((e) => e.email_address.toLowerCase() === d));
        } else if (f?.name) {
          out = list.filter((r) => ((r.values.name as { value: string }[]) ?? []).some((e) => e.value === f.name));
        }
        const off = Number(body?.offset ?? 0);
        return json(200, { data: out.slice(off, off + Number(body?.limit ?? 500)) });
      }
      if (method === "POST" && !id) {
        const rid = `rec_${object}_${++n}`;
        const values: Record<string, unknown> = {};
        for (const [slug, v] of Object.entries(body.data.values)) values[slug] = toEntries(slug, v);
        const rec: AttioRecord = { id: { workspace_id: "ws_1", object_id: object, record_id: rid }, values };
        list.push(rec);
        return json(200, { data: rec });
      }
      const rec = list.find((r) => r.id.record_id === id);
      if (!rec) return json(404, { message: "Record not found" });
      if (method === "GET") return json(200, { data: rec });
      if (method === "PATCH") {
        for (const [slug, v] of Object.entries(body.data.values)) {
          const prev = (rec.values[slug] as Record<string, unknown>[] | undefined) ?? [];
          for (const p of prev) if (p.active_until == null) p.active_until = nowIso();
          rec.values[slug] = [...prev, ...toEntries(slug, v)];
        }
        return json(200, { data: rec });
      }
      return json(405, { message: "method" });
    }) as typeof fetch,
  };
  return fake;
}

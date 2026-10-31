/**
 * Attio-compatible write proxy. An agent points its Attio client at
 *   <mainline>/api/proxy/attio/v2
 * instead of https://api.attio.com/v2. Writes never reach Attio: they become a Mainline PR (branch + policy +
 * staleness), and only merged changes are pushed to Attio by the adapter. Reads are served from main.
 *
 * The record id in the path may be an Attio record_id (matched via attrs.attioId) or a Mainline id/slug
 * (`acme-platform` with object deals -> deal:acme-platform), so the proxy works without a real Attio.
 * The caller's Authorization header is ignored and never forwarded or stored.
 */
import type { Actor, CRMState, EntityId, EntityRecord, FieldValue, NewEvent, PullRequest } from "../../core/types";
import type { Repo } from "../../server/repo";
import { resolveAttioRecord } from "./index";
import {
  OBJECT_TYPE, SLUG_FIELD, mapAttioRecord, normalizeObject, resolveAlias, sameValue, toAttioRecord,
  type AttioObject, type AttioRecord,
} from "./map";

export type ProxyRepo = Pick<Repo, "state" | "propose" | "merge">;

export interface ProxyRequest {
  method: string;
  object: string;
  /** path segments after /records: [] (create / list), [id] (get / update), ["query"] */
  rest: string[];
  body: unknown;
  agent?: string | null;
  reason?: string | null;
  /** absolute origin of the Mainline app, for prUrl */
  origin: string;
}

export interface ProxyResult {
  status: number;
  body: unknown;
}

export interface MainlineMeta {
  status: "pending_review" | "auto_merged" | "blocked" | "no_change";
  pr: string | null;
  prUrl: string | null;
  tier: string | null;
  reasons: string[];
  entity: EntityId;
  conflicts?: number;
  staleness?: string;
}

const attioError = (status: number, code: string, message: string): ProxyResult => ({
  status,
  body: { status_code: status, type: "invalid_request_error", code, message },
});

const safeDecode = (s: string) => {
  try { return decodeURIComponent(s); } catch { return s; }
};
const SYSTEM_MERGE: Actor = { kind: "system", id: "merge" };
const AGENT_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

function slugify(s: string): string {
  return s.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 48);
}

/** Extract `data.values` (Attio write body). Also accepts a bare `{values}` for forgiving clients. */
function valuesOf(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { data?: { values?: unknown }; values?: unknown };
  const v = b.data?.values ?? b.values;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function bodyMeta(body: unknown): { title?: string; reason?: string; evidence?: NewEvent["evidence"] } {
  const m = body && typeof body === "object" ? (body as { mainline?: unknown }).mainline : undefined;
  if (!m || typeof m !== "object") return {};
  const o = m as { title?: unknown; reason?: unknown; evidence?: unknown };
  const out: { title?: string; reason?: string; evidence?: NewEvent["evidence"] } = {};
  if (typeof o.title === "string" && o.title.trim()) out.title = o.title.trim().slice(0, 200);
  if (typeof o.reason === "string" && o.reason.trim()) out.reason = o.reason.trim().slice(0, 1000);
  if (Array.isArray(o.evidence)) {
    out.evidence = o.evidence
      .filter((e): e is { docId: string; claim: string; quote?: string } => !!e && typeof e === "object" && typeof (e as { docId?: unknown }).docId === "string" && typeof (e as { claim?: unknown }).claim === "string")
      .map((e) => ({ docId: e.docId, claim: e.claim, ...(typeof e.quote === "string" ? { quote: e.quote } : {}) }));
  }
  return out;
}

/** Map an Attio write body to our attrs (Attio slugs, plus our own field names for fields Attio lacks). */
function mapWrite(object: AttioObject, values: Record<string, unknown>, state: CRMState) {
  const rec: AttioRecord = { id: { record_id: "" }, values };
  const m = mapAttioRecord(object, rec, { resolveRef: (_o, rid) => resolveAttioRecord(state, "companies", rid) });
  const type = OBJECT_TYPE[object];
  const schemaFields = new Set((state.schema[type] ?? []).map((d) => d.field));
  for (const [k, raw] of Object.entries(values)) {
    if (k in SLUG_FIELD || !schemaFields.has(k) || k in m.attrs) continue;
    const v = Array.isArray(raw) && raw.length === 1 && (typeof raw[0] !== "object" || raw[0] === null) ? raw[0] : raw;
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) m.attrs[k] = v as FieldValue;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) m.attrs[k] = v as string[];
  }
  const unresolvedRef = m.refs.company && !m.attrs.company ? m.refs.company : undefined;
  return { m, unresolvedRef };
}

function describe(entity: EntityRecord | undefined, attrs: Record<string, FieldValue>, prev?: Record<string, FieldValue>): string {
  return Object.entries(attrs)
    .map(([k, v]) => (prev && k in prev ? `- ${k}: ${JSON.stringify(prev[k] ?? null)} → ${JSON.stringify(v)}` : `- ${k}: ${JSON.stringify(v)}`))
    .join("\n") + (entity ? `\n\nEntity: ${entity.id}` : "");
}

const label = (e: EntityRecord | undefined, fallback: string) => String(e?.attrs.name ?? fallback);

async function finish(repo: ProxyRepo, pr: PullRequest, object: AttioObject, entityId: EntityId, origin: string): Promise<ProxyResult> {
  let status: MainlineMeta["status"] = pr.policy?.tier === "block" ? "blocked" : "pending_review";
  let final = pr;
  const unresolved = (pr.conflicts ?? []).some((c) => !c.autoResolved && c.resolution === undefined);
  if (pr.policy?.tier === "auto" && !unresolved && pr.staleness?.status !== "stale") {
    try {
      final = (await repo.merge(pr.id, SYSTEM_MERGE)).pr;
      status = "auto_merged";
    } catch {
      status = "pending_review";
    }
  }
  const state = await repo.state(status === "auto_merged" ? undefined : { branch: pr.branch });
  const ent = state.entities[resolveAlias(state, entityId)];
  const record = ent ? toAttioRecord(ent, state) : { id: { workspace_id: "mainline", object_id: object, record_id: entityId }, values: {} };
  const meta: MainlineMeta = {
    status,
    pr: final.id,
    prUrl: `${origin}/prs/${encodeURIComponent(final.id)}`,
    tier: final.policy?.tier ?? null,
    reasons: final.policy?.reasons ?? [],
    entity: entityId,
    conflicts: (final.conflicts ?? []).length,
    ...(final.staleness ? { staleness: final.staleness.status } : {}),
  };
  return { status: 202, body: { data: record, mainline: meta } };
}

export async function handleAttioProxy(repo: ProxyRepo, req: ProxyRequest): Promise<ProxyResult> {
  const object = normalizeObject(req.object);
  if (!object) return attioError(404, "not_found", `Object "${req.object}" is not supported by the Mainline Attio proxy (companies, people, deals).`);
  const type = OBJECT_TYPE[object];
  const method = req.method.toUpperCase();
  const agentRaw = (req.agent ?? "").trim();
  const agent = agentRaw && AGENT_RE.test(agentRaw) ? agentRaw : "external-agent";
  const author: Actor = { kind: "agent", id: agent };
  const meta = bodyMeta(req.body);
  const reason = (req.reason ?? "").trim().slice(0, 1000) || meta.reason;
  const [first, ...extra] = req.rest;
  if (extra.length) return attioError(404, "not_found", "Unsupported path");

  const state = await repo.state();

  // ---- reads (served from main) ----
  if (method === "GET" && !first) return listRecords(state, object, {});
  if (method === "POST" && first === "query") return listRecords(state, object, (req.body ?? {}) as { limit?: unknown; offset?: unknown });
  if (method === "GET" && first) {
    const id = resolveAttioRecord(state, object, safeDecode(first));
    const ent = id ? state.entities[id] : undefined;
    if (!ent) return attioError(404, "not_found", `Record ${first} not found`);
    return { status: 200, body: { data: toAttioRecord(ent, state) } };
  }

  const values = valuesOf(req.body);
  if (method === "POST" && !first) {
    if (!values) return attioError(400, "validation_type", "Body must be {data:{values:{...}}}");
    const { m, unresolvedRef } = mapWrite(object, values, state);
    if (unresolvedRef) return attioError(400, "validation_type", `Referenced company ${unresolvedRef} not found`);
    if (!Object.keys(m.attrs).length) return attioError(400, "validation_type", "No mappable values (see supported attributes)");
    const base = slugify(String(m.attrs.name ?? m.attrs.email ?? m.attrs.domain ?? "")) || `new-${Date.now().toString(36)}`;
    let entity = `${type}:${base}`;
    for (let n = 2; state.entities[entity] || state.aliases[entity]; n++) entity = `${type}:${base}-${n}`;
    const name = label(undefined, entity);
    const pr = await repo.propose(agent, {
      title: meta.title ?? `Create ${type} "${String(m.attrs.name ?? entity)}" (via Attio API)`,
      description: `${agent} called POST /v2/objects/${object}/records through the Mainline Attio proxy.\n\n${describe(undefined, m.attrs)}${reason ? `\n\nReason: ${reason}` : ""}`,
      events: [{ actor: author, op: { type: "entity.create", entity, entityType: type, attrs: m.attrs }, reason: reason ?? `Create ${name} via Attio API`, ...(meta.evidence?.length ? { evidence: meta.evidence } : {}) }],
    });
    return finish(repo, pr, object, entity, req.origin);
  }

  if ((method === "PATCH" || method === "PUT") && first) {
    if (!values) return attioError(400, "validation_type", "Body must be {data:{values:{...}}}");
    const entityId = resolveAttioRecord(state, object, safeDecode(first));
    const ent = entityId ? state.entities[entityId] : undefined;
    if (!entityId || !ent || ent.deleted) return attioError(404, "not_found", `Record ${first} not found`);
    const { m, unresolvedRef } = mapWrite(object, values, state);
    if (unresolvedRef) return attioError(400, "validation_type", `Referenced company ${unresolvedRef} not found`);
    const changes: Record<string, FieldValue> = {};
    const prev: Record<string, FieldValue> = {};
    for (const [field, value] of Object.entries(m.attrs)) {
      if (sameValue(m, field, ent.attrs[field])) continue;
      changes[field] = value;
      prev[field] = ent.attrs[field] ?? null;
    }
    if (!Object.keys(changes).length) {
      const noop: MainlineMeta = { status: "no_change", pr: null, prUrl: null, tier: null, reasons: ["Values already match main"], entity: entityId };
      return { status: 200, body: { data: toAttioRecord(ent, state), mainline: noop } };
    }
    const readSet: Record<string, number> = {};
    for (const f of Object.keys(changes)) readSet[`${entityId}::${f}`] = state.versions[`${entityId}::${f}`] ?? 0;
    const fields = Object.keys(changes);
    const pr = await repo.propose(agent, {
      title: meta.title ?? `Update ${label(ent, entityId)}: ${fields.join(", ")} (via Attio API)`,
      description: `${agent} called ${method} /v2/objects/${object}/records/${first} through the Mainline Attio proxy.\n\n${describe(ent, changes, prev)}${reason ? `\n\nReason: ${reason}` : ""}`,
      readSet,
      events: fields.map((field) => ({
        actor: author,
        op: { type: "field.set" as const, entity: entityId, field, value: changes[field]!, prev: prev[field] ?? null },
        reason: reason ?? `Set ${field} via Attio API`,
        ...(meta.evidence?.length ? { evidence: meta.evidence } : {}),
      })),
    });
    return finish(repo, pr, object, entityId, req.origin);
  }

  return attioError(405, "method_not_allowed", `${method} not supported on this path`);
}

function listRecords(state: CRMState, object: AttioObject, body: { limit?: unknown; offset?: unknown }): ProxyResult {
  const type = OBJECT_TYPE[object];
  const limit = Math.min(Math.max(Number(body.limit) || 500, 1), 500);
  const offset = Math.max(Number(body.offset) || 0, 0);
  const all = Object.values(state.entities).filter((e) => e.type === type && !e.deleted && !e.mergedInto);
  return { status: 200, body: { data: all.slice(offset, offset + limit).map((e) => toAttioRecord(e, state)) } };
}

/** Public origin of the request (honours Railway's x-forwarded-* headers). */
export function requestOrigin(req: Request): string {
  const env = process.env.MAINLINE_PUBLIC_URL?.replace(/\/+$/, "");
  if (env) return env;
  const u = new URL(req.url);
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || u.host;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || u.protocol.replace(":", "");
  return `${proto}://${host}`;
}

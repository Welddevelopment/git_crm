/**
 * HubSpot-compatible write proxy. An agent that already talks to HubSpot changes ONE thing, its base URL:
 *   https://api.hubapi.com  ->  <mainline>/api/proxy/hubspot
 * Writes never reach HubSpot directly: they become a Mainline PR (branch + policy + staleness + review), and
 * only merged changes are pushed to HubSpot by the adapter. Reads are served from main.
 *
 *   PATCH /crm/v3/objects/{type}/{id}   update -> field.set PR      (202)
 *   POST  /crm/v3/objects/{type}        create -> entity.create PR  (202)
 *   GET   /crm/v3/objects/{type}/{id}   read from main
 *   GET   /crm/v3/objects/{type}        list from main
 *   POST  /crm/v3/objects/{type}/search list from main (filters ignored except a simple EQ)
 *
 * {type}: deals|contacts|companies|0-1|0-2|0-3. {id}: HubSpot record id (attrs.hubspotId) or a Mainline id/slug
 * (`acme-platform` with type deals -> deal:acme-platform), so the proxy works without a real HubSpot portal.
 * Actor: header `x-mainline-agent` (default "external-agent"). Reason: header `x-mainline-reason` or body
 * `mainline: {reason, title?, evidence: [{docId?, quote?, claim}]}`. The caller's Authorization header is ignored.
 */
import type { Actor, CRMState, EntityId, EntityRecord, EvidenceRef, FieldValue, NewEvent, PullRequest } from "../../core/types";
import type { Repo } from "../../server/repo";
import {
  OBJECT_TYPE, normalizeObject, propertiesToAttrs, resolveAlias, resolveHubSpotRecord, sameValue, toHubSpotObject,
  type HubSpotObject,
} from "./map";

export type ProxyRepo = Pick<Repo, "state" | "propose" | "merge">;

export interface ProxyRequest {
  method: string;
  objectType: string;
  /** path segments after /objects/{type}: [] (create / list), [id] (get / update), ["search"] */
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
  fields: string[];
  conflicts?: number;
  staleness?: string;
}

/** HubSpot-style error JSON. */
export function hubspotError(status: number, category: string, message: string, extra: Record<string, unknown> = {}): ProxyResult {
  return {
    status,
    body: { status: "error", message, correlationId: `mainline-${Date.now().toString(36)}`, category, ...extra },
  };
}

const SYSTEM_MERGE: Actor = { kind: "system", id: "merge" };
const AGENT_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

function slugify(s: string): string {
  return s.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 48);
}

function titleCase(agent: string): string {
  return agent.split(/[-_.]/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ") || agent;
}

interface BodyMeta { title?: string; reason?: string; evidence?: EvidenceRef[] }
function bodyMeta(body: unknown): BodyMeta {
  const m = body && typeof body === "object" ? (body as { mainline?: unknown }).mainline : undefined;
  if (!m || typeof m !== "object") return {};
  const o = m as { title?: unknown; reason?: unknown; evidence?: unknown };
  const out: BodyMeta = {};
  if (typeof o.title === "string" && o.title.trim()) out.title = o.title.trim().slice(0, 200);
  if (typeof o.reason === "string" && o.reason.trim()) out.reason = o.reason.trim().slice(0, 1000);
  if (Array.isArray(o.evidence)) {
    out.evidence = o.evidence
      .filter((e): e is { docId?: unknown; claim: string; quote?: unknown } => !!e && typeof e === "object" && typeof (e as { claim?: unknown }).claim === "string")
      .slice(0, 10)
      .map((e, i) => ({
        docId: typeof e.docId === "string" && e.docId ? e.docId : `external_${i + 1}`,
        claim: e.claim.slice(0, 500),
        ...(typeof e.quote === "string" && e.quote ? { quote: e.quote.slice(0, 300) } : {}),
      }));
  }
  return out;
}

function propertiesOf(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const p = (body as { properties?: unknown }).properties;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
}

/** Company association from a create body (`associations: [{to:{id}, types:[...]}]`) or a `company` property. */
function companyRef(state: CRMState, body: unknown, props: Record<string, unknown>): { id: EntityId | null; raw: string | null } {
  const assoc = (body as { associations?: unknown })?.associations;
  const raws: string[] = [];
  if (Array.isArray(assoc)) {
    for (const a of assoc) {
      const to = (a as { to?: { id?: unknown } })?.to?.id;
      if (to !== undefined && to !== null && String(to)) raws.push(String(to));
    }
  }
  for (const k of ["company", "associatedcompanyid"]) {
    const v = props[k];
    if (typeof v === "string" || typeof v === "number") raws.push(String(v));
  }
  for (const r of raws) {
    const id = resolveHubSpotRecord(state, "companies", r);
    if (id) return { id, raw: r };
  }
  return { id: null, raw: raws[0] ?? null };
}

function mapWrite(state: CRMState, type: string, props: Record<string, unknown>) {
  const extra = new Set((state.schema[type] ?? []).map((d) => d.field));
  extra.delete("company");
  extra.delete("hubspotId");
  const clean = { ...props };
  delete clean.company;
  delete clean.associatedcompanyid;
  return propertiesToAttrs(type, clean, { extraFields: extra });
}

const fmt = (v: FieldValue | undefined) => (v === undefined || v === null || v === "" ? "∅" : Array.isArray(v) ? v.join(", ") : String(v));
const label = (e: EntityRecord | undefined, fallback: string) => String(e?.attrs.name ?? fallback);

async function finish(
  repo: ProxyRepo, pr: PullRequest, entityId: EntityId, fields: string[], origin: string, created: boolean,
): Promise<ProxyResult> {
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
  // Show the record as it would look with the change (branch head), or main if it already merged.
  const state = await repo.state(status === "auto_merged" ? undefined : { branch: final.branch });
  const ent = state.entities[resolveAlias(state, entityId)];
  const obj = ent ? toHubSpotObject(ent, state) : { id: entityId, properties: {} };
  const meta: MainlineMeta = {
    status,
    pr: final.id,
    prUrl: `${origin}/prs/${encodeURIComponent(final.id)}`,
    tier: final.policy?.tier ?? null,
    reasons: final.policy?.reasons ?? [],
    entity: entityId,
    fields,
    conflicts: (final.conflicts ?? []).length,
    ...(final.staleness ? { staleness: final.staleness.status } : {}),
  };
  void created;
  return { status: 202, body: { ...obj, mainline: meta } };
}

function listObjects(state: CRMState, object: HubSpotObject, body: unknown, query?: { limit?: unknown }): ProxyResult {
  const type = OBJECT_TYPE[object];
  const b = (body ?? {}) as { limit?: unknown; after?: unknown; filterGroups?: unknown };
  const limit = Math.min(Math.max(Number(b.limit ?? query?.limit) || 100, 1), 200);
  const after = Math.max(Number(b.after) || 0, 0);
  let all = Object.values(state.entities).filter((e) => e.type === type && !e.deleted && !e.mergedInto);
  // Minimal search support: EQ filters on mapped properties (e.g. {propertyName:"domain", operator:"EQ", value}).
  const groups = Array.isArray(b.filterGroups) ? (b.filterGroups as { filters?: { propertyName?: string; operator?: string; value?: unknown }[] }[]) : [];
  if (groups.length) {
    all = all.filter((e) => {
      const props = toHubSpotObject(e, state).properties;
      return groups.some((g) => (g.filters ?? []).every((f) => {
        if (!f.propertyName || (f.operator ?? "EQ") !== "EQ") return true;
        return String(props[f.propertyName] ?? "").toLowerCase() === String(f.value ?? "").toLowerCase();
      }));
    });
  }
  const page = all.slice(after, after + limit).map((e) => toHubSpotObject(e, state));
  const next = after + limit < all.length ? { paging: { next: { after: String(after + limit) } } } : {};
  return { status: 200, body: { total: all.length, results: page, ...next } };
}

type UpdatePlan =
  | { error: ProxyResult }
  | { entityId: EntityId; changes: Record<string, FieldValue>; prev: Record<string, FieldValue>; fields: string[]; ignored: string[] };

function planUpdate(state: CRMState, type: string, object: HubSpotObject, rid: string, props: Record<string, unknown>): UpdatePlan {
  const entityId = resolveHubSpotRecord(state, object, rid);
  const ent = entityId ? state.entities[entityId] : undefined;
  if (!entityId || !ent || ent.deleted) {
    return { error: hubspotError(404, "OBJECT_NOT_FOUND", `resource not found: no ${object.slice(0, -1)} with id ${rid}`, { context: { id: [rid] } }) };
  }
  const m = mapWrite(state, type, props);
  if (m.invalid.length) return { error: hubspotError(400, "VALIDATION_ERROR", m.invalid.map((i) => `${i.property}: ${i.reason}`).join("; "), { errors: m.invalid }) };
  if (type !== "company" && (props.company !== undefined || props.associatedcompanyid !== undefined)) {
    const ref = companyRef(state, undefined, props);
    if (!ref.id) return { error: hubspotError(400, "VALIDATION_ERROR", `Associated company ${ref.raw} not found`) };
    m.attrs.company = ref.id;
  }
  const changes: Record<string, FieldValue> = {};
  const prev: Record<string, FieldValue> = {};
  for (const [field, value] of Object.entries(m.attrs)) {
    if (sameValue(field, value, ent.attrs[field])) continue;
    changes[field] = value;
    prev[field] = ent.attrs[field] ?? null;
  }
  return { entityId, changes, prev, fields: Object.keys(changes), ignored: m.ignored };
}

export async function handleHubSpotProxy(repo: ProxyRepo, req: ProxyRequest): Promise<ProxyResult> {
  const object = normalizeObject(req.objectType);
  if (!object) return hubspotError(400, "VALIDATION_ERROR", `Unable to infer object type from: ${req.objectType}. The Mainline HubSpot proxy supports deals, contacts and companies.`);
  const type = OBJECT_TYPE[object];
  const method = req.method.toUpperCase();
  const agentRaw = (req.agent ?? "").trim();
  const agent = agentRaw && AGENT_RE.test(agentRaw) ? agentRaw : "external-agent";
  const author: Actor = { kind: "agent", id: agent, name: titleCase(agent) };
  const meta = bodyMeta(req.body);
  const reason = (req.reason ?? "").trim().slice(0, 1000) || meta.reason;
  const evidence = meta.evidence?.length ? { evidence: meta.evidence } : {};
  const [first, ...extra] = req.rest;
  if (extra.length && !(first === "batch" && extra.length === 1)) return hubspotError(404, "OBJECT_NOT_FOUND", "Unsupported path");

  const state = await repo.state();

  // ---- reads (served from main) ----
  if (method === "GET" && !first) return listObjects(state, object, undefined);
  if (method === "POST" && first === "search" && !extra.length) return listObjects(state, object, req.body);
  if (method === "GET" && first && !extra.length) {
    const id = resolveHubSpotRecord(state, object, decodeURIComponent(first));
    const ent = id ? state.entities[id] : undefined;
    if (!ent || ent.deleted) return hubspotError(404, "OBJECT_NOT_FOUND", `Object not found.  objectId are usually numeric.`, { context: { id: [first] } });
    return { status: 200, body: toHubSpotObject(ent, state) };
  }

  const props = propertiesOf(req.body);

  // ---- create ----
  if (method === "POST" && !first) {
    if (!props) return hubspotError(400, "VALIDATION_ERROR", "Body must be {properties: {...}}");
    const m = mapWrite(state, type, props);
    if (m.invalid.length) return hubspotError(400, "VALIDATION_ERROR", m.invalid.map((i) => `${i.property}: ${i.reason}`).join("; "), { errors: m.invalid });
    const ref = type === "company" ? { id: null, raw: null } : companyRef(state, req.body, props);
    if (ref.raw && !ref.id) return hubspotError(400, "VALIDATION_ERROR", `Associated company ${ref.raw} not found`);
    if (ref.id) m.attrs.company = ref.id;
    if (!Object.keys(m.attrs).length) return hubspotError(400, "VALIDATION_ERROR", "No mappable properties");
    const base = slugify(String(m.attrs.name ?? m.attrs.email ?? m.attrs.domain ?? "")) || `new-${Date.now().toString(36)}`;
    let entity = `${type}:${base}`;
    for (let n = 2; state.entities[entity] || state.aliases[entity]; n++) entity = `${type}:${base}-${n}`;
    const name = String(m.attrs.name ?? entity);
    const fields = Object.keys(m.attrs);
    const pr = await repo.propose(agent, {
      title: meta.title ?? `${author.name} via HubSpot API: create ${type} ${name}`,
      description:
        `${author.name} called POST /crm/v3/objects/${object} through the Mainline HubSpot proxy (the write was intercepted, not sent to HubSpot).\n\n` +
        fields.map((f) => `- ${f}: ${fmt(m.attrs[f])}`).join("\n") +
        (m.ignored.length ? `\n\nIgnored properties: ${m.ignored.join(", ")}` : "") +
        (reason ? `\n\nReason: ${reason}` : ""),
      events: [{ actor: author, op: { type: "entity.create", entity, entityType: type, attrs: m.attrs }, reason: reason ?? `Create ${name} via HubSpot API`, ...evidence }],
    });
    return finish(repo, pr, entity, fields, req.origin, true);
  }

  // ---- update (single, or batch/update -> one PR) ----
  const isBatch = method === "POST" && first === "batch" && extra[0] === "update" && extra.length === 1;
  if (((method === "PATCH" || method === "PUT") && first && !extra.length) || isBatch) {
    const inputs: { id: string; properties: Record<string, unknown> | null }[] = isBatch
      ? (Array.isArray((req.body as { inputs?: unknown })?.inputs) ? ((req.body as { inputs: unknown[] }).inputs) : [])
        .map((i) => ({ id: String((i as { id?: unknown })?.id ?? ""), properties: propertiesOf(i) }))
      : [{ id: decodeURIComponent(first!), properties: props }];
    if (!inputs.length) return hubspotError(400, "VALIDATION_ERROR", "Body must be {inputs: [{id, properties}]}");
    const events: NewEvent[] = [];
    const lines: string[] = [];
    const touched: { entityId: EntityId; name: string; fields: string[] }[] = [];
    const readSet: Record<string, number> = {};
    const ignored = new Set<string>();
    for (const input of inputs) {
      if (!input.properties) return hubspotError(400, "VALIDATION_ERROR", "Body must be {properties: {...}}");
      const plan = planUpdate(state, type, object, input.id, input.properties);
      if ("error" in plan) return plan.error;
      plan.ignored.forEach((x) => ignored.add(x));
      if (!plan.fields.length) continue;
      const name = label(state.entities[plan.entityId], plan.entityId);
      touched.push({ entityId: plan.entityId, name, fields: plan.fields });
      for (const f of plan.fields) {
        readSet[`${plan.entityId}::${f}`] = state.versions[`${plan.entityId}::${f}`] ?? 0;
        lines.push(`- ${inputs.length > 1 ? `${name} ` : ""}${f}: ${fmt(plan.prev[f])} → ${fmt(plan.changes[f])}`);
        events.push({
          actor: author,
          op: { type: "field.set", entity: plan.entityId, field: f, value: plan.changes[f]!, prev: plan.prev[f] ?? null },
          reason: reason ?? `Set ${f} via HubSpot API`,
          ...evidence,
        });
      }
    }
    if (!events.length) {
      const one = resolveHubSpotRecord(state, object, inputs[0]!.id)!;
      const noop: MainlineMeta = { status: "no_change", pr: null, prUrl: null, tier: null, reasons: ["Values already match main"], entity: one, fields: [] };
      const ent = state.entities[one]!;
      return isBatch
        ? { status: 200, body: { status: "COMPLETE", results: inputs.map((i) => toHubSpotObject(state.entities[resolveHubSpotRecord(state, object, i.id)!]!, state)), mainline: noop } }
        : { status: 200, body: { ...toHubSpotObject(ent, state), mainline: noop } };
    }
    const subject = touched.length === 1
      ? `${touched[0]!.name} ${touched[0]!.fields.join(", ")}`
      : `${touched.length} ${object} (${[...new Set(touched.flatMap((t) => t.fields))].join(", ")})`;
    const path = isBatch ? `POST /crm/v3/objects/${object}/batch/update` : `${method} /crm/v3/objects/${object}/${inputs[0]!.id}`;
    const pr = await repo.propose(agent, {
      title: meta.title ?? `${author.name} via HubSpot API: ${subject}`,
      description:
        `${author.name} called ${path} through the Mainline HubSpot proxy (the write was intercepted, not sent to HubSpot).\n\n` +
        lines.join("\n") +
        (ignored.size ? `\n\nIgnored properties: ${[...ignored].join(", ")}` : "") +
        (reason ? `\n\nReason: ${reason}` : "") +
        `\n\nEntit${touched.length > 1 ? "ies" : "y"}: ${touched.map((t) => t.entityId).join(", ")}`,
      readSet,
      events,
    });
    const fields = [...new Set(touched.flatMap((t) => t.fields))];
    const res = await finish(repo, pr, touched[0]!.entityId, fields, req.origin, false);
    if (!isBatch) return res;
    const { mainline, ...first0 } = res.body as { mainline: MainlineMeta };
    const after = await repo.state(mainline.status === "auto_merged" ? undefined : { branch: pr.branch });
    const results = touched.map((t) => {
      const e = after.entities[resolveAlias(after, t.entityId)];
      return e ? toHubSpotObject(e, after) : first0;
    });
    return { status: 202, body: { status: "PENDING", results, mainline } };
  }

  if (method === "DELETE") {
    return hubspotError(403, "MAINLINE_BLOCKED", "Agents may not delete CRM records through Mainline (policy: entity-delete is blocked).");
  }
  return hubspotError(405, "METHOD_NOT_ALLOWED", `${method} not supported on this path`);
}

/** Public origin of the request (honours Railway's x-forwarded-* headers and MAINLINE_PUBLIC_URL). */
export function requestOrigin(req: Request): string {
  const env = process.env.MAINLINE_PUBLIC_URL?.replace(/\/+$/, "");
  if (env) return env;
  const u = new URL(req.url);
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || u.host;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || u.protocol.replace(":", "");
  return `${proto}://${host}`;
}

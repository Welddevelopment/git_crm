/**
 * Attio object schema helpers for writes. Attio workspaces differ (custom pipelines, extra required attributes),
 * so before creating deals we read the live deal schema and make every create carry each required attribute:
 *  - stage  -> an EXISTING status title (our stage mapped by title, then by pipeline position)
 *  - owner  -> a workspace member (by name, else the first member, else the token's authorizing member)
 *  - others -> a per-type default (text: deal name, currency/number: amount or 0, select/status: first option, ...)
 * Endpoints (REST v2): GET /objects/{o}/attributes, GET /objects/{o}/attributes/{a}/statuses, .../options.
 */
import type { AttioClient, AttioMember } from "./client";
import { toAttioStage, type AttioObject } from "./map";

export interface AttioAttribute {
  id?: { attribute_id?: string };
  title?: string;
  api_slug: string;
  type: string;
  is_required?: boolean;
  is_writable?: boolean;
  is_archived?: boolean;
  is_multiselect?: boolean;
  is_default_value_enabled?: boolean;
  default_value?: unknown;
  config?: { record_reference?: { allowed_object_ids?: string[] | null } | null; [k: string]: unknown };
}
interface TitledOption { title: string; is_archived?: boolean }

export interface DealSchema {
  attributes: AttioAttribute[];
  /** slugs Attio requires on create (never stripped by the option fallback) */
  required: string[];
  /** slug of the status attribute that holds the pipeline (default "stage") */
  stageSlug: string;
  /** live, non-archived status titles in pipeline order ([] if unknown) */
  statuses: string[];
  /** first option title per required select attribute */
  selectDefaults: Record<string, string>;
  /** workspace member id used when a deal's owner can't be resolved by name */
  fallbackOwnerId?: string;
}

const listData = async <T>(client: AttioClient, path: string): Promise<T[]> => {
  try {
    const r = await client.request<{ data?: T[] }>("GET", path);
    return Array.isArray(r?.data) ? r.data : [];
  } catch {
    return [];
  }
};

export function fetchAttributes(client: AttioClient, object: AttioObject): Promise<AttioAttribute[]> {
  return listData<AttioAttribute>(client, `/objects/${object}/attributes`);
}
async function liveTitles(client: AttioClient, object: AttioObject, slug: string, kind: "statuses" | "options"): Promise<string[]> {
  const rows = await listData<TitledOption>(client, `/objects/${object}/attributes/${encodeURIComponent(slug)}/${kind}`);
  return rows.filter((r) => r && typeof r.title === "string" && !r.is_archived).map((r) => r.title);
}

const cache = new WeakMap<AttioClient, Promise<DealSchema>>();

/** Live deal schema (memoised per client). Never throws: missing pieces degrade to Attio's default deal config. */
export function loadDealSchema(client: AttioClient, opts: { members?: AttioMember[] } = {}): Promise<DealSchema> {
  let p = cache.get(client);
  if (!p) {
    p = buildDealSchema(client, opts.members);
    cache.set(client, p);
  }
  return p;
}

async function buildDealSchema(client: AttioClient, members?: AttioMember[]): Promise<DealSchema> {
  const attributes = (await fetchAttributes(client, "deals")).filter((a) => a && a.api_slug && !a.is_archived);
  const statusAttr = attributes.find((a) => a.api_slug === "stage" && a.type === "status") ?? attributes.find((a) => a.type === "status");
  const stageSlug = statusAttr?.api_slug ?? "stage";
  const required = attributes.filter((a) => a.is_required).map((a) => a.api_slug);
  if (!attributes.length) required.push("name", "stage", "owner"); // Attio's default deal config
  const statuses = await liveTitles(client, "deals", stageSlug, "statuses");
  const selectDefaults: Record<string, string> = {};
  for (const a of attributes) {
    if (!a.is_required || a.type !== "select" || a.is_default_value_enabled) continue;
    const t = (await liveTitles(client, "deals", a.api_slug, "options"))[0];
    if (t) selectDefaults[a.api_slug] = t;
  }
  let fallbackOwnerId = (members ?? (await client.members()))[0]?.id.workspace_member_id;
  if (!fallbackOwnerId) {
    // members() needs the workspace_member:read scope; /self names the member who authorised the token.
    const self = await client.self().catch(() => undefined);
    const id = self?.authorized_by_workspace_member_id;
    if (typeof id === "string" && id) fallbackOwnerId = id;
  }
  return { attributes, required, stageSlug, statuses, selectDefaults, fallbackOwnerId };
}

// ---------- stage -> existing status title ----------
const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const isWon = (t: string) => /\bwon\b/.test(normTitle(t));
const isLost = (t: string) => /\blost\b/.test(normTitle(t));

/** Our stage (or an Attio title) -> one of `statuses`. Returns the TO_ATTIO title unchanged when statuses are unknown. */
export function resolveStageTitle(stage: string, statuses: string[]): string {
  const wanted = toAttioStage(stage);
  if (!statuses.length) return wanted;
  for (const cand of [wanted, stage]) {
    const exact = statuses.find((t) => t === cand);
    if (exact) return exact;
    const ci = statuses.find((t) => normTitle(t) === normTitle(cand));
    if (ci) return ci;
  }
  const s = normTitle(stage).replace(/ /g, "_");
  const open = statuses.filter((t) => !isWon(t) && !isLost(t));
  if (s === "closed_won" || s === "won") return statuses.find(isWon) ?? statuses[statuses.length - 1]!;
  if (s === "closed_lost" || s === "lost") return statuses.find(isLost) ?? statuses[statuses.length - 1]!;
  if (s === "discovery" || s === "demo" || s === "lead") return open[0] ?? statuses[0]!;
  if (s === "proposal" || s === "negotiation") {
    const named = open.find((t) => /progress|proposal|negotiat/.test(normTitle(t)));
    if (named) return named;
    if (open.length) return open[Math.min(open.length - 1, Math.floor(open.length / 2))]!;
  }
  return statuses[0]!;
}

// ---------- complete a deal write ----------
export interface DealFillContext {
  /** deal name (text default) */
  name?: string;
  /** deal amount (number/currency default) */
  amount?: number;
  /** Attio record id of the associated company, if known */
  companyRecordId?: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Map `stage` to a live status title (create and update). */
export function mapDealStage(values: Record<string, unknown>, schema: DealSchema): Record<string, unknown> {
  const out = { ...values };
  if (typeof out.stage === "string") {
    const title = resolveStageTitle(out.stage, schema.statuses);
    delete out.stage;
    out[schema.stageSlug] = title;
  }
  return out;
}

/** Deal create values with stage mapped, owner set, and every other required attribute defaulted. */
export function completeDealCreate(values: Record<string, unknown>, schema: DealSchema, ctx: DealFillContext = {}): Record<string, unknown> {
  const out = mapDealStage(values, schema);
  const present = (slug: string) => out[slug] !== undefined && out[slug] !== null && out[slug] !== "" && !(Array.isArray(out[slug]) && !(out[slug] as unknown[]).length);
  const member = (id: string) => [{ referenced_actor_type: "workspace-member", referenced_actor_id: id }];

  if (!present(schema.stageSlug)) out[schema.stageSlug] = schema.statuses[0] ?? resolveStageTitle("discovery", []);
  if (!present("owner") && schema.fallbackOwnerId && (schema.required.includes("owner") || !schema.attributes.length || schema.attributes.some((a) => a.api_slug === "owner"))) {
    out.owner = member(schema.fallbackOwnerId);
  }
  for (const a of schema.attributes) {
    if (!a.is_required || a.is_writable === false || present(a.api_slug)) continue;
    if (a.is_default_value_enabled && a.default_value != null) continue; // Attio fills it
    const slug = a.api_slug;
    switch (a.type) {
      case "text": out[slug] = ctx.name || "Untitled deal"; break;
      case "number": case "currency": out[slug] = Number.isFinite(ctx.amount) ? ctx.amount : 0; break;
      case "checkbox": out[slug] = false; break;
      case "date": out[slug] = today(); break;
      case "timestamp": out[slug] = new Date().toISOString(); break;
      case "rating": out[slug] = 1; break;
      case "status": {
        const t = slug === schema.stageSlug ? schema.statuses[0] : undefined;
        if (t) out[slug] = t;
        break;
      }
      case "select": if (schema.selectDefaults[slug]) out[slug] = a.is_multiselect ? [schema.selectDefaults[slug]] : schema.selectDefaults[slug]; break;
      case "actor-reference": if (schema.fallbackOwnerId) out[slug] = member(schema.fallbackOwnerId); break;
      case "record-reference": if (ctx.companyRecordId) out[slug] = [{ target_object: "companies", target_record_id: ctx.companyRecordId }]; break;
      default: break;
    }
  }
  return out;
}

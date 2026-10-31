/**
 * Attio <-> Mainline field mapping (pure, no I/O).
 *
 * Attio records carry `values: { <attr_slug>: Entry[] }` where each slug holds a history of entries; the
 * active one has `active_until: null`. We read active entries only, and are tolerant of the write shorthand
 * agents send to the Attio API (`{job_title: "CTO"}`, `{domains: ["x.com"]}`, `{stage: "Won 🎉"}` ...), so
 * the same mapper serves imports (read shape) and the proxy (write shape).
 */
import type { CRMState, EntityId, EntityRecord, EntityType, FieldValue } from "../../core/types";

export type AttioObject = "companies" | "people" | "deals";
export const ATTIO_OBJECTS: AttioObject[] = ["companies", "people", "deals"];

export type AttioEntry = Record<string, unknown> & { active_from?: string | null; active_until?: string | null };
export interface AttioRecord {
  id: { workspace_id?: string; object_id?: string; record_id: string };
  created_at?: string;
  web_url?: string;
  values: Record<string, unknown>;
}

export const OBJECT_TYPE: Record<AttioObject, EntityType> = { companies: "company", people: "contact", deals: "deal" };
export const TYPE_OBJECT: Record<string, AttioObject> = { company: "companies", contact: "people", deal: "deals" };
/** Prefix for entities first seen in Attio: `company:at-<record_id>`. */
export const IMPORT_PREFIX = "at-";

const OBJECT_ALIASES: Record<string, AttioObject> = {
  companies: "companies", company: "companies",
  people: "people", person: "people", persons: "people", contact: "people", contacts: "people",
  deals: "deals", deal: "deals",
};
/** companies|people|deals or our types (company|contact|deal) or Attio singulars -> Attio object slug. */
export function normalizeObject(s: string | null | undefined): AttioObject | null {
  return (s && OBJECT_ALIASES[s.toLowerCase()]) || null;
}

// ---------- reading entries ----------
function isEntryActive(e: unknown): boolean {
  return !(e && typeof e === "object" && (e as AttioEntry).active_until != null);
}
/** Active entries of one attribute (accepts a bare value, an entry, or an array of either). */
export function activeEntries(raw: unknown): AttioEntry[] {
  const arr = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return arr
    .filter(isEntryActive)
    .map((e) => (e !== null && typeof e === "object" ? (e as AttioEntry) : ({ value: e } as AttioEntry)));
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const titleOf = (v: unknown): string | undefined =>
  str(v) ?? (v && typeof v === "object" ? str((v as { title?: unknown }).title) : undefined);

const textOf = (e: AttioEntry) => str(e.value) ?? str(e.full_name) ?? titleOf(e.option) ?? titleOf(e.status);
const domainOf = (e: AttioEntry) => str(e.domain) ?? str(e.value);
const emailOf = (e: AttioEntry) => str(e.email_address) ?? str(e.original_email_address) ?? str(e.value);
const phoneOf = (e: AttioEntry) => str(e.original_phone_number) ?? str(e.phone_number) ?? str(e.value);
const optionOf = (e: AttioEntry) => titleOf(e.option) ?? titleOf(e.status) ?? str(e.value);
const refOf = (e: AttioEntry) => str(e.target_record_id) ?? str(e.record_id) ?? str(e.value);
function nameOf(e: AttioEntry): string | undefined {
  const full = str(e.full_name);
  if (full) return full;
  const parts = [str(e.first_name), str(e.last_name)].filter(Boolean);
  return parts.length ? parts.join(" ") : str(e.value);
}
function numberOf(e: AttioEntry): number | undefined {
  const v = e.currency_value ?? e.value;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
const first = <T>(entries: AttioEntry[], f: (e: AttioEntry) => T | undefined): T | undefined => {
  for (const e of entries) {
    const v = f(e);
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
};

// ---------- deal stages ----------
const OUR_STAGES = ["discovery", "demo", "proposal", "negotiation", "closed_won", "closed_lost"];
/** Lowercase, drop emoji/punctuation: "Won 🎉" -> "won", "Closed-Won" -> "closed won". */
const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const FROM_ATTIO: Record<string, string> = {
  lead: "discovery", "in progress": "demo", won: "closed_won", lost: "closed_lost",
  "closed won": "closed_won", "closed lost": "closed_lost",
};
/** Attio status title -> our deal stage enum where possible; unknown titles pass through unchanged. */
export function fromAttioStage(title: string): string {
  const n = normTitle(title);
  if (FROM_ATTIO[n]) return FROM_ATTIO[n]!;
  const snake = n.replace(/ /g, "_");
  return OUR_STAGES.includes(snake) ? snake : title;
}
const TO_ATTIO: Record<string, string> = {
  discovery: "Lead", demo: "In Progress", proposal: "In Progress", negotiation: "In Progress",
  closed_won: "Won 🎉", closed_lost: "Lost",
};
/** Our deal stage -> Attio's default deal pipeline title (unknown stages pass through). */
export function toAttioStage(stage: string): string {
  return TO_ATTIO[stage] ?? stage;
}
/** True if our stage and an Attio title mean the same thing (so proposal vs "In Progress" is not a diff). */
export function stagesEquivalent(ours: string, attioTitle: string): boolean {
  return fromAttioStage(attioTitle) === ours || normTitle(toAttioStage(ours)) === normTitle(attioTitle);
}

// ---------- employee ranges ----------
const RANGES: { title: string; min: number; max: number }[] = [
  { title: "1-10", min: 1, max: 10 }, { title: "11-50", min: 11, max: 50 }, { title: "51-250", min: 51, max: 250 },
  { title: "251-1K", min: 251, max: 1000 }, { title: "1K-5K", min: 1001, max: 5000 }, { title: "5K-10K", min: 5001, max: 10000 },
  { title: "10K-50K", min: 10001, max: 50000 }, { title: "50K-100K", min: 50001, max: 100000 }, { title: "100K+", min: 100001, max: Infinity },
];
const kNum = (s: string) => Number(s.replace(/k$/i, "")) * (/k$/i.test(s) ? 1000 : 1);
/** "251-1K" -> [251, 1000]; "100K+" -> [100000, Infinity]; unparseable -> null. */
export function parseEmployeeRange(title: string): [number, number] | null {
  const t = title.replace(/[\s,]/g, "");
  let m = t.match(/^(\d+(?:\.\d+)?k?)[-–](\d+(?:\.\d+)?k?)$/i);
  if (m) return [kNum(m[1]!), kNum(m[2]!)];
  m = t.match(/^(\d+(?:\.\d+)?k?)\+$/i);
  if (m) return [kNum(m[1]!), Infinity];
  const n = kNum(t);
  return Number.isFinite(n) ? [n, n] : null;
}
export function employeeRangeFor(n: number): string {
  return (RANGES.find((r) => n <= r.max) ?? RANGES[RANGES.length - 1]!).title;
}

// ---------- Attio -> Mainline ----------
export interface MappedAttio {
  object: AttioObject;
  entityType: EntityType;
  recordId: string;
  /** our fields; fields Attio has no value for are absent (we never clear on import) */
  attrs: Record<string, FieldValue>;
  /** raw Attio record ids of references (company), resolved into attrs.company when a resolver knows them */
  refs: { company?: string };
  /** lossy-mapping hints used by `sameValue` so e.g. 140 vs "51-250" is not a diff */
  hints: { employeeRange?: string; stageTitle?: string; categories?: string[] };
}

export interface MapContext {
  /** Attio record id -> Mainline entity id (for record references) */
  resolveRef?: (object: AttioObject, recordId: string) => EntityId | null;
  /** workspace member id -> display name (deal owner) */
  memberName?: (memberId: string) => string | undefined;
}

export function mapAttioRecord(object: AttioObject, record: AttioRecord, ctx: MapContext = {}): MappedAttio {
  const v = record.values ?? {};
  const get = (slug: string) => activeEntries(v[slug]);
  const out: MappedAttio = { object, entityType: OBJECT_TYPE[object], recordId: record.id?.record_id ?? "", attrs: {}, refs: {}, hints: {} };
  const set = (field: string, val: FieldValue | undefined) => {
    if (val !== undefined && val !== "") out.attrs[field] = val;
  };
  const ref = (slug: string) => {
    const id = first(get(slug), refOf);
    if (!id) return;
    out.refs.company = id;
    const ent = ctx.resolveRef?.("companies", id);
    if (ent) out.attrs.company = ent;
  };

  if (object === "companies") {
    set("name", first(get("name"), textOf));
    set("domain", first(get("domains"), domainOf));
    const range = first(get("employee_range"), optionOf);
    if (range) {
      out.hints.employeeRange = range;
      const r = parseEmployeeRange(range);
      if (r) set("employees", r[0]);
    }
    const cats = get("categories").map(optionOf).filter((c): c is string => !!c);
    if (cats.length) {
      out.hints.categories = cats;
      set("industry", cats.join(", "));
    }
  } else if (object === "people") {
    set("name", first(get("name"), nameOf));
    set("email", first(get("email_addresses"), emailOf));
    set("title", first(get("job_title"), textOf));
    set("phone", first(get("phone_numbers"), phoneOf));
    ref("company");
  } else {
    set("name", first(get("name"), textOf));
    set("amount", first(get("value"), numberOf));
    const stage = first(get("stage"), optionOf);
    if (stage) {
      out.hints.stageTitle = stage;
      set("stage", fromAttioStage(stage));
    }
    ref("associated_company");
    const ownerId = first(get("owner"), (e) => str(e.referenced_actor_id));
    const owner = ownerId ? ctx.memberName?.(ownerId) : first(get("owner"), (e) => str(e.value));
    set("owner", owner);
  }
  return out;
}

const blank = (x: unknown) => x === undefined || x === null || x === "";
/** Does our current value already say what Attio says? (case-insensitive ids, lossy ranges/stages/categories) */
export function sameValue(m: MappedAttio, field: string, ours: FieldValue | undefined): boolean {
  const theirs = m.attrs[field];
  if (blank(ours) && blank(theirs)) return true;
  if (blank(ours) || blank(theirs)) return false;
  if (field === "domain" || field === "email") return String(ours).toLowerCase() === String(theirs).toLowerCase();
  if (m.entityType === "company" && field === "employees" && m.hints.employeeRange && typeof ours === "number") {
    const r = parseEmployeeRange(m.hints.employeeRange);
    return !!r && ours >= r[0] && ours <= r[1];
  }
  if (m.entityType === "company" && field === "industry" && m.hints.categories) {
    const o = String(ours).toLowerCase();
    return m.hints.categories.some((c) => c.toLowerCase() === o) || String(theirs).toLowerCase() === o;
  }
  if (m.entityType === "deal" && field === "stage" && m.hints.stageTitle) return stagesEquivalent(String(ours), m.hints.stageTitle);
  return JSON.stringify(ours) === JSON.stringify(theirs);
}

// ---------- Mainline -> Attio (write shorthand) ----------
export interface ToAttioContext {
  /** Mainline entity id -> Attio record id (for references) */
  attioIdOf?: (entityId: EntityId) => string | undefined;
  /** deal owner name -> workspace member id */
  ownerMemberId?: (owner: string) => string | undefined;
}

function splitName(full: string) {
  const s = full.trim();
  const i = s.indexOf(" ");
  return i < 0 ? { first_name: s, last_name: "", full_name: s } : { first_name: s.slice(0, i), last_name: s.slice(i + 1).trim(), full_name: s };
}

/** Our attrs (any subset) -> Attio `data.values` for POST/PATCH. Unmapped fields are skipped. */
export function toAttioValues(entityType: EntityType, attrs: Record<string, FieldValue | undefined>, ctx: ToAttioContext = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const has = (k: string) => attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== "";
  const s = (k: string) => String(attrs[k]);
  const refTo = (k: string, slug: string) => {
    if (!has(k)) return;
    const rid = ctx.attioIdOf?.(s(k));
    if (rid) out[slug] = [{ target_object: "companies", target_record_id: rid }];
  };
  if (entityType === "company") {
    if (has("name")) out.name = s("name");
    if (has("domain")) out.domains = [s("domain").toLowerCase()];
    if (has("employees") && Number.isFinite(Number(attrs.employees))) out.employee_range = employeeRangeFor(Number(attrs.employees));
    if (has("industry")) out.categories = [s("industry")];
  } else if (entityType === "contact") {
    if (has("name")) out.name = [splitName(s("name"))];
    if (has("email")) out.email_addresses = [s("email")];
    if (has("title")) out.job_title = s("title");
    refTo("company", "company");
  } else if (entityType === "deal") {
    if (has("name")) out.name = s("name");
    if (has("amount") && Number.isFinite(Number(attrs.amount))) out.value = Number(attrs.amount);
    if (has("stage")) out.stage = toAttioStage(s("stage"));
    refTo("company", "associated_company");
    if (has("owner")) {
      const mid = ctx.ownerMemberId?.(s("owner"));
      if (mid) out.owner = [{ referenced_actor_type: "workspace-member", referenced_actor_id: mid }];
    }
  }
  return out;
}

/** Which of our fields a write to these Attio slugs touches (used to mark echoes). */
export const SLUG_FIELD: Record<string, string> = {
  name: "name", domains: "domain", employee_range: "employees", categories: "industry",
  email_addresses: "email", job_title: "title", phone_numbers: "phone", company: "company",
  value: "amount", stage: "stage", associated_company: "company", owner: "owner",
};

// ---------- Mainline -> Attio (read shape, for the proxy's GET/query) ----------
export function resolveAlias(state: CRMState, id: EntityId): EntityId {
  let cur = id;
  for (let i = 0; i < 20 && state.aliases?.[cur]; i++) cur = state.aliases[cur]!;
  return cur;
}

/** Render a Mainline entity in Attio's record shape (active entries only). record_id = attioId or our entity id. */
export function toAttioRecord(entity: EntityRecord, state: CRMState): AttioRecord {
  const object = TYPE_OBJECT[entity.type] ?? entity.type;
  const a = entity.attrs;
  const prov = state.provenance?.[entity.id] ?? {};
  const entry = (field: string, body: Record<string, unknown>): AttioEntry => ({
    active_from: prov[field] ? new Date(prov[field]!.ts).toISOString() : null,
    active_until: null,
    ...body,
  });
  const has = (k: string) => a[k] !== undefined && a[k] !== null && a[k] !== "";
  const refId = (k: string) => {
    const target = state.entities[resolveAlias(state, String(a[k]))];
    return (target?.attrs.attioId as string | undefined) || target?.id || String(a[k]);
  };
  const values: Record<string, AttioEntry[]> = {};
  if (entity.type === "company") {
    if (has("name")) values.name = [entry("name", { value: a.name })];
    if (has("domain")) values.domains = [entry("domain", { domain: a.domain })];
    if (has("employees")) values.employee_range = [entry("employees", { option: { title: employeeRangeFor(Number(a.employees)) } })];
    if (has("industry")) values.categories = [entry("industry", { option: { title: a.industry } })];
  } else if (entity.type === "contact") {
    if (has("name")) values.name = [entry("name", splitName(String(a.name)))];
    if (has("email")) values.email_addresses = [entry("email", { email_address: a.email })];
    if (has("title")) values.job_title = [entry("title", { value: a.title })];
    if (has("phone")) values.phone_numbers = [entry("phone", { original_phone_number: a.phone })];
    if (has("company")) values.company = [entry("company", { target_object: "companies", target_record_id: refId("company") })];
  } else if (entity.type === "deal") {
    if (has("name")) values.name = [entry("name", { value: a.name })];
    if (has("amount")) values.value = [entry("amount", { currency_value: a.amount, currency_code: "USD" })];
    if (has("stage")) values.stage = [entry("stage", { status: { title: toAttioStage(String(a.stage)) } })];
    if (has("company")) values.associated_company = [entry("company", { target_object: "companies", target_record_id: refId("company") })];
  }
  return {
    id: { workspace_id: "mainline", object_id: object, record_id: (a.attioId as string | undefined) || entity.id },
    values,
  };
}

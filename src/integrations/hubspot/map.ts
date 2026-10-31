/**
 * HubSpot <-> Mainline field mapping (pure, no I/O). Single source of truth for the adapter (write-back),
 * the importer / poller (read), the seed, and the HubSpot-compatible proxy (agent writes).
 *
 *   deal:    dealname <-> name, amount <-> amount (number), dealstage <-> stage (value map below),
 *            closedate <-> closeDate (YYYY-MM-DD), hs_next_step <-> nextStep, company via associations
 *   contact: firstname + lastname <-> name, email, jobtitle <-> title, phone, company via associations
 *   company: name, domain, numberofemployees <-> employees
 * `industry` is deliberately not mapped: in HubSpot it is a fixed enumeration (COMPUTER_SOFTWARE, ...) and our
 * free-text industries would be rejected on write / clobbered on import.
 */
import type { CRMState, EntityId, EntityRecord, EntityType, FieldValue } from "../../core/types";

export type HubSpotObject = "companies" | "contacts" | "deals";
export const HUBSPOT_OBJECTS: HubSpotObject[] = ["companies", "contacts", "deals"];
export const OBJECT_TYPE: Record<HubSpotObject, EntityType> = { companies: "company", contacts: "contact", deals: "deal" };
export const TYPE_OBJECT: Record<string, HubSpotObject> = { company: "companies", contact: "contacts", deal: "deals" };
/** Prefix for entities created from HubSpot records: `company:hs-<id>`. */
export const IMPORT_PREFIX = "hs-";

const OBJECT_ALIASES: Record<string, HubSpotObject> = {
  "0-1": "contacts", contact: "contacts", contacts: "contacts", person: "contacts", people: "contacts",
  "0-2": "companies", company: "companies", companies: "companies",
  "0-3": "deals", deal: "deals", deals: "deals",
};

/** "0-3" | "deals" | "deal" | "DEAL" -> "deals"; unknown -> null. */
export function normalizeObject(objectType: string | null | undefined): HubSpotObject | null {
  if (!objectType) return null;
  return OBJECT_ALIASES[objectType.trim().toLowerCase()] ?? null;
}

// ---------- deal stages ----------
/** HubSpot default sales pipeline stage id -> Mainline stage. */
export const HS_STAGE_TO_MAINLINE: Record<string, string> = {
  appointmentscheduled: "demo",
  qualifiedtobuy: "discovery",
  presentationscheduled: "demo",
  decisionmakerboughtin: "proposal",
  contractsent: "negotiation",
  closedwon: "closed_won",
  closedlost: "closed_lost",
};
/** Mainline stage -> HubSpot default pipeline stage id (inverse; `demo` -> presentationscheduled). */
export const MAINLINE_STAGE_TO_HS: Record<string, string> = {
  discovery: "qualifiedtobuy",
  demo: "presentationscheduled",
  proposal: "decisionmakerboughtin",
  negotiation: "contractsent",
  closed_won: "closedwon",
  closed_lost: "closedlost",
};

/** HubSpot dealstage (or a Mainline stage name, or a label like "Contract Sent") -> Mainline stage; null if unknown. */
export function stageFromHubSpot(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (HS_STAGE_TO_MAINLINE[s]) return HS_STAGE_TO_MAINLINE[s]!;
  const compact = s.replace(/[\s_-]+/g, "");
  if (HS_STAGE_TO_MAINLINE[compact]) return HS_STAGE_TO_MAINLINE[compact]!;
  const snake = s.replace(/[\s-]+/g, "_");
  if (MAINLINE_STAGE_TO_HS[snake]) return snake;
  if (compact === "closedwon" || compact === "won") return "closed_won";
  if (compact === "closedlost" || compact === "lost") return "closed_lost";
  return null;
}

export function stageToHubSpot(stage: FieldValue | undefined): string | null {
  if (typeof stage !== "string") return null;
  return MAINLINE_STAGE_TO_HS[stage] ?? (HS_STAGE_TO_MAINLINE[stage] ? stage : null);
}

// ---------- dates ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * HubSpot closedate ("2026-12-15", ISO datetime, or epoch ms) -> "YYYY-MM-DD". We write noon UTC so the date
 * shows the same in every US/EU timezone; anything else is rounded to the nearest UTC midnight (a date picked
 * in the HubSpot UI is stored as local midnight).
 */
export function dateFromHubSpot(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" && DATE_RE.test(v.trim())) return v.trim();
  const ms = typeof v === "number" ? v : /^\d{10,}$/.test(String(v).trim()) ? Number(v) : Date.parse(String(v));
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (d.getUTCHours() === 12 && d.getUTCMinutes() === 0) return d.toISOString().slice(0, 10);
  return new Date(ms + 12 * 3_600_000).toISOString().slice(0, 10);
}
export function dateToHubSpot(v: FieldValue | undefined): string | null {
  if (typeof v !== "string" || !DATE_RE.test(v)) return null;
  return `${v}T12:00:00.000Z`;
}

// ---------- names ----------
export function splitName(name: string): { firstname: string; lastname: string } {
  const t = name.trim().replace(/\s+/g, " ");
  const i = t.indexOf(" ");
  return i < 0 ? { firstname: t, lastname: "" } : { firstname: t.slice(0, i), lastname: t.slice(i + 1) };
}
export function joinName(first: unknown, last: unknown): string {
  return [first, last].filter((x) => typeof x === "string" && x.trim()).map((x) => (x as string).trim()).join(" ");
}

// ---------- properties ----------
/** HubSpot properties we read per object (for list / search calls). */
export const READ_PROPERTIES: Record<HubSpotObject, string[]> = {
  companies: ["name", "domain", "numberofemployees", "hs_lastmodifieddate"],
  contacts: ["firstname", "lastname", "email", "jobtitle", "phone", "lastmodifieddate"],
  deals: ["dealname", "amount", "dealstage", "closedate", "hs_next_step", "pipeline", "hs_lastmodifieddate"],
};
/** Property used for "modified since" search filters. Contacts use the legacy name. */
export const MODIFIED_PROPERTY: Record<HubSpotObject, string> = {
  companies: "hs_lastmodifieddate",
  contacts: "lastmodifieddate",
  deals: "hs_lastmodifieddate",
};

/** Our field -> HubSpot property (1:1 mappings; contact.name is special-cased to firstname+lastname). */
const FIELD_TO_PROP: Record<string, Record<string, string>> = {
  deal: { name: "dealname", amount: "amount", stage: "dealstage", closeDate: "closedate", nextStep: "hs_next_step" },
  contact: { name: "firstname", email: "email", title: "jobtitle", phone: "phone" },
  company: { name: "name", domain: "domain", employees: "numberofemployees" },
};
/** HubSpot property -> our field (inverse; lastname folds into contact.name). */
const PROP_TO_FIELD: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries(FIELD_TO_PROP).map(([t, m]) => [t, Object.fromEntries(Object.entries(m).map(([f, p]) => [p, f]))]),
);
PROP_TO_FIELD.contact!.lastname = "name";

/** Fields that exist in both systems (what import compares). `company` is the association. */
export const SYNC_FIELDS: Record<string, string[]> = {
  company: ["name", "domain", "employees"],
  contact: ["name", "email", "title", "phone", "company"],
  deal: ["name", "amount", "stage", "closeDate", "nextStep", "company"],
};

export function hubspotProperty(entityType: EntityType, field: string): string | undefined {
  return FIELD_TO_PROP[entityType]?.[field];
}
export function mainlineField(entityType: EntityType, property: string): string | undefined {
  return PROP_TO_FIELD[entityType]?.[property];
}

const str = (v: unknown): string | null => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : null);
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export interface MappedHubSpot {
  attrs: Record<string, FieldValue>;
  /** properties we could not map (or values we could not parse), for PR descriptions / 400s */
  ignored: string[];
  invalid: { property: string; value: unknown; reason: string }[];
}

/**
 * HubSpot `properties` -> Mainline attrs for one entity type. Only properties that are present (and not
 * blank) produce attrs, so a partial PATCH maps to a partial update. `extraFields` lets callers accept our own
 * field names (e.g. a schema field like `procurementContact`) for properties HubSpot doesn't have.
 */
export function propertiesToAttrs(
  entityType: EntityType,
  props: Record<string, unknown>,
  opts: { extraFields?: Set<string>; keepBlank?: boolean } = {},
): MappedHubSpot {
  const out: MappedHubSpot = { attrs: {}, ignored: [], invalid: [] };
  const has = (k: string) => Object.prototype.hasOwnProperty.call(props, k) && props[k] !== undefined;
  const blank = (v: unknown) => v === null || (typeof v === "string" && !v.trim());
  const set = (field: string, v: FieldValue) => { out.attrs[field] = v; };

  for (const [prop, raw] of Object.entries(props)) {
    if (raw === undefined) continue;
    // our own field names are accepted too (amount, stage, closeDate, nextStep, title, employees, ...)
    const field = mainlineField(entityType, prop) ?? (FIELD_TO_PROP[entityType]?.[prop] ? prop : undefined) ?? (opts.extraFields?.has(prop) ? prop : undefined);
    if (!field) {
      if (!["hs_lastmodifieddate", "lastmodifieddate", "createdate", "hs_object_id", "pipeline", "hs_createdate"].includes(prop)) out.ignored.push(prop);
      continue;
    }
    if (entityType === "contact" && field === "name" && (prop === "firstname" || prop === "lastname")) continue; // below
    if (blank(raw)) {
      if (opts.keepBlank) set(field, typeof raw === "string" ? "" : null);
      continue;
    }
    switch (`${entityType}.${field}`) {
      case "deal.amount":
      case "company.employees": {
        const n = num(raw);
        if (n === null) out.invalid.push({ property: prop, value: raw, reason: "not a number" });
        else set(field, n);
        break;
      }
      case "deal.stage": {
        const s = stageFromHubSpot(raw);
        if (!s) out.invalid.push({ property: prop, value: raw, reason: `unknown deal stage (use ${Object.keys(HS_STAGE_TO_MAINLINE).join(", ")})` });
        else set(field, s);
        break;
      }
      case "deal.closeDate": {
        const d = dateFromHubSpot(raw);
        if (!d) out.invalid.push({ property: prop, value: raw, reason: "not a date" });
        else set(field, d);
        break;
      }
      default: {
        if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) set(field, raw as string[]);
        else if (typeof raw === "boolean") set(field, raw);
        else {
          const s = str(raw);
          if (s === null) out.invalid.push({ property: prop, value: raw, reason: "unsupported value" });
          else set(field, field === "domain" ? s.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") : s);
        }
      }
    }
  }
  if (entityType === "contact" && (has("firstname") || has("lastname"))) {
    const name = joinName(props.firstname, props.lastname);
    if (name) set("name", name);
    else if (opts.keepBlank) set("name", "");
  }
  return out;
}

/** Mainline attrs -> HubSpot `properties` (strings, as the HubSpot API wants them). Unmapped fields are dropped. */
export function attrsToProperties(entityType: EntityType, attrs: Record<string, FieldValue | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (entityType === "contact" && field === "name") {
      const { firstname, lastname } = splitName(typeof v === "string" ? v : "");
      out.firstname = firstname;
      out.lastname = lastname;
      continue;
    }
    const prop = hubspotProperty(entityType, field);
    if (!prop) continue;
    if (v === null) { out[prop] = ""; continue; }
    if (entityType === "deal" && field === "stage") {
      const s = stageToHubSpot(v);
      if (s) out[prop] = s;
      continue;
    }
    if (entityType === "deal" && field === "closeDate") {
      const d = dateToHubSpot(v);
      if (d) out[prop] = d;
      continue;
    }
    out[prop] = Array.isArray(v) ? v.join(";") : String(v);
  }
  return out;
}

/** Field-level equality in Mainline space (numbers vs numeric strings, case-insensitive domains/emails). */
export function sameValue(field: string, a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  const n = (v: FieldValue | undefined) => (v === undefined || v === null ? "" : Array.isArray(v) ? v.join(";") : String(v).trim());
  if (field === "domain" || field === "email") return n(a).toLowerCase() === n(b).toLowerCase();
  if (field === "amount" || field === "employees") {
    const x = Number(n(a)), y = Number(n(b));
    if (n(a) !== "" && n(b) !== "" && Number.isFinite(x) && Number.isFinite(y)) return x === y;
  }
  return n(a) === n(b);
}

/** Natural key used to link records that exist on both sides: company domain, contact email, deal name. */
export function naturalKey(entityType: EntityType, attrs: Record<string, FieldValue | undefined>): string {
  const v = entityType === "company" ? attrs.domain : entityType === "contact" ? attrs.email : entityType === "deal" ? attrs.name : undefined;
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

export function resolveAlias(state: CRMState, id: EntityId): EntityId {
  let cur = id;
  for (let i = 0; i < 20 && state.aliases?.[cur]; i++) cur = state.aliases[cur]!;
  return cur;
}

const hsIdOf = (e: EntityRecord): string | null => {
  const v = e.attrs.hubspotId;
  return v === undefined || v === null || v === "" ? null : String(v);
};
export { hsIdOf as hubspotIdOf };

/**
 * HubSpot record -> Mainline entity id. Matches `attrs.hubspotId` (preferring live entities, following merge
 * aliases), then falls back to a Mainline id/slug (`deal:acme-platform`, `acme-platform`, `hs-<id>`) so the
 * proxy and the extension work without a real HubSpot portal. `objectType` null = any type.
 */
export function resolveHubSpotRecord(state: CRMState, objectType: string | null | undefined, id: string): EntityId | null {
  const rid = (id ?? "").trim();
  if (!rid) return null;
  const object = normalizeObject(objectType ?? null);
  const type = object ? OBJECT_TYPE[object] : null;
  let fallback: EntityId | null = null;
  for (const e of Object.values(state.entities)) {
    if (type && e.type !== type) continue;
    if (hsIdOf(e) !== rid) continue;
    if (!e.deleted && !e.mergedInto) return e.id;
    fallback ??= e.id;
  }
  if (fallback) return resolveAlias(state, fallback);
  const types = type ? [type] : ["deal", "contact", "company"];
  const candidates = rid.includes(":") ? [rid] : types.flatMap((t) => [`${t}:${rid}`, `${t}:${IMPORT_PREFIX}${rid}`]);
  for (const c of candidates) {
    if (!state.entities[c] && !state.aliases[c]) continue;
    const resolved = resolveAlias(state, c);
    const rec = state.entities[resolved];
    if (rec && (!type || rec.type === type)) return resolved;
  }
  return null;
}

/** Render a Mainline entity as a HubSpot CRM v3 object (`{id, properties, createdAt, updatedAt, archived}`). */
export function toHubSpotObject(entity: EntityRecord, state: CRMState): {
  id: string; properties: Record<string, string | null>; createdAt: string; updatedAt: string; archived: boolean;
  associations?: Record<string, { results: { id: string; type: string }[] }>;
} {
  const props: Record<string, string | null> = attrsToProperties(entity.type, entity.attrs);
  const id = hsIdOf(entity) ?? entity.id;
  props.hs_object_id = id;
  const prov = Object.values(state.provenance[entity.id] ?? {});
  const ts = prov.map((p) => p.ts);
  const updated = ts.length ? Math.max(...ts) : Date.now();
  const created = ts.length ? Math.min(...ts) : updated;
  props.createdate = new Date(created).toISOString();
  props[entity.type === "contact" ? "lastmodifieddate" : "hs_lastmodifieddate"] = new Date(updated).toISOString();
  const out: ReturnType<typeof toHubSpotObject> = {
    id, properties: props, createdAt: new Date(created).toISOString(), updatedAt: new Date(updated).toISOString(), archived: false,
  };
  const ref = entity.attrs.company;
  if (typeof ref === "string" && ref) {
    const c = state.entities[resolveAlias(state, ref)];
    if (c) out.associations = { companies: { results: [{ id: hsIdOf(c) ?? c.id, type: `${entity.type}_to_company` }] } };
  }
  return out;
}

/** HubSpot v4 default association type ids used on create (HUBSPOT_DEFINED, "primary"). */
export const ASSOC_TO_COMPANY: Record<string, number> = { contact: 1, deal: 5 };

/** OWNER: agent builder "schema". Must work with NO API key (deterministic fallback) and be better with one. */
import type {
  Actor,
  AgentContext,
  AgentProposal,
  CRMAgent,
  CRMState,
  EntityId,
  EntityType,
  EvidenceDoc,
  EvidenceRef,
  FieldType,
  FieldValue,
  NewEvent,
} from "../../core/types";
import { DETECTORS, sentenceBounds, type Detector } from "./detectors";

export { DETECTORS } from "./detectors";
export type { Detector, DetectorHit } from "./detectors";

/** A field must be seen on at least this many distinct entities before we propose it. */
export const MIN_ENTITIES = 3;
const MAX_QUOTE_WORDS = 24;
const ACTOR: Actor = { kind: "agent", id: "schema", name: "Schema agent" };
const SCANNED_KINDS = new Set<EvidenceDoc["kind"]>(["email", "note", "call"]);

/** One discovered (entity, value) pair with its supporting evidence. */
export interface Finding {
  entity: EntityId;
  value: FieldValue;
  evidence: EvidenceRef[];
  ts: number;
}

export interface FieldCandidate {
  entityType: EntityType;
  field: string;
  fieldType: FieldType;
  description: string;
  findings: Finding[];
  source: "detector" | "llm";
}

// ---------- helpers ----------

/** Resolve merged-away ids to their survivor. */
function resolve(state: CRMState, id: EntityId): EntityId {
  let cur = id;
  const seen = new Set<EntityId>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const next = state.aliases?.[cur] ?? state.entities[cur]?.mergedInto;
    if (!next) break;
    cur = next;
  }
  return cur;
}

function liveEntity(state: CRMState, id: EntityId) {
  const r = state.entities[resolve(state, id)];
  return r && !r.deleted ? r : undefined;
}

function typeOf(state: CRMState, id: EntityId): EntityType | undefined {
  return liveEntity(state, id)?.type ?? id.split(":")[0];
}

export function fieldExists(state: CRMState, entityType: EntityType, field: string): boolean {
  return (state.schema?.[entityType] ?? []).some((f) => f.field === field);
}

function domainOf(addr?: string): string | undefined {
  if (!addr) return undefined;
  const m = addr.match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return m ? m[1].toLowerCase() : undefined;
}

/** True if the company's domain matches the email domain (incl. subdomains like mail.acme.com). */
function domainMatches(companyDomain: FieldValue | undefined, emailDomain: string | undefined): boolean {
  if (typeof companyDomain !== "string" || !emailDomain) return false;
  const cd = companyDomain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  return emailDomain === cd || emailDomain.endsWith("." + cd);
}

function companyIdOf(state: CRMState, id: EntityId): EntityId | undefined {
  const r = liveEntity(state, id);
  if (!r) return undefined;
  if (r.type === "company") return r.id;
  const c = r.attrs.company;
  return typeof c === "string" ? resolve(state, c) : undefined;
}

function senderCompany(state: CRMState, doc: EvidenceDoc): EntityId | undefined {
  const d = domainOf(doc.from);
  if (!d) return undefined;
  for (const r of Object.values(state.entities)) {
    if (r.type === "company" && !r.deleted && !r.mergedInto && domainMatches(r.attrs.domain, d)) return r.id;
  }
  // fall back to a contact whose email domain matches
  for (const r of Object.values(state.entities)) {
    if (r.type === "contact" && !r.deleted && domainOf(String(r.attrs.email ?? "")) === d) {
      const c = companyIdOf(state, r.id);
      if (c) return c;
    }
  }
  return undefined;
}

/**
 * Which entity of `entityType` is this doc about?
 * Uses doc.entities; with several candidates, prefers the one whose company matches the sender's domain.
 * Falls back to the sender's company (and its single deal) when doc.entities doesn't name one.
 */
export function targetEntity(state: CRMState, doc: EvidenceDoc, entityType: EntityType): EntityId | undefined {
  const ids = [...new Set((doc.entities ?? []).map((e) => resolve(state, e)))];
  const candidates = ids.filter((id) => liveEntity(state, id)?.type === entityType);
  const sender = senderCompany(state, doc);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    if (sender) {
      const match = candidates.find((id) => companyIdOf(state, id) === sender);
      if (match) return match;
    }
    return [...candidates].sort()[0];
  }
  // no explicit candidate: infer from companies in doc.entities / sender domain
  const companies = new Set<EntityId>();
  if (sender) companies.add(sender);
  for (const id of ids) {
    const c = companyIdOf(state, id);
    if (c) companies.add(c);
  }
  if (entityType === "company") return companies.size === 1 ? [...companies][0] : sender;
  const pool = Object.values(state.entities).filter(
    (r) => r.type === entityType && !r.deleted && !r.mergedInto && companies.has(companyIdOf(state, r.id) ?? ""),
  );
  if (pool.length === 1) return pool[0].id;
  if (pool.length > 1 && sender) {
    const own = pool.filter((r) => companyIdOf(state, r.id) === sender);
    if (own.length === 1) return own[0].id;
  }
  return undefined;
}

/** Verbatim quote (<= MAX_QUOTE_WORDS words) around [start, end), cut from the containing sentence. */
export function makeQuote(body: string, start: number, end: number): string {
  const [s, e] = sentenceBounds(body, start, end);
  let qs = s;
  let qe = e;
  const words = (a: number, b: number) => body.slice(a, b).trim().split(/\s+/).filter(Boolean).length;
  // trim from the side farther from the match until it fits (keeps the match itself intact)
  while (words(qs, qe) > MAX_QUOTE_WORDS) {
    const left = start - qs;
    const right = qe - end;
    if (left <= 0 && right <= 0) break;
    if (left >= right) {
      const nxt = body.indexOf(" ", qs + 1);
      if (nxt < 0 || nxt >= start) qs = start;
      else qs = nxt + 1;
    } else {
      const prv = body.lastIndexOf(" ", qe - 2);
      if (prv < end) qe = end;
      else qe = prv;
    }
  }
  return body.slice(qs, qe).trim();
}

function sameValue(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ---------- deterministic pass ----------

export function runDetectors(state: CRMState, docs: EvidenceDoc[], detectors: Detector[] = DETECTORS): FieldCandidate[] {
  const ordered = docs.filter((d) => SCANNED_KINDS.has(d.kind)).sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  const out: FieldCandidate[] = [];
  for (const det of detectors) {
    if (fieldExists(state, det.entityType, det.field)) continue;
    const byEntity = new Map<EntityId, Finding>();
    for (const doc of ordered) {
      const hits = det.detect(doc);
      if (!hits.length) continue;
      const entity = targetEntity(state, doc, det.entityType);
      if (!entity) continue;
      for (const hit of hits) {
        const ref: EvidenceRef = { docId: doc.id, quote: makeQuote(doc.body, hit.start, hit.end), claim: hit.claim };
        const prev = byEntity.get(entity);
        if (!prev) {
          byEntity.set(entity, { entity, value: hit.value, evidence: [ref], ts: doc.ts });
          continue;
        }
        prev.value = det.combine ? det.combine(prev.value, hit.value) : hit.value; // latest wins by default
        prev.ts = doc.ts;
        if (!prev.evidence.some((r) => r.docId === ref.docId && r.quote === ref.quote)) {
          // newest evidence first: it's the one that justifies the current value
          prev.evidence.unshift(ref);
        }
      }
    }
    out.push({
      entityType: det.entityType,
      field: det.field,
      fieldType: det.fieldType,
      description: det.description,
      findings: [...byEntity.values()],
      source: "detector",
    });
  }
  return out;
}

// ---------- proposal building ----------

const plural = (t: EntityType, n: number) => (n === 1 ? t : t.endsWith("y") ? t.slice(0, -1) + "ies" : t + "s");

export function buildProposal(state: CRMState, cand: FieldCandidate): AgentProposal | null {
  if (fieldExists(state, cand.entityType, cand.field)) return null;
  const findings = cand.findings
    .filter((f) => liveEntity(state, f.entity)?.type === cand.entityType)
    .sort((a, b) => a.entity.localeCompare(b.entity));
  const distinct = new Set(findings.map((f) => f.entity));
  if (distinct.size < MIN_ENTITIES) return null;

  const key = `${cand.entityType}.${cand.field}`;
  const events: NewEvent[] = [
    {
      actor: ACTOR,
      op: {
        type: "schema.addField",
        entityType: cand.entityType,
        field: cand.field,
        fieldType: cand.fieldType,
        description: cand.description,
      },
      reason: `Add ${key}: mentioned for ${distinct.size} ${plural(cand.entityType, distinct.size)}, no field exists today`,
      evidence: findings.map((f) => f.evidence[0]),
    },
  ];
  const readSet: Record<string, number> = {};
  let backfilled = 0;
  for (const f of findings) {
    const rec = liveEntity(state, f.entity)!;
    const prev = rec.attrs[cand.field];
    if (sameValue(prev, f.value)) continue;
    const vkey = `${rec.id}::${cand.field}`;
    readSet[vkey] = state.versions?.[vkey] ?? 0;
    events.push({
      actor: ACTOR,
      op: { type: "field.set", entity: rec.id, field: cand.field, value: f.value, ...(prev !== undefined ? { prev } : {}) },
      reason: `Backfill ${key} from ${f.evidence.length === 1 ? "email" : `${f.evidence.length} emails`}`,
      evidence: f.evidence,
    });
    backfilled++;
  }
  if (backfilled < MIN_ENTITIES) return null;

  const names = findings.map((f) => {
    const name = liveEntity(state, f.entity)?.attrs.name;
    const v = Array.isArray(f.value) ? f.value.join(", ") : String(f.value);
    return `- ${typeof name === "string" && name ? name : f.entity}: ${v}`;
  });
  const how = cand.source === "llm" ? "Proposed by Claude from recurring email content; every value is quoted verbatim." : "Detected by pattern match.";
  return {
    title: `Schema: add ${key} (+${backfilled} backfilled)`,
    description: [
      `Mentioned in ${distinct.size} ${plural(cand.entityType, distinct.size)}' emails, no field exists today.`,
      "",
      `New field \`${key}\` (${cand.fieldType}): ${cand.description}`,
      "",
      "Backfill:",
      ...names,
      "",
      how,
    ].join("\n"),
    events,
    readSet,
  };
}

// ---------- LLM pass ----------

const FIELD_TYPES: FieldType[] = ["string", "number", "boolean", "date", "enum", "string[]", "ref"];

interface LLMField {
  entityType: string;
  field: string;
  fieldType: string;
  description?: string;
  values: { entity: string; value: unknown; docId: string; quote: string }[];
}

function extractJSON(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : text;
  const start = src.search(/[[{]/);
  if (start < 0) return null;
  const open = src[start];
  const close = open === "[" ? "]" : "}";
  const end = src.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(src.slice(start, end + 1));
  } catch {
    return null;
  }
}

function coerceValue(fieldType: FieldType, v: unknown): FieldValue | undefined {
  switch (fieldType) {
    case "number": {
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : NaN;
      return Number.isFinite(n) ? n : undefined;
    }
    case "boolean":
      return typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined;
    case "string[]":
      if (Array.isArray(v) && v.every((x) => typeof x === "string") && v.length) return v as string[];
      if (typeof v === "string" && v.trim()) return [v.trim()];
      return undefined;
    case "date":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
    default:
      return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined;
  }
}

/** Validate a raw LLM suggestion against the real state + docs. Returns null if it doesn't hold up. */
export function validateLLMField(state: CRMState, docs: EvidenceDoc[], raw: unknown, taken: Set<string>): FieldCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as LLMField;
  if (!["company", "contact", "deal"].includes(r.entityType)) return null;
  if (typeof r.field !== "string" || !/^[a-z][A-Za-z0-9]{1,40}$/.test(r.field)) return null;
  const fieldType = FIELD_TYPES.find((t) => t === r.fieldType);
  if (!fieldType || fieldType === "ref") return null;
  const key = `${r.entityType}.${r.field}`;
  if (taken.has(key) || fieldExists(state, r.entityType, r.field)) return null;
  // also reject if entities already carry that attribute (field exists informally)
  if (!Array.isArray(r.values)) return null;
  const docById = new Map(docs.map((d) => [d.id, d]));
  const byEntity = new Map<EntityId, Finding>();
  for (const v of r.values) {
    if (!v || typeof v.entity !== "string" || typeof v.docId !== "string" || typeof v.quote !== "string") continue;
    const rec = liveEntity(state, v.entity);
    if (!rec || rec.type !== r.entityType) continue;
    const doc = docById.get(v.docId);
    const quote = v.quote.trim();
    if (!doc || !quote || !doc.body.includes(quote)) continue;
    if (quote.split(/\s+/).length > 30) continue;
    const value = coerceValue(fieldType, v.value);
    if (value === undefined) continue;
    const ref: EvidenceRef = { docId: doc.id, quote, claim: `${r.field} = ${Array.isArray(value) ? value.join(", ") : value}` };
    const prev = byEntity.get(rec.id);
    if (!prev || doc.ts >= prev.ts) {
      byEntity.set(rec.id, { entity: rec.id, value, evidence: prev ? [ref, ...prev.evidence] : [ref], ts: doc.ts });
    } else {
      prev.evidence.push(ref);
    }
  }
  if (byEntity.size < MIN_ENTITIES) return null;
  return {
    entityType: r.entityType,
    field: r.field,
    fieldType,
    description: (typeof r.description === "string" && r.description.trim()) || `Recurring fact from emails: ${r.field}`,
    findings: [...byEntity.values()],
    source: "llm",
  };
}

const LLM_SYSTEM =
  "You are the schema agent of a CRM. You find recurring structured facts in customer emails that the CRM has no field for. " +
  "Answer ONLY with JSON. Quotes must be copied verbatim (exact substring) from the email body, under 25 words.";

function llmPrompt(state: CRMState, docs: EvidenceDoc[], exclude: string[]): string {
  const schema = Object.entries(state.schema ?? {})
    .map(([t, fs]) => `${t}: ${fs.map((f) => f.field).join(", ")}`)
    .join("\n");
  const entities = Object.values(state.entities)
    .filter((e) => !e.deleted && !e.mergedInto)
    .map((e) => `${e.id} (${typeof e.attrs.name === "string" ? e.attrs.name : e.type})`)
    .join("\n");
  const emails = docs
    .map((d) => `--- docId: ${d.id}\nfrom: ${d.from ?? ""}\nsubject: ${d.title}\nentities: ${(d.entities ?? []).join(", ")}\n${d.body.slice(0, 1500)}`)
    .join("\n");
  return [
    "Existing schema (fields per entity type):",
    schema,
    "",
    `Do NOT propose these (already handled): ${exclude.join(", ") || "none"}`,
    "",
    "Entities (use these exact ids):",
    entities,
    "",
    "Emails:",
    emails,
    "",
    "Propose up to 2 NEW fields, each mentioned for at least 3 distinct entities. Respond with a JSON array:",
    '[{"entityType":"deal","field":"camelCaseName","fieldType":"string|number|boolean|date|enum|string[]","description":"...",' +
      '"values":[{"entity":"deal:...","value":"...","docId":"...","quote":"exact text from the email"}]}]',
    "Return [] if nothing qualifies.",
  ].join("\n");
}

export async function llmCandidates(ctx: AgentContext, docs: EvidenceDoc[], exclude: string[]): Promise<FieldCandidate[]> {
  if (!docs.length) return [];
  let text: string | null = null;
  try {
    text = await ctx.llm({ system: LLM_SYSTEM, prompt: llmPrompt(ctx.state, docs, exclude), maxTokens: 2000 });
  } catch (e) {
    ctx.log(`schema: LLM call failed (${(e as Error).message}); deterministic only`);
    return [];
  }
  if (!text) return [];
  const parsed = extractJSON(text);
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
  const taken = new Set(exclude);
  const out: FieldCandidate[] = [];
  for (const raw of list.slice(0, 2)) {
    const cand = validateLLMField(ctx.state, docs, raw, taken);
    if (!cand) {
      ctx.log(`schema: rejected LLM suggestion ${JSON.stringify((raw as LLMField)?.field ?? raw).slice(0, 80)}`);
      continue;
    }
    taken.add(`${cand.entityType}.${cand.field}`);
    out.push(cand);
  }
  return out;
}

// ---------- agent ----------

export const schemaAgent: CRMAgent = {
  id: "schema",
  name: "Schema agent",
  description: "Notices information the CRM has no field for, and proposes schema migrations with backfill",
  async run(ctx: AgentContext): Promise<AgentProposal[]> {
    const docs = ctx.docs.filter((d) => SCANNED_KINDS.has(d.kind));
    const proposals: AgentProposal[] = [];
    const handled: string[] = DETECTORS.map((d) => `${d.entityType}.${d.field}`);

    for (const cand of runDetectors(ctx.state, docs)) {
      const p = buildProposal(ctx.state, cand);
      const n = new Set(cand.findings.map((f) => f.entity)).size;
      if (p) {
        proposals.push(p);
        ctx.log(`schema: proposing ${cand.entityType}.${cand.field} (${n} entities)`);
      } else if (n > 0) {
        ctx.log(`schema: ${cand.entityType}.${cand.field} seen on ${n} entit${n === 1 ? "y" : "ies"} (< ${MIN_ENTITIES}), skipping`);
      }
    }

    for (const cand of await llmCandidates(ctx, docs, handled)) {
      const p = buildProposal(ctx.state, cand);
      if (p) {
        proposals.push(p);
        ctx.log(`schema: proposing ${cand.entityType}.${cand.field} (LLM, validated)`);
      }
    }
    return proposals;
  },
};

/** OWNER: agent builder "hygiene". Must work with NO API key (deterministic fallback) and be better with one. */
import type {
  Actor,
  AgentContext,
  AgentProposal,
  CRMAgent,
  CRMState,
  EntityId,
  EntityRecord,
  FieldValue,
  NewEvent,
} from "../../core/types";

const ACTOR: Actor = { kind: "agent", id: "hygiene", name: "Hygiene agent" };
const vkey = (entity: EntityId, field: string) => `${entity}::${field}`;

/** Free-mail domains never count as "same company" evidence. */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
]);

// ---------- helpers ----------
export function isLive(state: CRMState, e: EntityRecord): boolean {
  return !e.deleted && !e.mergedInto && !state.aliases[e.id];
}

function nonEmpty(v: FieldValue | undefined): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function sameValue(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

const filledCount = (e: EntityRecord) => Object.values(e.attrs).filter(nonEmpty).length;

function str(e: EntityRecord, field: string): string {
  const v = e.attrs[field];
  return typeof v === "string" ? v : "";
}

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function normName(name: string): string {
  return nameTokens(name).join(" ");
}

export function emailDomain(email: string): string {
  const at = email.trim().toLowerCase().lastIndexOf("@");
  return at >= 0 ? email.trim().toLowerCase().slice(at + 1) : "";
}

function normDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

/** Survivor = more filled fields; tie → lexicographically smaller id. */
export function pickSurvivor(a: EntityRecord, b: EntityRecord): { into: EntityRecord; from: EntityRecord } {
  const fa = filledCount(a);
  const fb = filledCount(b);
  if (fa !== fb) return fa > fb ? { into: a, from: b } : { into: b, from: a };
  return a.id < b.id ? { into: a, from: b } : { into: b, from: a };
}

/** Field choices for the survivor: prefer non-empty, prefer the longer name. Only fields that actually change. */
export function computeFieldChoices(into: EntityRecord, from: EntityRecord): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  const fields = [...new Set([...Object.keys(into.attrs), ...Object.keys(from.attrs)])].sort();
  for (const f of fields) {
    const iv = into.attrs[f];
    const fv = from.attrs[f];
    let chosen: FieldValue | undefined = iv;
    if (f === "name" && typeof iv === "string" && typeof fv === "string") {
      chosen = fv.trim().length > iv.trim().length ? fv : iv;
    } else if (!nonEmpty(iv) && nonEmpty(fv)) {
      chosen = fv;
    }
    if (chosen !== undefined && !sameValue(chosen, iv)) out[f] = chosen;
  }
  return out;
}

function readSetFor(state: CRMState, ...entities: EntityRecord[]): Record<string, number> {
  const rs: Record<string, number> = {};
  for (const e of entities) {
    for (const f of Object.keys(e.attrs)) {
      const k = vkey(e.id, f);
      rs[k] = state.versions[k] ?? 0;
    }
  }
  return rs;
}

// ---------- contact dedup ----------
export interface ContactPair {
  a: EntityRecord;
  b: EntityRecord;
  rule: "exact-name+domain" | "exact-name" | "initial+domain";
  reason: string;
}

function isInitial(tok: string): boolean {
  return tok.length === 1;
}

export function findContactPairs(state: CRMState): ContactPair[] {
  const contacts = Object.values(state.entities)
    .filter((e) => e.type === "contact" && isLive(state, e))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const pairs: ContactPair[] = [];
  for (let i = 0; i < contacts.length; i++) {
    for (let j = i + 1; j < contacts.length; j++) {
      const a = contacts[i];
      const b = contacts[j];
      const na = str(a, "name").trim();
      const nb = str(b, "name").trim();
      if (!na || !nb) continue;
      const da = emailDomain(str(a, "email"));
      const db = emailDomain(str(b, "email"));
      const sameDomain = !!da && da === db && !FREE_MAIL.has(da);
      if (normName(na) === normName(nb)) {
        if (sameDomain) {
          pairs.push({ a, b, rule: "exact-name+domain", reason: `Same person: exact name match '${na}' and both use @${da}` });
        } else {
          const domNote = da && db && da !== db ? ` (different email domains: @${da} vs @${db})` : "";
          pairs.push({ a, b, rule: "exact-name", reason: `Weak evidence: exact name match: '${na}'${domNote}` });
        }
        continue;
      }
      if (!sameDomain) continue;
      const ta = nameTokens(na);
      const tb = nameTokens(nb);
      if (ta.length < 2 || tb.length < 2) continue;
      const la = ta[ta.length - 1];
      const lb = tb[tb.length - 1];
      if (ta[0] === tb[0] && la[0] === lb[0] && (isInitial(la) || isInitial(lb))) {
        pairs.push({
          a, b, rule: "initial+domain",
          reason: `Same person: '${na}' and '${nb}' share first name, last initial and @${da}`,
        });
      }
    }
  }
  const rank = { "exact-name+domain": 0, "initial+domain": 1, "exact-name": 2 } as const;
  return pairs.sort((p, q) => rank[p.rule] - rank[q.rule]);
}

// ---------- company dedup ----------
export function findCompanyPairs(state: CRMState): { a: EntityRecord; b: EntityRecord; reason: string }[] {
  const byDomain = new Map<string, EntityRecord[]>();
  for (const e of Object.values(state.entities)) {
    if (e.type !== "company" || !isLive(state, e)) continue;
    const d = normDomain(str(e, "domain"));
    if (!d) continue;
    byDomain.set(d, [...(byDomain.get(d) ?? []), e]);
  }
  const out: { a: EntityRecord; b: EntityRecord; reason: string }[] = [];
  for (const [d, list] of [...byDomain.entries()].sort()) {
    const sorted = list.sort((x, y) => (x.id < y.id ? -1 : 1));
    for (let i = 1; i < sorted.length; i++) {
      out.push({
        a: sorted[0], b: sorted[i],
        reason: `Same company: '${str(sorted[0], "name")}' and '${str(sorted[i], "name")}' share domain ${d}`,
      });
    }
  }
  return out;
}

// ---------- normalization ----------
export function normalizePhone(raw: string): string {
  const s = raw.trim();
  if (!s || /x|ext/i.test(s)) return s;
  if (s.startsWith("+") && !s.startsWith("+1")) return s; // non-US
  const digits = s.replace(/\D/g, "");
  let d = digits;
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) return s;
  return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export function normalizeCompanyName(raw: string): string {
  let s = raw.trim().replace(/\s+/g, " ");
  s = s.replace(/,?\s+inc\.?$/i, "").trim();
  if (/[a-z]/.test(s) && s === s.toLowerCase()) {
    s = s.replace(/(^|[\s\-])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
  }
  return s;
}

interface FieldFix {
  entity: EntityId;
  field: string;
  from: string;
  to: string;
  why: string;
}

export function findNormalizations(state: CRMState, skip: Set<EntityId> = new Set()): FieldFix[] {
  const fixes: FieldFix[] = [];
  const ents = Object.values(state.entities)
    .filter((e) => isLive(state, e) && !skip.has(e.id))
    .sort((x, y) => (x.id < y.id ? -1 : 1));
  for (const e of ents) {
    for (const field of Object.keys(e.attrs).sort()) {
      const v = e.attrs[field];
      if (typeof v !== "string") continue;
      let next = v.trim();
      const whys: string[] = [];
      if (next !== v) whys.push("trim whitespace");
      if (field === "email") {
        const lower = next.toLowerCase();
        if (lower !== next) whys.push("lowercase email");
        next = lower;
      } else if (field === "phone") {
        const p = normalizePhone(next);
        if (p !== next) whys.push("US phone format");
        next = p;
      } else if (field === "domain") {
        const lower = next.toLowerCase();
        if (lower !== next) whys.push("lowercase domain");
        next = lower;
      } else if (e.type === "company" && field === "name") {
        const n = normalizeCompanyName(next);
        if (n !== next) {
          const before = whys.length;
          if (/,?\s+inc\.?$/i.test(next)) whys.push("strip Inc. suffix");
          if (/[a-z]/.test(next) && next === next.toLowerCase()) whys.push("Title Case");
          if (whys.length === before) whys.push("collapse spaces");
        }
        next = n;
      }
      if (next !== v) fixes.push({ entity: e.id, field, from: v, to: next, why: whys.join(", ") || "normalize" });
    }
  }
  return fixes;
}

// ---------- LLM confirmation ----------
type Verdict = { same: boolean; note: string } | null;

async function confirmWithLLM(ctx: AgentContext, p: ContactPair, state: CRMState): Promise<Verdict> {
  const describe = (e: EntityRecord) => {
    const companyRef = str(e, "company");
    const company = companyRef ? state.entities[state.aliases[companyRef] ?? companyRef] : undefined;
    return JSON.stringify({ id: e.id, ...e.attrs, companyName: company ? str(company, "name") : undefined });
  };
  try {
    const out = await ctx.llm({
      system:
        "You are a CRM data-hygiene reviewer. Decide whether two contact records are the same real person. " +
        "Answer with SAME or DIFFERENT on the first line, then one short sentence of justification.",
      prompt: `Candidate duplicate (${p.rule}): ${p.reason}\nRecord A: ${describe(p.a)}\nRecord B: ${describe(p.b)}`,
      maxTokens: 150,
    });
    if (out == null) return null;
    const text = out.trim();
    const first = text.split("\n")[0].toUpperCase();
    const note = text.split("\n").slice(1).join(" ").trim() || text;
    if (first.includes("DIFFERENT")) return { same: false, note };
    if (first.includes("SAME")) return { same: true, note };
    return null;
  } catch (err) {
    ctx.log(`hygiene: LLM confirm failed (${String(err)}); using deterministic result`);
    return null;
  }
}

// ---------- proposal builders ----------
function label(state: CRMState, e: EntityRecord, other: EntityRecord): string {
  const name = str(e, "name").trim() || e.id;
  if (normName(name) !== normName(str(other, "name"))) return name;
  const ref = str(e, "company");
  const company = ref ? state.entities[state.aliases[ref] ?? ref] : undefined;
  const qual = (company && str(company, "name")) || emailDomain(str(e, "email")) || e.id;
  return `${name} (${qual})`;
}

function mergeProposal(
  state: CRMState,
  kind: "contact" | "company",
  into: EntityRecord,
  from: EntityRecord,
  reason: string,
  verdict: Verdict,
): AgentProposal {
  const fieldChoices = computeFieldChoices(into, from);
  const lowConf = verdict && !verdict.same;
  const title = `${lowConf ? "[low confidence] " : ""}Merge duplicate ${kind}: ${label(state, from, into)} → ${label(state, into, from)}`;
  const fullReason = verdict ? `${reason}. Claude: ${verdict.same ? "same person" : "different people"} — ${verdict.note}` : reason;
  const choiceLines = Object.entries(fieldChoices).map(([f, v]) => `- ${f}: ${JSON.stringify(v)} (from ${from.id})`);
  const description = [
    `${fullReason}.`,
    "",
    `Absorb \`${from.id}\` into \`${into.id}\` (survivor has ${filledCount(into)} filled fields vs ${filledCount(from)}; ties go to the smaller id).`,
    choiceLines.length ? `Field choices carried onto the survivor:\n${choiceLines.join("\n")}` : "No field values change on the survivor.",
    "One PR per merge so this can be reverted on its own.",
  ].join("\n");
  const ev: NewEvent = {
    actor: ACTOR,
    op: { type: "entity.merge", from: from.id, into: into.id, fieldChoices },
    reason: fullReason,
    evidence: [],
  };
  return { title, description, events: [ev], readSet: readSetFor(state, into, from) };
}

async function run(ctx: AgentContext): Promise<AgentProposal[]> {
  const state = ctx.state;
  const proposals: AgentProposal[] = [];
  const localAlias = new Map<EntityId, EntityId>();
  const resolve = (id: EntityId) => {
    let cur = id;
    while (localAlias.has(cur)) cur = localAlias.get(cur)!;
    return cur;
  };

  // contacts
  for (const p of findContactPairs(state)) {
    const ra = resolve(p.a.id);
    const rb = resolve(p.b.id);
    if (ra === rb || ra !== p.a.id || rb !== p.b.id) continue; // already absorbed this run
    const { into, from } = pickSurvivor(p.a, p.b);
    const verdict = await confirmWithLLM(ctx, p, state);
    localAlias.set(from.id, into.id);
    proposals.push(mergeProposal(state, "contact", into, from, p.reason, verdict));
    ctx.log(`hygiene: proposing merge ${from.id} → ${into.id} (${p.rule})`);
  }

  // companies
  for (const p of findCompanyPairs(state)) {
    const ra = resolve(p.a.id);
    const rb = resolve(p.b.id);
    if (ra === rb || ra !== p.a.id || rb !== p.b.id) continue;
    const { into, from } = pickSurvivor(p.a, p.b);
    localAlias.set(from.id, into.id);
    proposals.push(mergeProposal(state, "company", into, from, p.reason, null));
  }

  // normalization (skip records about to be merged away so a rebase can't clobber the survivor)
  const fixes = findNormalizations(state, new Set(localAlias.keys()));
  if (fixes.length) {
    const ents = new Set(fixes.map((f) => f.entity));
    const events: NewEvent[] = fixes.map((f) => ({
      actor: ACTOR,
      op: { type: "field.set", entity: f.entity, field: f.field, value: f.to, prev: f.from },
      reason: `Normalize ${f.field} (${f.why}): ${JSON.stringify(f.from)} → ${JSON.stringify(f.to)}`,
      evidence: [],
    }));
    const readSet: Record<string, number> = {};
    for (const f of fixes) readSet[vkey(f.entity, f.field)] = state.versions[vkey(f.entity, f.field)] ?? 0;
    proposals.push({
      title: `Normalize ${fixes.length} field${fixes.length === 1 ? "" : "s"} across ${ents.size} record${ents.size === 1 ? "" : "s"}`,
      description:
        "Formatting-only cleanup (no meaning changes):\n" +
        fixes.map((f) => `- ${f.entity}.${f.field}: ${JSON.stringify(f.from)} → ${JSON.stringify(f.to)} (${f.why})`).join("\n"),
      events,
      readSet,
    });
  }
  return proposals;
}

export const hygieneAgent: CRMAgent = {
  id: "hygiene",
  name: "Hygiene agent",
  description: "Deduplicates and normalizes records",
  run,
};

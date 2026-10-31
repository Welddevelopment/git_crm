/**
 * OWNER: agent builder A1 ("inbox").
 * Reads email threads and proposes small, evidence-backed PRs: deal stage/amount/close date/next step,
 * company headcount, contact titles (from signatures) and new contacts (unknown senders at known domains).
 * Works with NO API key (deterministic parsers); with one, Claude fills in fields the parsers missed.
 */
import type {
  AgentContext, AgentProposal, CRMAgent, CRMState, EntityId, EntityRecord, EvidenceDoc, EvidenceRef, FieldValue, NewEvent,
} from "../../core/types";
import { extractJSON } from "../llm";
import {
  cutQuote, domainOf, findAmount, findCloseDate, findEmployees, findNextStep, findSeats, findSignature, findStage,
  fmtDay, fmtMoney, fmtStage, ownTextEnd, parseFrom, slugify, STAGE_RANK, STAGES,
} from "./extract";

const ACTOR = { kind: "agent", id: "inbox", name: "Inbox agent" } as const;

// ---------- state helpers ----------

/** Follow aliases / mergedInto to the surviving entity. */
export function resolve(state: CRMState, id: EntityId): EntityId {
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

const typeOf = (state: CRMState, id: EntityId) => state.entities[id]?.type ?? id.split(":")[0];
const live = (e: EntityRecord | undefined): e is EntityRecord => !!e && !e.deleted && !e.mergedInto;
const str = (v: FieldValue | undefined) => (typeof v === "string" ? v : "");
const normDomain = (d: string) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();

function sameValue(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (typeof a === "string" && typeof b === "string") return a.trim().toLowerCase() === b.trim().toLowerCase();
  if (a == null && b == null) return true;
  return a === b;
}

/** Contact whose email matches exactly. Deliberately NOT alias-resolved (STORY collision #2 targets the dup). */
function contactByEmail(state: CRMState, email: string): EntityRecord | undefined {
  const all = Object.values(state.entities).filter(
    (e) => e.type === "contact" && !e.deleted && str(e.attrs.email).trim().toLowerCase() === email,
  );
  return all.find((e) => !e.mergedInto) ?? all[0];
}

function companyByDomain(state: CRMState, domain: string): EntityRecord | undefined {
  if (!domain) return undefined;
  return Object.values(state.entities).find((e) => {
    if (e.type !== "company" || !live(e)) return false;
    const d = normDomain(str(e.attrs.domain));
    return !!d && (domain === d || domain.endsWith("." + d));
  });
}

function dealsOfCompany(state: CRMState, companyId: EntityId): EntityRecord[] {
  return Object.values(state.entities).filter(
    (e) => e.type === "deal" && live(e) && typeof e.attrs.company === "string" && resolve(state, e.attrs.company) === companyId,
  );
}

// ---------- per-email targeting ----------

interface Sender {
  email: string;
  displayName?: string;
  contact?: EntityRecord; // exact email match (may be a dup / merged-away)
}

interface Targets { deal?: EntityId; company?: EntityId; sender?: Sender }

const GENERIC_LOCAL = /^(no-?reply|notifications?|support|info|billing|team|hello|sales|admin|mailer-daemon)$/i;

function targetsFor(state: CRMState, doc: EvidenceDoc): Targets {
  const t: Targets = {};
  const from = parseFrom(doc.from);
  if (from) t.sender = { email: from.email, displayName: from.name, contact: contactByEmail(state, from.email) };

  const ids = (doc.entities ?? []).map((id) => resolve(state, id)).filter((id) => state.entities[id] && !state.entities[id].deleted);
  const deals = [...new Set(ids.filter((id) => typeOf(state, id) === "deal"))];
  const companies = [...new Set(ids.filter((id) => typeOf(state, id) === "company"))];

  if (deals.length) t.deal = deals[0];
  if (companies.length) t.company = companies[0];
  if (!t.company && t.deal) {
    const c = state.entities[t.deal]?.attrs.company;
    if (typeof c === "string") t.company = resolve(state, c);
  }
  if (!t.company && t.sender?.contact) {
    const c = state.entities[resolve(state, t.sender.contact.id)]?.attrs.company;
    if (typeof c === "string") t.company = resolve(state, c);
  }
  if (!t.company && t.sender) t.company = companyByDomain(state, domainOf(t.sender.email))?.id;
  if (!t.deal && t.company) {
    const open = dealsOfCompany(state, t.company).filter((d) => !/^closed/.test(str(d.attrs.stage)));
    if (open.length === 1) t.deal = open[0].id;
  }
  return t;
}

// ---------- extraction ----------

type FieldKey = "stage" | "amount" | "closeDate" | "nextStep" | "employees" | "title";

interface Finding {
  entity: EntityId; // target entity (for "title": exact sender contact id, or the new contact id)
  field: FieldKey;
  value: FieldValue;
  doc: EvidenceDoc;
  quote: string;
  claim: string;
  source: "rules" | "llm";
}

interface NewContact { id: EntityId; attrs: Record<string, FieldValue>; doc: EvidenceDoc; quote: string; claim: string }

interface Cluster {
  key: EntityId;
  company?: EntityId;
  deals: Set<EntityId>;
  docs: EvidenceDoc[];
  findings: Map<string, Finding>; // `${entity}::${field}` -> latest finding
  newContacts: Map<string, NewContact>; // email -> pending create
  senders: Map<string, Sender>;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
function nameFromEmail(email: string): string {
  return titleCase(email.split("@")[0].replace(/[._-]+/g, " ").replace(/\d+/g, "").trim());
}
function senderFirst(s: Sender | undefined, state: CRMState): string {
  if (!s) return "Sender";
  const n = str(s.contact?.attrs.name) || s.displayName || nameFromEmail(s.email);
  return firstName(n.replace(/\.$/, "")) || "Sender";
}
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

function put(cl: Cluster, f: Finding) {
  const k = `${f.entity}::${f.field}`;
  const prev = cl.findings.get(k);
  if (!prev || f.doc.ts >= prev.doc.ts) cl.findings.set(k, f);
}

function newContactId(state: CRMState, taken: Set<string>, first: string, companyId: EntityId): EntityId {
  const base = `contact:${slugify(first) || "contact"}-${companyId.replace(/^company:/, "")}`;
  let id = base;
  for (let i = 2; state.entities[id] || taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

function extractRules(state: CRMState, cl: Cluster, doc: EvidenceDoc, t: Targets, takenIds: Set<string>) {
  const body = doc.body ?? "";
  const end = ownTextEnd(body);
  const who = senderFirst(t.sender, state);
  const q = (s: number, e: number) => cutQuote(body, s, e);

  if (t.deal) {
    const stage = findStage(body, end);
    const amount = findAmount(body, end);
    const seats = findSeats(body, end);
    if (stage) {
      const extra = seats ? ` for ${seats} seats${amount ? ` (${usd(amount.value as number)})` : ""}` : "";
      put(cl, {
        entity: t.deal, field: "stage", value: stage.value, doc, quote: q(stage.start, stage.end),
        claim: `${who} ${stage.what}${extra} → ${fmtStage(stage.value)}`, source: "rules",
      });
    }
    if (amount) {
      const v = amount.value as number;
      const claim = seats ? `${who} confirmed ${seats} seats, total ${usd(v)}` : `${who} ${amount.what} ${usd(v)} for the deal`;
      put(cl, { entity: t.deal, field: "amount", value: v, doc, quote: q(amount.start, amount.end), claim, source: "rules" });
    }
    const close = findCloseDate(body, end);
    if (close) {
      put(cl, {
        entity: t.deal, field: "closeDate", value: close.value, doc, quote: q(close.start, close.end),
        claim: `${who} is targeting a close date of ${close.value}`, source: "rules",
      });
    }
    const next = findNextStep(body, end);
    if (next) {
      put(cl, {
        entity: t.deal, field: "nextStep", value: next.value, doc, quote: q(next.start, next.end),
        claim: `Next step agreed: ${next.value}`, source: "rules",
      });
    }
  }

  if (t.company) {
    const emp = findEmployees(body, end);
    if (emp) {
      put(cl, {
        entity: t.company, field: "employees", value: emp.value, doc, quote: q(emp.start, emp.end),
        claim: `${who} says the company is now ${emp.value} people`, source: "rules",
      });
    }
  }

  const s = t.sender;
  if (!s) return;
  const sig = findSignature(body, end);
  if (s.contact) {
    if (sig) {
      const cname = str(s.contact.attrs.name);
      const ok = !cname || firstName(cname).replace(/\.$/, "").toLowerCase() === firstName(sig.name).toLowerCase()
        || s.email.split("@")[0].toLowerCase().includes(firstName(sig.name).toLowerCase());
      if (ok) {
        put(cl, {
          entity: s.contact.id, field: "title", value: sig.title, doc, quote: body.slice(sig.start, sig.end),
          claim: `${s.email} signs as "${sig.name} — ${sig.title}"`, source: "rules",
        });
      }
    }
    return;
  }

  // Unknown sender at a known company domain → new contact.
  const local = s.email.split("@")[0];
  const company = companyByDomain(state, domainOf(s.email));
  if (!company || GENERIC_LOCAL.test(local)) return;
  const existing = cl.newContacts.get(s.email);
  const name = sig?.name || (s.displayName && !s.displayName.includes("@") ? s.displayName : "") || nameFromEmail(s.email);
  const title = sig?.title ?? (existing ? str(existing.attrs.title) : "");
  if (existing && existing.doc.ts > doc.ts) {
    if (!existing.attrs.title && title) existing.attrs.title = title;
    return;
  }
  const id = existing?.id ?? newContactId(state, takenIds, firstName(name), company.id);
  takenIds.add(id);
  const attrs: Record<string, FieldValue> = { name, email: s.email, company: company.id };
  if (title) attrs.title = title;
  const quote = sig ? body.slice(sig.start, sig.end) : cutQuote(body, 0, Math.min(body.length, 1));
  cl.newContacts.set(s.email, {
    id, attrs, doc, quote,
    claim: `New sender ${s.email} at ${str(company.attrs.name) || company.id}${title ? ` (${title})` : ""}`,
  });
}

// ---------- LLM pass ----------

interface LLMField { value?: unknown; docId?: unknown; quote?: unknown }
interface LLMReply {
  deal?: Partial<Record<"stage" | "amount" | "closeDate" | "nextStep", LLMField | null>> | null;
  company?: { employees?: LLMField | null } | null;
  contacts?: { email?: unknown; title?: LLMField | null }[] | null;
}

const SYSTEM = `You extract CRM updates from sales email threads. Reply with STRICT JSON only, no prose.
Only report facts the emails state explicitly. Each fact needs the email id it came from and a short VERBATIM quote (under 25 words, copied exactly from that email's body). If several emails disagree, use the most recent one. Use null when an email does not state a field. Never invent ids.`;

function llmPrompt(state: CRMState, cl: Cluster, dealId: EntityId | undefined): string {
  const deal = dealId ? state.entities[dealId] : undefined;
  const company = cl.company ? state.entities[cl.company] : undefined;
  const contacts = [...cl.senders.values()].filter((s) => s.contact).map((s) => ({ email: s.email, name: s.contact!.attrs.name, title: s.contact!.attrs.title ?? "" }));
  const current = {
    deal: deal ? { name: deal.attrs.name, stage: deal.attrs.stage, amount: deal.attrs.amount, closeDate: deal.attrs.closeDate, nextStep: deal.attrs.nextStep ?? "" } : null,
    company: company ? { name: company.attrs.name, employees: company.attrs.employees ?? null } : null,
    contacts,
  };
  const emails = [...cl.docs].sort((a, b) => a.ts - b.ts).map((d) => ({
    id: d.id, date: new Date(d.ts).toISOString().slice(0, 10), from: d.from ?? "", subject: d.title, body: d.body.slice(0, ownTextEnd(d.body)).slice(0, 4000),
  }));
  return `Current CRM record:\n${JSON.stringify(current, null, 2)}

Emails (oldest first):\n${JSON.stringify(emails, null, 2)}

Return JSON with exactly this shape (each fact is {"value", "docId", "quote"} or null):
{
  "deal": {
    "stage": one of ${JSON.stringify(STAGES)} or null,
    "amount": total deal value in USD as a number (not a per-seat price; seat counts alone are not an amount) or null,
    "closeDate": "YYYY-MM-DD" (assume year 2026 if not given) or null,
    "nextStep": short string or null
  },
  "company": { "employees": integer headcount or null },
  "contacts": [ { "email": one of ${JSON.stringify(contacts.map((c) => c.email))}, "title": job title from that sender's signature or null } ]
}${deal ? "" : "\nThere is no deal for this thread: set \"deal\" to null."}`;
}

function validLLM(field: FieldKey, v: unknown): FieldValue | undefined {
  switch (field) {
    case "stage":
      return typeof v === "string" && (STAGES as string[]).includes(v) ? v : undefined;
    case "amount": {
      const n = typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : v;
      return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
    }
    case "employees": {
      const n = typeof v === "string" ? Number(v.replace(/[,\s]/g, "")) : v;
      return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
    }
    case "closeDate":
      return typeof v === "string" && /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v) ? v : undefined;
    case "nextStep":
    case "title":
      return typeof v === "string" && v.trim() && v.length <= 140 ? v.trim() : undefined;
  }
}

/** Accept an LLM fact only if its doc is in the cluster and its quote is verbatim from that doc. */
function llmFinding(cl: Cluster, entity: EntityId, field: FieldKey, f: LLMField | null | undefined, claim: (v: FieldValue) => string): Finding | null {
  if (!f || typeof f !== "object") return null;
  const value = validLLM(field, f.value);
  if (value === undefined) return null;
  const doc = cl.docs.find((d) => d.id === f.docId);
  if (!doc || typeof f.quote !== "string") return null;
  let quote = f.quote.trim();
  if (!quote || !doc.body.includes(quote)) return null;
  const words = quote.split(/\s+/);
  if (words.length > 24) {
    const idx = doc.body.indexOf(quote);
    quote = cutQuote(doc.body, idx, idx + 1);
  }
  return { entity, field, value, doc, quote, claim: claim(value), source: "llm" };
}

async function llmPass(ctx: AgentContext, cl: Cluster): Promise<void> {
  const state = ctx.state;
  const dealId = cl.deals.size === 1 ? [...cl.deals][0] : undefined;
  let reply: string | null = null;
  try {
    reply = await ctx.llm({ system: SYSTEM, prompt: llmPrompt(state, cl, dealId), maxTokens: 1024 });
  } catch {
    reply = null;
  }
  if (!reply) return;
  const json = extractJSON<LLMReply>(reply);
  if (!json || typeof json !== "object") {
    ctx.log(`LLM reply for ${cl.key} was not JSON; using rules only`);
    return;
  }
  const add = (f: Finding | null) => {
    if (!f) return;
    const k = `${f.entity}::${f.field}`;
    if (!cl.findings.has(k)) cl.findings.set(k, f); // deterministic wins
  };
  if (dealId && json.deal && typeof json.deal === "object") {
    add(llmFinding(cl, dealId, "stage", json.deal.stage, (v) => `Thread indicates the deal is in ${fmtStage(v)}`));
    add(llmFinding(cl, dealId, "amount", json.deal.amount, (v) => `Thread puts the deal at ${usd(v as number)}`));
    add(llmFinding(cl, dealId, "closeDate", json.deal.closeDate, (v) => `Thread targets a close date of ${v}`));
    add(llmFinding(cl, dealId, "nextStep", json.deal.nextStep, (v) => `Next step agreed: ${v}`));
  }
  if (cl.company && json.company && typeof json.company === "object") {
    add(llmFinding(cl, cl.company, "employees", json.company.employees, (v) => `Thread says the company is now ${v} people`));
  }
  if (Array.isArray(json.contacts)) {
    for (const c of json.contacts) {
      if (!c || typeof c.email !== "string") continue;
      const s = cl.senders.get(c.email.trim().toLowerCase());
      if (!s?.contact) continue; // only contacts we matched ourselves; never ids from the model
      add(llmFinding(cl, s.contact.id, "title", c.title, (v) => `${s.email} signs as ${v}`));
    }
  }
}

// ---------- proposal assembly ----------

const FIELD_ORDER: FieldKey[] = ["stage", "amount", "closeDate", "nextStep", "employees", "title"];

function evidence(f: { doc: EvidenceDoc; quote: string; claim: string }): EvidenceRef[] {
  return [{ docId: f.doc.id, quote: f.quote, claim: f.claim }];
}

function describe(state: CRMState, f: Finding, prev: FieldValue | undefined): { bullet: string; short: string } {
  const e = state.entities[resolve(state, f.entity)];
  switch (f.field) {
    case "stage":
      return { bullet: `Stage: ${fmtStage(prev)} → ${fmtStage(f.value)}`, short: `${fmtStage(prev)} → ${fmtStage(f.value)}` };
    case "amount":
      return { bullet: `Amount: ${fmtMoney(prev)} → ${fmtMoney(f.value)}`, short: `${fmtMoney(prev)} → ${fmtMoney(f.value)}` };
    case "closeDate":
      return { bullet: `Close date: ${str(prev) || "—"} → ${f.value}`, short: `close ${f.value}` };
    case "nextStep":
      return { bullet: `Next step: "${f.value}"`, short: "next step" };
    case "employees":
      return { bullet: `Employees (${str(e?.attrs.name) || f.entity}): ${prev ?? "—"} → ${f.value}`, short: `${f.value} employees` };
    case "title": {
      const n = str(state.entities[f.entity]?.attrs.name) || f.entity;
      return { bullet: `Title (${n}, ${f.entity}): "${str(prev) || "—"}" → "${f.value}"`, short: `${n}: ${f.value}` };
    }
  }
}

function buildProposal(state: CRMState, cl: Cluster): AgentProposal | null {
  const events: NewEvent[] = [];
  const bullets: string[] = [];
  const shorts: string[] = [];
  const usedDocs = new Set<string>();

  for (const nc of cl.newContacts.values()) {
    // Another email may have created this person already (same email) — never duplicate.
    if (contactByEmail(state, str(nc.attrs.email))) continue;
    const when = fmtDay(nc.doc.ts);
    events.push({
      actor: { ...ACTOR },
      op: { type: "entity.create", entity: nc.id, entityType: "contact", attrs: nc.attrs },
      reason: `New contact from email (${when}): ${nc.attrs.name} <${nc.attrs.email}>`,
      evidence: evidence(nc),
    });
    bullets.push(`New contact: ${nc.attrs.name}${nc.attrs.title ? ` (${nc.attrs.title})` : ""} <${nc.attrs.email}>`);
    shorts.push(`+ ${nc.attrs.name}`);
    usedDocs.add(nc.doc.id);
  }

  const findings = [...cl.findings.values()].sort(
    (a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field) || a.entity.localeCompare(b.entity),
  );
  for (const f of findings) {
    // Contact title targets the exact sender entity (even a dup); compare against it, or its survivor if merged away.
    const rec = f.field === "title" ? state.entities[f.entity] : state.entities[resolve(state, f.entity)];
    if (!rec || rec.deleted) continue;
    const cmp = f.field === "title" && rec.mergedInto ? state.entities[resolve(state, f.entity)] ?? rec : rec;
    const prev = cmp.attrs[f.field];
    if (sameValue(prev, f.value)) continue;
    if (f.field === "stage") {
      const cur = str(prev);
      if (/^closed/.test(cur)) continue; // never reopen a closed deal from a cue
      if (f.value !== "closed_lost" && cur && (STAGE_RANK[f.value as string] ?? 0) < (STAGE_RANK[cur] ?? 0)) continue; // no regressions
    }
    const { bullet, short } = describe(state, f, prev);
    const sender = parseFrom(f.doc.from);
    const reasonFrom = sender ? `${sender.name ?? sender.email}` : "email";
    events.push({
      actor: { ...ACTOR },
      op: { type: "field.set", entity: f.entity, field: f.field, value: f.value, ...(prev !== undefined ? { prev } : {}) },
      reason: `${bullet} — per ${reasonFrom}'s email (${fmtDay(f.doc.ts)})${f.source === "llm" ? " [LLM-extracted]" : ""}`,
      evidence: evidence(f),
    });
    bullets.push(bullet);
    shorts.push(short);
    usedDocs.add(f.doc.id);
  }

  if (!events.length) return null;

  const deal = cl.deals.size === 1 ? state.entities[[...cl.deals][0]] : undefined;
  const company = cl.company ? state.entities[cl.company] : undefined;
  const cname = str(company?.attrs.name);
  const dname = str(deal?.attrs.name);
  const companyShort = cname.split(/\s+/)[0] || cname;
  const subject = dname ? (/[—–]/.test(dname) || !cname ? dname : `${companyShort} — ${dname}`) : cname || cl.key;
  const shown = shorts.slice(0, 3).join(", ") + (shorts.length > 3 ? ` +${shorts.length - 3} more` : "");

  return {
    title: `${subject}: ${shown}`,
    description: `${bullets.map((b) => `- ${b}`).join("\n")}\n\nEvidence: ${usedDocs.size} email${usedDocs.size === 1 ? "" : "s"}`,
    events,
  };
}

// ---------- agent ----------

export async function runInbox(ctx: AgentContext): Promise<AgentProposal[]> {
  const state = ctx.state;
  const emails = ctx.docs.filter((d) => d.kind === "email" && typeof d.body === "string").sort((a, b) => a.ts - b.ts);
  const clusters = new Map<EntityId, Cluster>();
  const takenIds = new Set<string>();

  for (const doc of emails) {
    const t = targetsFor(state, doc);
    const key = t.company ?? t.deal ?? (t.sender?.contact ? resolve(state, t.sender.contact.id) : undefined)
      ?? (t.sender ? companyByDomain(state, domainOf(t.sender.email))?.id : undefined);
    if (!key) continue;
    let cl = clusters.get(key);
    if (!cl) {
      cl = { key, company: t.company, deals: new Set(), docs: [], findings: new Map(), newContacts: new Map(), senders: new Map() };
      clusters.set(key, cl);
    }
    if (t.deal) cl.deals.add(t.deal);
    cl.docs.push(doc);
    if (t.sender) cl.senders.set(t.sender.email, t.sender);
    extractRules(state, cl, doc, t, takenIds);
  }

  const list = [...clusters.values()];
  await Promise.all(list.map((cl) => llmPass(ctx, cl)));

  const out: { p: AgentProposal; ts: number }[] = [];
  for (const cl of list) {
    const p = buildProposal(state, cl);
    if (p) out.push({ p, ts: Math.max(...cl.docs.map((d) => d.ts)) });
  }
  out.sort((a, b) => b.ts - a.ts);
  ctx.log(`read ${emails.length} emails in ${list.length} threads → ${out.length} proposal(s)`);
  return out.map((o) => o.p);
}

export const inboxAgent: CRMAgent = {
  id: "inbox",
  name: "Inbox agent",
  description: "Reads email threads and keeps contacts, deals and stages current — with the email as evidence",
  run: runInbox,
};

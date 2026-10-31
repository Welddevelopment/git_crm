/** OWNER: W3 (staleness / decision conflicts).
 *
 * Two flavours of "your PR is out of date":
 *  - version-conflict: a field the agent READ changed on main since it read it (readSet).
 *  - stale (decision conflict): newer evidence landed on main that contradicts the agent's reasoning,
 *    e.g. the PR moves Acme to Negotiation, but a new email says Acme is pausing.
 *
 * Pure: no I/O, no Date.now(). The LLM judge is injected.
 */
import type { Branch, CRMState, EntityId, Event, EvidenceDoc, FieldValue, Op, PullRequest, StalenessReport } from "./types";

/** Decides whether newer evidence invalidates a PR's reasoning. Heuristic default; LLM judge optional. */
export type Judge = (args: { prTitle: string; claims: { eventId: string; claim: string; reason?: string }[]; newDoc: EvidenceDoc }) =>
  Promise<{ contradicts: boolean; explanation: string; affectsEvents: string[] }>;

export interface StalenessInput {
  pr: PullRequest;
  branch: Branch;
  branchEvents: Event[];
  mainEvents: Event[];
  mainState: CRMState; // current main head
  judge?: Judge; // default: heuristicJudge
}

type Claim = Parameters<Judge>[0]["claims"][number];
/** Local extension: checkStaleness passes the op along so judges can reason structurally. Optional for other callers. */
type RichClaim = Claim & { op?: Op; entity?: EntityId };

// ---------------------------------------------------------------- helpers

function resolve(state: CRMState, id: EntityId): EntityId {
  let cur = id;
  const seen = new Set<EntityId>();
  while (state.aliases?.[cur] && !seen.has(cur)) {
    seen.add(cur);
    cur = state.aliases[cur];
  }
  // also honour mergedInto on the record itself
  while (state.entities?.[cur]?.mergedInto && !seen.has(cur)) {
    seen.add(cur);
    cur = state.entities[cur].mergedInto!;
  }
  return cur;
}

function opEntities(op: Op): EntityId[] {
  switch (op.type) {
    case "entity.create":
    case "field.set":
    case "entity.delete":
      return [op.entity];
    case "entity.merge":
      return [op.from, op.into];
    case "evidence.attach":
      return op.doc.entities ?? [];
    default:
      return [];
  }
}

function fmtValue(v: FieldValue | undefined): string {
  if (v === undefined) return "∅";
  if (Array.isArray(v)) return `[${v.join(", ")}]`;
  return String(v);
}

function describeOp(op: Op): string {
  switch (op.type) {
    case "entity.create":
      return `Create ${op.entityType} ${op.entity}`;
    case "field.set": {
      const v = op.field === "amount" && typeof op.value === "number" ? fmtMoney(op.value) : fmtValue(op.value);
      return `Set ${op.entity}.${op.field} = ${v}`;
    }
    case "entity.delete":
      return `Delete ${op.entity}`;
    case "entity.merge":
      return `Merge ${op.from} into ${op.into}`;
    case "schema.addField":
      return `Add field ${op.entityType}.${op.field} (${op.fieldType})`;
    case "schema.renameField":
      return `Rename field ${op.entityType}.${op.from} → ${op.to}`;
    case "schema.removeField":
      return `Remove field ${op.entityType}.${op.field}`;
    case "evidence.attach":
      return `Attach ${op.doc.kind} "${op.doc.title}"`;
  }
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

const KIND_LABEL: Record<EvidenceDoc["kind"], string> = { email: "email", web: "web page", note: "note", call: "call notes" };

function fmtDate(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

function truncWords(s: string, n: number): string {
  const words = s.trim().split(/\s+/);
  return words.length <= n ? words.join(" ") : words.slice(0, n).join(" ") + "…";
}

// ---------------------------------------------------------------- heuristic judge

const NEGATIVE_CUES: RegExp[] = [
  /\bpaus(?:e|es|ed|ing)\b/,
  /\bon hold\b/,
  /\bbudget freeze\b/,
  /\bhiring freeze\b/,
  /\bfreez(?:e|ing)\b/,
  /\bpostpon\w*/,
  /\bnot moving forward\b/,
  /\bwon'?t be moving forward\b/,
  /\bgoing with another vendor\b/,
  /\bcancel\w*/,
  /\bno longer\b/,
  /\bdelay(?:ed|ing)? (?:the|our)\b/,
  /\bpush(?:ed|ing)? (?:this |it )?(?:back|out) to\b/,
];

const FORWARD_TEXT =
  /\b(negotiat\w*|proposal|demo|msa|seats?|stage|advanc\w*|upgrad\w*|expan\w*|increas\w*|upsell|ready to sign|redlines?|close ?date|closing)\b|\$\s?\d/i;

const DEAL_FWD_FIELDS = new Set(["stage", "amount", "closeDate"]);

function isForwardMoving(c: RichClaim): boolean {
  const op = c.op;
  if (op) {
    if (op.type === "field.set" && op.entity.startsWith("deal:") && DEAL_FWD_FIELDS.has(op.field)) {
      if (op.field === "stage" && op.value === "closed_lost") return false;
      if (op.field === "amount" && typeof op.value === "number" && typeof op.prev === "number" && op.value < op.prev) return false;
      return true;
    }
    if (op.type === "entity.create" && op.entityType === "deal") return true;
  }
  return FORWARD_TEXT.test(`${c.claim} ${c.reason ?? ""}`);
}

function findCue(text: string): { cue: string; sentence: string } | null {
  const lower = text.toLowerCase();
  for (const re of NEGATIVE_CUES) {
    const m = re.exec(lower);
    if (!m) continue;
    // sentence containing the cue, from the original text
    const start = Math.max(lower.lastIndexOf(".", m.index), lower.lastIndexOf("!", m.index), lower.lastIndexOf("?", m.index), lower.lastIndexOf("\n", m.index)) + 1;
    const ends = [".", "!", "?", "\n"].map((ch) => lower.indexOf(ch, m.index + m[0].length)).filter((i) => i >= 0);
    const end = ends.length ? Math.min(...ends) : text.length;
    return { cue: m[0], sentence: text.slice(start, end).trim() };
  }
  return null;
}

// "$45,000", "$45k", "$1.2m"; ignores per-unit prices like "$1,000/seat" or "$80 per seat".
const MONEY_RE = /\$\s?(\d{1,3}(?:,\d{3})+(?!\d)|\d+(?:\.\d+)?(?![\d,]))\s?(k|m|million|thousand)?\b(?!\s*(?:\/|per\b))/gi;

export function parseAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(MONEY_RE)) {
    let n = Number(m[1].replace(/,/g, ""));
    const unit = (m[2] ?? "").toLowerCase();
    if (unit === "k" || unit === "thousand") n *= 1_000;
    if (unit === "m" || unit === "million") n *= 1_000_000;
    if (Number.isFinite(n)) out.push(Math.round(n));
  }
  return out;
}

function headline(doc: EvidenceDoc): string {
  return `New ${KIND_LABEL[doc.kind] ?? doc.kind} "${doc.title}" (${fmtDate(doc.ts)})`;
}

function claimSummary(claims: RichClaim[]): string {
  const texts = [...new Set(claims.map((c) => c.claim))];
  const s = texts.slice(0, 2).join("; ") + (texts.length > 2 ? ` (+${texts.length - 2} more)` : "");
  return truncWords(s, 20);
}

export const heuristicJudge: Judge = async ({ claims, newDoc }) => {
  const rich = claims as RichClaim[];
  const text = `${newDoc.title}\n${newDoc.body}`;
  const docEntities = new Set(newDoc.entities ?? []);

  // 1) Negative cue vs forward-moving claims.
  const cue = findCue(text);
  if (cue) {
    const forward = rich.filter(isForwardMoving);
    if (forward.length) {
      return {
        contradicts: true,
        explanation: `${headline(newDoc)} says "${truncWords(cue.sentence, 18)}" — contradicts "${claimSummary(forward)}".`,
        affectsEvents: forward.map((c) => c.eventId),
      };
    }
  }

  // 2) Same deal, different dollar amount than the PR sets.
  const docAmounts = parseAmounts(text);
  if (docAmounts.length) {
    const amountClaims: { c: RichClaim; amount: number }[] = [];
    for (const c of rich) {
      const op = c.op;
      if (op) {
        if (op.type === "field.set" && op.field === "amount" && typeof op.value === "number") {
          const ent = c.entity ?? op.entity;
          if (docEntities.has(ent) || docEntities.has(op.entity)) amountClaims.push({ c, amount: op.value });
        }
      } else if (/\bamount\b/i.test(`${c.claim} ${c.reason ?? ""}`) && [...docEntities].some((e) => e.startsWith("deal:"))) {
        const a = parseAmounts(`${c.claim} ${c.reason ?? ""}`);
        if (a.length) amountClaims.push({ c, amount: a[a.length - 1] });
      }
    }
    const mismatched = amountClaims.filter(({ amount }) => !docAmounts.includes(amount));
    if (mismatched.length) {
      const { amount } = mismatched[0];
      const mentioned = docAmounts.map(fmtMoney).join(", ");
      return {
        contradicts: true,
        explanation: `${headline(newDoc)} mentions ${mentioned} — contradicts the PR setting the amount to ${fmtMoney(amount)}.`,
        affectsEvents: mismatched.map(({ c }) => c.eventId),
      };
    }
  }

  return { contradicts: false, explanation: cue ? `"${cue.cue}" found, but no forward-moving change in this PR.` : "No contradiction found.", affectsEvents: [] };
};

// ---------------------------------------------------------------- LLM judge

const LLM_SYSTEM = `You review pull requests that AI agents opened against a CRM.
Each PR makes changes justified by claims drawn from evidence. A NEW document has arrived since the PR was opened.
Decide whether the new document contradicts or invalidates the reasoning behind any change (a "decision conflict").
Only flag real contradictions (e.g. the customer paused, cancelled, chose another vendor, or stated a different amount/date/fact).
Respond with STRICT JSON only, no prose, no code fences:
{"contradicts": boolean, "explanation": string (one sentence, < 35 words, quote the new doc briefly), "affectsEvents": string[] (eventIds of affected changes)}`;

function buildPrompt(prTitle: string, claims: RichClaim[], doc: EvidenceDoc): string {
  const lines = claims.map((c) => {
    const op = c.op ? ` | change: ${describeOp(c.op)}` : "";
    return `- eventId=${c.eventId} | claim: ${c.claim}${c.reason && c.reason !== c.claim ? ` | reason: ${c.reason}` : ""}${op}`;
  });
  return [
    `PR: ${prTitle}`,
    `Changes and their claims:`,
    ...lines,
    ``,
    `NEW ${doc.kind.toUpperCase()} (${new Date(doc.ts).toISOString()})`,
    `Title: ${doc.title}`,
    doc.from ? `From: ${doc.from}` : "",
    doc.entities?.length ? `About: ${doc.entities.join(", ")}` : "",
    `Body:`,
    doc.body.slice(0, 4000),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function parseJudgeJson(raw: string, validIds: Set<string>): { contradicts: boolean; explanation: string; affectsEvents: string[] } | null {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  s = s.slice(a, b + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(s);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  let contradicts: boolean;
  if (typeof o.contradicts === "boolean") contradicts = o.contradicts;
  else if (o.contradicts === "true" || o.contradicts === "false") contradicts = o.contradicts === "true";
  else return null;
  const explanation = typeof o.explanation === "string" ? o.explanation.trim() : "";
  let affects = Array.isArray(o.affectsEvents) ? o.affectsEvents.filter((x): x is string => typeof x === "string" && validIds.has(x)) : [];
  if (contradicts && affects.length === 0) affects = [...validIds];
  if (!contradicts) affects = [];
  return { contradicts, explanation: explanation || (contradicts ? "New evidence contradicts this PR." : "No contradiction found."), affectsEvents: affects };
}

export function llmJudge(llm: (a: { system: string; prompt: string; maxTokens?: number }) => Promise<string | null>): Judge {
  return async (args) => {
    const claims = args.claims as RichClaim[];
    let raw: string | null = null;
    try {
      raw = await llm({ system: LLM_SYSTEM, prompt: buildPrompt(args.prTitle, claims, args.newDoc), maxTokens: 300 });
    } catch {
      raw = null;
    }
    if (raw) {
      const parsed = parseJudgeJson(raw, new Set(claims.map((c) => c.eventId)));
      if (parsed) {
        if (parsed.contradicts && !parsed.explanation.startsWith("New ")) {
          parsed.explanation = `${headline(args.newDoc)}: ${parsed.explanation}`;
        }
        return parsed;
      }
    }
    return heuristicJudge(args);
  };
}

// ---------------------------------------------------------------- checkStaleness

export async function checkStaleness(input: StalenessInput): Promise<StalenessReport> {
  const { pr, branch, branchEvents, mainEvents, mainState } = input;
  const judge = input.judge ?? heuristicJudge;

  // 1) version conflicts from the read set
  const changedReads: StalenessReport["changedReads"] = [];
  for (const [key, seenVersion] of Object.entries(branch.readSet ?? {})) {
    const currentVersion = mainState.versions?.[key] ?? 0;
    if (currentVersion > seenVersion) changedReads.push({ key, seenVersion, currentVersion });
  }

  // 2) entities this PR touches (resolved), plus parent companies of deals/contacts
  const touched = new Set<EntityId>();
  const addWithCompany = (id: EntityId, extraAttrs?: Record<string, FieldValue>) => {
    const r = resolve(mainState, id);
    touched.add(r);
    const rec = mainState.entities?.[r];
    const type = rec?.type ?? r.split(":")[0];
    if (type === "deal" || type === "contact") {
      const company = (extraAttrs?.company ?? rec?.attrs?.company) as FieldValue | undefined;
      if (typeof company === "string" && company) touched.add(resolve(mainState, company));
    }
  };
  const citedDocs = new Set<string>();
  for (const e of branchEvents) {
    for (const ref of e.evidence ?? []) citedDocs.add(ref.docId);
    if (e.op.type === "evidence.attach") {
      citedDocs.add(e.op.doc.id);
      continue; // attaching a doc isn't itself a decision
    }
    const extra =
      e.op.type === "entity.create" ? e.op.attrs : e.op.type === "field.set" && e.op.field === "company" ? { company: e.op.value } : undefined;
    for (const id of opEntities(e.op)) addWithCompany(id, extra);
  }

  // 3) candidate newer docs on main about those entities
  const candidates: EvidenceDoc[] = [];
  const seenDocs = new Set<string>();
  for (const e of mainEvents) {
    if (e.seq <= branch.forkSeq || e.op.type !== "evidence.attach") continue;
    const doc = e.op.doc;
    if (seenDocs.has(doc.id) || citedDocs.has(doc.id)) continue;
    const resolvedEntities = (doc.entities ?? []).map((id) => resolve(mainState, id));
    if (!resolvedEntities.some((id) => touched.has(id))) continue;
    seenDocs.add(doc.id);
    candidates.push({ ...doc, entities: [...new Set([...(doc.entities ?? []), ...resolvedEntities])] });
  }

  // 4) claims
  const claims: RichClaim[] = branchEvents
    .filter((e) => e.op.type !== "evidence.attach")
    .map((e) => ({
      eventId: e.id,
      claim: e.evidence?.[0]?.claim ?? e.reason ?? describeOp(e.op),
      reason: e.reason,
      op: e.op,
      entity: opEntities(e.op)[0] ? resolve(mainState, opEntities(e.op)[0]) : undefined,
    }));

  // 5) judge each candidate
  const contradictions: StalenessReport["contradictions"] = [];
  if (claims.length) {
    for (const doc of candidates) {
      const verdict = await judge({ prTitle: pr.title, claims, newDoc: doc });
      if (verdict.contradicts) {
        contradictions.push({ docId: doc.id, title: doc.title, explanation: verdict.explanation, affectsEvents: verdict.affectsEvents });
      }
    }
  }

  const status = contradictions.length ? "stale" : changedReads.length ? "version-conflict" : "fresh";
  const checkedAt = mainEvents.reduce((m, e) => Math.max(m, e.ts), 0);
  return { status, checkedAt, changedReads, contradictions };
}

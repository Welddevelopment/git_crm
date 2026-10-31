/**
 * Deterministic email parsers for the inbox agent (no LLM needed).
 * Every hit carries [start, end) offsets into doc.body so evidence quotes are cut verbatim.
 * Phrase conventions come from STORY.md.
 */
import type { FieldValue } from "../../core/types";

export type DealStage = "discovery" | "demo" | "proposal" | "negotiation" | "closed_won" | "closed_lost";
export const STAGES: DealStage[] = ["discovery", "demo", "proposal", "negotiation", "closed_won", "closed_lost"];
export const STAGE_RANK: Record<string, number> = {
  discovery: 1, demo: 2, proposal: 3, negotiation: 4, closed_won: 5, closed_lost: 6,
};
export const STAGE_LABEL: Record<string, string> = {
  discovery: "Discovery", demo: "Demo", proposal: "Proposal", negotiation: "Negotiation",
  closed_won: "Closed won", closed_lost: "Closed lost",
};

export interface Hit {
  value: FieldValue;
  start: number;
  end: number;
  /** short phrase describing what the sender did, used to build claims ("asked for the MSA") */
  what: string;
}

// ---------- body helpers ----------

/** End offset of the sender's own text: cuts quoted replies ("On … wrote:", "> …", "-----Original Message"). */
export function ownTextEnd(body: string): number {
  const re = /^(?:On .{4,200}wrote:\s*$|>|-{2,}\s*(?:Original|Forwarded) Message|From: .+@)/im;
  const m = re.exec(body);
  return m ? m.index : body.length;
}

/** Sentence bounds (within one line) around [start, end). A period only ends a sentence when followed by space/EOL. */
export function sentenceBounds(body: string, start: number, end: number): [number, number] {
  const isEnd = (i: number) => body[i] === "\n" || (/[.!?]/.test(body[i]) && (i + 1 >= body.length || /\s/.test(body[i + 1])));
  let s = start;
  while (s > 0 && !isEnd(s - 1)) s--;
  let e = end;
  while (e < body.length && !isEnd(e)) e++;
  if (e < body.length && body[e] !== "\n") e++;
  return [s, e];
}

/** Verbatim excerpt (≤ maxWords words) of the sentence containing [start, end). Always a substring of body. */
export function cutQuote(body: string, start: number, end: number, maxWords = 24): string {
  let [s, e] = sentenceBounds(body, start, end);
  while (s < e && /\s/.test(body[s])) s++;
  while (e > s && /\s/.test(body[e - 1])) e--;
  const toks: [number, number][] = [];
  const re = /\S+/g;
  const seg = body.slice(s, e);
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg))) toks.push([s + m.index, s + m.index + m[0].length]);
  if (toks.length <= maxWords) return body.slice(s, e);
  let idx = toks.findIndex(([, te]) => te > start);
  if (idx < 0) idx = 0;
  const ws = Math.max(0, Math.min(idx - 6, toks.length - maxWords));
  return body.slice(toks[ws][0], toks[ws + maxWords - 1][1]);
}

function all(re: RegExp, text: string): RegExpExecArray[] {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    out.push(m);
    if (m[0].length === 0) g.lastIndex++;
  }
  return out;
}

const num = (s: string) => Number(s.replace(/,/g, ""));

// ---------- stage ----------

const STAGE_CUES: { stage: DealStage; re: RegExp; what: string }[] = [
  { stage: "negotiation", re: /\bsend (?:over |us )?the MSA\b/i, what: "asked for the MSA" },
  { stage: "negotiation", re: /\bready to sign\b/i, what: "said they're ready to sign" },
  { stage: "negotiation", re: /\bredlines?\b/i, what: "sent redlines" },
  { stage: "demo", re: /\bbook a demo\b/i, what: "asked to book a demo" },
  { stage: "proposal", re: /\bsend (?:over |us )?a proposal\b/i, what: "asked for a proposal" },
  { stage: "closed_won", re: /\bsigned\b(?!\s+off)/i, what: "confirmed the contract is signed" },
  { stage: "closed_lost", re: /\bgoing with another vendor\b/i, what: "said they're going with another vendor" },
];
/** "once it's signed", "when the MSA is signed", "if we get it signed" are future tense: not closed_won. */
const SIGNED_FUTURE = /\b(?:once|when|after|until|before|if|get|getting|to be|will be|can be|needs? to be)\b[^.!?\n]*$/i;

export function findStage(body: string, end = ownTextEnd(body)): Hit | null {
  const text = body.slice(0, end);
  let best: Hit | null = null;
  for (const cue of STAGE_CUES) {
    for (const m of all(cue.re, text)) {
      if (cue.stage === "closed_won") {
        const [s] = sentenceBounds(body, m.index, m.index + m[0].length);
        if (SIGNED_FUTURE.test(body.slice(s, m.index))) continue;
      }
      const hit: Hit = { value: cue.stage, start: m.index, end: m.index + m[0].length, what: cue.what };
      if (!best || STAGE_RANK[cue.stage] > STAGE_RANK[best.value as string]) best = hit;
    }
  }
  return best;
}

// ---------- money ----------

const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(k|K|m|M|mm|MM|million|thousand)?(?![\w])/g;
const PER_UNIT = /^\s*(?:\/|per|each|a|an)\s*(?:seat|user|licen[cs]e|month|mo\b|head)/i;

export function parseMoney(raw: string, unit?: string): number {
  let n = num(raw);
  const u = (unit ?? "").toLowerCase();
  if (u === "k" || u === "thousand") n *= 1_000;
  else if (u === "m" || u === "mm" || u === "million") n *= 1_000_000;
  return Math.round(n);
}

/** Deal amount. Prefers an explicit "total"; ignores per-seat/per-month prices. Seats alone never set an amount. */
export function findAmount(body: string, end = ownTextEnd(body)): Hit | null {
  const text = body.slice(0, end);
  const hits: (Hit & { total: boolean })[] = [];
  for (const m of all(MONEY, text)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 16);
    if (PER_UNIT.test(after)) continue;
    const value = parseMoney(m[1], m[2]);
    if (!value) continue;
    const before = text.slice(Math.max(0, m.index - 28), m.index);
    const total = /\btotal(?:ing|s)?\b[^$\n]{0,14}$/i.test(before);
    hits.push({ value, start: m.index, end: m.index + m[0].length, what: total ? "confirmed a total of" : "mentioned", total });
  }
  if (!hits.length) return null;
  const t = hits.find((h) => h.total);
  const h = t ?? hits[0];
  return { value: h.value, start: h.start, end: h.end, what: h.what };
}

export function findSeats(body: string, end = ownTextEnd(body)): number | null {
  const m = /\b(\d[\d,]*)\s+seats\b/i.exec(body.slice(0, end));
  return m ? num(m[1]) : null;
}

// ---------- close date ----------

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const DATE_KEYWORD = /\b(?:close|closing|closed|sign|signing|signature|target(?:ing)?|go[- ]live|launch|deadline|decision|wrap(?: up)?|finali[sz]e)\b[^.!?\n]{0,24}$/i;
const pad = (n: number) => String(n).padStart(2, "0");

export function findCloseDate(body: string, end = ownTextEnd(body), defaultYear = 2026): Hit | null {
  const text = body.slice(0, end);
  const cands: Hit[] = [];
  for (const m of all(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi"), text)) {
    const mi = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)));
    const day = Number(m[2]);
    if (mi < 0 || day < 1 || day > 31) continue;
    const year = m[3] ? Number(m[3]) : defaultYear;
    cands.push({ value: `${year}-${pad(mi + 1)}-${pad(day)}`, start: m.index, end: m.index + m[0].length, what: "target close" });
  }
  for (const m of all(/\b(20\d{2})-(\d{2})-(\d{2})\b/g, text)) {
    cands.push({ value: m[0], start: m.index, end: m.index + m[0].length, what: "target close" });
  }
  cands.sort((a, b) => a.start - b.start);
  for (const c of cands) {
    const [s] = sentenceBounds(body, c.start, c.end);
    if (DATE_KEYWORD.test(body.slice(s, c.start))) return c;
  }
  return null;
}

// ---------- headcount ----------

export function findEmployees(body: string, end = ownTextEnd(body)): Hit | null {
  const text = body.slice(0, end);
  const res = [
    /\b(?:we(?:'|’)re now|we are now|we're at|now at|grown to|grew to|up to)\s+(?:about |around |over |roughly )?(\d[\d,]*)\s+(?:people|employees|staff|FTEs?)\b/i,
    /\b(\d[\d,]*)\s+employees\b/i,
  ];
  for (const re of res) {
    const m = re.exec(text);
    if (m) {
      const value = num(m[1]);
      if (value > 0) return { value, start: m.index, end: m.index + m[0].length, what: "headcount" };
    }
  }
  return null;
}

// ---------- next step ----------

export function findNextStep(body: string, end = ownTextEnd(body)): Hit | null {
  const m = /^[ \t]*next steps?[ \t]*[:—–-][ \t]*(.+?)[ \t]*$/im.exec(body.slice(0, end));
  if (!m) return null;
  let value = m[1].replace(/[.;\s]+$/, "").trim();
  if (!value) return null;
  if (value.length > 140) value = value.slice(0, 137).trimEnd() + "…";
  const valStart = m.index + m[0].indexOf(m[1]);
  return { value, start: valStart, end: valStart + m[1].length, what: "next step" };
}

// ---------- signature ----------

const SIG_LINE = /^[ \t]*([A-Z][\w'’.-]*(?:[ \t]+[A-Z][\w'’.-]*){1,3})[ \t]+[—–-][ \t]+([^\n]{2,60}?)[ \t]*$/;

export interface Signature { name: string; title: string; start: number; end: number }

/** "<Name> — <Title>" in the last few non-empty lines of the sender's own text. */
export function findSignature(body: string, end = ownTextEnd(body)): Signature | null {
  const lines: { text: string; start: number }[] = [];
  let pos = 0;
  for (const line of body.slice(0, end).split("\n")) {
    if (line.trim()) lines.push({ text: line, start: pos });
    pos += line.length + 1;
  }
  for (const l of lines.slice(-4).reverse()) {
    const m = SIG_LINE.exec(l.text);
    if (!m) continue;
    const title = m[2].trim();
    if (/[.!?]$/.test(title) || /@|https?:/.test(title)) continue;
    const lead = l.text.length - l.text.trimStart().length;
    const trimmed = l.text.trim();
    return { name: m[1].trim(), title, start: l.start + lead, end: l.start + lead + trimmed.length };
  }
  return null;
}

// ---------- sender ----------

export function parseFrom(from: string | undefined): { email: string; name?: string } | null {
  if (!from) return null;
  const angle = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (angle) return { email: angle[2].trim().toLowerCase(), name: angle[1].trim() || undefined };
  const bare = /([^\s<>@,;]+@[^\s<>@,;]+\.[A-Za-z]{2,})/.exec(from);
  return bare ? { email: bare[1].toLowerCase() } : null;
}

export const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

// ---------- formatting ----------

export function fmtMoney(n: FieldValue | undefined): string {
  if (typeof n !== "number") return n == null || n === "" ? "—" : String(n);
  if (n >= 1_000_000) return `$${+(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${+(n / 1_000).toFixed(1)}k`;
  return `$${n}`;
}
export const fmtStage = (s: FieldValue | undefined) => (typeof s === "string" ? STAGE_LABEL[s] ?? s : "—");
export function fmtDay(ts: number): string {
  const d = new Date(ts);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCDate()}`;
}
export const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-");

/** Deterministic web-page detectors for the webwatch agent. Pure: text in, findings out. */
import type { EvidenceDoc } from "../../core/types";

export type PageKind = "careers" | "pricing" | "about" | "homepage" | "other";

export interface SignalFinding {
  kind: "signal";
  signal: string; // e.g. "hiring:data-engineering"
  quote: string; // verbatim substring of doc.body, < 25 words
  claim: string; // "Careers page lists 3 Data Engineer roles"
}
export interface EmployeesFinding {
  kind: "employees";
  value: number;
  quote: string;
  claim: string;
}
export type Finding = SignalFinding | EmployeesFinding;

// ---------- helpers ----------

const PAGE_LABEL: Record<PageKind, string> = {
  careers: "Careers page",
  pricing: "Pricing page",
  about: "About page",
  homepage: "Homepage",
  other: "Website",
};
export const pageLabel = (k: PageKind) => PAGE_LABEL[k];

export function pageKind(doc: Pick<EvidenceDoc, "id" | "title" | "url">): PageKind {
  const hay = `${doc.url ?? ""} ${doc.id} ${doc.title}`.toLowerCase();
  if (/career|jobs?\b|hiring|join[-_ ]?us|open[-_ ]?roles/.test(hay)) return "careers";
  if (/pricing|plans?\b/.test(hay)) return "pricing";
  if (/about|company|team\b/.test(hay)) return "about";
  if (/home|landing/.test(hay)) return "homepage";
  if (doc.url) {
    try {
      const p = new URL(doc.url).pathname;
      if (p === "/" || p === "") return "homepage";
    } catch {
      /* ignore */
    }
  }
  return "other";
}

/** Strip markdown list/heading/table decoration; result is still a verbatim substring of the line. */
function cleanLine(line: string): string {
  return line.replace(/^[\s>*#|+-]+/, "").replace(/[\s|*]+$/, "").trim();
}

/** Verbatim excerpt of at most 24 words. */
export function shortQuote(text: string): string {
  const t = text.trim();
  const words = t.split(/\s+/);
  if (words.length <= 24) return t;
  // keep a verbatim prefix: cut at the 24th word boundary in the original string
  let count = 0;
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  let end = t.length;
  while ((m = re.exec(t))) {
    count++;
    if (count === 24) {
      end = m.index + m[0].length;
      break;
    }
  }
  return t.slice(0, end);
}

/** Sentence (or line) of `body` containing [start, end). */
function sentenceAround(body: string, start: number, end: number): string {
  let s = start;
  while (s > 0 && !/[\n.!?]/.test(body[s - 1]!)) s--;
  let e = end;
  while (e < body.length && !/[\n.!?]/.test(body[e]!)) e++;
  if (e < body.length && /[.!?]/.test(body[e]!)) e++;
  return cleanLine(body.slice(s, e));
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------- hiring ----------

interface RoleFamily {
  signal: string;
  label: string; // used in claims, e.g. "Data Engineer"
  re: RegExp;
  min: number;
}

/** Order matters: first matching family wins for a given line. */
const ROLE_FAMILIES: RoleFamily[] = [
  { signal: "hiring:data-engineering", label: "Data Engineer", re: /\b(data engineer|analytics engineer|data platform engineer|etl engineer)s?\b/i, min: 2 },
  { signal: "hiring:ml", label: "ML Engineer", re: /\b(machine learning|ml|ai) (engineer|scientist|researcher)s?\b/i, min: 2 },
  { signal: "hiring:sales", label: "sales", re: /\b(account executive|sales development|sales representative|sales manager|sales engineer|sdr|bdr|account manager|head of sales|vp,? sales|sales director|sales lead)s?\b/i, min: 2 },
  { signal: "hiring:security", label: "security", re: /\b(security engineer|security analyst|ciso|appsec engineer)s?\b/i, min: 2 },
  { signal: "hiring:marketing", label: "marketing", re: /\b(marketing manager|product marketing|growth marketer|demand gen\w*|content marketer)s?\b/i, min: 2 },
  { signal: "hiring:engineering", label: "engineering", re: /\b(software engineer|backend engineer|frontend engineer|full[- ]?stack engineer|platform engineer|site reliability engineer|sre)s?\b/i, min: 3 },
];

const COUNT_PHRASE = /\b(\d{1,3})\s+(?:open\s+)?(?:[A-Za-z,]+\s+){0,3}?(roles?|positions?|openings?|jobs?)\b/i;
const PAREN_COUNT = /\((\d{1,3})(?:\s+(?:open\s+)?(?:roles?|positions?|openings?|jobs?))?\)|[×x]\s?(\d{1,2})\b|\b(\d{1,2})\s?[×x]\s/i;

function detectHiring(doc: EvidenceDoc, kind: PageKind): SignalFinding[] {
  const tally = new Map<RoleFamily, { n: number; quote: string }>();
  for (const raw of doc.body.split(/\r?\n/)) {
    const original = cleanLine(raw);
    let line = original;
    if (!line) continue;
    for (const fam of ROLE_FAMILIES) {
      const hits = line.match(new RegExp(fam.re.source, "gi"))?.length ?? 0;
      if (!hits) continue;
      // "3 open Data Engineer roles" / "Data Engineer (3)" / "3x Data Engineer" count as 3;
      // otherwise each title mention on the line counts as one listing.
      const m = line.match(COUNT_PHRASE) ?? line.match(PAREN_COUNT);
      const explicit = m ? Number(m[1] ?? m[2] ?? m[3]) : 0;
      const n = Math.max(hits, explicit);
      const cur = tally.get(fam) ?? { n: 0, quote: shortQuote(original) };
      cur.n += n;
      tally.set(fam, cur);
      // don't let "Data Platform Engineer" also count as a generic "Platform Engineer"
      line = line.replace(new RegExp(fam.re.source, "gi"), " ");
    }
  }
  const out: SignalFinding[] = [];
  for (const [fam, { n, quote }] of tally) {
    if (n < fam.min) continue;
    out.push({ kind: "signal", signal: fam.signal, quote, claim: `${pageLabel(kind)} lists ${n} ${fam.label} roles` });
  }
  return out;
}

// ---------- pricing ----------

function detectEnterpriseTier(doc: EvidenceDoc, kind: PageKind): SignalFinding[] {
  const lines = doc.body.split(/\r?\n/);
  for (const raw of lines) {
    const line = cleanLine(raw);
    if (!line) continue;
    const explicit = /\benterprise\s+(tier|plan|edition|pricing)\b/i.test(line);
    const heading = kind === "pricing" && /^enterprise\b/i.test(line);
    if (explicit || heading) {
      return [{ kind: "signal", signal: "pricing:enterprise-tier", quote: shortQuote(line), claim: `${pageLabel(kind)} offers an Enterprise tier` }];
    }
  }
  return [];
}

// ---------- headcount ----------

const EMPLOYEES_RE = /\b(\d{1,3}(?:,\d{3})*|\d+)\+?\s+(employees|team members|staff|people)\b/gi;

function detectEmployees(doc: EvidenceDoc, kind: PageKind): EmployeesFinding[] {
  if (kind === "pricing") return []; // plan limits, not headcount
  EMPLOYEES_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMPLOYEES_RE.exec(doc.body))) {
    // skip ranges like "50-200 employees" (company-size buckets, not a headcount)
    const before = doc.body.slice(Math.max(0, m.index - 12), m.index);
    if (/[-–]\s?$/.test(before)) continue;
    // qualifiers ("up to 500 employees", "over 50 employees") describe customers or buckets, not this company
    if (/\b(up to|under|over|than|from|for)\s+$/i.test(before)) continue;
    // "people" is noisy on web pages ("1,000 people trust us"); only take it on about pages
    if (m[2]!.toLowerCase() === "people" && kind !== "about") continue;
    const n = Number(m[1]!.replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) continue;
    const quote = shortQuote(sentenceAround(doc.body, m.index, m.index + m[0].length));
    return [{ kind: "employees", value: n, quote, claim: `${pageLabel(kind)} says ${n} employees` }];
  }
  return [];
}

// ---------- security / compliance ----------

function detectCompliance(doc: EvidenceDoc, kind: PageKind): SignalFinding[] {
  const out: SignalFinding[] = [];
  const checks: { signal: string; re: RegExp; label: string }[] = [
    { signal: "security:soc2", re: /\bSOC\s?-?2\b/i, label: "SOC 2" },
    { signal: "security:iso27001", re: /\bISO\s?\/?(?:IEC\s)?27001\b/i, label: "ISO 27001" },
  ];
  for (const c of checks) {
    const m = c.re.exec(doc.body);
    if (!m) continue;
    const quote = shortQuote(sentenceAround(doc.body, m.index, m.index + m[0].length));
    out.push({ kind: "signal", signal: c.signal, quote, claim: `${pageLabel(kind)} shows a ${c.label} badge` });
  }
  return out;
}

// ---------- expansion ----------

const REGION = String.raw`(?:the\s+)?((?:[A-Z][\w&-]*|of)(?:\s+(?:[A-Z][\w&-]*|of)){0,2})`;
const EXPANSION_RES = [new RegExp(String.raw`\bnow serving\s+(?:customers\s+in\s+)?${REGION}`, "g"), new RegExp(String.raw`\b[Ll]aunched in\s+${REGION}`, "g")];

function detectExpansion(doc: EvidenceDoc, kind: PageKind): SignalFinding[] {
  const out: SignalFinding[] = [];
  const seen = new Set<string>();
  for (const re of EXPANSION_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    // normalise sentence-initial casing; same length, so indices still line up with doc.body
    const body = doc.body.replace(/\bNow serving\b/g, "now serving");
    while ((m = re.exec(body))) {
      const region = m[1]!.replace(/\s+of$/, "").trim();
      const s = slug(region);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      const quote = shortQuote(sentenceAround(doc.body, m.index, m.index + m[0].length));
      out.push({ kind: "signal", signal: `expansion:${s}`, quote, claim: `${pageLabel(kind)} announces expansion into ${region}` });
    }
  }
  return out;
}

/** Run every detector on one page snapshot. */
export function detect(doc: EvidenceDoc): Finding[] {
  const kind = pageKind(doc);
  return [
    ...detectHiring(doc, kind),
    ...detectEnterpriseTier(doc, kind),
    ...detectEmployees(doc, kind),
    ...detectCompliance(doc, kind),
    ...detectExpansion(doc, kind),
  ];
}

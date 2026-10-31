/**
 * Deterministic detectors for recurring structured facts that the CRM has no field for.
 * Registry pattern: add a Detector to DETECTORS and the schema agent picks it up.
 */
import type { EntityType, EvidenceDoc, FieldType, FieldValue } from "../../core/types";

export interface DetectorHit {
  value: FieldValue;
  /** [start, end) offsets of the match in doc.body; the quote is cut around it (verbatim). */
  start: number;
  end: number;
  claim: string;
}

export interface Detector {
  id: string;
  entityType: EntityType;
  field: string;
  fieldType: FieldType;
  description: string;
  detect(doc: EvidenceDoc): DetectorHit[];
  /** How to fold values when one entity is mentioned in several docs. Default: latest doc wins. */
  combine?: (prev: FieldValue, next: FieldValue) => FieldValue;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_RE = `(${MONTHS.join("|")}|${MONTHS.map((m) => m.slice(0, 3)).join("|")})`;
const normMonth = (m: string) => MONTHS.find((x) => x.toLowerCase().startsWith(m.toLowerCase().slice(0, 3))) ?? m;

/** Proper-noun-ish name: 1–4 capitalised words ("Sam Lee", "O'Neil", "Mary-Jo Park"). */
const NAME = `[A-Z][\\w'’.-]*(?:\\s+[A-Z][\\w'’.-]*){0,3}`;
const EMAIL = `[^\\s()<>@,;]+@[^\\s()<>@,;]+\\.[A-Za-z]{2,}`;

function allMatches(re: RegExp, body: string): RegExpExecArray[] {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const g = new RegExp(re.source, flags);
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = g.exec(body))) {
    out.push(m);
    if (m[0].length === 0) g.lastIndex++;
  }
  return out;
}

/** Bounds of the sentence (within one line) containing [start, end). */
export function sentenceBounds(body: string, start: number, end: number): [number, number] {
  let s = start;
  while (s > 0 && !/[.!?\n]/.test(body[s - 1])) s--;
  let e = end;
  while (e < body.length && !/[.!?\n]/.test(body[e])) e++;
  if (e < body.length && /[.!?]/.test(body[e])) e++;
  return [s, e];
}

// ---------- procurement contact ----------
const procurement: Detector = {
  id: "procurement-contact",
  entityType: "deal",
  field: "procurementContact",
  fieldType: "string",
  description: "Who runs procurement / purchasing on the buyer side (\"Name <email>\").",
  detect(doc) {
    const re = new RegExp(
      `[Pp]rocurement (?:contact|lead|person)(?:,|:|\\s+is)?\\s+(${NAME})\\s*[(<]\\s*(${EMAIL})\\s*[)>]`,
      "g",
    );
    return allMatches(re, doc.body).map((m) => {
      const name = m[1].trim();
      const email = m[2].trim();
      return {
        value: `${name} <${email}>`,
        start: m.index,
        end: m.index + m[0].length,
        claim: `Procurement contact is ${name} (${email})`,
      };
    });
  },
};

// ---------- security review ----------
const SECURITY_STATUS: { status: string; re: RegExp }[] = [
  { status: "failed", re: /\b(failed|did not pass|didn't pass)\b/i },
  { status: "passed", re: /\b(passed|completed|complete|approved|cleared|signed off)\b/i },
  { status: "in_progress", re: /\b(started|starting|kicked off|underway|in progress|ongoing|reviewing)\b/i },
  { status: "required", re: /\b(required|requires|require|need|needs|needed|mandatory|will have to)\b/i },
];
const securityReview: Detector = {
  id: "security-review",
  entityType: "deal",
  field: "securityReview",
  fieldType: "string",
  description: "Buyer security review status: required | in_progress | passed | failed.",
  detect(doc) {
    const hits: DetectorHit[] = [];
    for (const m of allMatches(/security (?:review|questionnaire|assessment)/gi, doc.body)) {
      const [s, e] = sentenceBounds(doc.body, m.index, m.index + m[0].length);
      const sentence = doc.body.slice(s, e);
      const found = SECURITY_STATUS.find((x) => x.re.test(sentence));
      if (!found) continue;
      hits.push({ value: found.status, start: m.index, end: m.index + m[0].length, claim: `Security review: ${found.status}` });
    }
    return hits;
  },
};

// ---------- fiscal year start ----------
const fiscalYear: Detector = {
  id: "fiscal-year-start",
  entityType: "company",
  field: "fiscalYearStart",
  fieldType: "string",
  description: "Month the company's fiscal year / budget cycle starts (drives renewal & budget timing).",
  detect(doc) {
    const re = new RegExp(
      `(?:fiscal year|budget cycle|FY)\\s+(?:starts|begins|resets|kicks off|runs from)(?:\\s+(?:in|on))?\\s+${MONTH_RE}\\b`,
      "gi",
    );
    return allMatches(re, doc.body).map((m) => {
      const month = normMonth(m[1]);
      return { value: month, start: m.index, end: m.index + m[0].length, claim: `Fiscal year starts in ${month}` };
    });
  },
};

// ---------- competitors ----------
/** Vendor name: capitalised word(s); dots only inside a word ("Monday.com"), never trailing. */
const VENDOR = `[A-Z][\\w&-]*(?:\\.[\\w&-]+)*(?:[ \\t][A-Z][\\w&-]*(?:\\.[\\w&-]+)*)?`;
const COMPETITOR_LIST = `(${VENDOR}(?:(?:,[ \\t]*|,?[ \\t]+and[ \\t]+|[ \\t]+or[ \\t]+)${VENDOR})*)`;
function splitNames(list: string): string[] {
  return list
    .split(/,\s*|\s+and\s+|\s+or\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 1);
}
const competitors: Detector = {
  id: "competitors",
  entityType: "deal",
  field: "competitors",
  fieldType: "string[]",
  description: "Other vendors the buyer is evaluating against us.",
  combine(prev, next) {
    const a = Array.isArray(prev) ? prev : [];
    const b = Array.isArray(next) ? next : [];
    return [...new Set([...a, ...b])];
  },
  detect(doc) {
    const res = [
      new RegExp(`[Aa]lso (?:evaluating|looking at|considering|talking to|comparing)\\s+${COMPETITOR_LIST}`, "g"),
      new RegExp(`[Cc]ompetitors?(?:\\s+(?:is|are|like|include|includes))?[:,]?\\s+${COMPETITOR_LIST}`, "g"),
    ];
    const hits: DetectorHit[] = [];
    for (const re of res) {
      for (const m of allMatches(re, doc.body)) {
        const names = splitNames(m[1]).filter((n) => !/^(We|I|Our|The|They)$/.test(n));
        if (!names.length) continue;
        hits.push({ value: names, start: m.index, end: m.index + m[0].length, claim: `Also evaluating ${names.join(", ")}` });
      }
    }
    return hits;
  },
};

export const DETECTORS: Detector[] = [procurement, securityReview, fiscalYear, competitors];
export const MONTH_NAMES = MONTHS;

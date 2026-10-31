/**
 * OWNER: A4 webwatch. "Watch an account by URL": turn freshly scraped pages (Firecrawl) into ONE proposal —
 * a new company (entity.create) or, if the domain is already in the CRM, field.set for what's new.
 * Pure apart from the optional LLM call; deterministic without one.
 */
import type { AgentContext, AgentProposal, CRMState, EntityId, EntityRecord, EvidenceDoc, EvidenceRef, FieldValue, NewEvent } from "../../core/types";
import { extractJSON } from "../llm";
import { detect, pageKind, pageLabel, shortQuote, type EmployeesFinding, type SignalFinding } from "./detectors";
import { hostOf, toEvidenceDoc, type ScrapedPage } from "./firecrawl";

const ACTOR = { kind: "agent", id: "webwatch", name: "Web watcher" } as const;
const MAX_LLM_SIGNALS = 3;
const LLM_DOC_CHARS = 6_000;
const SIGNAL_RE = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;

// ---------- naming ----------

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ltd", "plc"]);

/** "www.acmerobotics.com" → "acmerobotics", "foo.co.uk" → "foo", "app.linear.app" → "linear". */
export function slugFromHost(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length > 1) labels.pop(); // TLD
  if (labels.length > 1 && SECOND_LEVEL.has(labels[labels.length - 1]!)) labels.pop(); // co.uk, com.au
  const core = labels[labels.length - 1] ?? host;
  return core.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "company";
}

const GENERIC = /^(home|homepage|welcome|official site|official website|index|landing)$/i;
const SEPARATORS = /\s+[|\-–—·:•»]\s+|\s*[|·•»]\s*/;
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function titleCase(slug: string): string {
  return slug.split("-").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

/** Company name from og:site_name, else the title segment that looks like the brand, else the host slug. */
export function cleanCompanyName(opts: { siteName?: string; title?: string; host: string }): string {
  const slug = slugFromHost(opts.host);
  const ok = (s: string | undefined) => !!s && s.length <= 60 && !GENERIC.test(s) && compact(s) !== "";
  const site = opts.siteName?.trim();
  if (ok(site) && compact(site!) !== compact(opts.host)) return site!;
  const title = opts.title?.trim();
  if (title && compact(title) !== compact(opts.host)) {
    const segs = title.split(SEPARATORS).map((s) => s.trim()).filter((s) => ok(s));
    const brand = segs.find((s) => compact(s).includes(slug) || slug.includes(compact(s)));
    if (brand) return brand;
    if (segs.length === 1 && segs[0]!.split(/\s+/).length <= 4) return segs[0]!;
    // "Plan and build products – Linear": the short segment is usually the brand
    const short = segs.filter((s) => s.split(/\s+/).length <= 3);
    if (short.length) return short[0]!;
  }
  return titleCase(slug);
}

// ---------- industry (deterministic, best effort) ----------

const INDUSTRIES: { label: string; re: RegExp }[] = [
  { label: "Fintech", re: /\b(payments?|fintech|banking|lending|invoic\w*|card issuing|treasury)\b/gi },
  { label: "Healthcare", re: /\b(health\w*|clinic\w*|patients?|medical|hospital\w*|care teams?)\b/gi },
  { label: "Logistics", re: /\b(logistics|freight|shipping|supply chain|warehous\w*|fleet)\b/gi },
  { label: "Robotics", re: /\b(robot\w*|automation hardware|autonomous)\b/gi },
  { label: "Security", re: /\b(cyber\s?security|threat detection|zero[- ]trust|endpoint security|siem)\b/gi },
  { label: "Legal", re: /\b(legal|law firms?|lawyers?|contracts? management)\b/gi },
  { label: "Retail", re: /\b(retail\w*|e-?commerce|shoppers?|storefronts?)\b/gi },
  { label: "Food & Beverage", re: /\b(food|restaurants?|beverages?|grocer\w*)\b/gi },
  { label: "Energy", re: /\b(energy|solar|grid|utilities|batter(y|ies))\b/gi },
  { label: "AI / ML", re: /\b(machine learning|LLMs?|AI models?|generative AI|foundation models?)\b/gi },
  { label: "Developer tools", re: /\b(developers?|APIs?|SDKs?|open[- ]source|devops)\b/gi },
  { label: "Software", re: /\b(SaaS|software|platform|workflow\w*)\b/gi },
];

export function guessIndustry(text: string): string | undefined {
  let best: { label: string; n: number } | undefined;
  for (const ind of INDUSTRIES) {
    const n = text.match(ind.re)?.length ?? 0;
    if (n >= 2 && (!best || n > best.n)) best = { label: ind.label, n };
  }
  return best?.label;
}

// ---------- helpers ----------

function asSignals(v: FieldValue | undefined): string[] {
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === "string");
  if (typeof v === "string" && v.trim()) return v.split(/[,;]\s*/).filter(Boolean);
  return [];
}

function findCompanyByHost(state: CRMState, host: string): EntityRecord | undefined {
  for (const rec of Object.values(state.entities)) {
    if (rec.type !== "company" || rec.deleted || rec.mergedInto) continue;
    const d = hostOf(typeof rec.attrs.domain === "string" ? rec.attrs.domain : undefined);
    if (d && (d === host || host.endsWith(`.${d}`) || d.endsWith(`.${host}`))) return rec;
  }
  return undefined;
}

function freeCompanyId(state: CRMState, host: string): EntityId {
  const base = `company:${slugFromHost(host)}`;
  if (!state.entities[base] && !state.aliases?.[base]) return base;
  const full = `company:${host.replace(/[^a-z0-9]+/g, "-")}`;
  if (!state.entities[full] && !state.aliases?.[full]) return full;
  for (let i = 2; ; i++) if (!state.entities[`${base}-${i}`] && !state.aliases?.[`${base}-${i}`]) return `${base}-${i}`;
}

const ref = (doc: EvidenceDoc, f: { quote?: string; claim: string }): EvidenceRef => ({ docId: doc.id, ...(f.quote ? { quote: f.quote } : {}), claim: f.claim });

interface Sig {
  signal: string;
  quote: string;
  claim: string;
  doc: EvidenceDoc;
  source: "detector" | "llm";
}

/** Run the deterministic detectors over all pages; first finding per signal wins, about page preferred for headcount. */
function detectAll(docs: EvidenceDoc[]): { signals: Sig[]; employees?: { f: EmployeesFinding; doc: EvidenceDoc } } {
  const signals: Sig[] = [];
  const seen = new Set<string>();
  let employees: { f: EmployeesFinding; doc: EvidenceDoc } | undefined;
  for (const doc of docs) {
    for (const f of detect(doc)) {
      if (f.kind === "signal") {
        const s = f as SignalFinding;
        if (seen.has(s.signal)) continue;
        seen.add(s.signal);
        signals.push({ signal: s.signal, quote: s.quote, claim: s.claim, doc, source: "detector" });
      } else if (!employees || (pageKind(doc) === "about" && pageKind(employees.doc) !== "about")) {
        employees = { f, doc };
      }
    }
  }
  return { signals, employees };
}

// ---------- LLM enrichment ----------

interface LlmEnrichment {
  description?: string;
  industry?: string;
  signals: Sig[];
}

interface LlmReply {
  description?: unknown;
  industry?: unknown;
  signals?: { signal?: unknown; quote?: unknown; claim?: unknown; docId?: unknown }[];
}

const oneLine = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

async function enrich(llm: AgentContext["llm"], name: string, url: string, docs: EvidenceDoc[], have: Set<string>): Promise<LlmEnrichment | null> {
  let raw: string | null;
  try {
    const pages = docs.map((d) => `### docId: ${d.id}\nURL: ${d.url ?? ""}\nTitle: ${d.title}\n\n${d.body.slice(0, LLM_DOC_CHARS)}`).join("\n\n---\n\n");
    raw = await llm({
      system:
        "You are a B2B sales-intelligence analyst. You read scraped website pages and return ONLY a JSON object, no prose. " +
        "Every quote MUST be copied verbatim (exact characters) from the page text and be under 20 words.",
      prompt:
        `Account: ${name} (${url})\nAlready-detected signals: ${[...have].join(", ") || "none"}\n\n` +
        `Return JSON: {"description": "<one line, max 25 words, what the company does>", "industry": "<1-3 words>", ` +
        `"signals": [{"signal": "<category:kebab-slug, e.g. hiring:sales, funding:series-b, launch:new-product, expansion:emea>", ` +
        `"quote": "<verbatim excerpt>", "docId": "<docId it came from>", "claim": "<short conclusion>"}]}\n` +
        `Give at most ${MAX_LLM_SIGNALS} NEW buying signals not already listed; [] if none.\n\nPages:\n\n${pages}`,
      maxTokens: 700,
    });
  } catch {
    return null;
  }
  const j = extractJSON<LlmReply>(raw);
  if (!j || typeof j !== "object") return null;
  const out: LlmEnrichment = { signals: [] };
  const description = oneLine(j.description, 220);
  const industry = oneLine(j.industry, 40);
  if (description) out.description = description;
  if (industry) out.industry = industry;
  const taken = new Set(have);
  for (const s of Array.isArray(j.signals) ? j.signals : []) {
    if (out.signals.length >= MAX_LLM_SIGNALS) break;
    const signal = typeof s?.signal === "string" ? s.signal.trim().toLowerCase() : "";
    const quoteRaw = typeof s?.quote === "string" ? s.quote.trim() : "";
    if (!SIGNAL_RE.test(signal) || taken.has(signal) || quoteRaw.length < 4) continue;
    // validate: the quote must be a verbatim substring of a scraped page (the named one first)
    const named = docs.find((d) => d.id === s.docId);
    const doc = named && named.body.includes(quoteRaw) ? named : docs.find((d) => d.body.includes(quoteRaw));
    if (!doc) continue;
    const quote = shortQuote(quoteRaw); // verbatim prefix, < 25 words
    const claim = oneLine(s.claim, 140) ?? `${pageLabel(pageKind(doc))} suggests ${signal}`;
    taken.add(signal);
    out.signals.push({ signal, quote, claim, doc, source: "llm" });
  }
  return out;
}

// ---------- proposal ----------

/**
 * Build ONE proposal from pages scraped for `url`.
 *  - domain not in CRM → evidence.attach per page + entity.create company:<slug> (stage "lead", watchUrl, signals, employees?)
 *  - domain already in CRM → evidence.attach per page + field.set for new signals / changed employees / missing watchUrl
 * `llm` returning null (no key) → deterministic detectors only.
 */
export async function proposeFromUrl(
  state: CRMState,
  docs: EvidenceDoc[],
  url: string,
  llm: AgentContext["llm"] = async () => null,
): Promise<AgentProposal> {
  const host = hostOf(url) ?? hostOf(docs[0]?.url) ?? "unknown";
  const pages = docs.filter((d) => d.kind === "web" && d.body.trim());
  const home = (pages.find((d) => d.url === url) ?? pages[0]) as ScrapedPage | undefined;
  const existing = findCompanyByHost(state, host);
  const companyId = existing?.id ?? freeCompanyId(state, host);

  const name =
    existing && typeof existing.attrs.name === "string" && existing.attrs.name
      ? existing.attrs.name
      : cleanCompanyName({ siteName: home?.siteName, title: home?.title, host });

  // stored docs: contract shape, tagged with the company they're about
  const stored = pages.map((d) => ({ ...toEvidenceDoc(d), entities: [...new Set([...(d.entities ?? []), companyId])] }));
  const byId = new Map(stored.map((d) => [d.id, d]));
  const relink = (d: EvidenceDoc) => byId.get(d.id) ?? d;

  const prevSignals = asSignals(existing?.attrs.signals);
  const have = new Set(prevSignals);
  const found = detectAll(stored);
  const sigs: Sig[] = found.signals.filter((s) => !have.has(s.signal)).map((s) => ({ ...s, doc: relink(s.doc) }));
  for (const s of sigs) have.add(s.signal);

  const llmOut = stored.length ? await enrich(llm, name, url, stored, have) : null;
  for (const s of llmOut?.signals ?? []) {
    if (have.has(s.signal)) continue;
    have.add(s.signal);
    sigs.push(s);
  }

  const homeText = `${home?.description ?? ""}\n${home?.title ?? ""}\n${home?.body ?? ""}`;
  const industry = llmOut?.industry ?? guessIndustry(homeText);
  const description = llmOut?.description ?? (home?.description ? oneLine(home.description, 220) : undefined);

  let employees = found.employees ? { ...found.employees, doc: relink(found.employees.doc) } : undefined;
  const prevEmployees = existing?.attrs.employees;
  if (employees && existing && Number(prevEmployees) === employees.f.value) employees = undefined;

  const events: NewEvent[] = stored.map((doc) => ({
    actor: ACTOR,
    op: { type: "evidence.attach", doc },
    reason: `Snapshot of ${doc.url ?? doc.title} (Firecrawl)`,
    evidence: [{ docId: doc.id, claim: `Live ${pageLabel(pageKind(doc)).toLowerCase()} snapshot via Firecrawl` }],
  }));

  const sigList = (base: string[]) => [...new Set([...base, ...sigs.map((s) => s.signal)])].sort();
  const sigRefs = sigs.map((s) => ref(s.doc, s));
  const readSet: Record<string, number> = {};

  if (!existing) {
    const attrs: Record<string, FieldValue> = { name, domain: host, stage: "lead", watchUrl: url, signals: sigList([]) };
    if (industry) attrs.industry = industry;
    if (employees) attrs.employees = employees.f.value;
    const evidence: EvidenceRef[] = [
      ...(home ? [ref(home as EvidenceDoc, { claim: `${name} (${host}) found at ${url}` })] : []),
      ...sigRefs,
      ...(employees ? [ref(employees.doc, employees.f)] : []),
    ];
    events.push({
      actor: ACTOR,
      op: { type: "entity.create", entity: companyId, entityType: "company", attrs },
      reason: [`New account from ${url}`, ...sigs.map((s) => s.claim), ...(employees ? [employees.f.claim] : [])].join("; "),
      evidence,
    });
  } else {
    if (sigs.length) {
      events.push({
        actor: ACTOR,
        op: { type: "field.set", entity: companyId, field: "signals", value: sigList(prevSignals), ...(existing.attrs.signals !== undefined ? { prev: prevSignals } : {}) },
        reason: sigs.map((s) => s.claim).join("; "),
        evidence: sigRefs,
      });
      readSet[`${companyId}::signals`] = state.versions?.[`${companyId}::signals`] ?? 0;
    }
    if (employees) {
      events.push({
        actor: ACTOR,
        op: { type: "field.set", entity: companyId, field: "employees", value: employees.f.value, ...(prevEmployees !== undefined ? { prev: prevEmployees } : {}) },
        reason: employees.f.claim,
        evidence: [ref(employees.doc, employees.f)],
      });
      readSet[`${companyId}::employees`] = state.versions?.[`${companyId}::employees`] ?? 0;
    }
    if (existing.attrs.watchUrl !== url && home) {
      events.push({
        actor: ACTOR,
        op: { type: "field.set", entity: companyId, field: "watchUrl", value: url, ...(existing.attrs.watchUrl !== undefined ? { prev: existing.attrs.watchUrl } : {}) },
        reason: `Start watching ${url} for changes`,
        evidence: [ref(home as EvidenceDoc, { claim: `Watched URL for ${name}` })],
      });
    }
  }

  const n = sigs.length;
  const plural = `+${n} signal${n === 1 ? "" : "s"}`;
  const title = existing ? `Web update: ${name} (${plural})` : `New account from web: ${name} (${plural})`;
  const lines = [
    ...(description ? [`${description}`, ""] : []),
    existing
      ? `Scraped **${url}** with Firecrawl — **${name}** is already in the CRM (\`${companyId}\`), so this PR only updates what changed.`
      : `Scraped **${url}** with Firecrawl and drafted a new lead **${name}** (\`${companyId}\`, ${host}${industry ? `, ${industry}` : ""}).`,
    "",
    `Pages: ${stored.map((d) => `[${pageLabel(pageKind(d))}](${d.url ?? ""})`).join(", ") || "none"}`,
    ...(sigs.length ? ["", "Signals:", ...sigs.map((s) => `- \`${s.signal}\` — ${s.claim} ("${s.quote}")${s.source === "llm" ? " · Claude" : ""}`)] : []),
    ...(employees ? ["", `Headcount: ${existing ? `${prevEmployees ?? "unset"} → ` : ""}${employees.f.value} — ${employees.f.claim} ("${employees.f.quote}")`] : []),
  ];
  const proposal: AgentProposal = { title, description: lines.join("\n"), events };
  if (Object.keys(readSet).length) proposal.readSet = readSet;
  return proposal;
}

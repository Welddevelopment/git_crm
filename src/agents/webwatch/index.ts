/** OWNER: agent builder "webwatch". Must work with NO API key (deterministic fallback) and be better with one. */
import type { AgentContext, AgentProposal, CRMAgent, CRMState, EntityId, EvidenceDoc, EvidenceRef, FieldValue, NewEvent } from "../../core/types";
import { detect, pageKind, pageLabel, type EmployeesFinding, type SignalFinding } from "./detectors";

import { hasFirecrawlKey, scrapeUrl, toEvidenceDoc } from "./firecrawl";

export { detect, pageKind } from "./detectors";
export { scrapeUrl, crawlCompany, hasFirecrawlKey } from "./firecrawl";
export { proposeFromUrl } from "./fromUrl";

const ACTOR = { kind: "agent", id: "webwatch", name: "Web watcher" } as const;

// ---------- small state helpers (no engine import: agents read CRMState directly) ----------

function resolve(state: CRMState, id: EntityId): EntityId {
  let cur = id;
  for (let i = 0; i < 16 && state.aliases?.[cur]; i++) cur = state.aliases[cur]!;
  return cur;
}

function liveCompany(state: CRMState, id: EntityId) {
  const rec = state.entities[resolve(state, id)];
  if (!rec || rec.deleted || rec.type !== "company") return undefined;
  return rec;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function asSignals(v: FieldValue | undefined): string[] {
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === "string");
  if (typeof v === "string" && v.trim()) return v.split(/[,;]\s*/).filter(Boolean);
  return [];
}

/** Map each web doc to the company it's about: doc.entities first, then URL host ↔ company.domain. */
function groupByCompany(state: CRMState, docs: EvidenceDoc[]): Map<EntityId, EvidenceDoc[]> {
  const byDomain = new Map<string, EntityId>();
  for (const rec of Object.values(state.entities)) {
    if (rec.type !== "company" || rec.deleted || rec.mergedInto) continue;
    const d = hostOf(typeof rec.attrs.domain === "string" ? rec.attrs.domain : undefined);
    if (d) byDomain.set(d, rec.id);
  }
  const groups = new Map<EntityId, EvidenceDoc[]>();
  for (const doc of docs) {
    if (doc.kind !== "web") continue;
    const ids = new Set<EntityId>();
    for (const e of doc.entities ?? []) {
      if (!e.startsWith("company:")) continue;
      const rec = liveCompany(state, e);
      if (rec) ids.add(rec.id);
    }
    if (ids.size === 0) {
      const h = hostOf(doc.url);
      const hit = h && (byDomain.get(h) ?? [...byDomain].find(([d]) => h.endsWith(`.${d}`))?.[1]);
      if (hit) ids.add(hit);
    }
    for (const id of ids) groups.set(id, [...(groups.get(id) ?? []), doc]);
  }
  return groups;
}

// ---------- live mode (Firecrawl) ----------
// Only companies a human opted in (attrs.watchUrl, set via "Watch account by URL") are scraped.
// Seeded companies have fictional domains that may resolve to unrelated real sites, so never scrape attrs.domain.

async function liveDocs(ctx: AgentContext, covered: Set<EntityId>): Promise<EvidenceDoc[]> {
  if (!hasFirecrawlKey()) return [];
  const targets = Object.values(ctx.state.entities).filter(
    (r) => r.type === "company" && !r.deleted && !r.mergedInto && !covered.has(r.id) && typeof r.attrs.watchUrl === "string" && /^https?:\/\//i.test(r.attrs.watchUrl),
  );
  if (!targets.length) return [];
  const now = ctx.now();
  const docs = await Promise.all(
    targets.map(async (r): Promise<EvidenceDoc | null> => {
      const d = await scrapeUrl(String(r.attrs.watchUrl), { now }).catch(() => null);
      return d ? { ...toEvidenceDoc(d), entities: [r.id] } : null;
    }),
  );
  const ok = docs.filter((d): d is EvidenceDoc => d !== null);
  ctx.log(`live: scraped ${ok.length}/${targets.length} watched URL(s) via Firecrawl`);
  return ok;
}

// ---------- proposal building ----------

const ref = (doc: EvidenceDoc, f: { quote: string; claim: string }): EvidenceRef => ({ docId: doc.id, quote: f.quote, claim: f.claim });

interface CompanyPlan {
  companyId: EntityId;
  name: string;
  newSignals: { f: SignalFinding; doc: EvidenceDoc }[];
  employees?: { f: EmployeesFinding; doc: EvidenceDoc; prev: FieldValue | undefined };
  signalsPrev: string[];
  hadSignals: boolean;
  liveDocs: EvidenceDoc[];
}

function planCompany(state: CRMState, companyId: EntityId, docs: EvidenceDoc[], live: Set<string>): CompanyPlan | null {
  const rec = state.entities[companyId];
  if (!rec) return null;
  const name = typeof rec.attrs.name === "string" && rec.attrs.name ? rec.attrs.name : companyId;
  const existing = asSignals(rec.attrs.signals);
  const have = new Set(existing);
  const newSignals: CompanyPlan["newSignals"] = [];
  let employees: CompanyPlan["employees"];

  // oldest → newest, so the latest snapshot wins for headcount
  const ordered = [...docs].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  for (const doc of ordered) {
    for (const f of detect(doc)) {
      if (f.kind === "signal") {
        if (have.has(f.signal)) continue;
        have.add(f.signal);
        newSignals.push({ f, doc });
      } else {
        employees = { f, doc, prev: rec.attrs.employees };
      }
    }
  }
  if (employees && Number(employees.prev) === employees.f.value) employees = undefined;
  newSignals.sort((a, b) => a.f.signal.localeCompare(b.f.signal));
  if (!newSignals.length && !employees) return null;
  const usedLive = ordered.filter((d) => live.has(d.id) && (newSignals.some((s) => s.doc === d) || employees?.doc === d));
  return { companyId, name, newSignals, employees, signalsPrev: existing, hadSignals: rec.attrs.signals !== undefined, liveDocs: usedLive };
}

function buildProposal(p: CompanyPlan): AgentProposal {
  const events: NewEvent[] = [];
  // live-scraped pages aren't in the doc store yet: attach them so the evidence resolves on merge
  for (const doc of p.liveDocs) {
    events.push({ actor: ACTOR, op: { type: "evidence.attach", doc }, reason: `Snapshot of ${doc.url ?? doc.title}`, evidence: [{ docId: doc.id, claim: "Live website snapshot (Firecrawl)" }] });
  }
  if (p.newSignals.length) {
    const value = [...new Set([...p.signalsPrev, ...p.newSignals.map((s) => s.f.signal)])].sort();
    events.push({
      actor: ACTOR,
      op: { type: "field.set", entity: p.companyId, field: "signals", value, ...(p.hadSignals ? { prev: p.signalsPrev } : {}) },
      reason: p.newSignals.map((s) => s.f.claim).join("; "),
      evidence: p.newSignals.map((s) => ref(s.doc, s.f)),
    });
  }
  if (p.employees) {
    const { f, doc, prev } = p.employees;
    events.push({
      actor: ACTOR,
      op: { type: "field.set", entity: p.companyId, field: "employees", value: f.value, ...(prev !== undefined ? { prev } : {}) },
      reason: f.claim,
      evidence: [ref(doc, f)],
    });
  }

  const parts = [
    ...p.newSignals.map((s) => `+${s.f.signal}`),
    ...(p.employees ? [`employees ${p.employees.prev ?? "?"}→${p.employees.f.value}`] : []),
  ];
  const lines = [
    `Website changes detected for **${p.name}**:`,
    ...p.newSignals.map((s) => `- \`${s.f.signal}\` — ${s.f.claim} ("${s.f.quote}")`),
    ...(p.employees ? [`- employees ${p.employees.prev ?? "unset"} → ${p.employees.f.value} — ${p.employees.f.claim} ("${p.employees.f.quote}")`] : []),
  ];
  return { title: `${p.name}: ${parts.join(", ")}`, description: lines.join("\n"), events };
}

async function llmSummary(ctx: AgentContext, p: CompanyPlan): Promise<string | null> {
  try {
    const facts = [
      ...p.newSignals.map((s) => `${s.f.claim} — "${s.f.quote}" (${pageLabel(pageKind(s.doc))})`),
      ...(p.employees ? [`${p.employees.f.claim} (CRM had ${p.employees.prev ?? "nothing"})`] : []),
    ].join("\n");
    const out = await ctx.llm({
      system: "You are a sales-intelligence analyst. Reply with ONE sentence (max 30 words) naming the single most notable website change and why a seller should care. No preamble.",
      prompt: `Account: ${p.name}\nDetected changes:\n${facts}`,
      maxTokens: 120,
    });
    const s = out?.trim();
    return s ? s.replace(/\s+/g, " ") : null;
  } catch {
    return null;
  }
}

export const webwatchAgent: CRMAgent = {
  id: "webwatch",
  name: "Web watcher",
  description: "Watches each account's website — careers, pricing, about pages — and turns changes into signals",
  async run(ctx) {
    const groups = groupByCompany(ctx.state, ctx.docs);
    const fetched = await liveDocs(ctx, new Set(groups.keys()));
    const liveIds = new Set(fetched.map((d) => d.id));
    for (const [id, docs] of groupByCompany(ctx.state, fetched)) groups.set(id, [...(groups.get(id) ?? []), ...docs]);

    const plans = [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, docs]) => planCompany(ctx.state, id, docs, liveIds))
      .filter((p): p is CompanyPlan => p !== null);

    const proposals: AgentProposal[] = [];
    for (const plan of plans) {
      const prop = buildProposal(plan);
      const summary = await llmSummary(ctx, plan);
      if (summary) prop.description = `${summary}\n\n${prop.description}`;
      proposals.push(prop);
    }
    ctx.log(`scanned ${groups.size} account(s), ${proposals.length} with new signals`);
    return proposals;
  },
};

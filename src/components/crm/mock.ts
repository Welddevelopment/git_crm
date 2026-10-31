/**
 * OWNER: W10. Local mock world (STORY.md data). Used ONLY with `?mock=1` or when the API is unreachable.
 * Persists to sessionStorage so a rehearsal survives page navigations.
 */
import type { Actor, AgentId, AgentTrust, CRMState, Event, EvidenceRef, FieldProvenance, FieldValue, NewEvent, Op, PullRequest } from "@/core/types";
import type { FleetStatus, TimelineEntry } from "@/core/api-contract";
import { foldEvents, localBlame } from "./lib";

const H = 3600_000, D = 24 * H;
const SEED: Actor = { kind: "system", id: "seed" };
const JOEL: Actor = { kind: "human", id: "joel", name: "Joel" };
const ag = (id: AgentId): Actor => ({ kind: "agent", id, name: id });

interface World { now: number; main: Event[]; prs: PullRequest[]; running: Record<string, boolean>; injected: boolean; nextPr: number; lastRun: Record<string, number> }

const AGENT_META: { id: AgentId; name: string; description: string }[] = [
  { id: "inbox", name: "Inbox agent", description: "Reads email → contacts, deal stage, amount, close date" },
  { id: "hygiene", name: "Hygiene agent", description: "Dedups records, normalizes fields" },
  { id: "schema", name: "Schema agent", description: "Spots data with no home → proposes new fields + backfill" },
  { id: "webwatch", name: "Webwatch agent", description: "Watches careers / pricing pages → company signals" },
];

let world: World | null = null;
const listeners = new Set<() => void>();
const KEY = "mainline.mock.v1";

function save() {
  try { sessionStorage.setItem(KEY, JSON.stringify(world)); } catch {}
  listeners.forEach((f) => { try { f(); } catch {} });
}
function load(): World {
  if (world) return world;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) { world = JSON.parse(raw) as World; return world; }
  } catch {}
  world = freshWorld();
  return world;
}

let evtCounter = 0;
function push(w: World, ne: NewEvent & { ts: number }, origin?: Event["origin"]): Event {
  const ev: Event = { id: `evt_m${(++evtCounter).toString(36)}_${w.main.length + 1}`, branch: "main", seq: w.main.length + 1, ts: ne.ts, actor: ne.actor, op: ne.op, reason: ne.reason, evidence: ne.evidence, origin: origin || ne.origin };
  w.main.push(ev);
  return ev;
}

// ---------- seed ----------
function freshWorld(): World {
  const now = Date.now();
  const w: World = { now, main: [], prs: [], running: {}, injected: false, nextPr: 1, lastRun: {} };
  let t = now - 14 * D;
  const tick = (ms = 7 * 60_000) => (t += ms);
  const add = (op: Op, actor: Actor = SEED, reason?: string) => push(w, { actor, op, reason, ts: tick() });

  const fields: Record<string, [string, "string" | "number" | "enum" | "string[]" | "ref" | "date"][]> = {
    company: [["name", "string"], ["domain", "string"], ["industry", "string"], ["employees", "number"], ["stage", "enum"], ["signals", "string[]"]],
    contact: [["name", "string"], ["email", "string"], ["title", "string"], ["company", "ref"], ["phone", "string"]],
    deal: [["name", "string"], ["company", "ref"], ["amount", "number"], ["stage", "enum"], ["closeDate", "date"], ["owner", "string"], ["nextStep", "string"]],
  };
  for (const [et, fs] of Object.entries(fields)) for (const [f, ft] of fs) add({ type: "schema.addField", entityType: et, field: f, fieldType: ft }, SEED, "initial schema");

  const companies: [string, string, string, string, number, string][] = [
    ["acme", "Acme Robotics", "acmerobotics.com", "Robotics", 420, "lead"],
    ["northwind", "Northwind Freight", "northwindfreight.com", "Logistics", 180, "customer"],
    ["kestrel", "Kestrel Bank", "kestrelbank.com", "Financial services", 2300, "lead"],
    ["lumen", "Lumen Grid", "lumengrid.io", "Energy software", 38, "lead"],
    ["brightline", "Brightline Health", "brightlinehealth.com", "Healthcare", 860, "customer"],
    ["orbital", "Orbital Foods", "orbitalfoods.co", "Food & beverage", 310, "lead"],
    ["tidewater", "Tidewater Logistics", "tidewaterlogistics.com", "Logistics", 540, "customer"],
    ["vantage", "Vantage Retail", "vantageretail.com", "Retail", 1200, "lead"],
    ["quill", "Quill Legal", "quill.legal", "Legal tech", 64, "lead"],
    ["harbor", "Harbor Analytics", "harboranalytics.ai", "Analytics", 95, "churned"],
  ];
  for (const [s, name, domain, industry, employees, stage] of companies)
    add({ type: "entity.create", entity: `company:${s}`, entityType: "company", attrs: { name, domain, industry, employees, stage, signals: [] } });

  const contacts: [string, string, string, string, string, string][] = [
    ["priya-acme", "Priya Sharma", "priya@acmerobotics.com", "Engineering Manager", "acme", "+1 415 555 0142"],
    ["priya-sharma", "Priya S.", "p.sharma@acmerobotics.com", "", "acme", ""],
    ["marco-acme", "Marco Ruiz", "marco@acmerobotics.com", "Head of Procurement", "acme", "+1 415 555 0177"],
    ["dana-northwind", "Dana Ortiz", "dana@northwindfreight.com", "Head of Logistics", "northwind", "+1 312 555 0110"],
    ["li-northwind", "Li Wei", "li.wei@northwindfreight.com", "IT Director", "northwind", ""],
    ["alex-chen-kestrel", "Alex Chen", "alex.chen@kestrelbank.com", "CISO", "kestrel", "+1 646 555 0199"],
    ["rachel-kestrel", "Rachel Moss", "rmoss@kestrelbank.com", "VP Security Engineering", "kestrel", ""],
    ["alex-chen-lumen", "Alex Chen", "achen@lumengrid.io", "Founder & CEO", "lumen", "+1 512 555 0123"],
    ["sofia-brightline", "Sofia Grant", "sgrant@brightlinehealth.com", "COO", "brightline", "+1 617 555 0131"],
    ["omar-brightline", "Omar Haddad", "omar@brightlinehealth.com", "Director of IT", "brightline", ""],
    ["ben-orbital", "Ben Okafor", "ben@orbitalfoods.co", "Ops Lead", "orbital", "+1 503 555 0164"],
    ["hana-tidewater", "Hana Kim", "hana.kim@tidewaterlogistics.com", "VP Operations", "tidewater", ""],
    ["jules-tidewater", "Jules Martin", "jmartin@tidewaterlogistics.com", "Finance Manager", "tidewater", ""],
    ["nina-vantage", "Nina Patel", "nina@vantageretail.com", "Head of Data", "vantage", "+1 206 555 0188"],
    ["tom-quill", "Tom Becker", "tom@quill.legal", "Managing Partner", "quill", ""],
    ["eva-harbor", "Eva Lindqvist", "eva@harboranalytics.ai", "CTO", "harbor", ""],
  ];
  for (const [s, name, email, title, co, phone] of contacts)
    add({ type: "entity.create", entity: `contact:${s}`, entityType: "contact", attrs: { name, email, title, company: `company:${co}`, phone } });

  const deals: [string, string, string, number, string, string, string][] = [
    ["acme-platform", "Acme — Platform rollout", "acme", 20000, "discovery", "2026-12-15", "Intro call follow-up"],
    ["northwind-fleet", "Northwind — Fleet tracking", "northwind", 60000, "demo", "2026-11-30", "Send proposal"],
    ["kestrel-security", "Kestrel — Security review", "kestrel", 85000, "demo", "2027-01-20", "SOC2 questionnaire"],
    ["lumen-pilot", "Lumen — Pilot", "lumen", 12000, "discovery", "2026-12-01", "Scope pilot"],
    ["brightline-expansion", "Brightline — Expansion", "brightline", 48000, "proposal", "2026-11-20", "Pricing review"],
    ["orbital-ops", "Orbital — Ops suite", "orbital", 30000, "discovery", "2027-02-01", "Book demo"],
    ["tidewater-renewal", "Tidewater — Renewal", "tidewater", 72000, "negotiation", "2026-11-10", "Redlines from legal"],
    ["vantage-analytics", "Vantage — Analytics add-on", "vantage", 26000, "proposal", "2026-12-05", "Follow up on proposal"],
    ["quill-starter", "Quill — Starter plan", "quill", 9000, "demo", "2026-11-25", "Demo for partners"],
  ];
  for (const [s, name, co, amount, stage, closeDate, nextStep] of deals)
    add({ type: "entity.create", entity: `deal:${s}`, entityType: "deal", attrs: { name, company: `company:${co}`, amount, stage, closeDate, owner: "Joel", nextStep } });

  // a few days of history so the timeline has texture
  t = now - 9 * D;
  add({ type: "field.set", entity: "deal:northwind-fleet", field: "stage", value: "proposal", prev: "demo" }, JOEL, "Proposal sent after demo");
  tick(40 * 60_000);
  add({ type: "field.set", entity: "deal:northwind-fleet", field: "nextStep", value: "Await sign-off from Dana", prev: "Send proposal" }, JOEL, "Updated after call");
  t = now - 6 * D;
  mergedPR(w, "webwatch", "Harbor careers page: hiring freeze", t, [
    { op: { type: "field.set", entity: "company:harbor", field: "signals", value: ["hiring:freeze"], prev: [] }, reason: "Careers page now reads 'no open roles'", evidence: [{ docId: "web_harbor_careers", quote: "We currently have no open roles.", claim: "Harbor paused hiring" }] },
  ], { kind: "system", id: "auto-merge" });
  t = now - 4 * D;
  mergedPR(w, "inbox", "Orbital: Ben asked to book a demo", t, [
    { op: { type: "field.set", entity: "deal:orbital-ops", field: "stage", value: "demo", prev: "discovery" }, reason: "Email asks to book a demo", evidence: [{ docId: "email_orbital_demo", quote: "Could we book a demo for the ops team next week?", claim: "Orbital wants a demo → Demo" }] },
    { op: { type: "field.set", entity: "deal:orbital-ops", field: "nextStep", value: "Demo with ops team", prev: "Book demo" }, reason: "Next step from email" },
  ], JOEL);
  t = now - 2.5 * D;
  add({ type: "field.set", entity: "deal:tidewater-renewal", field: "amount", value: 78000, prev: 72000 }, JOEL, "Added 2 seats per Hana");
  t = now - 1.2 * D;
  add({ type: "field.set", entity: "contact:hana-tidewater", field: "phone", value: "+1 757 555 0102", prev: "" }, JOEL, "From call");
  return w;
}

interface Step { op: Op; reason?: string; evidence?: EvidenceRef[] }
function mkPR(w: World, agent: AgentId, title: string, ts: number, steps: Step[], extra: Partial<PullRequest> = {}): PullRequest {
  const id = `pr_${w.nextPr++}`;
  const pr: PullRequest = {
    id, title, description: steps.map((s) => s.reason).filter(Boolean).join(" · "), branch: `agent/${agent}/${Math.round(ts / 1000)}`,
    author: ag(agent), status: "open", createdAt: ts, updatedAt: ts,
    policy: { tier: "auto", reasons: [], perEvent: {} }, staleness: { status: "fresh", checkedAt: ts, changedReads: [], contradictions: [] }, conflicts: [],
    ...extra,
  };
  (pr as PullRequest & { _steps?: Step[] })._steps = steps;
  w.prs.push(pr);
  return pr;
}
function mergeMock(w: World, pr: PullRequest, by: Actor, ts: number) {
  const steps = (pr as PullRequest & { _steps?: Step[] })._steps || [];
  const evs = steps.map((s, i) => push(w, { actor: pr.author, op: s.op, reason: s.reason, evidence: s.evidence, ts: ts + i }, { kind: "merge", pr: pr.id, sourceEvent: `${pr.branch}#${i + 1}` }));
  pr.status = "merged"; pr.mergedAt = ts; pr.mergedBy = by; pr.updatedAt = ts; pr.mergeEvents = evs.map((e) => e.id);
}
function mergedPR(w: World, agent: AgentId, title: string, ts: number, steps: Step[], by: Actor) {
  const pr = mkPR(w, agent, title, ts - 20 * 60_000, steps);
  mergeMock(w, pr, by, ts);
}

// ---------- scenario runs ----------
const E = {
  acme: { docId: "email_priya_msa", quote: "please send over the MSA … we'd like 45 seats, total $45,000", claim: "Acme asked for an MSA for 45 seats → Negotiation, $45,000" },
  sig: { docId: "email_psharma_sig", quote: "Priya Sharma — VP Engineering", claim: "Signature shows title VP Engineering" },
  dana: { docId: "email_dana_acq", quote: "we're now 250 people after the acquisition", claim: "Northwind headcount is 250" },
  nwWeb: { docId: "web_northwind_about", quote: "220 employees across 6 depots", claim: "Northwind about page says 220 employees" },
  proc: { docId: "email_procurement_x3", quote: "loop in our procurement contact, Sam Lee (sam@acmerobotics.com)", claim: "3 emails name a procurement contact; no field exists" },
  acmeJobs: { docId: "web_acme_careers", quote: "Data Engineer (3 openings)", claim: "Acme is hiring a data-engineering team" },
  brightPrice: { docId: "web_brightline_pricing", quote: "New: Enterprise tier", claim: "Brightline launched an Enterprise tier" },
};

function chaos(w: World) {
  const now = Date.now(); let t = now - 60_000;
  const d = (actor: Actor, op: Op, reason: string, evidence?: EvidenceRef[]) => push(w, { actor, op, reason, evidence, ts: (t += 900) });
  d(ag("inbox"), { type: "field.set", entity: "deal:acme-platform", field: "stage", value: "negotiation", prev: "discovery" }, "MSA requested", [E.acme]);
  d(ag("inbox"), { type: "field.set", entity: "deal:acme-platform", field: "amount", value: 45000, prev: 20000 }, "45 seats, total $45,000", [E.acme]);
  d(ag("inbox"), { type: "field.set", entity: "contact:priya-sharma", field: "title", value: "VP Engineering", prev: "" }, "From signature", [E.sig]);
  d(ag("hygiene"), { type: "entity.merge", from: "contact:priya-sharma", into: "contact:priya-acme" }, "Same name + company domain");
  d(ag("inbox"), { type: "field.set", entity: "company:northwind", field: "employees", value: 250, prev: 180 }, "Post-acquisition headcount", [E.dana]);
  d(ag("webwatch"), { type: "field.set", entity: "company:northwind", field: "employees", value: 220, prev: 250 }, "About page headcount", [E.nwWeb]);
  d(ag("hygiene"), { type: "entity.merge", from: "contact:alex-chen-lumen", into: "contact:alex-chen-kestrel", fieldChoices: { title: "Founder & CEO", email: "achen@lumengrid.io" } }, "Exact name match 'Alex Chen'");
  d(ag("hygiene"), { type: "field.set", entity: "contact:alex-chen-kestrel", field: "company", value: "company:lumen", prev: "company:kestrel" }, "Survivor takes newest company");
  d(ag("inbox"), { type: "field.set", entity: "deal:northwind-fleet", field: "amount", value: 96000, prev: 60000 }, "Parsed '$96k' from thread (was a competitor quote)", [{ docId: "email_dana_quote", quote: "the other vendor came in at $96k", claim: "Northwind deal is $96k" }]);
  d(ag("inbox"), { type: "field.set", entity: "deal:brightline-expansion", field: "amount", value: 120000, prev: 48000 }, "Sofia mentioned '$120k budget'", [{ docId: "email_sofia_budget", quote: "our total IT budget is $120k this year", claim: "Brightline deal is $120k" }]);
  d(ag("schema"), { type: "schema.addField", entityType: "deal", field: "procurementContact", fieldType: "string" }, "Procurement contact appears in 3 emails", [E.proc]);
  d(ag("schema"), { type: "field.set", entity: "deal:acme-platform", field: "procurementContact", value: "Sam Lee <sam@acmerobotics.com>" }, "Backfill", [E.proc]);
  d(ag("webwatch"), { type: "field.set", entity: "company:acme", field: "signals", value: ["hiring:data-engineering"], prev: [] }, "3 Data Engineer roles", [E.acmeJobs]);
  d(ag("hygiene"), { type: "field.set", entity: "company:acme", field: "signals", value: [], prev: ["hiring:data-engineering"] }, "Normalize: drop unrecognized signal tags");
  d(ag("inbox"), { type: "field.set", entity: "deal:tidewater-renewal", field: "stage", value: "closed_won", prev: "negotiation" }, "'signed' in thread (it was the NDA)", [{ docId: "email_hana_nda", quote: "NDA is signed, redlines on the MSA next", claim: "Tidewater signed → Closed won" }]);
  for (const a of AGENT_META) w.lastRun[a.id] = now;
  return 15;
}

function governed(w: World) {
  const now = Date.now(); let t = now - 50_000;
  const at = () => (t += 2500);
  const review = (reasons: string[]): PullRequest["policy"] => ({ tier: "review", reasons, perEvent: {} });
  mkPR(w, "inbox", "Acme — MSA requested: Negotiation, $45,000", at(), [
    { op: { type: "field.set", entity: "deal:acme-platform", field: "stage", value: "negotiation", prev: "discovery" }, reason: "Priya asked for the MSA", evidence: [E.acme] },
    { op: { type: "field.set", entity: "deal:acme-platform", field: "amount", value: 45000, prev: 20000 }, reason: "45 seats, total $45,000", evidence: [E.acme] },
  ], { policy: review(["deal.amount change +$25,000 > $10,000 threshold", "deal.stage change needs a human"]) });
  const sig = mkPR(w, "inbox", "Priya S. title → VP Engineering", at(), [
    { op: { type: "field.set", entity: "contact:priya-acme", field: "title", value: "VP Engineering", prev: "Engineering Manager" }, reason: "From email signature", evidence: [E.sig] },
  ]);
  const dedup = mkPR(w, "hygiene", "Merge duplicate contact Priya S. → Priya Sharma", at(), [
    { op: { type: "entity.merge", from: "contact:priya-sharma", into: "contact:priya-acme" }, reason: "Same name + company domain acmerobotics.com" },
  ]);
  mergeMock(w, dedup, { kind: "system", id: "auto-merge" }, at());
  sig.conflicts = [{ id: "c1", kind: "merged-away", entity: "contact:priya-sharma", autoResolved: { to: "contact:priya-acme", note: "rebased onto merge survivor" } }];
  mergeMock(w, sig, { kind: "system", id: "auto-merge" }, at());
  const nwInbox = mkPR(w, "inbox", "Northwind headcount → 250 (acquisition)", at(), [
    { op: { type: "field.set", entity: "company:northwind", field: "employees", value: 250, prev: 180 }, reason: "Dana: now 250 people", evidence: [E.dana] },
  ]);
  mergeMock(w, nwInbox, { kind: "system", id: "auto-merge" }, at());
  mkPR(w, "webwatch", "Northwind headcount → 220 (about page)", at(), [
    { op: { type: "field.set", entity: "company:northwind", field: "employees", value: 220, prev: 180 }, reason: "About page says 220", evidence: [E.nwWeb] },
  ], { conflicts: [{ id: "c2", kind: "field", entity: "company:northwind", field: "employees", base: 180, ours: 250, theirs: 220 }], policy: review(["field conflict with main"]) });
  const bad = mkPR(w, "hygiene", "Merge duplicate contact Alex Chen (Lumen) → Alex Chen (Kestrel)", at(), [
    { op: { type: "entity.merge", from: "contact:alex-chen-lumen", into: "contact:alex-chen-kestrel" }, reason: "Exact name match 'Alex Chen'" },
  ]);
  mergeMock(w, bad, { kind: "system", id: "auto-merge" }, at());
  mkPR(w, "schema", "Add deal.procurementContact + backfill 3 deals", at(), [
    { op: { type: "schema.addField", entityType: "deal", field: "procurementContact", fieldType: "string", description: "Buyer-side procurement contact" }, reason: "3 emails name a procurement contact", evidence: [E.proc] },
    { op: { type: "field.set", entity: "deal:acme-platform", field: "procurementContact", value: "Sam Lee <sam@acmerobotics.com>" }, reason: "Backfill", evidence: [E.proc] },
    { op: { type: "field.set", entity: "deal:tidewater-renewal", field: "procurementContact", value: "Jules Martin <jmartin@tidewaterlogistics.com>" }, reason: "Backfill" },
    { op: { type: "field.set", entity: "deal:kestrel-security", field: "procurementContact", value: "Pat Rowe <prowe@kestrelbank.com>" }, reason: "Backfill" },
  ], { policy: review(["schema change needs a human"]) });
  const sigs = mkPR(w, "webwatch", "Signals: Acme hiring data eng, Brightline enterprise tier", at(), [
    { op: { type: "field.set", entity: "company:acme", field: "signals", value: ["hiring:data-engineering"], prev: [] }, reason: "3 Data Engineer roles", evidence: [E.acmeJobs] },
    { op: { type: "field.set", entity: "company:brightline", field: "signals", value: ["pricing:enterprise-tier"], prev: [] }, reason: "Enterprise tier on pricing page", evidence: [E.brightPrice] },
  ]);
  mergeMock(w, sigs, { kind: "system", id: "auto-merge" }, at());
  for (const a of AGENT_META) w.lastRun[a.id] = now;
  return w.prs.filter((p) => p.createdAt > now - 60_000);
}

function inject(w: World) {
  const now = Date.now();
  const doc = { id: "email_inject_acme_pause", kind: "email" as const, ts: now, title: "Re: Platform rollout — pausing until Q1", from: "priya@acmerobotics.com", body: "Hi Joel — we're pausing the platform rollout until Q1 due to a budget freeze. Let's reconnect in January.", entities: ["company:acme", "deal:acme-platform", "contact:priya-acme"] };
  push(w, { actor: { kind: "system", id: "inbox-sync" }, op: { type: "evidence.attach", doc }, reason: "New email received", ts: now });
  const affected: string[] = [];
  for (const pr of w.prs) {
    if (pr.status !== "open") continue;
    const steps = (pr as PullRequest & { _steps?: Step[] })._steps || [];
    if (steps.some((s) => s.op.type === "field.set" && s.op.entity === "deal:acme-platform" && (s.op.field === "stage" || s.op.field === "amount"))) {
      pr.staleness = { status: "stale", checkedAt: now, changedReads: [], contradictions: [{ docId: doc.id, title: doc.title, explanation: "Newer email says Acme is pausing (budget freeze) — contradicts move to Negotiation at $45,000.", affectsEvents: [] }] };
      pr.updatedAt = now;
      affected.push(pr.id);
    }
  }
  w.injected = true;
  return affected;
}

function trustFor(w: World, id: AgentId): AgentTrust {
  const mine = w.prs.filter((p) => p.author.id === id);
  const merged = mine.filter((p) => p.status === "merged").length;
  const reverted = mine.filter((p) => p.status === "reverted").length;
  const closed = mine.filter((p) => p.status === "closed").length;
  const stale = mine.filter((p) => p.staleness?.status === "stale").length;
  const base: Record<string, number> = { inbox: 0.62, hygiene: 0.48, schema: 0.4, webwatch: 0.81 };
  const score = Math.max(0, Math.min(1, (base[id] ?? 0.5) + merged * 0.04 - reverted * 0.2 - stale * 0.06 - closed * 0.05));
  return { agent: id, prsOpened: mine.length, prsMerged: merged, prsReverted: reverted, prsClosed: closed, staleCount: stale, score, level: score >= 0.8 ? "autonomous" : score >= 0.55 ? "trusted" : "probation" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (p: PullRequest): PullRequest => { const { _steps, ...rest } = p as PullRequest & { _steps?: unknown }; void _steps; return rest; };

export const mock = {
  async state(q: { at?: number } = {}): Promise<{ state: CRMState }> {
    const w = load();
    const evs = q.at === undefined ? w.main : w.main.filter((e) => e.ts <= q.at!);
    return { state: foldEvents(evs) };
  },
  async timeline(): Promise<{ entries: TimelineEntry[] }> {
    const w = load();
    return { entries: w.main.map((e) => ({ seq: e.seq, ts: e.ts, event: e, pr: e.origin?.kind === "merge" ? e.origin.pr : e.origin?.kind === "revert" ? e.origin.pr : undefined })) };
  },
  async blame(entity: string, field: string): Promise<{ history: FieldProvenance[] }> {
    return { history: localBlame(load().main, entity, field).reverse() };
  },
  async prs(status?: PullRequest["status"]): Promise<{ prs: PullRequest[] }> {
    const w = load();
    return { prs: w.prs.filter((p) => !status || p.status === status).map(strip) };
  },
  async fleet(): Promise<FleetStatus> {
    const w = load();
    return { agents: AGENT_META.map((a) => ({ ...a, running: !!w.running[a.id], lastRunAt: w.lastRun[a.id], trust: trustFor(w, a.id) })) };
  },
  async runFleet(_agents?: AgentId[], mode: "governed" | "chaos" = "governed"): Promise<{ prs: PullRequest[]; directEvents: number }> {
    const w = load();
    for (const a of AGENT_META) w.running[a.id] = true;
    save();
    await sleep(1400);
    let res: { prs: PullRequest[]; directEvents: number };
    if (mode === "chaos") res = { prs: [], directEvents: chaos(w) };
    else res = { prs: governed(w).map(strip), directEvents: 0 };
    w.running = {};
    save();
    return res;
  },
  async reset(): Promise<{ ok: true }> {
    world = freshWorld();
    save();
    return { ok: true };
  },
  async inject(_docId: string): Promise<{ ok: true; affectedPRs: string[] }> {
    const w = load();
    const affectedPRs = inject(w);
    save();
    return { ok: true, affectedPRs };
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};
export type MockValue = FieldValue;

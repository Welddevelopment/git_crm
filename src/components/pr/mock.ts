/* OWNER: W9. Local mock of the PR API, used ONLY with ?mock=1 or when the real API fails.
 * Data mirrors STORY.md so the UI looks like the real demo. Mutations (merge/close/revert) are applied in memory. */
import type { PRDetail } from "@/core/api-contract";
import type {
  Actor, Branch, Change, Conflict, CRMState, EntityRecord, Event, EvidenceDoc, EvidenceRef, FieldValue, Op, PolicyDecision,
  PullRequest, Schema, StalenessReport,
} from "@/core/types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const agent = (id: string): Actor => ({ kind: "agent", id });
const JOEL: Actor = { kind: "human", id: "joel", name: "Joel" };
const SYSTEM_MERGE: Actor = { kind: "system", id: "merge" };

function entity(id: string, attrs: Record<string, FieldValue>): EntityRecord {
  return { id, type: id.split(":")[0], attrs };
}

function baseEntities(): Record<string, EntityRecord> {
  const list: EntityRecord[] = [
    entity("company:acme", { name: "Acme Robotics", domain: "acmerobotics.com", industry: "Robotics", employees: 420, stage: "lead", signals: [] }),
    entity("deal:acme-platform", { name: "Acme — Platform rollout", company: "company:acme", amount: 20000, stage: "discovery", closeDate: "2026-12-15", owner: "Joel", nextStep: "Intro call with Priya" }),
    entity("contact:priya-acme", { name: "Priya Sharma", email: "priya@acmerobotics.com", title: "Engineering Manager", company: "company:acme", phone: "+1 415 555 0142" }),
    entity("contact:priya-sharma", { name: "Priya S.", email: "p.sharma@acmerobotics.com", title: "", company: "company:acme", phone: "" }),
    entity("company:northwind", { name: "Northwind Freight", domain: "northwindfreight.com", industry: "Logistics", employees: 180, stage: "lead", signals: [] }),
    entity("deal:northwind-fleet", { name: "Northwind — Fleet tracking", company: "company:northwind", amount: 60000, stage: "proposal", closeDate: "2026-11-30", owner: "Joel", nextStep: "Pricing review" }),
    entity("contact:dana-northwind", { name: "Dana Ortiz", email: "dana@northwindfreight.com", title: "Head of Logistics", company: "company:northwind", phone: "(312) 555-0199" }),
    entity("company:kestrel", { name: "Kestrel Bank", domain: "kestrelbank.com", industry: "Financial services", employees: 2400, stage: "customer", signals: [] }),
    entity("contact:alex-chen-kestrel", { name: "Alex Chen", email: "alex.chen@kestrelbank.com", title: "CISO", company: "company:kestrel", phone: "+1 212 555 0188" }),
    entity("company:lumen", { name: "Lumen Grid", domain: "lumengrid.io", industry: "Energy", employees: 35, stage: "lead", signals: [] }),
    entity("contact:alex-chen-lumen", { name: "Alex Chen", email: "achen@lumengrid.io", title: "Founder & CEO", company: "company:lumen", phone: "+1 512 555 0123" }),
    entity("company:brightline", { name: "Brightline Health", domain: "brightlinehealth.com", industry: "Healthcare", employees: 900, stage: "lead", signals: [] }),
    entity("deal:brightline-care", { name: "Brightline — Care ops", company: "company:brightline", amount: 38000, stage: "demo", closeDate: "2027-01-20", owner: "Joel", nextStep: "Security review" }),
    entity("company:orbital", { name: "Orbital Foods", domain: "orbitalfoods.com", industry: "Food & beverage", employees: 610, stage: "lead", signals: [] }),
    entity("deal:orbital-supply", { name: "Orbital — Supply chain pilot", company: "company:orbital", amount: 24000, stage: "proposal", closeDate: "2026-12-01", owner: "Joel", nextStep: "Send proposal" }),
    entity("contact:mei-orbital", { name: "Mei Tanaka", email: "mei@orbitalfoods.com", title: "VP Operations", company: "company:orbital", phone: "312.555.0107" }),
    entity("company:quill", { name: "Quill Legal", domain: "quill.law", industry: "Legal", employees: 75, stage: "lead", signals: [] }),
    entity("contact:ruth-quill", { name: "Ruth Adler", email: "ruth@quill.law", title: "Managing Partner", company: "company:quill", phone: "415-555-0177" }),
    entity("company:harbor", { name: "Harbor Analytics", domain: "harboranalytics.com", industry: "Analytics", employees: 140, stage: "customer", signals: [] }),
    entity("contact:omar-harbor", { name: "Omar Haddad", email: "omar@harboranalytics.com", title: "CTO", company: "company:harbor", phone: "6175550134" }),
  ];
  return Object.fromEntries(list.map((e) => [e.id, e]));
}

const SCHEMA: Schema = {
  company: ["name", "domain", "industry", "employees", "stage", "signals"].map((f) => ({ field: f, fieldType: f === "employees" ? "number" : f === "signals" ? "string[]" : "string" })),
  contact: ["name", "email", "title", "company", "phone"].map((f) => ({ field: f, fieldType: f === "company" ? "ref" : "string" })),
  deal: ["name", "company", "amount", "stage", "closeDate", "owner", "nextStep"].map((f) => ({
    field: f, fieldType: f === "amount" ? "number" : f === "company" ? "ref" : f === "closeDate" ? "date" : "string",
  })),
};

function docs(now: number): Record<string, EvidenceDoc> {
  const d: EvidenceDoc[] = [
    {
      id: "email_priya_msa", kind: "email", ts: now - 2 * DAY, title: "Re: Platform rollout — next steps",
      from: "Priya Sharma <priya@acmerobotics.com>", to: ["joel@mainline.dev"],
      body: "Hi Joel,\n\nThanks for the walkthrough on Tuesday — the team loved it. Could you please send over the MSA so legal can start reviewing? We'd like 45 seats, total $45,000, and we're aiming to close by mid-December.\n\nBest,\nPriya Sharma — Engineering Manager\nAcme Robotics",
      entities: ["company:acme", "deal:acme-platform", "contact:priya-acme"],
    },
    {
      id: "email_priya_sig", kind: "email", ts: now - 1 * DAY - 5 * HOUR, title: "Security questionnaire",
      from: "Priya Sharma <p.sharma@acmerobotics.com>", to: ["joel@mainline.dev"],
      body: "Joel — attaching our vendor security questionnaire. No rush, end of next week is fine.\n\nPriya Sharma — VP Engineering\nAcme Robotics",
      entities: ["company:acme", "contact:priya-sharma"],
    },
    {
      id: "email_priya_pause", kind: "email", ts: now - 4 * MIN, title: "Platform rollout — pausing until Q1",
      from: "Priya Sharma <priya@acmerobotics.com>", to: ["joel@mainline.dev"],
      body: "Hi Joel,\n\nBad news, I'm afraid: finance just announced a budget freeze for the rest of the year. We're pausing the platform rollout until Q1 and won't be able to sign the MSA this quarter. I'll reach out in January.\n\nPriya Sharma — VP Engineering\nAcme Robotics",
      entities: ["company:acme", "deal:acme-platform", "contact:priya-acme"],
    },
    {
      id: "email_dana_acq", kind: "email", ts: now - 3 * DAY, title: "Re: Fleet tracking proposal",
      from: "Dana Ortiz <dana@northwindfreight.com>", to: ["joel@mainline.dev"],
      body: "Hey Joel, quick update before we review pricing — we're now 250 people after the acquisition of Bayline closed, so the seat count in the proposal should go up.\n\nDana Ortiz — Head of Logistics\nNorthwind Freight",
      entities: ["company:northwind", "deal:northwind-fleet", "contact:dana-northwind"],
    },
    {
      id: "web_northwind_about", kind: "web", ts: now - 1 * DAY, title: "About us — Northwind Freight", url: "https://northwindfreight.com/about",
      body: "Northwind Freight moves what matters across the Midwest. Founded in 2009 in Chicago. Today: 220 employees across 6 hubs, 400+ trucks, and a 99.2% on-time rate.",
      entities: ["company:northwind"],
    },
    {
      id: "email_procurement_acme", kind: "email", ts: now - 2 * DAY - 3 * HOUR, title: "Re: MSA",
      from: "Priya Sharma <priya@acmerobotics.com>", to: ["joel@mainline.dev"],
      body: "Also, please loop in our procurement contact, Sam Lee (sam@acmerobotics.com) on the paperwork.\n\nPriya Sharma — Engineering Manager\nAcme Robotics",
      entities: ["deal:acme-platform", "company:acme"],
    },
    {
      id: "email_procurement_northwind", kind: "email", ts: now - 4 * DAY, title: "Pricing review",
      from: "Dana Ortiz <dana@northwindfreight.com>", to: ["joel@mainline.dev"],
      body: "For the pricing review, loop in our procurement contact, Rita Gomez (rita@northwindfreight.com). She owns vendor onboarding.\n\nDana Ortiz — Head of Logistics\nNorthwind Freight",
      entities: ["deal:northwind-fleet", "company:northwind"],
    },
    {
      id: "email_procurement_orbital", kind: "email", ts: now - 5 * DAY, title: "Pilot paperwork",
      from: "Mei Tanaka <mei@orbitalfoods.com>", to: ["joel@mainline.dev"],
      body: "Happy to move ahead with the pilot. Please loop in our procurement contact, Ken Ito (ken@orbitalfoods.com) for the PO.\n\nMei Tanaka — VP Operations\nOrbital Foods",
      entities: ["deal:orbital-supply", "company:orbital"],
    },
    {
      id: "web_acme_careers", kind: "web", ts: now - 6 * HOUR, title: "Careers — Acme Robotics", url: "https://acmerobotics.com/careers",
      body: "Open roles: Senior Data Engineer (Remote) · Data Engineer, Streaming (SF) · Data Engineer, Platform (SF) · Robotics Technician (Austin)",
      entities: ["company:acme"],
    },
    {
      id: "web_brightline_pricing", kind: "web", ts: now - 7 * HOUR, title: "Pricing — Brightline Health", url: "https://brightlinehealth.com/pricing",
      body: "Starter · Growth · Enterprise — custom SSO, dedicated CSM and HIPAA BAA. Contact sales for Enterprise pricing.",
      entities: ["company:brightline"],
    },
    {
      id: "email_orbital_close", kind: "email", ts: now - 30 * HOUR, title: "Timeline",
      from: "Mei Tanaka <mei@orbitalfoods.com>", to: ["joel@mainline.dev"],
      body: "We'd like to close by November 15 if the pilot scope stays as is.\n\nMei Tanaka — VP Operations\nOrbital Foods",
      entities: ["deal:orbital-supply"],
    },
  ];
  return Object.fromEntries(d.map((x) => [x.id, x]));
}

interface Spec {
  id: string;
  title: string;
  description: string;
  agent: string; // author agent id or "joel"
  branchNo: number | string;
  status: PullRequest["status"];
  age: number; // ms ago created
  forkSeq: number;
  ops: { op: Op; reason?: string; evidence?: EvidenceRef[] }[];
  changes: Change[];
  conflicts?: Conflict[];
  staleness?: Omit<StalenessReport, "checkedAt">;
  policy: { tier: PolicyDecision["tier"]; reasons: string[]; eventTiers?: PolicyDecision["tier"][] };
  mergedBy?: Actor;
  mergedAgo?: number;
  revertedBy?: string;
  readSet?: Record<string, number>;
}

const fc = (entity: string, field: string, before: FieldValue | undefined, after: FieldValue | undefined): Change => ({ kind: "field.changed", entity, field, before, after });
const set = (entity: string, field: string, value: FieldValue, prev?: FieldValue): Op => ({ type: "field.set", entity, field, value, prev });
const attach = (doc: EvidenceDoc): Op => ({ type: "evidence.attach", doc });

function specs(D: Record<string, EvidenceDoc>, base: Record<string, EntityRecord>): Spec[] {
  return [
    {
      id: "pr_12", title: "Normalize phone numbers for 4 contacts", agent: "hygiene", branchNo: 3, status: "open", age: 3 * MIN, forkSeq: 61,
      description: "Rewrites phone numbers to E.164 so dialers and dedup can match them. Formatting only — no digits change.",
      ops: [
        { op: set("contact:dana-northwind", "phone", "+1 312 555 0199", "(312) 555-0199"), reason: "Normalize to E.164" },
        { op: set("contact:mei-orbital", "phone", "+1 312 555 0107", "312.555.0107"), reason: "Normalize to E.164" },
        { op: set("contact:ruth-quill", "phone", "+1 415 555 0177", "415-555-0177"), reason: "Normalize to E.164" },
        { op: set("contact:omar-harbor", "phone", "+1 617 555 0134", "6175550134"), reason: "Normalize to E.164" },
      ],
      changes: [
        fc("contact:dana-northwind", "phone", "(312) 555-0199", "+1 312 555 0199"),
        fc("contact:mei-orbital", "phone", "312.555.0107", "+1 312 555 0107"),
        fc("contact:ruth-quill", "phone", "415-555-0177", "+1 415 555 0177"),
        fc("contact:omar-harbor", "phone", "6175550134", "+1 617 555 0134"),
      ],
      policy: { tier: "auto", reasons: ["Formatting-only change to contact.phone — auto-merge eligible", "hygiene agent is trusted (score 0.91)"] },
    },
    {
      id: "pr_1", title: "Acme Platform rollout → Negotiation, $45,000", agent: "inbox", branchNo: 3, status: "open", age: 38 * MIN, forkSeq: 52,
      description: "Priya asked for the MSA and confirmed 45 seats at $45,000. Moving the deal to Negotiation and updating amount and next step.",
      readSet: { "deal:acme-platform::stage": 12, "deal:acme-platform::amount": 12, "deal:acme-platform::nextStep": 12 },
      ops: [
        { op: attach(D.email_priya_msa), reason: "Attach source email" },
        { op: set("deal:acme-platform", "stage", "negotiation", "discovery"), reason: "Customer requested the MSA", evidence: [{ docId: "email_priya_msa", quote: "Could you please send over the MSA so legal can start reviewing?", claim: "Priya asked for the MSA → stage Negotiation" }] },
        { op: set("deal:acme-platform", "amount", 45000, 20000), reason: "45 seats confirmed", evidence: [{ docId: "email_priya_msa", quote: "We'd like 45 seats, total $45,000", claim: "45 seats at $45,000 total → amount $45,000" }] },
        { op: set("deal:acme-platform", "nextStep", "Send MSA for 45 seats", "Intro call with Priya"), reason: "Follow-up from email", evidence: [{ docId: "email_priya_msa", quote: "send over the MSA", claim: "Next step is sending the MSA" }] },
      ],
      changes: [
        { kind: "evidence.added", docId: "email_priya_msa" },
        fc("deal:acme-platform", "stage", "discovery", "negotiation"),
        fc("deal:acme-platform", "amount", 20000, 45000),
        fc("deal:acme-platform", "nextStep", "Intro call with Priya", "Send MSA for 45 seats"),
      ],
      staleness: {
        status: "stale", changedReads: [],
        contradictions: [{ docId: "email_priya_pause", title: D.email_priya_pause.title, explanation: "Priya says Acme is pausing the rollout until Q1 due to a budget freeze — contradicts moving the deal to Negotiation at $45,000.", affectsEvents: ["evt_pr_1_2", "evt_pr_1_3"] }],
      },
      policy: { tier: "review", reasons: ["deal.amount change +$25,000 exceeds $10,000 threshold", "deal.stage change requires a human"], eventTiers: ["auto", "review", "review", "auto"] },
    },
    {
      id: "pr_2", title: "Priya Sharma's title → VP Engineering", agent: "inbox", branchNo: 4, status: "open", age: 31 * MIN, forkSeq: 52,
      description: "Email signature from p.sharma@acmerobotics.com lists her title as VP Engineering.",
      ops: [
        { op: attach(D.email_priya_sig) },
        { op: set("contact:priya-sharma", "title", "VP Engineering", ""), reason: "Title from signature", evidence: [{ docId: "email_priya_sig", quote: "Priya Sharma — VP Engineering", claim: "Signature lists title VP Engineering" }] },
      ],
      changes: [{ kind: "evidence.added", docId: "email_priya_sig" }, fc("contact:priya-sharma", "title", "", "VP Engineering")],
      conflicts: [{
        id: "cf_pr2_merged", kind: "merged-away", entity: "contact:priya-sharma", field: "title", base: "", theirs: "VP Engineering", theirsEvent: "evt_pr_2_2",
        autoResolved: { to: "contact:priya-acme", note: "Main merged Priya S. into Priya Sharma (pr_3) — change rebased onto the survivor." },
      }],
      policy: { tier: "review", reasons: ["Change was rebased onto a merge survivor — confirm the target", "inbox agent is on probation (score 0.58)"] },
    },
    {
      id: "pr_5", title: "Northwind Freight headcount → 220", agent: "webwatch", branchNo: 2, status: "open", age: 52 * MIN, forkSeq: 41,
      description: "Northwind's About page now reads \"220 employees across 6 hubs\".",
      readSet: { "company:northwind::employees": 41 },
      ops: [
        { op: attach(D.web_northwind_about) },
        { op: set("company:northwind", "employees", 220, 180), reason: "About page headcount", evidence: [{ docId: "web_northwind_about", quote: "220 employees across 6 hubs", claim: "About page says 220 employees" }] },
      ],
      changes: [{ kind: "evidence.added", docId: "web_northwind_about" }, fc("company:northwind", "employees", 180, 220)],
      conflicts: [{ id: "cf_pr5_emp", kind: "field", entity: "company:northwind", field: "employees", base: 180, ours: 250, theirs: 220, oursEvent: "evt_main_57", theirsEvent: "evt_pr_5_2" }],
      staleness: { status: "version-conflict", changedReads: [{ key: "company:northwind::employees", seenVersion: 41, currentVersion: 57 }], contradictions: [] },
      policy: { tier: "review", reasons: ["company.employees change > 20% (+22%)"] },
    },
    {
      id: "pr_7", title: "Add deal.procurementContact + backfill 3 deals", agent: "schema", branchNo: 1, status: "open", age: 22 * MIN, forkSeq: 55,
      description: "3 emails name a procurement contact but deals have nowhere to store it. Adds a `procurementContact` field to deals and backfills it from those emails.",
      ops: [
        { op: { type: "schema.addField", entityType: "deal", field: "procurementContact", fieldType: "string", description: "Who signs the PO on the customer side" }, reason: "Recurring info with no field" },
        { op: set("deal:acme-platform", "procurementContact", "Sam Lee <sam@acmerobotics.com>"), evidence: [{ docId: "email_procurement_acme", quote: "loop in our procurement contact, Sam Lee (sam@acmerobotics.com)", claim: "Acme procurement contact is Sam Lee" }] },
        { op: set("deal:northwind-fleet", "procurementContact", "Rita Gomez <rita@northwindfreight.com>"), evidence: [{ docId: "email_procurement_northwind", quote: "loop in our procurement contact, Rita Gomez (rita@northwindfreight.com)", claim: "Northwind procurement contact is Rita Gomez" }] },
        { op: set("deal:orbital-supply", "procurementContact", "Ken Ito <ken@orbitalfoods.com>"), evidence: [{ docId: "email_procurement_orbital", quote: "loop in our procurement contact, Ken Ito (ken@orbitalfoods.com)", claim: "Orbital procurement contact is Ken Ito" }] },
      ],
      changes: [
        { kind: "schema.changed", entityType: "deal", description: "Add field procurementContact (string) — Who signs the PO on the customer side" },
        fc("deal:acme-platform", "procurementContact", undefined, "Sam Lee <sam@acmerobotics.com>"),
        fc("deal:northwind-fleet", "procurementContact", undefined, "Rita Gomez <rita@northwindfreight.com>"),
        fc("deal:orbital-supply", "procurementContact", undefined, "Ken Ito <ken@orbitalfoods.com>"),
      ],
      policy: { tier: "review", reasons: ["schema.addField always requires a human", "Backfill writes 3 deals"], eventTiers: ["review", "auto", "auto", "auto"] },
    },
    {
      id: "pr_8", title: "Signals: Acme hiring data engineers, Brightline enterprise tier", agent: "webwatch", branchNo: 1, status: "merged", age: 5 * HOUR, forkSeq: 44,
      description: "Acme lists 3 Data Engineer roles; Brightline's pricing page added an Enterprise tier.",
      ops: [
        { op: set("company:acme", "signals", ["hiring:data-engineering"], []), evidence: [{ docId: "web_acme_careers", quote: "Senior Data Engineer (Remote) · Data Engineer, Streaming (SF) · Data Engineer, Platform (SF)", claim: "3 open data-engineering roles" }] },
        { op: set("company:brightline", "signals", ["pricing:enterprise-tier"], []), evidence: [{ docId: "web_brightline_pricing", quote: "Starter · Growth · Enterprise", claim: "New Enterprise pricing tier" }] },
      ],
      changes: [fc("company:acme", "signals", [], ["hiring:data-engineering"]), fc("company:brightline", "signals", [], ["pricing:enterprise-tier"])],
      policy: { tier: "auto", reasons: ["company.signals additions are low risk — auto"] },
      mergedBy: SYSTEM_MERGE, mergedAgo: 5 * HOUR - 2 * MIN,
    },
    {
      id: "pr_3", title: "Dedup: merge Priya S. into Priya Sharma", agent: "hygiene", branchNo: 1, status: "merged", age: 47 * MIN, forkSeq: 50,
      description: "Same first name, matching last initial and the same company domain (acmerobotics.com). Keeping Priya Sharma as the survivor.",
      ops: [{ op: { type: "entity.merge", from: "contact:priya-sharma", into: "contact:priya-acme" }, reason: "Name similarity 0.93 + same email domain" }],
      changes: [{ kind: "entity.merged", from: "contact:priya-sharma", into: "contact:priya-acme" }],
      policy: { tier: "auto", reasons: ["entity.merge with matching email domain — auto", "hygiene agent is trusted (score 0.91)"] },
      mergedBy: SYSTEM_MERGE, mergedAgo: 44 * MIN,
    },
    {
      id: "pr_4", title: "Northwind headcount → 250 after acquisition", agent: "inbox", branchNo: 2, status: "merged", age: 3 * HOUR, forkSeq: 41,
      description: "Dana says Northwind is now 250 people after the Bayline acquisition.",
      ops: [
        { op: attach(D.email_dana_acq) },
        { op: set("company:northwind", "employees", 250, 180), evidence: [{ docId: "email_dana_acq", quote: "we're now 250 people after the acquisition", claim: "Headcount is 250 post-acquisition" }] },
      ],
      changes: [{ kind: "evidence.added", docId: "email_dana_acq" }, fc("company:northwind", "employees", 180, 250)],
      policy: { tier: "review", reasons: ["company.employees change > 20% (+39%)"] },
      mergedBy: JOEL, mergedAgo: 2 * HOUR + 40 * MIN,
    },
    {
      id: "pr_6", title: "Dedup: merge Alex Chen into Alex Chen", agent: "hygiene", branchNo: 2, status: "reverted", age: 4 * HOUR, forkSeq: 43,
      description: "Exact name match \"Alex Chen\". Keeping the Kestrel Bank record as the survivor.",
      ops: [{ op: { type: "entity.merge", from: "contact:alex-chen-lumen", into: "contact:alex-chen-kestrel" }, reason: "Exact name match" }],
      changes: [{ kind: "entity.merged", from: "contact:alex-chen-lumen", into: "contact:alex-chen-kestrel" }],
      policy: { tier: "auto", reasons: ["entity.merge on exact name match — auto", "hygiene agent is trusted (score 0.91)"] },
      mergedBy: SYSTEM_MERGE, mergedAgo: 4 * HOUR - 1 * MIN, revertedBy: "pr_9",
    },
    {
      id: "pr_9", title: "Revert \"Dedup: merge Alex Chen into Alex Chen\"", agent: "joel", branchNo: "revert/pr_6", status: "merged", age: 12 * MIN, forkSeq: 58,
      description: "Different people: Kestrel's CISO and Lumen Grid's founder. Restores contact:alex-chen-lumen.",
      ops: [{ op: { type: "entity.create", entity: "contact:alex-chen-lumen", entityType: "contact", attrs: base["contact:alex-chen-lumen"].attrs }, reason: "Revert of pr_6" }],
      changes: [{ kind: "entity.added", entity: "contact:alex-chen-lumen", entityType: "contact", attrs: base["contact:alex-chen-lumen"].attrs }],
      policy: { tier: "auto", reasons: ["Revert by a human"] },
      mergedBy: JOEL, mergedAgo: 12 * MIN,
    },
    {
      id: "pr_10", title: "Orbital supply pilot close date → 2026-11-15", agent: "inbox", branchNo: 1, status: "closed", age: 26 * HOUR, forkSeq: 30,
      description: "Mei wants to close by November 15.",
      ops: [{ op: set("deal:orbital-supply", "closeDate", "2026-11-15", "2026-12-01"), evidence: [{ docId: "email_orbital_close", quote: "We'd like to close by November 15 if the pilot scope stays as is.", claim: "Target close date is Nov 15" }] }],
      changes: [fc("deal:orbital-supply", "closeDate", "2026-12-01", "2026-11-15")],
      policy: { tier: "review", reasons: ["deal.closeDate moved earlier by 16 days"] },
    },
  ];
}

interface World {
  prs: PullRequest[];
  details: Record<string, PRDetail>;
  main: CRMState;
}

function buildWorld(): World {
  const now = Date.now();
  const D = docs(now);
  const base = baseEntities();
  const baseState: CRMState = {
    schema: SCHEMA, entities: base, aliases: {}, evidence: { email_priya_msa: D.email_priya_msa, email_dana_acq: D.email_dana_acq }, provenance: {}, versions: {}, headSeq: 52,
  };
  const prs: PullRequest[] = [];
  const details: Record<string, PRDetail> = {};
  for (const s of specs(D, base)) {
    const author: Actor = s.agent === "joel" ? JOEL : agent(s.agent);
    const branchName = typeof s.branchNo === "string" ? s.branchNo : `agent/${s.agent}/${s.branchNo}`;
    const createdAt = now - s.age;
    const events: Event[] = s.ops.map((o, i) => ({
      id: `evt_${s.id}_${i + 1}`, branch: branchName, seq: i + 1, ts: createdAt - (s.ops.length - i) * 4000, actor: author, op: o.op, reason: o.reason, evidence: o.evidence,
    }));
    const perEvent: PolicyDecision["perEvent"] = {};
    events.forEach((e, i) => (perEvent[e.id] = { tier: s.policy.eventTiers?.[i] ?? s.policy.tier }));
    const pr: PullRequest = {
      id: s.id, title: s.title, description: s.description, branch: branchName, author, status: s.status, createdAt,
      updatedAt: s.mergedAgo ? now - s.mergedAgo : s.status === "closed" ? createdAt + 2 * HOUR : createdAt,
      mergedAt: s.mergedAgo ? now - s.mergedAgo : undefined, mergedBy: s.mergedBy,
      mergeEvents: s.mergedBy ? events.map((e) => `main_${e.id}`) : undefined, revertedBy: s.revertedBy,
      changes: s.changes, conflicts: s.conflicts ?? [],
      staleness: { checkedAt: now, status: "fresh", changedReads: [], contradictions: [], ...s.staleness },
      policy: { tier: s.policy.tier, reasons: s.policy.reasons, perEvent },
    };
    const branch: Branch = { name: branchName, parent: "main", forkSeq: s.forkSeq, headSeq: events.length, createdBy: author, createdAt, readSet: s.readSet };
    const docIds = new Set<string>();
    events.forEach((e) => {
      e.evidence?.forEach((r) => docIds.add(r.docId));
      if (e.op.type === "evidence.attach") docIds.add(e.op.doc.id);
    });
    pr.staleness?.contradictions.forEach((c) => docIds.add(c.docId));
    prs.push(pr);
    details[s.id] = { pr, branch, events, docs: [...docIds].map((id) => D[id]).filter(Boolean), baseState: { ...baseState, headSeq: s.forkSeq } };
  }
  const main: CRMState = { ...baseState, evidence: D, headSeq: 61 };
  return { prs, details, main };
}

let world: World | null = null;
const w = () => (world ??= buildWorld());
let nextId = 100;
const delay = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 120));
const fail = (status: number, msg: string) => Promise.reject(new Error(`mock -> ${status}: ${JSON.stringify({ error: msg })}`));

function touch(pr: PullRequest) {
  pr.updatedAt = Date.now();
  const d = w().details[pr.id];
  if (d) d.pr = pr;
}

export const mockApi = {
  prs: (status?: PullRequest["status"]) => delay({ prs: w().prs.filter((p) => !status || p.status === status) }),
  pr: (id: string) => {
    const d = w().details[id];
    return d ? delay(d) : fail(404, `no such PR ${id}`);
  },
  state: () => delay({ state: w().main }),
  merge: (id: string, by: string, resolutions?: Record<string, unknown>) => {
    const pr = w().prs.find((p) => p.id === id);
    if (!pr) return fail(404, `no such PR ${id}`);
    if (pr.status !== "open") return fail(409, `PR is ${pr.status}`);
    if (pr.policy?.tier === "block") return fail(409, "blocked by policy");
    const open = (pr.conflicts || []).filter((c) => !c.autoResolved && !c.resolution && !(resolutions && c.id in resolutions));
    if (open.length) return fail(409, `${open.length} unresolved conflict(s)`);
    pr.conflicts = (pr.conflicts || []).map((c) => (resolutions?.[c.id] ? { ...c, resolution: resolutions[c.id] as Conflict["resolution"] } : c));
    pr.status = "merged";
    pr.mergedAt = Date.now();
    pr.mergedBy = { kind: "human", id: by.toLowerCase(), name: by };
    touch(pr);
    return delay({ pr, events: [] as Event[] });
  },
  close: (id: string, by: string) => {
    const pr = w().prs.find((p) => p.id === id);
    if (!pr) return fail(404, `no such PR ${id}`);
    if (pr.status !== "open") return fail(409, `PR is ${pr.status}`);
    pr.status = "closed";
    void by;
    touch(pr);
    return delay({ pr });
  },
  revert: (id: string, by: string) => {
    const pr = w().prs.find((p) => p.id === id);
    if (!pr) return fail(404, `no such PR ${id}`);
    if (pr.status !== "merged") return fail(409, `can only revert merged PRs (is ${pr.status})`);
    const rid = `pr_${nextId++}`;
    const actor: Actor = { kind: "human", id: by.toLowerCase(), name: by };
    const revertPr: PullRequest = {
      id: rid, title: `Revert "${pr.title}"`, description: `Reverts ${pr.id}.`, branch: `revert/${pr.id}`, author: actor, status: "merged",
      createdAt: Date.now(), updatedAt: Date.now(), mergedAt: Date.now(), mergedBy: actor, changes: [], conflicts: [],
      policy: { tier: "auto", reasons: ["Revert by a human"], perEvent: {} }, staleness: { status: "fresh", checkedAt: Date.now(), changedReads: [], contradictions: [] },
    };
    pr.status = "reverted";
    pr.revertedBy = rid;
    touch(pr);
    w().prs.unshift(revertPr);
    const src = w().details[pr.id];
    w().details[rid] = { ...src, pr: revertPr, events: [], branch: { ...src.branch, name: revertPr.branch, createdBy: actor, readSet: undefined } };
    return delay({ revertPr, events: [] as Event[] });
  },
  refresh: (id: string) => {
    const pr = w().prs.find((p) => p.id === id);
    return pr ? delay({ pr }) : fail(404, `no such PR ${id}`);
  },
};

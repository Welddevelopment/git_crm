/**
 * MAINLINE — SHARED CONTRACT. DO NOT EDIT unless you are the lead.
 * Need a change? Write it in CONTRACT_REQUESTS.md and build a local extension type meanwhile.
 *
 * Mental model: git for CRM data.
 *  - Every change is an immutable Event appended to a Branch's log.
 *  - `main` is the source of truth. Agents only write to their own branches.
 *  - State(branch) = fold(main events up to branch.forkSeq) + fold(branch events).
 *  - A PullRequest proposes merging a branch into main. Merge = three-way merge
 *    (base = main@forkSeq, ours = main@head, theirs = branch head).
 *  - Schema is data too: schema ops live in the same log, so they branch/merge/revert.
 */

// ---------- ids ----------
export type EntityId = string; // e.g. "company:acme", "contact:priya-acme", "deal:acme-platform"
export type EventId = string; // globally unique, e.g. "evt_<ulid>"
export type BranchName = string; // "main" | "agent/inbox/1730334000" | ...
export type PRId = string; // "pr_<n>"
export type AgentId = "inbox" | "hygiene" | "schema" | "webwatch" | (string & {});
export type EntityType = "company" | "contact" | "deal" | (string & {});
export type FieldValue = string | number | boolean | null | string[];

export type Actor =
  | { kind: "human"; id: string; name?: string }
  | { kind: "agent"; id: AgentId; name?: string }
  | { kind: "system"; id: "merge" | "revert" | "seed" | (string & {}) };

// ---------- evidence ----------
/** A source document an agent relied on. Emails, web snapshots, notes. */
export interface EvidenceDoc {
  id: string; // "email_12", "web_acme_careers_2026-10-30"
  kind: "email" | "web" | "note" | "call";
  ts: number; // epoch ms when the doc was created/observed
  title: string; // subject line / page title
  from?: string;
  to?: string[];
  url?: string;
  body: string;
  entities?: EntityId[]; // entities this doc is about (best effort)
}

/** A pointer from a change to the evidence that justifies it. */
export interface EvidenceRef {
  docId: string;
  quote?: string; // short excerpt (<25 words) that supports the change
  claim: string; // what the agent concluded, e.g. "Acme asked for an MSA → Negotiation"
}

// ---------- operations ----------
export type Op =
  | { type: "entity.create"; entity: EntityId; entityType: EntityType; attrs: Record<string, FieldValue> }
  | { type: "field.set"; entity: EntityId; field: string; value: FieldValue; prev?: FieldValue }
  | { type: "entity.delete"; entity: EntityId }
  /** Dedup: `from` is absorbed into `into`. Afterwards references to `from` resolve to `into`. */
  | { type: "entity.merge"; from: EntityId; into: EntityId; fieldChoices?: Record<string, FieldValue> }
  /** Schema-as-data. */
  | { type: "schema.addField"; entityType: EntityType; field: string; fieldType: FieldType; description?: string }
  | { type: "schema.renameField"; entityType: EntityType; from: string; to: string }
  | { type: "schema.removeField"; entityType: EntityType; field: string }
  /** Attach a document to the CRM (makes evidence visible on main; also drives staleness). */
  | { type: "evidence.attach"; doc: EvidenceDoc };

export type FieldType = "string" | "number" | "boolean" | "date" | "enum" | "string[]" | "ref";

export interface Event {
  id: EventId;
  branch: BranchName;
  seq: number; // position in its branch log, 1-based, contiguous
  ts: number; // wall clock (epoch ms) — used for time travel
  actor: Actor;
  op: Op;
  reason?: string; // human-readable why
  evidence?: EvidenceRef[];
  /** For events written by merge/revert: which events they came from. */
  origin?: { kind: "merge"; pr: PRId; sourceEvent: EventId } | { kind: "revert"; revertOf: EventId; pr?: PRId };
}

/** Event as submitted by a writer; the store assigns id/seq/ts/branch. */
export type NewEvent = Pick<Event, "actor" | "op" | "reason" | "evidence" | "origin"> & { ts?: number };

// ---------- state ----------
export interface FieldDef {
  field: string;
  fieldType: FieldType;
  description?: string;
}
export type Schema = Record<string, FieldDef[]>; // keyed by EntityType

export interface EntityRecord {
  id: EntityId;
  type: EntityType;
  attrs: Record<string, FieldValue>;
  deleted?: boolean;
  /** If this entity was merged into another, the survivor's id. */
  mergedInto?: EntityId;
}

/** Last writer of each field: powers `blame`. */
export interface FieldProvenance {
  eventId: EventId;
  actor: Actor;
  ts: number;
  seq: number; // seq in main (or branch) where it was set
  branch: BranchName;
  reason?: string;
  evidence?: EvidenceRef[];
}

export interface CRMState {
  schema: Schema;
  entities: Record<EntityId, EntityRecord>;
  /** alias map from merged-away ids to survivors (transitively resolved) */
  aliases: Record<EntityId, EntityId>;
  evidence: Record<string, EvidenceDoc>;
  provenance: Record<EntityId, Record<string, FieldProvenance>>;
  /** monotonic version per (entity, field) = main seq of last write. "entity::field" -> seq */
  versions: Record<string, number>;
  headSeq: number;
}

// ---------- diff ----------
export type Change =
  | { kind: "entity.added"; entity: EntityId; entityType: EntityType; attrs: Record<string, FieldValue> }
  | { kind: "entity.removed"; entity: EntityId }
  | { kind: "entity.merged"; from: EntityId; into: EntityId }
  | { kind: "field.changed"; entity: EntityId; field: string; before: FieldValue | undefined; after: FieldValue | undefined }
  | { kind: "schema.changed"; entityType: EntityType; description: string }
  | { kind: "evidence.added"; docId: string };

// ---------- branches & PRs ----------
export interface Branch {
  name: BranchName;
  parent: BranchName; // always "main" for now
  forkSeq: number; // main seq at fork time (base of 3-way merge)
  headSeq: number; // number of events on this branch
  createdBy: Actor;
  createdAt: number;
  /** Fields the agent read while working: "entity::field" -> main version it saw. Drives version-conflict detection. */
  readSet?: Record<string, number>;
}

export type PRStatus = "open" | "merged" | "closed" | "reverted";

export interface Conflict {
  id: string;
  kind:
    | "field" // both sides changed the same field to different values
    | "deleted" // theirs edits an entity that ours deleted
    | "merged-away" // theirs edits an entity that ours merged into another (auto-rebased if resolvable)
    | "schema"; // theirs writes a field the schema no longer has
  entity?: EntityId;
  field?: string;
  base?: FieldValue;
  ours?: FieldValue; // main
  theirs?: FieldValue; // branch
  oursEvent?: EventId;
  theirsEvent?: EventId;
  autoResolved?: { to: EntityId; note: string }; // e.g. rebased onto merge survivor
  resolution?: "ours" | "theirs" | { value: FieldValue };
}

export type StalenessStatus = "fresh" | "version-conflict" | "stale";
export interface StalenessReport {
  status: StalenessStatus;
  checkedAt: number;
  /** read-set fields that changed on main since the agent read them */
  changedReads: { key: string; seenVersion: number; currentVersion: number }[];
  /** evidence on main newer than the PR that contradicts its reasoning */
  contradictions: { docId: string; title: string; explanation: string; affectsEvents: EventId[] }[];
}

export type RiskTier = "auto" | "review" | "block";
export interface PolicyDecision {
  tier: RiskTier;
  reasons: string[]; // e.g. "deal.amount change +$25k > $10k threshold"
  /** per-event tiers */
  perEvent: Record<EventId, { tier: RiskTier; rule?: string }>;
}

export interface PullRequest {
  id: PRId;
  title: string;
  description: string;
  branch: BranchName;
  author: Actor;
  status: PRStatus;
  createdAt: number;
  updatedAt: number;
  mergedAt?: number;
  mergedBy?: Actor;
  /** main events produced by merging (for revert) */
  mergeEvents?: EventId[];
  revertedBy?: PRId;
  /** cached analysis, recomputed by the service */
  changes?: Change[];
  conflicts?: Conflict[];
  staleness?: StalenessReport;
  policy?: PolicyDecision;
}

// ---------- policy & trust ----------
export interface PolicyRule {
  id: string;
  description: string; // "Deal amount changes over $10k need a human"
  match: {
    entityType?: EntityType;
    field?: string; // exact or "*"
    opType?: Op["type"];
    agent?: AgentId;
  };
  /** Optional numeric guard: applies when |after - before| > threshold */
  absDeltaGt?: number;
  tier: RiskTier;
}

export interface AgentTrust {
  agent: AgentId;
  prsOpened: number;
  prsMerged: number;
  prsReverted: number;
  prsClosed: number;
  staleCount: number;
  score: number; // 0..1
  level: "probation" | "trusted" | "autonomous";
}

// ---------- agents ----------
export interface AgentProposal {
  title: string;
  description: string;
  events: NewEvent[];
  readSet?: Record<string, number>;
}

export interface AgentContext {
  agent: AgentId;
  /** state of main at the moment the agent started (what it "reads") */
  state: CRMState;
  /** documents the agent may look at (inbox, web snapshots) */
  docs: EvidenceDoc[];
  /** call the LLM; returns null if no API key → agents MUST fall back to deterministic logic */
  llm: (args: { system: string; prompt: string; maxTokens?: number }) => Promise<string | null>;
  now: () => number;
  log: (msg: string) => void;
}

export interface CRMAgent {
  id: AgentId;
  name: string;
  description: string;
  /** Return zero or more proposals. Each proposal becomes its own branch + PR. */
  run(ctx: AgentContext): Promise<AgentProposal[]>;
}

// ---------- adapters (the "layer in front of your CRM" story) ----------
/** Where merged main changes get pushed. Built-in CRM = no-op; HubSpot adapter = stretch. */
export interface TargetAdapter {
  id: "builtin" | "hubspot" | (string & {});
  name: string;
  push(events: Event[], state: CRMState): Promise<{ ok: boolean; pushed: number; errors?: string[] }>;
}

/** Notifier for high-risk PRs (iMessage via Photon is the stretch). */
export interface Notifier {
  id: string;
  notify(pr: PullRequest, summary: string): Promise<void>;
}

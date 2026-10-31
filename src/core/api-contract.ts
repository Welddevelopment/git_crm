/**
 * MAINLINE CONTRACT — HTTP API between the Next.js server (W6) and the UI (W9, W10).
 * Lead-owned. All routes are JSON. Base path: /api
 * UI should import `api` from src/client/api.ts (lead-provided fetch wrappers), never hand-roll fetch.
 */
import type {
  AgentId, AgentTrust, Branch, CRMState, Change, EntityId, Event, EvidenceDoc, FieldProvenance, PolicyRule, PRId, PullRequest,
} from "./types";

export interface PRDetail {
  pr: PullRequest; // includes changes/conflicts/staleness/policy (fresh)
  branch: Branch;
  events: Event[]; // branch events
  docs: EvidenceDoc[]; // evidence docs referenced by the events
  baseState: CRMState; // main @ forkSeq (for showing "before")
}

export interface FleetStatus {
  agents: { id: AgentId; name: string; description: string; running: boolean; lastRunAt?: number; trust: AgentTrust }[];
}

export interface TimelineEntry {
  seq: number;
  ts: number;
  event: Event;
  pr?: PRId; // PR that produced it (if via merge)
}

export interface ApiRoutes {
  // GET /api/state?at=<epochMs>&branch=<name>   -> state of main (optionally at time) or of a branch head
  "GET /api/state": { query: { at?: number; branch?: string }; res: { state: CRMState } };
  // GET /api/timeline -> main log (newest last)
  "GET /api/timeline": { query: {}; res: { entries: TimelineEntry[] } };
  // GET /api/blame?entity=&field=
  "GET /api/blame": { query: { entity: EntityId; field: string }; res: { history: FieldProvenance[] } };

  "GET /api/prs": { query: { status?: PullRequest["status"] }; res: { prs: PullRequest[] } };
  "GET /api/prs/:id": { query: {}; res: PRDetail };
  // merge: optional per-conflict resolutions. Fails 409 if unresolved conflicts or policy=block.
  "POST /api/prs/:id/merge": {
    body: { by: string; resolutions?: Record<string, "ours" | "theirs" | { value: unknown }> };
    res: { pr: PullRequest; events: Event[] };
  };
  "POST /api/prs/:id/close": { body: { by: string; reason?: string }; res: { pr: PullRequest } };
  "POST /api/prs/:id/revert": { body: { by: string }; res: { revertPr: PullRequest; events: Event[] } };
  // recompute staleness/conflicts/policy for one or all open PRs
  "POST /api/prs/:id/refresh": { body: {}; res: { pr: PullRequest } };

  "GET /api/fleet": { query: {}; res: FleetStatus };
  // run one agent or all; mode "governed" = branches+PRs (default), "chaos" = agents write straight to main (the 'before' demo)
  "POST /api/fleet/run": { body: { agents?: AgentId[]; mode?: "governed" | "chaos" }; res: { prs: PullRequest[]; directEvents: number } };

  "GET /api/policy": { query: {}; res: { rules: PolicyRule[] } };
  "PUT /api/policy": { body: { rules: PolicyRule[] }; res: { rules: PolicyRule[] } };

  // demo controls
  "POST /api/demo/reset": { body: { scenario?: string }; res: { ok: true } };
  // inject a new document into the world (e.g. the "Acme is pausing" email) to trigger staleness live
  "POST /api/demo/inject": { body: { docId: string }; res: { ok: true; affectedPRs: PRId[] } };

  // server-sent events: emits {kind, key} whenever anything changes. UI refetches on message.
  "GET /api/stream": { query: {}; res: "text/event-stream" };
}

export type { Change };

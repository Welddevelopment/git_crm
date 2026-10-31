/** MAINLINE CONTRACT — persistence interface. Lead-owned. Implementations live beside it (memory.ts, file.ts, convex/). */
import type { Branch, BranchName, Event, EvidenceDoc, NewEvent, PRId, PullRequest } from "../core/types";

export interface Store {
  // events
  append(branch: BranchName, events: NewEvent[]): Promise<Event[]>; // assigns id/seq/ts; atomic per call
  events(branch: BranchName, opts?: { fromSeq?: number; toSeq?: number }): Promise<Event[]>; // ordered by seq
  getEvent(id: string): Promise<Event | undefined>;

  // branches
  createBranch(b: Omit<Branch, "headSeq">): Promise<Branch>;
  getBranch(name: BranchName): Promise<Branch | undefined>;
  listBranches(): Promise<Branch[]>;
  updateBranch(name: BranchName, patch: Partial<Branch>): Promise<Branch>;

  // pull requests
  createPR(pr: Omit<PullRequest, "id">): Promise<PullRequest>;
  getPR(id: PRId): Promise<PullRequest | undefined>;
  listPRs(filter?: { status?: PullRequest["status"] }): Promise<PullRequest[]>; // newest first
  updatePR(id: PRId, patch: Partial<PullRequest>): Promise<PullRequest>;

  // source documents (inbox, web snapshots) — the raw world agents read
  putDocs(docs: EvidenceDoc[]): Promise<void>;
  listDocs(filter?: { kind?: EvidenceDoc["kind"]; sinceTs?: number }): Promise<EvidenceDoc[]>;

  // realtime: called on every mutation; returns unsubscribe
  subscribe(fn: (change: { kind: "events" | "branch" | "pr" | "docs"; key?: string }) => void): () => void;

  reset(): Promise<void>; // wipe everything (demo reset)
}

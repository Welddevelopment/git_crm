/** OWNER: graph worker. Wire format of GET /api/graph (shared by the route and the BranchGraph component). */
import type { PRStatus, RiskTier } from "@/core/types";

export type MainNodeKind = "seed" | "system" | "human" | "merge" | "revert" | "direct";

/** A "commit" on main: consecutive main events from the same merge / actor / second, collapsed. */
export interface GraphMainNode {
  seq: number; // last main seq in this commit
  firstSeq: number;
  ts: number;
  actorKind: "human" | "agent" | "system";
  actorId: string;
  actorName?: string;
  label: string;
  pr?: string; // PR whose merge produced it
  count: number; // events collapsed into this node
  kind: MainNodeKind;
}

export interface GraphBranch {
  name: string;
  pr: string;
  title: string;
  author: string; // agent id (or actor id)
  authorKind: "human" | "agent" | "system";
  forkSeq: number;
  forkTs: number;
  status: PRStatus;
  createdAt: number;
  updatedAt: number;
  mergedAt?: number;
  mergeSeq?: number; // main seq of its first merge event
  mergedBy?: string;
  tier?: RiskTier;
  reasons: number;
  stale: boolean;
  versionConflict: boolean;
  conflicts: number; // unresolved
  events: number; // events on the branch
  revertedBy?: string;
  revertSeq?: number; // main seq where the revert landed
}

export interface GraphData {
  main: GraphMainNode[];
  branches: GraphBranch[];
  headSeq: number;
  now: number;
}

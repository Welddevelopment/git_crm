/**
 * OWNER: W6 (repo service). This is THE application service every caller uses (API routes, agent runtime, scripts).
 * Method signatures are contract; bodies are yours. Compose: store + engine/state + engine/merge + staleness + policy.
 */
import type { Store } from "../store/store";
import type {
  Actor, AgentId, AgentProposal, AgentTrust, Branch, BranchName, CRMState, Event, EvidenceDoc, FieldProvenance,
  NewEvent, PolicyRule, PRId, PullRequest, Conflict, TargetAdapter, Notifier,
} from "../core/types";
import type { PRDetail, TimelineEntry } from "../core/api-contract";
const TODO = (n: string): never => { throw new Error(`NOT_IMPLEMENTED: repo.${n} (W6)`); };

export interface RepoDeps { store: Store; adapters?: TargetAdapter[]; notifiers?: Notifier[]; rules?: PolicyRule[] }

export class Repo {
  constructor(public deps: RepoDeps) {}
  // reads
  async mainEvents(): Promise<Event[]> { return TODO("mainEvents"); }
  async state(opts?: { at?: number; branch?: BranchName }): Promise<CRMState> { return TODO("state"); }
  async timeline(): Promise<TimelineEntry[]> { return TODO("timeline"); }
  async blame(entity: string, field: string): Promise<FieldProvenance[]> { return TODO("blame"); }
  // writes to main by humans/system (seed, chaos mode, manual edits)
  async commitToMain(events: NewEvent[]): Promise<Event[]> { return TODO("commitToMain"); }
  // branch + PR lifecycle
  async createBranch(name: BranchName, by: Actor, readSet?: Record<string, number>): Promise<Branch> { return TODO("createBranch"); }
  async commit(branch: BranchName, events: NewEvent[]): Promise<Event[]> { return TODO("commit"); }
  /** Convenience used by agent runtime: branch + commit + open PR + analyze, in one call. */
  async propose(agent: AgentId, proposal: AgentProposal): Promise<PullRequest> { return TODO("propose"); }
  async openPR(branch: BranchName, title: string, description: string, author: Actor): Promise<PullRequest> { return TODO("openPR"); }
  /** Recompute changes/conflicts/staleness/policy and persist on the PR. Also fire notifiers if tier=review and newly opened. */
  async analyze(id: PRId): Promise<PullRequest> { return TODO("analyze"); }
  async refreshOpenPRs(): Promise<PullRequest[]> { return TODO("refreshOpenPRs"); }
  async prDetail(id: PRId): Promise<PRDetail> { return TODO("prDetail"); }
  async listPRs(status?: PullRequest["status"]): Promise<PullRequest[]> { return TODO("listPRs"); }
  async merge(id: PRId, by: Actor, resolutions?: Record<string, Conflict["resolution"]>): Promise<{ pr: PullRequest; events: Event[] }> { return TODO("merge"); }
  async close(id: PRId, by: Actor, reason?: string): Promise<PullRequest> { return TODO("close"); }
  /** Creates a revert PR that is merged immediately; original PR status -> "reverted". */
  async revert(id: PRId, by: Actor): Promise<{ revertPr: PullRequest; events: Event[] }> { return TODO("revert"); }
  /** Auto-merge PRs whose policy tier is "auto" and which have no conflicts/staleness. */
  async autoMerge(): Promise<PullRequest[]> { return TODO("autoMerge"); }
  // policy & trust
  async rules(): Promise<PolicyRule[]> { return TODO("rules"); }
  async setRules(rules: PolicyRule[]): Promise<PolicyRule[]> { return TODO("setRules"); }
  async trust(agent: AgentId): Promise<AgentTrust> { return TODO("trust"); }
  // world documents
  async addDocs(docs: EvidenceDoc[], alsoAttachToMain?: boolean): Promise<void> { return TODO("addDocs"); }
}

/** Process-wide singleton used by API routes. W6 wires store choice (memory/file) + seed on first use. */
export function getRepo(): Promise<Repo> { return TODO("getRepo"); }

/**
 * OWNER: W6 (repo service). This is THE application service every caller uses (API routes, agent runtime, scripts).
 * Method signatures are contract; bodies are yours. Compose: store + engine/state + engine/merge + staleness + policy.
 */
import type { Store } from "../store/store";
import type {
  Actor, AgentId, AgentProposal, AgentTrust, Branch, BranchName, CRMState, Event, EvidenceDoc, FieldProvenance,
  NewEvent, PolicyRule, PRId, PullRequest, Conflict, TargetAdapter, Notifier, Change, StalenessReport, PolicyDecision,
} from "../core/types";
import type { PRDetail, TimelineEntry } from "../core/api-contract";
import { blame as blameOf, branchState, diffStates, fold, stateAt } from "../core/engine/state";
import { previewMerge, revertEvents, threeWayMerge, type MergeResult } from "../core/engine/merge";
import { restoreOps } from "../core/engine/restore";
import { checkStaleness, heuristicJudge, llmJudge, type Judge } from "../core/staleness";
import { DEFAULT_RULES, computeTrust, evaluatePolicy } from "../core/policy";
import { MemoryStore } from "../store/memory";
import { FileStore } from "../store/file";
import { injectableDocs, seedInbox, seedMainEvents, seedWeb } from "../seed";
import { getNotifiers } from "../notify";
import { getAdapters } from "../adapters";

/** Error carrying an HTTP status; API routes turn it into `{error}` JSON with that status. */
export class RepoError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
    this.name = "RepoError";
  }
}
const notFound = (what: string) => new RepoError(404, `${what} not found`);
const conflict = (msg: string, details?: unknown) => new RepoError(409, msg, details);

const SYSTEM_MERGE: Actor = { kind: "system", id: "merge" };
const SYSTEM_REVERT: Actor = { kind: "system", id: "revert" };
const SYSTEM_SEED: Actor = { kind: "system", id: "seed" };

const actorLabel = (a: Actor) => ("name" in a && a.name) || (a.kind === "human" ? a.id : `${a.kind}:${a.id}`);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const warn = (where: string, e: unknown) => console.warn(`[mainline] ${where}: ${errMsg(e)}`);

/** A conflict is unresolved if neither the engine auto-resolved it nor the caller picked a resolution. */
export const isUnresolved = (c: Conflict) => !c.autoResolved && c.resolution === undefined;

export interface RepoDeps { store: Store; adapters?: TargetAdapter[]; notifiers?: Notifier[]; rules?: PolicyRule[] }

export class Repo {
  private _rules: PolicyRule[];
  private rulesVersion = 0;
  /** prId -> cache key of the inputs its stored analysis was computed from */
  private analysisKey = new Map<PRId, string>();
  /** serializes writes to main that depend on a read of main (merge / revert / autoMerge) */
  private chain: Promise<unknown> = Promise.resolve();
  private judge?: Judge;

  constructor(public deps: RepoDeps) {
    this._rules = structuredClone(deps.rules ?? DEFAULT_RULES);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ---------- helpers ----------
  private get store() { return this.deps.store; }
  private async mustPR(id: PRId): Promise<PullRequest> {
    const pr = await this.store.getPR(id);
    if (!pr) throw notFound(`PR ${id}`);
    return pr;
  }
  private async mustBranch(name: BranchName): Promise<Branch> {
    const b = await this.store.getBranch(name);
    if (!b) throw notFound(`branch ${name}`);
    return b;
  }
  private async mainHead(): Promise<number> {
    const b = await this.store.getBranch("main");
    if (b) return b.headSeq;
    const evs = await this.store.events("main");
    return evs.length ? evs[evs.length - 1]!.seq : 0;
  }
  private async getJudge(): Promise<Judge> {
    if (this.judge) return this.judge;
    let judge: Judge = heuristicJudge;
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const rt = await import("../agents/runtime");
        const llm = llmJudge(rt.makeLLM());
        judge = async (args) => {
          try {
            return await llm(args);
          } catch (e) {
            warn("llm judge failed, using heuristic", e);
            return heuristicJudge(args);
          }
        };
      } catch (e) {
        warn("llm judge unavailable", e);
      }
    }
    // Verdicts depend only on (claims, doc): memoize so PR refreshes don't re-ask the LLM.
    const memo = new Map<string, ReturnType<Judge>>();
    const cached: Judge = (args) => {
      const k = JSON.stringify([args.newDoc.id, args.newDoc.ts, args.claims.map((c) => [c.eventId, c.claim])]);
      let v = memo.get(k);
      if (!v) {
        v = judge(args);
        memo.set(k, v);
        v.catch(() => memo.delete(k));
      }
      return v;
    };
    return (this.judge = cached);
  }

  // ---------- reads ----------
  async mainEvents(): Promise<Event[]> {
    return this.store.events("main");
  }

  async state(opts?: { at?: number; branch?: BranchName }): Promise<CRMState> {
    const main = await this.mainEvents();
    if (opts?.branch && opts.branch !== "main") {
      const b = await this.mustBranch(opts.branch);
      return branchState(main, b, await this.store.events(b.name));
    }
    if (opts?.at !== undefined && Number.isFinite(opts.at)) return stateAt(main, opts.at);
    return fold(main);
  }

  async timeline(): Promise<TimelineEntry[]> {
    const main = await this.mainEvents();
    return main.map((event) => {
      const o = event.origin;
      const pr = o?.kind === "merge" ? o.pr : o?.kind === "revert" ? o.pr : undefined;
      const entry: TimelineEntry = { seq: event.seq, ts: event.ts, event };
      if (pr) entry.pr = pr;
      return entry;
    });
  }

  async blame(entity: string, field: string): Promise<FieldProvenance[]> {
    return blameOf(await this.mainEvents(), entity, field);
  }

  // ---------- writes to main ----------
  async commitToMain(events: NewEvent[]): Promise<Event[]> {
    if (!events.length) return [];
    if (!(await this.store.getBranch("main"))) {
      try {
        await this.store.createBranch({ name: "main", parent: "main", forkSeq: 0, createdBy: SYSTEM_SEED, createdAt: Date.now() });
      } catch { /* created concurrently */ }
    }
    return this.store.append("main", events);
  }

  // ---------- branch + PR lifecycle ----------
  async createBranch(name: BranchName, by: Actor, readSet?: Record<string, number>): Promise<Branch> {
    const b: Omit<Branch, "headSeq"> = { name, parent: "main", forkSeq: await this.mainHead(), createdBy: by, createdAt: Date.now() };
    if (readSet) b.readSet = readSet;
    return this.store.createBranch(b);
  }

  async commit(branch: BranchName, events: NewEvent[]): Promise<Event[]> {
    if (branch === "main") return this.commitToMain(events);
    await this.mustBranch(branch);
    return this.store.append(branch, events);
  }

  /** Create a branch with a unique `${prefix}${n}` name (retries on collisions from concurrent callers). */
  private async createUniqueBranch(prefix: string, by: Actor, readSet?: Record<string, number>): Promise<Branch> {
    const existing = (await this.store.listBranches()).filter((b) => b.name.startsWith(prefix)).length;
    for (let n = existing + 1; n < existing + 1000; n++) {
      try {
        return await this.createBranch(`${prefix}${n}`, by, readSet);
      } catch (e) {
        if (!/exists/i.test(errMsg(e))) throw e;
      }
    }
    throw new Error(`could not allocate branch name for ${prefix}`);
  }

  async propose(agent: AgentId, proposal: AgentProposal): Promise<PullRequest> {
    const author: Actor = { kind: "agent", id: agent };
    const branch = await this.createUniqueBranch(`agent/${agent}/`, author, proposal.readSet);
    const events = proposal.events.map((e) => ({ ...e, actor: e.actor ?? author }));
    await this.commit(branch.name, events);
    const pr = await this.openPR(branch.name, proposal.title, proposal.description, author);
    return this.analyze(pr.id);
  }

  async openPR(branch: BranchName, title: string, description: string, author: Actor): Promise<PullRequest> {
    await this.mustBranch(branch);
    const now = Date.now();
    return this.store.createPR({ title, description, branch, author, status: "open", createdAt: now, updatedAt: now });
  }

  private async cacheKey(pr: PullRequest): Promise<string> {
    const b = await this.store.getBranch(pr.branch);
    return `${await this.mainHead()}:${b?.headSeq ?? 0}:${this.rulesVersion}`;
  }

  async analyze(id: PRId): Promise<PullRequest> {
    const pr = await this.mustPR(id);
    if (pr.status !== "open") return pr;
    const key = await this.cacheKey(pr);
    const firstTime = !pr.policy;
    const branch = await this.mustBranch(pr.branch);
    const [mainEvents, branchEvents, allPRs] = await Promise.all([
      this.mainEvents(), this.store.events(branch.name), this.store.listPRs(),
    ]);
    const mainState = fold(mainEvents);
    const baseState = fold(mainEvents.filter((e) => e.seq <= branch.forkSeq));

    let changes: Change[] | undefined = pr.changes;
    let conflicts: Conflict[] | undefined = pr.conflicts;
    try {
      const m = previewMerge({ mainEvents, branch, branchEvents, pr: pr.id });
      changes = m.changes;
      conflicts = m.conflicts;
    } catch (e) {
      warn(`previewMerge ${id}`, e);
      try { changes = diffStates(baseState, branchState(mainEvents, branch, branchEvents)); } catch { /* keep */ }
    }

    let staleness: StalenessReport | undefined = pr.staleness;
    try {
      staleness = await checkStaleness({ pr, branch, branchEvents, mainEvents, mainState, judge: await this.getJudge() });
    } catch (e) {
      warn(`checkStaleness ${id}`, e);
    }

    let policy: PolicyDecision | undefined = pr.policy;
    try {
      const trust = pr.author.kind === "agent" ? computeTrust(pr.author.id, allPRs) : undefined;
      policy = evaluatePolicy({ branchEvents, baseState, rules: this._rules, trust });
    } catch (e) {
      warn(`evaluatePolicy ${id}`, e);
    }

    const patch: Partial<PullRequest> = { updatedAt: Date.now() };
    if (changes) patch.changes = changes;
    if (conflicts) patch.conflicts = conflicts;
    if (staleness) patch.staleness = staleness;
    if (policy) patch.policy = policy;
    const updated = await this.store.updatePR(id, patch);
    this.analysisKey.set(id, key);

    if (firstTime && policy && policy.tier !== "auto" && pr.author.kind !== "system") void this.notify(updated);
    return updated;
  }

  /** Analyze only if inputs (main head, branch head, rules) changed since the last analysis. */
  private async ensureAnalyzed(id: PRId): Promise<PullRequest> {
    const pr = await this.mustPR(id);
    if (pr.status !== "open") return pr;
    if (pr.policy && this.analysisKey.get(id) === (await this.cacheKey(pr))) return pr;
    return this.analyze(id);
  }

  private async notify(pr: PullRequest): Promise<void> {
    const notifiers = this.deps.notifiers ?? [];
    if (!notifiers.length) return;
    const p = pr.policy;
    const summary = `[${p?.tier ?? "review"}] ${pr.title}${p?.reasons?.length ? ` — ${p.reasons.join("; ")}` : ""}`;
    await Promise.all(notifiers.map(async (n) => {
      try { await n.notify(pr, summary); } catch (e) { warn(`notifier ${n.id}`, e); }
    }));
  }

  async refreshOpenPRs(): Promise<PullRequest[]> {
    const open = await this.store.listPRs({ status: "open" });
    const out: PullRequest[] = [];
    for (const pr of open) {
      try { out.push(await this.analyze(pr.id)); } catch (e) { warn(`refresh ${pr.id}`, e); }
    }
    return out;
  }

  async prDetail(id: PRId): Promise<PRDetail> {
    const pr = await this.ensureAnalyzed(id);
    const branch = await this.mustBranch(pr.branch);
    const [mainEvents, events, docs] = await Promise.all([this.mainEvents(), this.store.events(branch.name), this.store.listDocs()]);
    const baseState = fold(mainEvents.filter((e) => e.seq <= branch.forkSeq));
    const mainState = fold(mainEvents);
    const want = new Set<string>();
    for (const e of events) {
      for (const r of e.evidence ?? []) want.add(r.docId);
      if (e.op.type === "evidence.attach") want.add(e.op.doc.id);
    }
    for (const c of pr.staleness?.contradictions ?? []) want.add(c.docId);
    const byId = new Map<string, EvidenceDoc>();
    for (const d of Object.values(mainState.evidence)) byId.set(d.id, d);
    for (const d of docs) byId.set(d.id, d);
    for (const e of events) if (e.op.type === "evidence.attach") byId.set(e.op.doc.id, e.op.doc);
    const out = [...want].map((d) => byId.get(d)).filter((d): d is EvidenceDoc => !!d);
    return { pr, branch, events, docs: out, baseState };
  }

  async listPRs(status?: PullRequest["status"]): Promise<PullRequest[]> {
    return this.store.listPRs(status ? { status } : undefined);
  }

  private async mergeInternal(
    id: PRId, by: Actor, resolutions: Record<string, Conflict["resolution"]> | undefined,
    opts: { bypassPolicy?: boolean; skipRefresh?: boolean } = {},
  ): Promise<{ pr: PullRequest; events: Event[] }> {
    let pr = await this.mustPR(id);
    if (pr.status !== "open") throw conflict(`PR ${id} is ${pr.status}, not open`);
    if (!opts.bypassPolicy) {
      pr = await this.ensureAnalyzed(id);
      if (pr.policy?.tier === "block") throw conflict(`PR ${id} is blocked by policy: ${pr.policy.reasons.join("; ")}`, { policy: pr.policy });
    }
    const branch = await this.mustBranch(pr.branch);
    const [mainEvents, branchEvents] = await Promise.all([this.mainEvents(), this.store.events(branch.name)]);
    let result: MergeResult;
    try {
      result = threeWayMerge({ mainEvents, branch, branchEvents, pr: id, resolutions });
    } catch (e) {
      throw new RepoError(500, `merge engine failed: ${errMsg(e)}`);
    }
    const unresolved = result.conflicts.filter(isUnresolved);
    if (!result.ok || unresolved.length) {
      await this.store.updatePR(id, { conflicts: result.conflicts, updatedAt: Date.now() });
      throw conflict(`PR ${id} has ${unresolved.length || "unresolved"} conflict(s); resolve them before merging`, { conflicts: unresolved });
    }
    const events = await this.commitToMain(result.toAppend);
    const now = Date.now();
    const merged = await this.store.updatePR(id, {
      status: "merged", mergedAt: now, mergedBy: by, mergeEvents: events.map((e) => e.id),
      conflicts: result.conflicts, changes: result.changes, updatedAt: now,
    });
    this.analysisKey.delete(id);
    void this.pushToAdapters(events);
    if (!opts.skipRefresh) await this.refreshOpenPRs();
    return { pr: (await this.store.getPR(id)) ?? merged, events };
  }

  private async pushToAdapters(events: Event[]): Promise<void> {
    const adapters = this.deps.adapters ?? [];
    if (!adapters.length || !events.length) return;
    let state: CRMState;
    try { state = fold(await this.mainEvents()); } catch (e) { warn("adapter state", e); return; }
    await Promise.all(adapters.map(async (a) => {
      try {
        const r = await a.push(events, state);
        if (!r.ok) warn(`adapter ${a.id}`, r.errors?.join("; ") ?? "push failed");
      } catch (e) { warn(`adapter ${a.id}`, e); }
    }));
  }

  async merge(id: PRId, by: Actor, resolutions?: Record<string, Conflict["resolution"]>): Promise<{ pr: PullRequest; events: Event[] }> {
    return this.serial(() => this.mergeInternal(id, by, resolutions));
  }

  async close(id: PRId, by: Actor, reason?: string): Promise<PullRequest> {
    const pr = await this.mustPR(id);
    if (pr.status !== "open") throw conflict(`PR ${id} is ${pr.status}, not open`);
    const who = actorLabel(by);
    const note = `\n\nClosed by ${who}${reason ? `: ${reason}` : ""}`;
    this.analysisKey.delete(id);
    return this.store.updatePR(id, { status: "closed", updatedAt: Date.now(), description: pr.description + note });
  }

  async revert(id: PRId, by: Actor): Promise<{ revertPr: PullRequest; events: Event[] }> {
    return this.serial(async () => {
      const pr = await this.mustPR(id);
      if (pr.status !== "merged") throw conflict(`PR ${id} is ${pr.status}; only merged PRs can be reverted`);
      if (!pr.mergeEvents?.length) throw conflict(`PR ${id} has no merge events to revert`);
      const mainEvents = await this.mainEvents();
      let inverse: NewEvent[];
      try {
        inverse = revertEvents(mainEvents, pr.mergeEvents, fold(mainEvents));
      } catch (e) {
        throw new RepoError(500, `revert engine failed: ${errMsg(e)}`);
      }
      if (!inverse.length) throw conflict(`nothing to revert for PR ${id}`);
      const branch = await this.createUniqueBranch(`revert/${id}/`, SYSTEM_REVERT);
      const revertPr = await this.openPR(
        branch.name, `Revert "${pr.title}"`, `Reverts ${pr.id} (${pr.title}). Requested by ${actorLabel(by)}.`, SYSTEM_REVERT,
      );
      await this.commit(branch.name, inverse.map((e) => {
        const origin = e.origin?.kind === "revert" ? { ...e.origin, pr: revertPr.id } : e.origin;
        return { ...e, actor: e.actor ?? SYSTEM_REVERT, ...(origin ? { origin } : {}) };
      }));
      const { pr: mergedRevert, events } = await this.mergeInternal(revertPr.id, by, undefined, { bypassPolicy: true, skipRefresh: true });
      await this.store.updatePR(id, { status: "reverted", revertedBy: mergedRevert.id, updatedAt: Date.now() });
      await this.refreshOpenPRs();
      return { revertPr: (await this.store.getPR(mergedRevert.id)) ?? mergedRevert, events };
    });
  }

  /**
   * Point-in-time restore: open a PR that sets main back to how it was at wall-clock `at`, and merge it.
   * Nothing is rewritten; the restore is one merged PR (revertible like any other). Schema additions stay.
   */
  async restore(at: number, by: Actor): Promise<{ pr: PullRequest; events: Event[] }> {
    return this.serial(async () => {
      if (!Number.isFinite(at)) throw new RepoError(400, "restore needs a numeric `at` (epoch ms)");
      const main = await this.mainEvents();
      const plan = restoreOps(fold(main), stateAt(main, at));
      if (!plan.ops.length) throw conflict("main already matches that point in time");
      const when = new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC";
      const branch = await this.createUniqueBranch(`restore/`, by);
      const lines = [
        `Restores main to how it was at ${when}. Requested by ${actorLabel(by)}.`,
        "",
        `- ${plan.fieldsReset} field${plan.fieldsReset === 1 ? "" : "s"} set back`,
        `- ${plan.recreated} record${plan.recreated === 1 ? "" : "s"} brought back (deleted or merged away since)`,
        `- ${plan.removed} record${plan.removed === 1 ? "" : "s"} removed (created since)`,
      ];
      if (plan.schemaSkipped.length) lines.push(`- Schema kept: ${plan.schemaSkipped.join(", ")} (removing fields would destroy data)`);
      lines.push("", "Revert this PR to undo the restore.");
      const pr = await this.openPR(branch.name, `Restore main to ${when}`, lines.join("\n"), by);
      await this.commit(branch.name, plan.ops.map((op) => ({ actor: by, op, reason: `restore to ${when}` })));
      const merged = await this.mergeInternal(pr.id, by, undefined, { bypassPolicy: true, skipRefresh: true });
      await this.refreshOpenPRs();
      return { pr: (await this.store.getPR(merged.pr.id)) ?? merged.pr, events: merged.events };
    });
  }

  async autoMerge(): Promise<PullRequest[]> {
    return this.serial(async () => {
      const merged: PullRequest[] = [];
      const open = (await this.store.listPRs({ status: "open" })).sort((a, b) => a.createdAt - b.createdAt);
      for (const p of open) {
        try {
          const pr = await this.ensureAnalyzed(p.id);
          if (pr.status !== "open" || pr.policy?.tier !== "auto") continue;
          if ((pr.conflicts ?? []).some(isUnresolved)) continue;
          if (pr.staleness?.status === "stale") continue;
          const r = await this.mergeInternal(pr.id, SYSTEM_MERGE, undefined, { skipRefresh: true });
          merged.push(r.pr);
        } catch (e) {
          if (!(e instanceof RepoError && e.status === 409)) warn(`autoMerge ${p.id}`, e);
        }
      }
      if (merged.length) await this.refreshOpenPRs();
      return merged;
    });
  }

  // ---------- policy & trust ----------
  async rules(): Promise<PolicyRule[]> {
    return structuredClone(this._rules);
  }
  async setRules(rules: PolicyRule[]): Promise<PolicyRule[]> {
    if (!Array.isArray(rules)) throw new RepoError(400, "rules must be an array");
    this._rules = structuredClone(rules);
    this.rulesVersion++;
    await this.refreshOpenPRs();
    return this.rules();
  }
  async trust(agent: AgentId): Promise<AgentTrust> {
    return computeTrust(agent, await this.store.listPRs());
  }

  // ---------- world documents ----------
  async addDocs(docs: EvidenceDoc[], alsoAttachToMain?: boolean): Promise<void> {
    if (!docs.length) return;
    await this.store.putDocs(docs);
    if (alsoAttachToMain) {
      await this.commitToMain(docs.map((doc) => ({
        actor: { kind: "system", id: "inbox-sync" } as Actor,
        op: { type: "evidence.attach", doc },
        reason: `New ${doc.kind}: ${doc.title}`,
        ts: doc.ts,
      })));
      await this.refreshOpenPRs();
    }
  }

  // ---------- demo ----------
  /** Wipe the store and reseed the demo world. Rules return to defaults. */
  async resetAndSeed(): Promise<void> {
    await this.serial(async () => {
      await this.store.reset();
      this._rules = structuredClone(this.deps.rules ?? DEFAULT_RULES);
      this.rulesVersion++;
      this.analysisKey.clear();
      await seedRepo(this);
    });
  }
}

/** Seed main + the world docs agents read (inbox + web are NOT attached to main). */
export async function seedRepo(repo: Repo): Promise<void> {
  await repo.commitToMain(seedMainEvents());
  await repo.deps.store.putDocs([...seedInbox(), ...seedWeb()]);
}

/** Docs held back for live injection during the demo. */
export function findInjectable(docId: string): EvidenceDoc | undefined {
  return injectableDocs().find((d) => d.id === docId);
}

// ---------- process singleton ----------
type G = typeof globalThis & { __mainlineRepo?: Promise<Repo> };
const g = globalThis as G;

function loadIntegrations(): Pick<RepoDeps, "adapters" | "notifiers"> {
  const out: Pick<RepoDeps, "adapters" | "notifiers"> = {};
  try { out.adapters = getAdapters(); } catch (e) { warn("adapters unavailable", e); }
  try { out.notifiers = getNotifiers(); } catch (e) { warn("notifiers unavailable", e); }
  return out;
}

async function boot(): Promise<Repo> {
  const dir = process.env.MAINLINE_DATA_DIR;
  const store: Store = dir ? new FileStore(dir) : new MemoryStore();
  const repo = new Repo({ store, ...loadIntegrations() });
  if ((await store.events("main", { toSeq: 1 })).length === 0) await seedRepo(repo);
  return repo;
}

/** Process-wide singleton used by API routes. W6 wires store choice (memory/file) + seed on first use. */
export function getRepo(): Promise<Repo> {
  if (!g.__mainlineRepo) {
    g.__mainlineRepo = boot().catch((e) => {
      g.__mainlineRepo = undefined;
      throw e;
    });
  }
  return g.__mainlineRepo;
}

/** Demo reset: wipe the store and reseed (same store instance, so SSE subscribers survive). */
export async function resetRepo(): Promise<Repo> {
  const repo = await getRepo();
  await repo.resetAndSeed();
  return repo;
}

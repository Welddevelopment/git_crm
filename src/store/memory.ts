/** In-memory Store implementation (W5). Single-process; returns deep copies so callers can't mutate internals. */
import type { Branch, BranchName, Event, EvidenceDoc, NewEvent, PRId, PullRequest } from "../core/types";
import type { Store } from "./store";

export type StoreChange = { kind: "events" | "branch" | "pr" | "docs"; key?: string };

/** Serializable snapshot of a MemoryStore. */
export interface MemorySnapshot {
  version: 1;
  logs: Record<BranchName, Event[]>;
  branches: Record<BranchName, Branch>;
  prs: PullRequest[];
  docs: EvidenceDoc[];
  prCounter: number;
  evtCounter: number;
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

export class MemoryStore implements Store {
  protected logs = new Map<BranchName, Event[]>();
  protected eventIndex = new Map<string, Event>();
  protected branches = new Map<BranchName, Branch>();
  protected prs = new Map<PRId, PullRequest>();
  protected prOrder: PRId[] = [];
  protected docs = new Map<string, EvidenceDoc>();
  protected prCounter = 0;
  protected evtCounter = 0;
  private listeners = new Set<(c: StoreChange) => void>();
  private readonly idSalt = Math.random().toString(36).slice(2, 7);

  // ---------- events ----------
  async append(branch: BranchName, events: NewEvent[]): Promise<Event[]> {
    if (events.length === 0) return [];
    const log = this.logs.get(branch) ?? [];
    let seq = log.length;
    const now = Date.now();
    // Build everything first, then commit (atomic per call).
    const built: Event[] = events.map((ne) => {
      seq += 1;
      this.evtCounter += 1;
      const ev: Event = {
        id: `evt_${this.evtCounter.toString(36).padStart(6, "0")}_${this.idSalt}`,
        branch,
        seq,
        ts: ne.ts ?? now,
        actor: clone(ne.actor),
        op: clone(ne.op),
      };
      if (ne.reason !== undefined) ev.reason = ne.reason;
      if (ne.evidence !== undefined) ev.evidence = clone(ne.evidence);
      if (ne.origin !== undefined) ev.origin = clone(ne.origin);
      return ev;
    });
    for (const ev of built) {
      log.push(ev);
      this.eventIndex.set(ev.id, ev);
    }
    this.logs.set(branch, log);
    const b = this.branches.get(branch);
    if (b) b.headSeq = log.length;
    this.emit({ kind: "events", key: branch });
    return clone(built);
  }

  async events(branch: BranchName, opts?: { fromSeq?: number; toSeq?: number }): Promise<Event[]> {
    const log = this.logs.get(branch) ?? [];
    const from = opts?.fromSeq ?? 1;
    const to = opts?.toSeq ?? Number.POSITIVE_INFINITY;
    // seq is contiguous starting at 1, so index = seq - 1
    const start = Math.max(0, from - 1);
    const end = Math.min(log.length, to === Number.POSITIVE_INFINITY ? log.length : Math.max(0, to));
    return clone(log.slice(start, end));
  }

  async getEvent(id: string): Promise<Event | undefined> {
    return clone(this.eventIndex.get(id));
  }

  // ---------- branches ----------
  async createBranch(b: Omit<Branch, "headSeq">): Promise<Branch> {
    if (this.branches.has(b.name)) throw new Error(`branch already exists: ${b.name}`);
    const branch: Branch = { ...clone(b), headSeq: this.logs.get(b.name)?.length ?? 0 };
    this.branches.set(b.name, branch);
    this.emit({ kind: "branch", key: b.name });
    return clone(branch);
  }

  async getBranch(name: BranchName): Promise<Branch | undefined> {
    return clone(this.branches.get(name));
  }

  async listBranches(): Promise<Branch[]> {
    return clone([...this.branches.values()]);
  }

  async updateBranch(name: BranchName, patch: Partial<Branch>): Promise<Branch> {
    const cur = this.branches.get(name);
    if (!cur) throw new Error(`branch not found: ${name}`);
    const next: Branch = { ...cur, ...clone(patch), name: cur.name };
    this.branches.set(name, next);
    this.emit({ kind: "branch", key: name });
    return clone(next);
  }

  // ---------- pull requests ----------
  async createPR(pr: Omit<PullRequest, "id">): Promise<PullRequest> {
    this.prCounter += 1;
    const id: PRId = `pr_${this.prCounter}`;
    const full: PullRequest = { ...clone(pr), id };
    this.prs.set(id, full);
    this.prOrder.push(id);
    this.emit({ kind: "pr", key: id });
    return clone(full);
  }

  async getPR(id: PRId): Promise<PullRequest | undefined> {
    return clone(this.prs.get(id));
  }

  async listPRs(filter?: { status?: PullRequest["status"] }): Promise<PullRequest[]> {
    const out: PullRequest[] = [];
    for (let i = this.prOrder.length - 1; i >= 0; i--) {
      const pr = this.prs.get(this.prOrder[i]!);
      if (!pr) continue;
      if (filter?.status && pr.status !== filter.status) continue;
      out.push(pr);
    }
    // newest first: createdAt desc, ties broken by creation order (already reversed)
    out.sort((a, b) => b.createdAt - a.createdAt);
    return clone(out);
  }

  async updatePR(id: PRId, patch: Partial<PullRequest>): Promise<PullRequest> {
    const cur = this.prs.get(id);
    if (!cur) throw new Error(`PR not found: ${id}`);
    const next: PullRequest = { ...cur, ...clone(patch), id: cur.id };
    this.prs.set(id, next);
    this.emit({ kind: "pr", key: id });
    return clone(next);
  }

  // ---------- docs ----------
  async putDocs(docs: EvidenceDoc[]): Promise<void> {
    if (docs.length === 0) return;
    for (const d of docs) this.docs.set(d.id, clone(d));
    this.emit({ kind: "docs" });
  }

  async listDocs(filter?: { kind?: EvidenceDoc["kind"]; sinceTs?: number }): Promise<EvidenceDoc[]> {
    const out = [...this.docs.values()].filter(
      (d) => (!filter?.kind || d.kind === filter.kind) && (filter?.sinceTs === undefined || d.ts >= filter.sinceTs),
    );
    out.sort((a, b) => a.ts - b.ts);
    return clone(out);
  }

  // ---------- realtime ----------
  subscribe(fn: (change: StoreChange) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  protected emit(change: StoreChange): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(change);
      } catch {
        // a bad listener must never break a write
      }
    }
    this.onMutation();
  }

  /** Hook for subclasses (e.g. FileStore persistence). */
  protected onMutation(): void {}

  // ---------- reset ----------
  async reset(): Promise<void> {
    this.clearAll();
    for (const kind of ["events", "branch", "pr", "docs"] as const) this.emit({ kind });
  }

  protected clearAll(): void {
    this.logs.clear();
    this.eventIndex.clear();
    this.branches.clear();
    this.prs.clear();
    this.prOrder = [];
    this.docs.clear();
    this.prCounter = 0;
    this.evtCounter = 0;
  }

  // ---------- snapshot ----------
  toJSON(): MemorySnapshot {
    return clone({
      version: 1 as const,
      logs: Object.fromEntries(this.logs),
      branches: Object.fromEntries(this.branches),
      prs: this.prOrder.map((id) => this.prs.get(id)!).filter(Boolean),
      docs: [...this.docs.values()],
      prCounter: this.prCounter,
      evtCounter: this.evtCounter,
    });
  }

  /** Replace this store's contents with a snapshot (no notifications). */
  protected loadSnapshot(obj: unknown): void {
    const s = obj as Partial<MemorySnapshot> | null;
    this.clearAll();
    if (!s || typeof s !== "object") return;
    for (const [name, evs] of Object.entries(s.logs ?? {})) {
      const copy = clone(evs);
      this.logs.set(name, copy);
      for (const ev of copy) this.eventIndex.set(ev.id, ev);
    }
    for (const [name, b] of Object.entries(s.branches ?? {})) this.branches.set(name, clone(b));
    for (const pr of s.prs ?? []) {
      this.prs.set(pr.id, clone(pr));
      this.prOrder.push(pr.id);
    }
    for (const d of s.docs ?? []) this.docs.set(d.id, clone(d));
    const maxPr = Math.max(0, ...this.prOrder.map((id) => Number(id.replace(/^pr_/, "")) || 0));
    this.prCounter = Math.max(s.prCounter ?? 0, maxPr);
    this.evtCounter = Math.max(s.evtCounter ?? 0, this.eventIndex.size);
  }

  static fromJSON(obj: unknown): MemoryStore {
    const st = new MemoryStore();
    st.loadSnapshot(obj);
    return st;
  }

  /** Aliases for toJSON / loadSnapshot. */
  snapshot(): MemorySnapshot {
    return this.toJSON();
  }
  restore(obj: unknown): void {
    this.loadSnapshot(obj);
    for (const kind of ["events", "branch", "pr", "docs"] as const) this.emit({ kind });
  }
}

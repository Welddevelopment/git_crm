/** OWNER: W10. Pure UI helpers: formatting, a tiny local fold (mock only), human-readable event lines. */
import type { Actor, CRMState, EntityId, EntityRecord, Event, FieldProvenance, FieldValue, PullRequest } from "@/core/types";
import type { TimelineEntry } from "@/core/api-contract";

// ---------- formatting ----------
export const usd = (n: number) => (n < 0 ? "-" : "") + "$" + Math.round(Math.abs(n)).toLocaleString("en-US");
export const signedUsd = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "±") + "$" + Math.round(Math.abs(n)).toLocaleString("en-US");
export const prNum = (id?: string) => (id ? "#" + id.replace(/^pr_/, "") : "");

export function fmtValue(v: FieldValue | undefined, field?: string): string {
  if (v === undefined || v === null || v === "") return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (typeof v === "number") return field && /amount|arr|revenue|value|price/i.test(field) ? usd(v) : v.toLocaleString("en-US");
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
export const fmtDate = (ts: number) =>
  new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const fmtDateLong = (ts: number) =>
  new Date(ts).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

export function actorLabel(a: Actor): string {
  if (a.kind === "agent") return `${a.id} agent`;
  if (a.kind === "human") return a.name || a.id;
  return a.id === "seed" ? "seed" : a.id;
}
export function actorColor(a: Actor | undefined, isRevert = false): string {
  if (isRevert) return "var(--negative)";
  if (!a) return "var(--series-3)";
  return a.kind === "agent" ? "var(--blue)" : a.kind === "human" ? "var(--series-2)" : "var(--series-3)";
}

// ---------- state helpers ----------
export function resolve(state: Pick<CRMState, "aliases">, id: EntityId): EntityId {
  let cur = id;
  for (let i = 0; i < 20 && state.aliases[cur] && state.aliases[cur] !== cur; i++) cur = state.aliases[cur];
  return cur;
}
export function entityName(state: CRMState | null | undefined, id: EntityId): string {
  if (!state) return id;
  const e = state.entities[id] || state.entities[resolve(state, id)];
  const n = e?.attrs?.name;
  return typeof n === "string" && n ? n : id.split(":")[1] || id;
}
export const isLive = (e: EntityRecord) => !e.deleted && !e.mergedInto;

export function pipelineTotal(state: CRMState | null | undefined): number {
  if (!state) return 0;
  let sum = 0;
  for (const e of Object.values(state.entities)) {
    if (e.type !== "deal" || !isLive(e)) continue;
    const st = String(e.attrs.stage ?? "");
    if (st === "closed_won" || st === "closed_lost") continue;
    const a = e.attrs.amount;
    if (typeof a === "number") sum += a;
    else if (typeof a === "string" && !isNaN(Number(a))) sum += Number(a);
  }
  return sum;
}

/** Columns for an entity type: schema order first, then any extra attrs seen on records. */
export function columnsFor(state: CRMState, type: string): string[] {
  const cols: string[] = (state.schema[type] || []).map((f) => f.field);
  const seen = new Set(cols);
  for (const e of Object.values(state.entities)) {
    if (e.type !== type) continue;
    for (const k of Object.keys(e.attrs)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  }
  const ni = cols.indexOf("name");
  if (ni > 0) { cols.splice(ni, 1); cols.unshift("name"); }
  return cols;
}

export function sameValue(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return (a ?? null) === (b ?? null);
}

/** Count overwritten fields + merged-away entities between two states (used by the chaos demo). */
export function overwriteStats(before: CRMState, after: CRMState) {
  let overwritten = 0, mergedAway = 0, deleted = 0;
  for (const [id, b] of Object.entries(before.entities)) {
    const a = after.entities[id];
    if (!a || !isLive(b)) continue;
    if (a.mergedInto && !b.mergedInto) { mergedAway++; continue; }
    if (a.deleted && !b.deleted) { deleted++; continue; }
    for (const [k, v] of Object.entries(b.attrs)) {
      if (v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
      if (!sameValue(v, a.attrs[k])) overwritten++;
    }
  }
  return { overwritten, mergedAway, deleted };
}

// ---------- local fold (used ONLY by the mock data source) ----------
export function emptyState(): CRMState {
  return { schema: {}, entities: {}, aliases: {}, evidence: {}, provenance: {}, versions: {}, headSeq: 0 };
}
export function foldEvents(events: Event[]): CRMState {
  const s = emptyState();
  const prov = (id: EntityId, field: string, ev: Event) => {
    (s.provenance[id] ||= {})[field] = { eventId: ev.id, actor: ev.actor, ts: ev.ts, seq: ev.seq, branch: ev.branch, reason: ev.reason, evidence: ev.evidence };
    s.versions[`${id}::${field}`] = ev.seq;
  };
  for (const ev of events) {
    const op = ev.op;
    s.headSeq = ev.seq;
    switch (op.type) {
      case "entity.create": {
        s.entities[op.entity] = { id: op.entity, type: op.entityType, attrs: { ...op.attrs } };
        for (const k of Object.keys(op.attrs)) prov(op.entity, k, ev);
        break;
      }
      case "field.set": {
        const id = resolve(s, op.entity);
        const e = s.entities[id];
        if (!e) break;
        e.attrs[op.field] = op.value;
        prov(id, op.field, ev);
        break;
      }
      case "entity.delete": { const e = s.entities[resolve(s, op.entity)]; if (e) e.deleted = true; break; }
      case "entity.merge": {
        const into = resolve(s, op.into);
        const from = s.entities[op.from];
        const tgt = s.entities[into];
        if (!from || !tgt) break;
        from.mergedInto = into;
        s.aliases[op.from] = into;
        for (const [k, v] of Object.entries(op.fieldChoices || {})) { tgt.attrs[k] = v; prov(into, k, ev); }
        break;
      }
      case "schema.addField": {
        const arr = (s.schema[op.entityType] ||= []);
        if (!arr.some((f) => f.field === op.field)) arr.push({ field: op.field, fieldType: op.fieldType, description: op.description });
        break;
      }
      case "schema.renameField": {
        const f = (s.schema[op.entityType] || []).find((x) => x.field === op.from);
        if (f) f.field = op.to;
        break;
      }
      case "schema.removeField": { s.schema[op.entityType] = (s.schema[op.entityType] || []).filter((x) => x.field !== op.field); break; }
      case "evidence.attach": { s.evidence[op.doc.id] = op.doc; break; }
    }
  }
  return s;
}
export function localBlame(events: Event[], entity: EntityId, field: string): FieldProvenance[] {
  // Resolve against final alias map so history of merged-away records shows on the survivor.
  const final = foldEvents(events);
  const target = resolve(final, entity);
  const out: FieldProvenance[] = [];
  for (const ev of events) {
    const op = ev.op;
    const hit =
      (op.type === "entity.create" && resolve(final, op.entity) === target && field in op.attrs && op.entity === target) ||
      (op.type === "field.set" && op.field === field && resolve(final, op.entity) === target) ||
      (op.type === "entity.merge" && resolve(final, op.into) === target && !!op.fieldChoices && field in op.fieldChoices);
    if (hit) out.push({ eventId: ev.id, actor: ev.actor, ts: ev.ts, seq: ev.seq, branch: ev.branch, reason: ev.reason, evidence: ev.evidence });
  }
  return out;
}

// ---------- human-readable events ----------
export interface FeedLine {
  key: string;
  ts: number;
  actor: Actor;
  pr?: string;
  revert: boolean;
  parts: { t: string; kind?: "b" | "val" | "muted" | "del" | "add" }[];
}

/**
 * Turn main's log into human sentences, e.g.
 * "inbox agent set Acme — Platform rollout amount $20,000 → $45,000 via PR #3".
 * `prev` is reconstructed by scanning the log so it works even if op.prev is missing.
 */
export function describeTimeline(entries: TimelineEntry[], state: CRMState | null, opts: { includeSeed?: boolean } = {}): FeedLine[] {
  const last = new Map<string, FieldValue>();
  const names = new Map<EntityId, string>();
  const aliases: Record<string, string> = {};
  const res = (id: string) => { let c = id; for (let i = 0; i < 20 && aliases[c]; i++) c = aliases[c]; return c; };
  const nm = (id: string) => names.get(res(id)) || names.get(id) || entityName(state, id);
  const out: FeedLine[] = [];
  for (const en of entries) {
    const ev = en.event;
    const op = ev.op;
    const isRevert = ev.origin?.kind === "revert" || ev.actor.id === "revert";
    const pr = en.pr || (ev.origin && "pr" in ev.origin ? ev.origin.pr : undefined);
    const isSeed = ev.actor.kind === "system" && ev.actor.id === "seed";
    // the actor to credit: for merges, credit the PR author if the event carried it; else event actor
    const actor = ev.actor;
    let parts: FeedLine["parts"] | null = null;
    const who = { t: actorLabel(actor), kind: "b" as const };
    switch (op.type) {
      case "entity.create": {
        const n = typeof op.attrs.name === "string" ? op.attrs.name : op.entity;
        names.set(op.entity, n);
        for (const [k, v] of Object.entries(op.attrs)) last.set(`${op.entity}::${k}`, v);
        parts = [who, { t: ` created ${op.entityType} ` }, { t: n, kind: "b" }];
        break;
      }
      case "field.set": {
        const id = res(op.entity);
        const key = `${id}::${op.field}`;
        const prev = op.prev !== undefined ? op.prev : last.get(key);
        last.set(key, op.value);
        if (op.field === "name" && typeof op.value === "string") names.set(id, op.value);
        parts = [who, { t: isRevert ? " restored " : " set " }, { t: nm(id), kind: "b" }, { t: ` ${op.field} ` }];
        if (prev !== undefined && prev !== null && prev !== "") parts.push({ t: fmtValue(prev, op.field), kind: "val" }, { t: " → " });
        parts.push({ t: fmtValue(op.value, op.field), kind: "val" });
        break;
      }
      case "entity.merge": {
        parts = [who, { t: " merged " }, { t: nm(op.from), kind: "b" }, { t: ` (${op.from.split(":")[1]})`, kind: "muted" }, { t: " into " }, { t: nm(op.into), kind: "b" }, { t: ` (${op.into.split(":")[1]})`, kind: "muted" }];
        aliases[op.from] = op.into;
        break;
      }
      case "entity.delete": parts = [who, { t: isRevert ? " un-did " : " deleted " }, { t: nm(op.entity), kind: "b" }]; break;
      case "schema.addField": parts = [who, { t: " added field " }, { t: `${op.entityType}.${op.field}`, kind: "val" }, { t: ` (${op.fieldType})`, kind: "muted" }]; break;
      case "schema.renameField": parts = [who, { t: " renamed " }, { t: `${op.entityType}.${op.from}`, kind: "val" }, { t: " → " }, { t: op.to, kind: "val" }]; break;
      case "schema.removeField": parts = [who, { t: " removed field " }, { t: `${op.entityType}.${op.field}`, kind: "val" }]; break;
      case "evidence.attach": parts = [who, { t: ` attached ${op.doc.kind} ` }, { t: `“${op.doc.title}”`, kind: "b" }]; break;
    }
    if (!parts) continue;
    if (isSeed && !opts.includeSeed) continue;
    if (pr) parts.push({ t: isRevert ? " — revert of " : " via ", kind: "muted" }, { t: `PR ${prNum(pr)}`, kind: isRevert ? "del" : undefined });
    else if (ev.actor.kind === "agent") parts.push({ t: " — direct write, no PR", kind: "del" });
    out.push({ key: ev.id, ts: ev.ts, actor, pr, revert: isRevert, parts });
  }
  return out;
}

// ---------- PR stats ----------
export function prStats(prs: PullRequest[]) {
  const open = prs.filter((p) => p.status === "open");
  return {
    open: open.length,
    awaiting: open.filter((p) => p.policy?.tier !== "auto" || (p.conflicts || []).some((c) => !c.autoResolved && !c.resolution)).length,
    autoMerged: prs.filter((p) => p.status === "merged" && p.mergedBy && p.mergedBy.kind !== "human").length,
    stale: open.filter((p) => p.staleness?.status === "stale").length,
    merged: prs.filter((p) => p.status === "merged").length,
  };
}

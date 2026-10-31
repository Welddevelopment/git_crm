/* OWNER: W9. Formatting helpers for the PR UI. */
import type { Actor, CRMState, EntityId, FieldValue, PullRequest } from "@/core/types";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const MONEY_FIELD = /(^|\.)(amount|arr|mrr|acv|value|price|revenue|budget)$/i;

export function isMoneyField(field?: string): boolean {
  return !!field && MONEY_FIELD.test(field);
}

export function fmtMoney(n: number): string {
  return usd.format(n);
}

export function fmtSignedMoney(n: number): string {
  return (n >= 0 ? "+" : "−") + usd.format(Math.abs(n));
}

export function fmtAge(ts: number | undefined, now = Date.now()): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function fmtDateTime(ts: number | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function actorName(a: Actor | undefined): string {
  if (!a) return "unknown";
  if (a.kind !== "system" && a.name) return a.name;
  if (a.kind === "agent") return `${a.id}`;
  if (a.kind === "system") return a.id === "merge" ? "auto-merge" : `system:${a.id}`;
  return a.id;
}

export function isAutoMerged(pr: PullRequest): boolean {
  return pr.mergedBy?.kind === "system";
}

export function isEntityRef(v: unknown): v is EntityId {
  return typeof v === "string" && /^(company|contact|deal):[a-z0-9-_.]+$/i.test(v);
}

export function entityType(id: EntityId): string {
  const i = id.indexOf(":");
  return i > 0 ? id.slice(0, i) : "entity";
}

/** Human display name for an entity, looking through aliases and falling back to the id slug. */
export function displayName(id: EntityId | undefined, state?: CRMState | null, extra?: Record<string, string>): string {
  if (!id) return "—";
  if (extra?.[id]) return extra[id];
  const rec = state?.entities?.[id];
  const n = rec?.attrs?.name;
  if (typeof n === "string" && n.trim()) return n;
  const alias = state?.aliases?.[id];
  if (alias && alias !== id) {
    const a = state?.entities?.[alias]?.attrs?.name;
    if (typeof a === "string" && a.trim()) return a;
  }
  const slug = id.slice(id.indexOf(":") + 1);
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function plainValue(v: FieldValue | undefined, field?: string): string {
  if (v === undefined) return "∅";
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "[]";
  if (typeof v === "number" && isMoneyField(field)) return fmtMoney(v);
  if (typeof v === "number") return v.toLocaleString("en-US");
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v === "") return '""';
  return v;
}

export function pluralize(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Count of changes worth showing (evidence attachments are not "changes" to a reviewer). */
export function changeCount(pr: PullRequest): number {
  return (pr.changes || []).filter((c) => c.kind !== "evidence.added").length;
}

export function unresolvedConflicts(pr: PullRequest): number {
  return (pr.conflicts || []).filter((c) => !c.autoResolved && !c.resolution).length;
}

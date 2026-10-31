/* PR triage: derive a category for every PR from what it actually changes, so a busy inbox can be
   filtered, grouped and bulk-approved. Pure and deterministic: no API or contract changes. */
import type { PullRequest } from "@/core/types";

export type CategoryKey = "pipeline" | "identity" | "schema" | "deals" | "records" | "cleanup" | "enrichment";

export const CATEGORIES: { key: CategoryKey; label: string; hint: string }[] = [
  { key: "pipeline", label: "Money & stage", hint: "Deal amount, stage, close date or owner. Moves the forecast." },
  { key: "identity", label: "Merges & deletes", hint: "Dedup merges and removed records. Hard to undo by hand." },
  { key: "schema", label: "Schema", hint: "New, renamed or removed fields." },
  { key: "deals", label: "Deal updates", hint: "Next steps, notes and other deal fields." },
  { key: "records", label: "New records", hint: "Companies, contacts or deals an agent created." },
  { key: "cleanup", label: "Data cleanup", hint: "Names, titles, emails, phones: hygiene fixes." },
  { key: "enrichment", label: "Enrichment & signals", hint: "Headcount, industry, funding, web signals." },
];

const PIPELINE_FIELDS = new Set(["amount", "stage", "closeDate", "owner", "probability", "forecastCategory", "dealstage"]);
const CLEANUP_FIELDS = new Set(["name", "firstName", "lastName", "title", "email", "phone", "company", "domain", "linkedin", "location"]);

const entityType = (id: string) => id.split(":")[0];

export function categorize(pr: PullRequest): CategoryKey {
  const changes = pr.changes || [];
  if (changes.some((c) => c.kind === "schema.changed")) return "schema";
  if (changes.some((c) => c.kind === "entity.merged" || c.kind === "entity.removed")) return "identity";
  const fields = changes.flatMap((c) => (c.kind === "field.changed" ? [c] : []));
  if (fields.some((c) => entityType(c.entity) === "deal" && PIPELINE_FIELDS.has(c.field))) return "pipeline";
  if (fields.some((c) => entityType(c.entity) === "deal")) return "deals";
  if (changes.some((c) => c.kind === "entity.added")) return "records";
  if (fields.length && fields.every((c) => CLEANUP_FIELDS.has(c.field))) return "cleanup";
  if (fields.length) return "enrichment";
  // No analysis yet: fall back to who opened it.
  const who = pr.author.id.toLowerCase();
  if (who.includes("hygiene")) return "cleanup";
  if (who.includes("schema")) return "schema";
  if (who.includes("inbox")) return "deals";
  return "enrichment";
}

export const unresolved = (pr: PullRequest) => (pr.conflicts || []).filter((c) => !c.autoResolved && !c.resolution).length;
const isStale = (pr: PullRequest) => pr.staleness?.status === "stale" || pr.staleness?.status === "version-conflict";

/** Open and needs a human look: held by policy, stale, or conflicting. */
export function needsYou(pr: PullRequest): boolean {
  return pr.status === "open" && (pr.policy?.tier !== "auto" || isStale(pr) || unresolved(pr) > 0);
}

/** Categories that are always reviewed one at a time: a bad dedup or schema change is the expensive kind of mistake. */
export const NO_BULK: ReadonlySet<CategoryKey> = new Set<CategoryKey>(["identity", "schema"]);

/** Safe to approve in bulk: open, not blocked, fresh evidence, no unresolved conflicts, not a merge/delete or schema change. */
export function bulkSafe(pr: PullRequest): boolean {
  return pr.status === "open" && !!pr.policy && pr.policy.tier !== "block" && !isStale(pr) && unresolved(pr) === 0 && !NO_BULK.has(categorize(pr));
}

export type GroupBy = "category" | "agent" | "none";

export interface Group {
  key: string;
  label: string;
  hint?: string;
  prs: PullRequest[];
}

const agentLabel = (pr: PullRequest) => ("name" in pr.author && pr.author.name) || pr.author.id;

export function groupPRs(prs: PullRequest[], by: GroupBy): Group[] {
  if (by === "none") return [{ key: "all", label: "All", prs }];
  if (by === "agent") {
    const m = new Map<string, PullRequest[]>();
    for (const p of prs) m.set(agentLabel(p), [...(m.get(agentLabel(p)) || []), p]);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length).map(([label, list]) => ({ key: `agent:${label}`, label, prs: list }));
  }
  return CATEGORIES.map((c) => ({ key: c.key, label: c.label, hint: c.hint, prs: prs.filter((p) => categorize(p) === c.key) })).filter((g) => g.prs.length);
}

export function categoryCounts(prs: PullRequest[]): Record<CategoryKey, number> {
  const out = Object.fromEntries(CATEGORIES.map((c) => [c.key, 0])) as Record<CategoryKey, number>;
  for (const p of prs) out[categorize(p)]++;
  return out;
}

export const categoryLabel = (k: CategoryKey) => CATEGORIES.find((c) => c.key === k)!.label;

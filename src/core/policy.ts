/** OWNER: W4 (policy + trust). Pure: no I/O, no clocks. */
import type {
  AgentId,
  AgentTrust,
  CRMState,
  EntityId,
  EntityType,
  Event,
  FieldValue,
  Op,
  PolicyDecision,
  PolicyRule,
  PullRequest,
  RiskTier,
} from "./types";

// ---------------------------------------------------------------------------
// Default rules: branch protection for revenue data.
// Most restrictive matching rule wins; no matching rule → review.
// ---------------------------------------------------------------------------
export const DEFAULT_RULES: PolicyRule[] = [
  // money
  {
    id: "deal-amount-large",
    description: "Deal amount changes over $10k need a human",
    match: { opType: "field.set", entityType: "deal", field: "amount" },
    absDeltaGt: 10000,
    tier: "review",
  },
  {
    id: "deal-amount-small",
    description: "Small deal amount adjustments (up to $10k) can auto-merge for trusted agents",
    match: { opType: "field.set", entityType: "deal", field: "amount" },
    tier: "auto",
  },
  // pipeline
  {
    id: "deal-stage",
    description: "Pipeline stage changes need a human",
    match: { opType: "field.set", entityType: "deal", field: "stage" },
    tier: "review",
  },
  {
    id: "deal-close-date",
    description: "Close date changes move the forecast and need a human",
    match: { opType: "field.set", entityType: "deal", field: "closeDate" },
    tier: "review",
  },
  {
    id: "deal-next-step",
    description: "Deal next-step notes can auto-merge",
    match: { opType: "field.set", entityType: "deal", field: "nextStep" },
    tier: "auto",
  },
  // identity
  {
    id: "entity-merge",
    description: "Record merges (dedup) change identity and need a human",
    match: { opType: "entity.merge" },
    tier: "review",
  },
  {
    id: "entity-delete",
    description: "Agents may never delete CRM records",
    match: { opType: "entity.delete" },
    tier: "block",
  },
  // structure
  {
    id: "schema-add-field",
    description: "Schema changes need a human",
    match: { opType: "schema.addField" },
    tier: "review",
  },
  {
    id: "schema-rename-field",
    description: "Schema changes need a human",
    match: { opType: "schema.renameField" },
    tier: "review",
  },
  {
    id: "schema-remove-field",
    description: "Schema changes need a human",
    match: { opType: "schema.removeField" },
    tier: "review",
  },
  // enrichment
  {
    id: "company-signals",
    description: "Company signals are enrichment and can auto-merge",
    match: { opType: "field.set", entityType: "company", field: "signals" },
    tier: "auto",
  },
  {
    id: "company-industry",
    description: "Company industry is enrichment and can auto-merge",
    match: { opType: "field.set", entityType: "company", field: "industry" },
    tier: "auto",
  },
  {
    id: "company-employees",
    description: "Company headcount is enrichment and can auto-merge",
    match: { opType: "field.set", entityType: "company", field: "employees" },
    tier: "auto",
  },
  {
    id: "contact-title",
    description: "Contact titles are enrichment and can auto-merge",
    match: { opType: "field.set", entityType: "contact", field: "title" },
    tier: "auto",
  },
  {
    id: "contact-phone",
    description: "Contact phone numbers are enrichment and can auto-merge",
    match: { opType: "field.set", entityType: "contact", field: "phone" },
    tier: "auto",
  },
  {
    id: "contact-email",
    description: "Contact emails are enrichment and can auto-merge",
    match: { opType: "field.set", entityType: "contact", field: "email" },
    tier: "auto",
  },
  // evidence & creation
  {
    id: "evidence-attach",
    description: "Attaching evidence is always safe",
    match: { opType: "evidence.attach" },
    tier: "auto",
  },
  {
    id: "create-contact",
    description: "New contacts can auto-merge",
    match: { opType: "entity.create", entityType: "contact" },
    tier: "auto",
  },
  {
    id: "create-company",
    description: "New companies can auto-merge",
    match: { opType: "entity.create", entityType: "company" },
    tier: "auto",
  },
  {
    id: "create-deal",
    description: "New deals add pipeline and need a human",
    match: { opType: "entity.create", entityType: "deal" },
    tier: "review",
  },
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const RANK: Record<RiskTier, number> = { auto: 0, review: 1, block: 2 };
const maxTier = (a: RiskTier, b: RiskTier): RiskTier => (RANK[b] > RANK[a] ? b : a);

function resolve(state: CRMState, id: EntityId): EntityId {
  let cur = id;
  const seen = new Set<EntityId>();
  while (state.aliases?.[cur] && !seen.has(cur)) {
    seen.add(cur);
    cur = state.aliases[cur];
  }
  return cur;
}

function typeFromId(id: EntityId): EntityType | undefined {
  const i = id.indexOf(":");
  return i > 0 ? id.slice(0, i) : undefined;
}

function fmtThreshold(n: number): string {
  if (n >= 1000 && n % 1000 === 0) return `$${n / 1000}k`;
  return `$${n.toLocaleString("en-US")}`;
}

function fmtMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US")}`;
}

function fmtValue(v: FieldValue | undefined, money: boolean): string {
  if (v === undefined || v === null || v === "") return "(empty)";
  if (typeof v === "number") return money ? fmtMoney(v) : v.toLocaleString("en-US");
  if (Array.isArray(v)) return v.length ? `[${v.join(", ")}]` : "[]";
  return String(v);
}

const isMoneyField = (field: string) => field === "amount";

interface Facts {
  opType: Op["type"];
  entityType?: EntityType;
  field?: string;
  agent?: AgentId;
  before?: FieldValue;
  after?: FieldValue;
  label: string; // e.g. "deal.amount $20,000 → $45,000"
}

function ruleMatches(rule: PolicyRule, f: Facts): boolean {
  const m = rule.match;
  if (m.opType && m.opType !== f.opType) return false;
  if (m.entityType && m.entityType !== "*" && m.entityType !== f.entityType) return false;
  if (m.field && m.field !== "*" && m.field !== f.field) return false;
  if (m.agent && m.agent !== "*" && m.agent !== f.agent) return false;
  if (rule.absDeltaGt !== undefined) {
    if (f.opType !== "field.set") return false;
    if (typeof f.before !== "number" || typeof f.after !== "number") return false;
    if (!(Math.abs(f.after - f.before) > rule.absDeltaGt)) return false;
  }
  return true;
}

/** Money, pipeline, identity and structure always need a human, even for autonomous agents. */
function isProtected(f: Facts): boolean {
  if (f.opType === "entity.merge") return true;
  if (f.opType.startsWith("schema.")) return true;
  if (f.opType === "field.set" && f.entityType === "deal" && (f.field === "amount" || f.field === "stage")) return true;
  return false;
}

function protectedArea(f: Facts): string {
  if (f.opType === "entity.merge") return "identity changes (merges)";
  if (f.opType.startsWith("schema.")) return "schema changes";
  if (f.field === "amount") return "money changes";
  return "pipeline stage changes";
}

function ruleReason(rule: PolicyRule, f: Facts): string {
  if (rule.absDeltaGt !== undefined && typeof f.before === "number" && typeof f.after === "number") {
    const delta = f.after - f.before;
    const money = f.field ? isMoneyField(f.field) : false;
    const d = money ? fmtMoney(Math.abs(delta)) : Math.abs(delta).toLocaleString("en-US");
    const thr = money ? fmtThreshold(rule.absDeltaGt) : rule.absDeltaGt.toLocaleString("en-US");
    return `${f.label} (${delta >= 0 ? "+" : "-"}${d}) exceeds ${thr} threshold`;
  }
  return `${f.label}: ${rule.description}`;
}

// ---------------------------------------------------------------------------
// evaluatePolicy
// ---------------------------------------------------------------------------
export function evaluatePolicy(args: {
  branchEvents: Event[];
  baseState: CRMState;
  rules: PolicyRule[];
  trust?: AgentTrust;
}): PolicyDecision {
  const { branchEvents, baseState, rules, trust } = args;
  const perEvent: PolicyDecision["perEvent"] = {};
  const reasons: string[] = [];
  const addReason = (r: string) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  const autoReasons: string[] = [];

  // running view of values/types inside the branch, starting from base
  const running = new Map<string, FieldValue | undefined>();
  const createdTypes = new Map<EntityId, EntityType>();

  const entityTypeOf = (id: EntityId): EntityType | undefined => {
    const rid = resolve(baseState, id);
    return baseState.entities?.[rid]?.type ?? createdTypes.get(id) ?? typeFromId(id);
  };
  const currentValue = (id: EntityId, field: string): FieldValue | undefined => {
    const key = `${id}::${field}`;
    if (running.has(key)) return running.get(key);
    return baseState.entities?.[resolve(baseState, id)]?.attrs?.[field];
  };

  let tier: RiskTier = "auto";
  let probationApplied = false;
  let autonomousDowngraded = false;

  for (const ev of branchEvents) {
    const op = ev.op;
    const agent: AgentId | undefined = ev.actor.kind === "agent" ? ev.actor.id : trust?.agent;
    const facts: Facts = { opType: op.type, agent, label: op.type };

    switch (op.type) {
      case "field.set": {
        const et = entityTypeOf(op.entity);
        const before = currentValue(op.entity, op.field) ?? op.prev;
        const money = isMoneyField(op.field);
        facts.entityType = et;
        facts.field = op.field;
        facts.before = before;
        facts.after = op.value;
        facts.label = `${et ?? "entity"}.${op.field} ${fmtValue(before, money)} → ${fmtValue(op.value, money)}`;
        running.set(`${op.entity}::${op.field}`, op.value);
        break;
      }
      case "entity.create":
        facts.entityType = op.entityType;
        facts.label = `new ${op.entityType} ${op.entity}`;
        createdTypes.set(op.entity, op.entityType);
        for (const [k, v] of Object.entries(op.attrs ?? {})) running.set(`${op.entity}::${k}`, v);
        break;
      case "entity.delete":
        facts.entityType = entityTypeOf(op.entity);
        facts.label = `delete ${op.entity}`;
        break;
      case "entity.merge":
        facts.entityType = entityTypeOf(op.from) ?? entityTypeOf(op.into);
        facts.label = `merge ${op.from} → ${op.into}`;
        break;
      case "schema.addField":
        facts.entityType = op.entityType;
        facts.field = op.field;
        facts.label = `schema: add ${op.entityType}.${op.field} (${op.fieldType})`;
        break;
      case "schema.renameField":
        facts.entityType = op.entityType;
        facts.field = op.from;
        facts.label = `schema: rename ${op.entityType}.${op.from} → ${op.to}`;
        break;
      case "schema.removeField":
        facts.entityType = op.entityType;
        facts.field = op.field;
        facts.label = `schema: remove ${op.entityType}.${op.field}`;
        break;
      case "evidence.attach":
        facts.label = `attach evidence "${op.doc.title}"`;
        break;
    }

    // 1. rules: most restrictive wins; no match → review
    const matched = rules.filter((r) => ruleMatches(r, facts));
    let evTier: RiskTier;
    let ruleId: string | undefined;
    let reason: string;
    if (matched.length === 0) {
      evTier = "review";
      ruleId = "default";
      reason = `${facts.label}: no policy rule covers this change, so a human reviews it`;
    } else {
      let winner = matched[0];
      for (const r of matched) if (RANK[r.tier] > RANK[winner.tier]) winner = r;
      evTier = winner.tier;
      ruleId = winner.id;
      reason = ruleReason(winner, facts);
    }

    // 2. trust adjustment
    if (trust && evTier !== "block") {
      if (trust.level === "autonomous" && evTier === "review") {
        if (isProtected(facts)) {
          addReason(`Agent ${trust.agent} is autonomous, but ${protectedArea(facts)} always need a human`);
        } else {
          evTier = "auto";
          ruleId = `${ruleId}+trust:autonomous`;
          autonomousDowngraded = true;
        }
      } else if (trust.level === "probation" && trust.prsReverted > 0 && evTier === "auto" && op.type !== "evidence.attach") {
        // New agents follow the rules as written; probation only bites once an agent has been reverted (demoted).
        evTier = "review";
        ruleId = `${ruleId}+trust:probation`;
        probationApplied = true;
      }
    }

    perEvent[ev.id] = { tier: evTier, rule: ruleId };
    tier = maxTier(tier, evTier);
    if (evTier === "auto") {
      if (!autoReasons.includes(reason)) autoReasons.push(reason);
    } else if (!ruleId.includes("trust:probation")) {
      addReason(reason);
    }
  }

  if (probationApplied && trust) {
    addReason(
      `Agent ${trust.agent} is on probation (${trust.prsMerged} merged, ${trust.prsReverted} reverted)`,
    );
  }
  if (autonomousDowngraded && trust) {
    addReason(`Agent ${trust.agent} is autonomous (trust ${trust.score.toFixed(2)}): routine changes auto-merge`);
  }

  if (branchEvents.length === 0) {
    addReason("No changes");
  } else if (tier === "auto") {
    // explain why it's safe
    for (const r of autoReasons) addReason(r);
  }

  // order: block/review reasons came first already; keep insertion order
  return { tier, reasons, perEvent };
}

// ---------------------------------------------------------------------------
// computeTrust
// ---------------------------------------------------------------------------
export function computeTrust(agent: AgentId, prs: PullRequest[]): AgentTrust {
  const mine = prs.filter((p) => p.author.kind === "agent" && p.author.id === agent);
  const opened = mine.length;
  const merged = mine.filter((p) => p.status === "merged").length;
  const reverted = mine.filter((p) => p.status === "reverted").length;
  const closed = mine.filter((p) => p.status === "closed").length;
  const stale = mine.filter((p) => p.staleness?.status === "stale").length;

  const raw = (merged + 1) / (opened + 2) - 0.25 * reverted - 0.1 * stale;
  const score = Math.min(1, Math.max(0, raw));

  let level: AgentTrust["level"] = "probation";
  if (merged >= 8 && reverted === 0 && score >= 0.85) level = "autonomous";
  else if (merged >= 3 && score >= 0.6) level = "trusted";

  return {
    agent,
    prsOpened: opened,
    prsMerged: merged,
    prsReverted: reverted,
    prsClosed: closed,
    staleCount: stale,
    score,
    level,
  };
}

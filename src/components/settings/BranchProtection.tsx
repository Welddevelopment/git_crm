"use client";
/** OWNER: settings worker. Branch protection: edit the policy rules (GET/PUT /api/policy). */
import { Fragment, useMemo, useState } from "react";
import { api } from "@/client/api";
import { DEFAULT_RULES } from "@/core/policy";
import type { Op, PolicyRule, RiskTier } from "@/core/types";
import { errMsg, useLive } from "./lib";

const OP_TYPES: Op["type"][] = [
  "field.set", "entity.create", "entity.delete", "entity.merge",
  "schema.addField", "schema.renameField", "schema.removeField", "evidence.attach",
];
const TIERS: RiskTier[] = ["auto", "review", "block"];
const TIER_LABEL: Record<RiskTier, string> = { auto: "auto-merge", review: "needs review", block: "blocked" };

interface Row { rule: PolicyRule; enabled: boolean; isNew?: boolean }

const sameRule = (a: PolicyRule, b: PolicyRule | undefined) => !!b && JSON.stringify(a) === JSON.stringify(b);

function groupOf(r: PolicyRule): string {
  const op = r.match.opType;
  if (op?.startsWith("schema.")) return "Schema";
  if (op === "entity.merge" || op === "entity.delete") return "Identity & deletes";
  if (op === "evidence.attach" || op === "entity.create") return "Evidence & new records";
  if (r.match.entityType === "deal") return r.match.field === "amount" ? "Money" : "Pipeline";
  if (r.match.entityType === "company" || r.match.entityType === "contact") return "Enrichment";
  return "Other";
}
const GROUP_ORDER = ["Money", "Pipeline", "Identity & deletes", "Schema", "Enrichment", "Evidence & new records", "Other"];

function MatchTokens({ m }: { m: PolicyRule["match"] }) {
  const toks: [string, string][] = [];
  if (m.opType) toks.push(["op", m.opType]);
  if (m.entityType) toks.push(["type", m.entityType]);
  if (m.field) toks.push(["field", m.field]);
  if (m.agent) toks.push(["agent", m.agent]);
  if (!toks.length) return <span className="st-tok"><span>any change</span></span>;
  return (
    <div className="st-match">
      {toks.map(([k, v]) => <span key={k} className="st-tok"><span>{k}=</span>{v}</span>)}
    </div>
  );
}

function TierSelect({ value, onChange }: { value: RiskTier; onChange: (t: RiskTier) => void }) {
  return (
    <select className={`st-select st-tier ${value}`} value={value} onChange={(e) => onChange(e.target.value as RiskTier)} aria-label="Tier">
      {TIERS.map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
    </select>
  );
}

function AddRuleForm({ onAdd, existingIds }: { onAdd: (r: PolicyRule) => void; existingIds: Set<string> }) {
  const [description, setDescription] = useState("");
  const [opType, setOpType] = useState<string>("field.set");
  const [entityType, setEntityType] = useState("");
  const [field, setField] = useState("");
  const [agent, setAgent] = useState("");
  const [threshold, setThreshold] = useState("");
  const [tier, setTier] = useState<RiskTier>("review");
  const [err, setErr] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) { setErr("Give the rule a description"); return; }
    const t = threshold.trim() ? Number(threshold) : undefined;
    if (t !== undefined && !(Number.isFinite(t) && t >= 0)) { setErr("Threshold must be a non-negative number"); return; }
    const base = ["custom", entityType, field, opType.replace(/\./g, "-"), agent].filter(Boolean).join("-").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    let id = base;
    for (let i = 2; existingIds.has(id); i++) id = `${base}-${i}`;
    const match: PolicyRule["match"] = {};
    if (opType) match.opType = opType as Op["type"];
    if (entityType.trim()) match.entityType = entityType.trim();
    if (field.trim()) match.field = field.trim();
    if (agent.trim()) match.agent = agent.trim();
    onAdd({ id, description: description.trim(), match, ...(t !== undefined ? { absDeltaGt: t } : {}), tier });
    setDescription(""); setEntityType(""); setField(""); setAgent(""); setThreshold(""); setErr(null);
  }

  return (
    <form className="st-form" onSubmit={submit}>
      <div className="st-row" style={{ marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>Add a rule</strong>
        <span className="st-small st-muted">Blank match fields match anything. Most restrictive matching rule wins.</span>
      </div>
      <div className="st-form-grid">
        <div className="st-field">
          <label htmlFor="nr-desc">Description</label>
          <input id="nr-desc" className="st-input" placeholder="Contact owner changes need a human" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="st-field">
          <label htmlFor="nr-op">Op</label>
          <select id="nr-op" className="st-select" value={opType} onChange={(e) => setOpType(e.target.value)}>
            <option value="">any</option>
            {OP_TYPES.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div className="st-field">
          <label htmlFor="nr-type">Entity type</label>
          <input id="nr-type" className="st-input" list="st-entity-types" placeholder="any" value={entityType} onChange={(e) => setEntityType(e.target.value)} />
          <datalist id="st-entity-types"><option value="company" /><option value="contact" /><option value="deal" /></datalist>
        </div>
        <div className="st-field">
          <label htmlFor="nr-field">Field</label>
          <input id="nr-field" className="st-input" placeholder="any (or *)" value={field} onChange={(e) => setField(e.target.value)} />
        </div>
        <div className="st-field">
          <label htmlFor="nr-agent">Agent</label>
          <input id="nr-agent" className="st-input" placeholder="any" value={agent} onChange={(e) => setAgent(e.target.value)} />
        </div>
        <div className="st-field">
          <label htmlFor="nr-th">|Δ| &gt;</label>
          <input id="nr-th" className="st-input num" style={{ width: "100%" }} inputMode="decimal" placeholder="—" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </div>
        <div className="st-field">
          <label htmlFor="nr-tier">Tier</label>
          <TierSelect value={tier} onChange={setTier} />
        </div>
      </div>
      <div className="st-row" style={{ marginTop: 10 }}>
        <button className="st-btn accent" type="submit">+ Add rule</button>
        {err ? <span className="st-err">{err}</span> : null}
      </div>
    </form>
  );
}

export function BranchProtection() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saved, setSaved] = useState<PolicyRule[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const dirty = useMemo(() => {
    if (!rows || !saved) return false;
    const active = rows.filter((r) => r.enabled).map((r) => r.rule);
    return JSON.stringify(active) !== JSON.stringify(saved);
  }, [rows, saved]);

  const { error, reload } = useLive(async () => {
    const r = await api.policy();
    setSaved(r.rules);
    setRows((prev) => {
      // Keep disabled rows visible (so they can be toggled back on) after a refetch.
      const disabled = (prev || []).filter((x) => !x.enabled && !r.rules.some((y) => y.id === x.rule.id));
      return [...r.rules.map((rule) => ({ rule, enabled: true })), ...disabled];
    });
    return r.rules;
  }, { paused: dirty || saving });

  const savedById = useMemo(() => new Map((saved || []).map((r) => [r.id, r])), [saved]);

  const update = (id: string, patch: (r: PolicyRule) => PolicyRule) =>
    setRows((rs) => rs && rs.map((x) => (x.rule.id === id ? { ...x, rule: patch(x.rule) } : x)));
  const toggle = (id: string) => setRows((rs) => rs && rs.map((x) => (x.rule.id === id ? { ...x, enabled: !x.enabled } : x)));
  const removeNew = (id: string) => setRows((rs) => rs && rs.filter((x) => x.rule.id !== id));

  async function save(rules: PolicyRule[]) {
    setSaving(true);
    setMsg(null);
    try {
      const r = await api.setPolicy(rules);
      setSaved(r.rules);
      setRows((prev) => {
        const disabled = (prev || []).filter((x) => !x.enabled && !r.rules.some((y) => y.id === x.rule.id));
        return [...r.rules.map((rule) => ({ rule, enabled: true })), ...disabled];
      });
      setMsg({ tone: "ok", text: "Saved — open PRs re-checked" });
    } catch (e) {
      setMsg({ tone: "err", text: errMsg(e) });
    } finally {
      setSaving(false);
    }
  }

  async function resetDefaults() {
    if (!window.confirm("Replace all rules with Mainline's defaults? Custom rules will be removed.")) return;
    setRows(DEFAULT_RULES.map((rule) => ({ rule: structuredClone(rule), enabled: true })));
    await save(structuredClone(DEFAULT_RULES));
  }

  const grouped = useMemo(() => {
    const g = new Map<string, Row[]>();
    for (const r of rows || []) {
      const k = groupOf(r.rule);
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(r);
    }
    return GROUP_ORDER.filter((k) => g.has(k)).map((k) => [k, g.get(k)!] as const);
  }, [rows]);

  const counts = useMemo(() => {
    const c: Record<RiskTier, number> = { auto: 0, review: 0, block: 0 };
    for (const r of rows || []) if (r.enabled) c[r.rule.tier]++;
    return c;
  }, [rows]);

  return (
    <>
      <div className="st-head">
        <div>
          <h1>Branch protection</h1>
          <p>Policy rules for merging agent branches into main.</p>
        </div>
        <span className="st-spacer" />
        {rows ? (
          <div className="st-row">
            <span className="st-badge add">{counts.auto} auto</span>
            <span className="st-badge warn">{counts.review} review</span>
            <span className="st-badge del">{counts.block} block</span>
          </div>
        ) : null}
      </div>

      <div className="st-explainer">
        Rules decide which agent changes <strong>auto-merge</strong>, <strong>need a human</strong>, or are <strong>blocked</strong>.
        Money, pipeline stage, identity merges and schema always need a human even for autonomous agents.
        <div className="st-small" style={{ marginTop: 4 }}>The most restrictive matching rule wins; a change no rule matches needs review. Thresholds apply when |after − before| exceeds the value.</div>
      </div>

      {error && !rows ? <div className="st-err">{error} <button className="st-btn sm" onClick={() => void reload()}>Retry</button></div> : null}
      {!rows && !error ? <div className="st-muted"><span className="st-spin" /> Loading rules…</div> : null}

      {rows ? (
        <div className="st-table-wrap">
          <table className="st-table">
            <thead>
              <tr>
                <th style={{ width: 44 }}>On</th>
                <th>Rule</th>
                <th>Match</th>
                <th style={{ width: 120 }}>Threshold |Δ| &gt;</th>
                <th style={{ width: 140 }}>Tier</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {grouped.map(([g, list]) => (
                <Fragment key={g}>
                  <tr className="group"><td colSpan={6}>{g}</td></tr>
                  {list.map(({ rule, enabled, isNew }) => {
                    const changed = isNew || (enabled ? !sameRule(rule, savedById.get(rule.id)) : savedById.has(rule.id));
                    return (
                      <tr key={rule.id} className={`${enabled ? "" : "off"} ${changed ? "changed" : ""}`}>
                        <td>
                          <button type="button" role="switch" aria-checked={enabled} aria-label={enabled ? "Disable rule" : "Enable rule"} className={`st-switch ${enabled ? "on" : ""}`} onClick={() => toggle(rule.id)} />
                        </td>
                        <td>
                          <div>{rule.description}</div>
                          <div className="st-tiny st-muted st-mono">{rule.id}{isNew ? " · new" : ""}</div>
                        </td>
                        <td><MatchTokens m={rule.match} /></td>
                        <td>
                          <input
                            className="st-input num"
                            inputMode="decimal"
                            placeholder="—"
                            disabled={!enabled}
                            aria-label="Threshold"
                            value={rule.absDeltaGt ?? ""}
                            onChange={(e) => {
                              const v = e.target.value.trim();
                              const n = Number(v);
                              update(rule.id, (r) => {
                                const { absDeltaGt: _drop, ...rest } = r;
                                void _drop;
                                return v === "" || !Number.isFinite(n) ? rest : { ...rest, absDeltaGt: n };
                              });
                            }}
                          />
                        </td>
                        <td><TierSelect value={rule.tier} onChange={(t) => update(rule.id, (r) => ({ ...r, tier: t }))} /></td>
                        <td>
                          {isNew ? <button className="st-btn sm ghost" title="Remove" onClick={() => removeNew(rule.id)}>✕</button> : null}
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {rows ? <AddRuleForm existingIds={new Set(rows.map((r) => r.rule.id))} onAdd={(rule) => setRows((rs) => [...(rs || []), { rule, enabled: true, isNew: true }])} /> : null}

      {rows ? (
        <div className="st-savebar">
          <button className="st-btn primary" disabled={!dirty || saving} onClick={() => void save(rows.filter((r) => r.enabled).map((r) => r.rule))}>
            {saving ? <span className="st-spin" /> : null} Save rules
          </button>
          <button className="st-btn" disabled={!dirty || saving} onClick={() => { setRows((saved || []).map((rule) => ({ rule, enabled: true }))); setMsg(null); }}>Discard changes</button>
          <button className="st-btn ghost" disabled={saving} onClick={() => void resetDefaults()}>Reset to defaults</button>
          <span className="st-spacer" />
          {dirty ? <span className="st-small" style={{ color: "var(--warn)" }}>Unsaved changes · live updates paused</span> : null}
          {msg ? <span className={`st-small ${msg.tone === "ok" ? "st-ok" : "st-err"}`}>{msg.text}</span> : null}
        </div>
      ) : null}
    </>
  );
}

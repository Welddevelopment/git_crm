"use client";
/** OWNER: settings worker. Agents & trust: per-agent trust level, score and PR outcomes from GET /api/fleet. */
import { api } from "@/client/api";
import type { FleetStatus } from "@/core/api-contract";
import type { AgentTrust } from "@/core/types";
import { fmtAgo, useLive } from "./lib";

type Level = AgentTrust["level"];
const LEVEL_TONE: Record<Level, string> = { probation: "warn", trusted: "accent", autonomous: "add" };
const LEVEL_COLOR: Record<Level, string> = { probation: "var(--series-3)", trusted: "var(--blue)", autonomous: "var(--positive)" };

const LEVEL_MEANS: Record<Level, { short: string; bullets: string[] }> = {
  probation: {
    short: "New or recently reverted. Follows the rules as written.",
    bullets: [
      "Low-risk changes still auto-merge per the branch protection rules",
      "Once an agent has a reverted PR, everything it proposes is reviewed (except attaching evidence)",
    ],
  },
  trusted: {
    short: "Has a track record. Follows the rules as written.",
    bullets: [
      "Requires 3+ merged PRs and a score of 0.60 or more",
      "Auto-tier changes merge on their own; review-tier changes wait for a human",
    ],
  },
  autonomous: {
    short: "Proven and never reverted. Routine changes auto-merge.",
    bullets: [
      "Requires 8+ merged PRs, zero reverts and a score of 0.85 or more",
      "Review-tier routine changes (close dates, new deals, …) auto-merge",
      "Never money, pipeline stage, record merges or schema: those always need a human",
      "Blocked changes stay blocked",
    ],
  },
};

function nextStep(t: AgentTrust): string | null {
  if (t.level === "autonomous") return null;
  if (t.level === "trusted") {
    if (t.prsReverted > 0) return "Autonomous requires zero reverts";
    const need = Math.max(0, 8 - t.prsMerged);
    return need ? `${need} more merged PR${need === 1 ? "" : "s"} (and score ≥ 0.85) to reach autonomous` : "Score must reach 0.85 for autonomous";
  }
  const need = Math.max(0, 3 - t.prsMerged);
  return need ? `${need} more merged PR${need === 1 ? "" : "s"} (and score ≥ 0.60) to reach trusted` : "Score must reach 0.60 for trusted";
}

function AgentRow({ a }: { a: FleetStatus["agents"][number] }) {
  const t = a.trust;
  const pct = Math.round(t.score * 100);
  const decided = t.prsMerged + t.prsReverted + t.prsClosed;
  const nx = nextStep(t);
  return (
    <div className="st-agent">
      <div>
        <div className="st-agent-name">
          <span className="st-av">{(a.name || a.id).slice(0, 1).toUpperCase()}</span>
          {a.name || a.id}
          <span className="st-tiny st-muted st-mono">{a.id}</span>
        </div>
        <div className="st-small st-muted" style={{ marginTop: 4 }}>{a.description}</div>
        <div className="st-tiny st-muted" style={{ marginTop: 4 }}>
          {a.running ? <span className="st-ok">● running</span> : <>last run {fmtAgo(a.lastRunAt)}</>}
        </div>
      </div>
      <div>
        <div className="st-row" style={{ marginBottom: 6 }}>
          <span className={`st-badge ${LEVEL_TONE[t.level]}`}><span className="dot" />{t.level}</span>
          <span className="st-spacer" />
          <span className="st-score">{t.score.toFixed(2)}</span>
        </div>
        <div className="st-bar" title={`trust score ${t.score.toFixed(2)}`}>
          <i style={{ width: `${pct}%`, ["--c" as string]: LEVEL_COLOR[t.level] }} />
          <span className="tick" style={{ left: "60%" }} title="trusted ≥ 0.60" />
          <span className="tick" style={{ left: "85%" }} title="autonomous ≥ 0.85" />
        </div>
        <div className="st-stats">
          <span><b className={t.prsMerged ? "pos" : undefined}>{t.prsMerged}</b> merged</span>
          <span><b className={t.prsReverted ? "neg" : undefined}>{t.prsReverted}</b> reverted</span>
          <span><b>{t.prsClosed}</b> closed</span>
          <span><b className={t.staleCount ? "warn" : undefined}>{t.staleCount}</b> stale</span>
        </div>
        <div className="st-tiny st-muted" style={{ marginTop: 4 }}>{t.prsOpened} opened · {decided} decided</div>
      </div>
      <div className="st-small">
        <div>{LEVEL_MEANS[t.level].short}</div>
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {LEVEL_MEANS[t.level].bullets.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
        {nx ? <div className="st-next">Next: {nx}</div> : null}
      </div>
    </div>
  );
}

export function Agents() {
  const { data, error } = useLive(() => api.fleet());
  return (
    <>
      <div className="st-head">
        <div>
          <h1>Agents &amp; trust</h1>
          <p>Each agent earns autonomy from its own track record. Trust changes what the branch protection rules let through.</p>
        </div>
      </div>

      {error && !data ? <div className="st-err">{error}</div> : null}
      {!data && !error ? <div className="st-muted"><span className="st-spin" /> Loading agents…</div> : null}
      {data && !data.agents.length ? <div className="st-muted">No agents registered.</div> : null}
      <div className="st-agents">
        {data?.agents.map((a) => <AgentRow key={a.id} a={a} />)}
      </div>

      <div className="st-explainer" style={{ marginTop: 16, marginBottom: 0 }}>
        <strong>How trust is earned.</strong> Only decided PRs count: merged, reverted or closed. A PR still awaiting review isn&apos;t evidence either way,
        and going stale means the world changed, not that the agent was wrong.
        <div><span className="st-formula">score = (merged + 1) / (decided + 2) − 0.25 × reverted</span></div>
        <div className="st-small" style={{ marginTop: 8 }}>Reverts cost trust twice: they count as a decided PR that didn&apos;t stick, and each one subtracts 0.25. One revert also rules out autonomous.</div>
      </div>

      <div className="st-levels">
        {(["probation", "trusted", "autonomous"] as Level[]).map((l) => (
          <div key={l} className="st-level">
            <h3><span className={`st-badge ${LEVEL_TONE[l]}`}><span className="dot" />{l}</span></h3>
            <div>{LEVEL_MEANS[l].short}</div>
            <ul>{LEVEL_MEANS[l].bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
          </div>
        ))}
      </div>
    </>
  );
}

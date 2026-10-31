"use client";
/* OWNER: W9. Right rail: merge box (checks + actions), policy box, branch info. */
import { useState, type ReactNode } from "react";
import type { Branch, Conflict, PolicyDecision, PullRequest, RiskTier } from "@/core/types";
import { IconAlert, IconCheck, IconClock, IconMerged, IconRevert, IconShield, IconX, TierBadge, ActorChip } from "./atoms";
import { fmtAge, fmtDateTime, pluralize } from "./format";
import { withMock } from "./source";

export interface MergeGate {
  blocked: boolean;
  unresolved: number;
  stale: boolean;
  versionConflict: boolean;
}

export function computeGate(pr: PullRequest, conflicts: Conflict[], resolutions: Record<string, unknown>): MergeGate {
  return {
    blocked: pr.policy?.tier === "block",
    unresolved: conflicts.filter((c) => !c.autoResolved && !c.resolution && !(c.id in resolutions)).length,
    stale: pr.staleness?.status === "stale",
    versionConflict: pr.staleness?.status === "version-conflict",
  };
}

export function MergeBox({
  pr, gate, busy, error, notice, onMerge, onClose, onRevert, onRefresh,
}: {
  pr: PullRequest;
  gate: MergeGate;
  busy: string | null;
  error: string | null;
  notice: ReactNode;
  onMerge: (force: boolean) => void;
  onClose: () => void;
  onRevert: () => void;
  onRefresh: () => void;
}) {
  const [confirmStale, setConfirmStale] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const tier = pr.policy?.tier;

  if (pr.status !== "open") {
    return (
      <div className="panel pr-mergebox">
        <div className="pr-checks">
          {pr.status === "merged" && (
            <div className="pr-check ok">
              <span className="ci"><IconMerged /></span>
              <div>
                Merged into <span className="pr-branch">main</span> {fmtAge(pr.mergedAt)}
                <small>
                  by {pr.mergedBy?.kind === "system" ? "policy (auto-merge)" : pr.mergedBy?.name ?? pr.mergedBy?.id} · {pluralize(pr.mergeEvents?.length ?? 0, "event")} on main
                </small>
              </div>
            </div>
          )}
          {pr.status === "reverted" && (
            <div className="pr-check warn">
              <span className="ci"><IconRevert /></span>
              <div>
                Reverted{pr.revertedBy ? <> by <a href={withMock(`/prs/${pr.revertedBy}`)} className="pr-mono">{pr.revertedBy}</a></> : null}
                <small>Its changes were undone on main with new events — history is preserved.</small>
              </div>
            </div>
          )}
          {pr.status === "closed" && (
            <div className="pr-check bad">
              <span className="ci"><IconX /></span>
              <div>
                Closed without merging
                <small>{fmtDateTime(pr.updatedAt)} · nothing reached main</small>
              </div>
            </div>
          )}
        </div>
        <div className="pr-actions">
          {pr.status === "merged" && (
            <button className="btn pr-btn-warn" disabled={!!busy} onClick={onRevert}>
              {busy === "revert" ? <span className="pr-spin" /> : <IconRevert />} Revert
            </button>
          )}
          {error && <div className="pr-error">{error}</div>}
          {notice && <div className="pr-success">{notice}</div>}
        </div>
      </div>
    );
  }

  const reasons: string[] = [];
  if (gate.blocked) reasons.push("Policy blocks this PR — it cannot be merged.");
  if (gate.unresolved) reasons.push(`Resolve ${pluralize(gate.unresolved, "conflict")} first.`);
  const hardBlocked = reasons.length > 0;
  const staleHold = !hardBlocked && gate.stale;
  const tip = hardBlocked ? reasons.join(" ") : staleHold ? "Evidence on main contradicts this PR. Use “Merge anyway” to override." : undefined;

  return (
    <div className="panel pr-mergebox">
      <div className="pr-checks">
        <div className={`pr-check ${tier === "block" ? "bad" : tier === "review" ? "warn" : "ok"}`}>
          <span className="ci"><IconShield /></span>
          <div>
            {tier === "block" ? "Blocked by policy" : tier === "review" ? "Human review required" : "Policy allows auto-merge"}
            <small>{pr.policy?.reasons[0] ?? "No policy decision yet"}</small>
          </div>
        </div>
        <div className={`pr-check ${gate.unresolved ? "warn" : "ok"}`}>
          <span className="ci">{gate.unresolved ? <IconAlert /> : <IconCheck />}</span>
          <div>
            {gate.unresolved ? `${pluralize(gate.unresolved, "conflict")} with main` : "No unresolved conflicts"}
            <small>{gate.unresolved ? "Pick a side for each below" : "Three-way merge is clean"}</small>
          </div>
        </div>
        <div className={`pr-check ${gate.stale ? "bad" : gate.versionConflict ? "warn" : "ok"}`}>
          <span className="ci">{gate.stale ? <IconAlert /> : gate.versionConflict ? <IconClock /> : <IconCheck />}</span>
          <div>
            {gate.stale ? "Evidence is stale" : gate.versionConflict ? "Main changed what the agent read" : "Evidence is fresh"}
            <small>
              checked {fmtAge(pr.staleness?.checkedAt)} ·{" "}
              <button className="pr-linkbtn" disabled={!!busy} onClick={onRefresh}>
                {busy === "refresh" ? "re-checking…" : "re-check"}
              </button>
            </small>
          </div>
        </div>
      </div>
      <div className="pr-actions">
        {confirmStale ? (
          <div className="pr-confirm">
            <strong>Merge a stale PR?</strong>
            <span>Newer evidence on main contradicts this change. Merging writes it to main anyway.</span>
            <div className="row" style={{ display: "flex", gap: 8 }}>
              <button className="btn danger" style={{ flex: 1 }} disabled={!!busy} onClick={() => { setConfirmStale(false); onMerge(true); }}>
                {busy === "merge" ? <span className="pr-spin" /> : null} Merge anyway
              </button>
              <button className="btn" onClick={() => setConfirmStale(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <span data-tip={tip} style={{ display: "flex" }}>
            <button
              className="btn primary"
              style={{ flex: 1 }}
              disabled={hardBlocked || !!busy || staleHold}
              onClick={() => onMerge(false)}
            >
              {busy === "merge" ? <span className="pr-spin" /> : <IconMerged />} Merge pull request
            </button>
          </span>
        )}
        {staleHold && !confirmStale && (
          <button className="btn pr-btn-ghost danger" onClick={() => setConfirmStale(true)}>
            <IconAlert size={13} /> Merge anyway…
          </button>
        )}
        {hardBlocked && <div className="pr-why">{reasons.join(" ")}</div>}
        {confirmClose ? (
          <div className="row">
            <button className="btn danger" disabled={!!busy} onClick={() => { setConfirmClose(false); onClose(); }}>
              {busy === "close" ? <span className="pr-spin" /> : <IconX />} Confirm close
            </button>
            <button className="btn" onClick={() => setConfirmClose(false)}>Cancel</button>
          </div>
        ) : (
          <button className="btn pr-btn-ghost" disabled={!!busy} onClick={() => setConfirmClose(true)}>
            <IconX size={13} /> Close pull request
          </button>
        )}
        {error && <div className="pr-error">{error}</div>}
        {notice && <div className="pr-success">{notice}</div>}
      </div>
    </div>
  );
}

const TIER_VAR: Record<RiskTier, string> = { auto: "var(--add)", review: "var(--warn)", block: "var(--del)" };

export function PolicyBox({ policy, eventCount }: { policy?: PolicyDecision; eventCount: number }) {
  if (!policy)
    return (
      <div className="panel pr-box">
        <h3><IconShield size={12} /> Policy</h3>
        <div className="pr-muted pr-small">Not evaluated yet.</div>
      </div>
    );
  const per = Object.values(policy.perEvent || {});
  const tally = (t: RiskTier) => per.filter((p) => p.tier === t).length;
  return (
    <div className="panel pr-box" style={{ borderColor: `color-mix(in srgb, ${TIER_VAR[policy.tier]} 40%, var(--border))` }}>
      <h3>
        <IconShield size={12} /> Policy <span className="pr-spacer" /> <TierBadge tier={policy.tier} />
      </h3>
      <ul className="pr-reasons" style={{ ["--c" as string]: TIER_VAR[policy.tier] }}>
        {policy.reasons.length ? policy.reasons.map((r, i) => <li key={i}>{r}</li>) : <li className="pr-muted">No rules matched.</li>}
      </ul>
      {per.length > 0 && (
        <div className="pr-muted pr-small" style={{ marginTop: 10, display: "flex", gap: 10 }}>
          <span>{pluralize(eventCount, "event")}:</span>
          {(["auto", "review", "block"] as RiskTier[]).map((t) =>
            tally(t) ? (
              <span key={t} style={{ color: TIER_VAR[t] }}>
                {tally(t)} {t}
              </span>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

export function BranchBox({ pr, branch }: { pr: PullRequest; branch?: Branch }) {
  const reads = Object.entries(branch?.readSet || {});
  return (
    <div className="panel pr-box">
      <h3>Branch</h3>
      <dl className="pr-kv">
        <dt>head</dt>
        <dd>{pr.branch}</dd>
        <dt>base</dt>
        <dd>main@{branch?.forkSeq ?? "?"}</dd>
        <dt>events</dt>
        <dd>{branch?.headSeq ?? "?"}</dd>
        <dt>author</dt>
        <dd style={{ fontFamily: "var(--sans)" }}><ActorChip actor={pr.author} /></dd>
        <dt>opened</dt>
        <dd style={{ fontFamily: "var(--sans)" }}>{fmtDateTime(pr.createdAt)}</dd>
      </dl>
      {reads.length > 0 && (
        <>
          <h3 style={{ marginTop: 12 }}>Read set <span className="pr-muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· what the agent looked at</span></h3>
          <dl className="pr-kv">
            {reads.map(([k, v]) => (
              <FragmentKV key={k} k={k} v={`v${v}`} changed={pr.staleness?.changedReads.find((c) => c.key === k)?.currentVersion} />
            ))}
          </dl>
        </>
      )}
    </div>
  );
}

function FragmentKV({ k, v, changed }: { k: string; v: string; changed?: number }) {
  return (
    <>
      <dt className="pr-mono" style={{ fontSize: 11 }}>{k}</dt>
      <dd style={changed ? { color: "var(--warn)" } : undefined}>
        {v}
        {changed ? ` → v${changed}` : ""}
      </dd>
    </>
  );
}

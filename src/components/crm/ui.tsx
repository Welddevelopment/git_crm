"use client";
/** OWNER: W10. Small shared presentational pieces. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Actor } from "@/core/types";
import type { FleetStatus } from "@/core/api-contract";
import s from "./crm.module.css";
import { actorLabel, timeAgo, type FeedLine } from "./lib";
import { useMockFlag } from "./data";

export function ActorChip({ actor, small }: { actor: Actor; small?: boolean }) {
  const cls = actor.kind === "agent" ? s.chipAgent : actor.kind === "human" ? s.chipHuman : s.chipSystem;
  const glyph = actor.kind === "agent" ? "◆" : actor.kind === "human" ? "●" : "○";
  return (
    <span className={`${s.chip} ${cls}`} style={small ? { fontSize: 11 } : undefined} title={`${actor.kind}: ${actor.id}`}>
      <span aria-hidden>{glyph}</span>{actorLabel(actor)}
    </span>
  );
}

export function MockNotice() {
  const m = useMockFlag();
  if (!m) return null;
  return (
    <span className={`${s.chip} ${s.chipWarn}`} title="API unreachable or ?mock=1 — using local demo data">
      <span className={`${s.dot} ${s.pulse}`} style={{ background: "var(--warn)" }} /> mock data
    </span>
  );
}

export function LiveDot() {
  const m = useMockFlag();
  return (
    <span className={`${s.chip} ${s.chipAdd}`} title="Updates live via server-sent events">
      <span className={`${s.dot} ${s.pulse}`} style={{ background: "var(--add)" }} /> {m ? "live (local)" : "live"}
    </span>
  );
}

/** Number that flashes when it changes. */
export function Stat({ label, value, hint, tone, big }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "warn" | "add" | "del" | "accent"; big?: boolean }) {
  const [k, setK] = useState(0);
  const prev = useRef<ReactNode>(value);
  useEffect(() => { if (prev.current !== value) { prev.current = value; setK((x) => x + 1); } }, [value]);
  const toneCls = tone === "warn" ? s.statWarn : tone === "add" ? s.statAdd : tone === "del" ? s.statDel : tone === "accent" ? s.statAccent : "";
  return (
    <div key={k} className={`${s.stat} ${big ? s.statBig : ""} ${toneCls} ${k ? s.flash : ""}`}>
      <div className={s.statLabel}>{label}</div>
      <div className={s.statValue}>{value}</div>
      {hint ? <div className={s.statHint}>{hint}</div> : null}
    </div>
  );
}

const LEVEL: Record<string, { cls: string; label: string }> = {
  probation: { cls: s.chipWarn, label: "probation" },
  trusted: { cls: s.chipAccent, label: "trusted" },
  autonomous: { cls: s.chipAdd, label: "autonomous" },
};
const scoreColor = (x: number) => (x >= 0.8 ? "var(--add)" : x >= 0.55 ? "var(--accent)" : "var(--warn)");

export function FleetPanel({ fleet, right }: { fleet: FleetStatus | null; right?: ReactNode }) {
  return (
    <div className={s.panel}>
      <div className={s.panelHead}>
        <span className={s.panelTitle}>Agent fleet</span>
        {right}
      </div>
      <div>
        {!fleet ? <div className={`${s.agent} ${s.muted}`}>Loading fleet…</div> : null}
        {fleet?.agents.map((a) => {
          const t = a.trust;
          const lv = LEVEL[t.level] || LEVEL.probation;
          return (
            <div key={a.id} className={s.agent}>
              {a.running ? <span className={s.spinner} title="running" /> : <span className={s.agentIcon}>{a.id.slice(0, 2).toUpperCase()}</span>}
              <div style={{ minWidth: 0 }}>
                <div className={s.row} style={{ gap: 8 }}>
                  <span className={s.agentName}>{a.name}</span>
                  <span className={`${s.chip} ${lv.cls}`}>{lv.label}</span>
                  {a.running ? <span className={`${s.small} ${s.pulse}`} style={{ color: "var(--agent)" }}>running…</span> : a.lastRunAt ? <span className={`${s.tiny} ${s.muted}`}>ran {timeAgo(a.lastRunAt)} ago</span> : null}
                </div>
                <div className={s.agentDesc}>{a.description}</div>
                <div className={s.scoreWrap}>
                  <div className={s.scoreBar}><div className={s.scoreFill} style={{ width: `${Math.round(t.score * 100)}%`, background: scoreColor(t.score) }} /></div>
                  <span className={`${s.mono} ${s.tiny}`} style={{ color: scoreColor(t.score) }}>{t.score.toFixed(2)}</span>
                </div>
              </div>
              <div className={s.counts}>
                <span title="PRs merged"><b style={{ color: "var(--add)" }}>{t.prsMerged}</b> merged</span>
                <span title="PRs reverted"><b style={{ color: t.prsReverted ? "var(--del)" : undefined }}>{t.prsReverted}</b> reverted</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function FeedLineView({ line, fresh }: { line: FeedLine; fresh?: boolean }) {
  const color = line.revert ? "var(--del)" : line.actor.kind === "agent" ? "var(--agent)" : line.actor.kind === "human" ? "var(--human)" : "var(--muted)";
  return (
    <div className={`${s.feedItem} ${fresh ? s.feedNew : ""}`}>
      <div className={s.feedTime}><span className={s.dot} style={{ background: color, marginRight: 6 }} />{timeAgo(line.ts)}</div>
      <div className={s.feedText}>
        {line.parts.map((p, i) => {
          if (p.t.startsWith("PR #") && line.pr) return <a key={i} href={`/prs/${line.pr}`} className={s.mono} style={p.kind === "del" ? { color: "var(--del)" } : undefined}>{p.t}</a>;
          if (p.kind === "b") return <b key={i} style={i === 0 ? { color } : undefined}>{p.t}</b>;
          if (p.kind === "val") return <span key={i} className={s.val}>{p.t}</span>;
          if (p.kind === "muted") return <span key={i} className={s.muted}>{p.t}</span>;
          if (p.kind === "del") return <span key={i} style={{ color: "var(--del)" }}>{p.t}</span>;
          return <span key={i}>{p.t}</span>;
        })}
      </div>
    </div>
  );
}

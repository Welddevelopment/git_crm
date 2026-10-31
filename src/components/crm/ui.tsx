"use client";
/** OWNER: W10. Small shared presentational pieces ("Calendly B": hairlines, pills, tabular numbers). */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Actor } from "@/core/types";
import type { FleetStatus } from "@/core/api-contract";
import s from "./crm.module.css";
import { actorLabel, prNum, timeAgo, type FeedLine } from "./lib";
import { useMockFlag } from "./data";

export function ActorChip({ actor, small }: { actor: Actor; small?: boolean }) {
  return (
    <span className={`${s.tag} ${actor.kind === "agent" ? s.tagAgent : ""}`} style={small ? { fontSize: 11 } : undefined} title={`${actor.kind}: ${actor.id}`}>
      {actorLabel(actor)}
    </span>
  );
}

export function MockNotice() {
  const m = useMockFlag();
  if (!m) return null;
  return (
    <span className={`${s.chip} ${s.chipWarn}`} title="API unreachable or ?mock=1 — using local demo data">
      Mock data — local demo, not your CRM
    </span>
  );
}

export function LiveDot() {
  const m = useMockFlag();
  return (
    <span className={s.live} title="Updates live via server-sent events">
      <span className={s.dot} style={{ background: "var(--positive)" }} /> {m ? "Live (local)" : "Live"}
    </span>
  );
}

export const InfoIcon = ({ title }: { title?: string }) => (
  <svg className={s.kpiInfo} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-label={title} role="img">
    <title>{title}</title>
    <circle cx="8" cy="8" r="6.3" /><path d="M8 7.2v3.6" strokeLinecap="round" /><circle cx="8" cy="5.1" r=".55" fill="currentColor" stroke="none" />
  </svg>
);

export interface KpiProps {
  label: string;
  value: ReactNode;
  /** numeric value used to show "since you opened this page" change */
  n?: number;
  /** explicit change text; overrides the since-load delta */
  change?: { text: string; tone: "pos" | "neg" | "flat" } | null;
  /** is an increase good? (colours the since-load delta) */
  upIs?: "good" | "bad";
  fmtDelta?: (d: number) => string;
  meta?: [ReactNode, ReactNode?];
  info?: string;
}

/** One KPI cell. Flashes --blue-soft briefly when the value changes. */
export function Kpi({ label, value, n, change, upIs = "good", fmtDelta, meta, info }: KpiProps) {
  const [flash, setFlash] = useState(false);
  const prev = useRef<ReactNode>(value);
  const base = useRef<number | undefined>(undefined);
  if (base.current === undefined && typeof n === "number") base.current = n;
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value; setFlash(true);
      const t = setTimeout(() => setFlash(false), 60);
      return () => clearTimeout(t);
    }
  }, [value]);
  let ch = change;
  if (ch === undefined && typeof n === "number" && base.current !== undefined && n !== base.current) {
    const d = n - base.current;
    const good = upIs === "good" ? d > 0 : d < 0;
    ch = { text: fmtDelta ? fmtDelta(d) : `${d > 0 ? "+" : "−"}${Math.abs(d)}`, tone: good ? "pos" : "neg" };
  }
  return (
    <div className={`${s.kpi} ${flash ? s.flash : ""}`}>
      <div className={s.kpiLabel}><span>{label}</span><InfoIcon title={info || label} /></div>
      <div className={s.kpiValueRow}>
        <span className={s.kpiValue}>{value}</span>
        {ch ? <span className={`${s.kpiChange} ${ch.tone === "pos" ? s.pos : ch.tone === "neg" ? s.neg : ""}`}>{ch.text}</span> : null}
      </div>
      {meta?.[0] !== undefined ? <div className={s.kpiMeta}>{meta[0]}</div> : null}
      {meta?.[1] !== undefined ? <div className={s.kpiMeta}>{meta[1]}</div> : null}
    </div>
  );
}

export function KpiStrip({ children }: { children: ReactNode }) {
  return <div className={s.kpis}>{children}</div>;
}

const LEVEL: Record<string, string> = { probation: "probation", trusted: "trusted", autonomous: "autonomous" };

export function FleetPanel({ fleet, right }: { fleet: FleetStatus | null; right?: ReactNode }) {
  return (
    <div className={`${s.panel} ${s.fleetPanel}`}>
      <div className={s.panelHead}>
        <span className={s.panelTitle}>Agent fleet · Trust</span>
        {right ?? (fleet ? <span className={s.panelMeta}>{fleet.agents.length} agents</span> : null)}
      </div>
      <div className={s.tableWrap}>
        <table className={s.fleetTable}>
          <thead>
            <tr><th className={s.idx}>#</th><th>Agent</th><th className={s.r}>Trust</th><th className={s.r}>Merged</th><th className={s.r}>Reverted</th></tr>
          </thead>
          <tbody>
            {!fleet ? <tr><td colSpan={5} className={s.faint}>Loading fleet…</td></tr> : null}
            {fleet?.agents.map((a, i) => {
              const t = a.trust;
              return (
                <tr key={a.id} className={a.running ? s.rowRunning : undefined} title={a.description}>
                  <td className={s.idx}>{i + 1}</td>
                  <td>
                    <span className={s.agentCell}>
                      {a.running ? <span className={s.spinner} title="running" /> : <span className={`${s.avatar} ${t.level === "autonomous" ? s.avatarActive : ""}`} title={`${a.name}: ${t.level}`}>{a.name.slice(0, 1).toUpperCase()}</span>}
                      <span className={s.agentName}>{a.name}</span>
                      {a.running ? <span className={s.youLabel}>running</span>
                        : <span className={s.levelTag} title={a.lastRunAt ? `ran ${timeAgo(a.lastRunAt)} ago` : undefined}>{LEVEL[t.level] || t.level}</span>}
                    </span>
                  </td>
                  <td className={s.r}>{Math.round(t.score * 100)}%</td>
                  <td className={s.r}>{t.prsMerged}</td>
                  <td className={`${s.r} ${t.prsReverted ? s.neg : ""}`}>{t.prsReverted}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A "Recent chats"-style row: actor tag · sentence + meta · PR on the right. */
export function FeedLineView({ line, fresh }: { line: FeedLine; fresh?: boolean }) {
  // parts[0] is the actor (shown as the tag); trailing parts are the PR / direct-write suffix (shown right + in meta)
  let body = line.parts.slice(1);
  let suffix: "pr" | "direct" | null = null;
  const prIdx = body.findIndex((p) => p.t.startsWith("PR #"));
  if (prIdx >= 0) { body = body.slice(0, Math.max(0, prIdx - 1)); suffix = "pr"; }
  else if (body.length && body[body.length - 1].t.includes("direct write")) { body = body.slice(0, -1); suffix = "direct"; }
  if (body[0]) body = [{ ...body[0], t: body[0].t.replace(/^\s+/, "").replace(/^./, (c) => c.toUpperCase()) }, ...body.slice(1)];
  const via = suffix === "pr" ? (line.revert ? "revert of" : "merged via") : suffix === "direct" ? "direct write to main, no review" : line.actor.kind === "human" ? "human edit" : "system";
  return (
    <div className={`${s.feedItem} ${fresh ? s.feedNew : ""}`}>
      <ActorChip actor={line.actor} />
      <div style={{ minWidth: 0 }}>
        <div className={s.feedTitle}>
          {body.map((p, i) => {
            if (p.kind === "b") return <b key={i}>{p.t}</b>;
            if (p.kind === "val") return <span key={i} className={s.val}>{p.t}</span>;
            if (p.kind === "muted") return <span key={i} className={s.faint}>{p.t}</span>;
            if (p.kind === "del") return <span key={i} className={s.neg}>{p.t}</span>;
            return <span key={i}>{p.t}</span>;
          })}
        </div>
        <div className={s.feedMeta}>
          {timeAgo(line.ts)} ago · <span className={suffix === "direct" || line.revert ? s.neg : undefined}>{via}{suffix === "pr" && line.pr ? ` PR ${prNum(line.pr)}` : ""}</span>
        </div>
      </div>
      <div className={s.feedValue}>
        {line.pr ? <a href={`/prs/${line.pr}`} className={line.revert ? s.neg : undefined}>{prNum(line.pr)}</a>
          : suffix === "direct" ? <span className={s.neg}>no PR</span> : <span className={s.faint}>—</span>}
      </div>
    </div>
  );
}

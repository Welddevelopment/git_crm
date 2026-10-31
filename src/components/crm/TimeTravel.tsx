"use client";
/** OWNER: W10. /timeline — drag through main's history; deals + forecast re-render via api.state({at}). */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CRMState } from "@/core/types";
import type { TimelineEntry } from "@/core/api-contract";
import s from "./crm.module.css";
import { src, useLive } from "./data";
import { actorColor, describeTimeline, fmtDate, fmtDateLong, foldEvents, pipelineTotal, prNum, signedUsd, usd, type FeedLine } from "./lib";
import { EntityTable } from "./EntityTable";
import { FeedLineView, LiveDot, MockNotice } from "./ui";
import { timelineMeta } from "./CrmView";

interface Moment {
  idx: number;
  at: number; // ts of the last event in the moment (state is "as of" this)
  from: number;
  entries: TimelineEntry[];
  kind: "seed" | "merge" | "revert" | "direct" | "human" | "system";
  pr?: string;
  color: string;
  pipeline: number;
}

/** Group main's log into scrub stops: one per PR merge, per revert, per direct write; seed runs collapse. */
function toMoments(entries: TimelineEntry[]): Moment[] {
  const out: Moment[] = [];
  const all = entries.map((e) => e.event);
  let cur: Omit<Moment, "idx" | "pipeline"> | null = null;
  let upto = 0;
  const flush = () => {
    if (!cur) return;
    const st = foldEvents(all.slice(0, upto));
    out.push({ ...cur, idx: out.length, pipeline: pipelineTotal(st) });
    cur = null;
  };
  entries.forEach((en, i) => {
    const ev = en.event;
    const pr = en.pr || (ev.origin && "pr" in ev.origin ? ev.origin.pr : undefined);
    const isRevert = ev.origin?.kind === "revert" || ev.actor.id === "revert";
    const kind: Moment["kind"] =
      ev.actor.kind === "system" && ev.actor.id === "seed" ? "seed"
        : isRevert ? "revert"
        : pr ? "merge"
        : ev.actor.kind === "agent" ? "direct"
        : ev.actor.kind === "human" ? "human" : "system";
    const groupKey = kind === "seed" ? "seed" : pr ? `${kind}:${pr}` : `${kind}:${ev.id}`;
    const curKey = cur ? (cur.kind === "seed" ? "seed" : cur.pr ? `${cur.kind}:${cur.pr}` : `${cur.kind}:${cur.entries[0].event.id}`) : "";
    if (!cur || curKey !== groupKey) {
      flush();
      cur = { at: ev.ts, from: ev.ts, entries: [], kind, pr, color: kind === "seed" ? "var(--border)" : actorColor(ev.actor, isRevert) };
    }
    cur.entries.push(en);
    cur.at = Math.max(cur.at, ev.ts);
    upto = i + 1;
  });
  flush();
  return out;
}

const KIND_LABEL: Record<Moment["kind"], string> = { seed: "seed import", merge: "PR merged", revert: "revert", direct: "direct agent write", human: "human edit", system: "system" };

export default function TimeTravel() {
  const { data: both } = useLive(async () => {
    const [t, st] = await Promise.all([src.timeline(), src.state()]);
    return { tl: t.entries, live: st.state };
  });
  const tl = both?.tl ?? null;
  const live = both?.live ?? null;
  const moments = useMemo(() => toMoments(tl || []), [tl]);
  const last = moments.length - 1;

  const [idx, setIdx] = useState<number | null>(null); // null = following "now"
  const cur = idx === null ? last : Math.min(idx, last);
  const atNow = idx === null || cur === last;

  // fetch state at the moment (debounced), cached per `at`
  const cache = useRef(new Map<number, CRMState>());
  const [past, setPast] = useState<{ at: number; state: CRMState } | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => { cache.current.clear(); }, [tl]);
  useEffect(() => {
    if (atNow || !moments[cur]) { setLoading(false); return; }
    const at = moments[cur].at;
    const hit = cache.current.get(at);
    if (hit) { setPast({ at, state: hit }); setLoading(false); return; }
    setLoading(true);
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const r = await src.state({ at });
        cache.current.set(at, r.state);
        if (alive) setPast({ at, state: r.state });
      } finally { if (alive) setLoading(false); }
    }, 120);
    return () => { alive = false; clearTimeout(t); };
  }, [cur, atNow, moments]);

  const shown: CRMState | null = atNow ? live : past?.state || live;
  const meta = useMemo(() => timelineMeta(tl || []), [tl]);
  const nowTotal = pipelineTotal(live);
  const shownTotal = atNow ? nowTotal : past ? pipelineTotal(past.state) : moments[cur]?.pipeline ?? nowTotal;
  const delta = shownTotal - nowTotal;

  // what happened at this moment
  const lines: FeedLine[] = useMemo(() => {
    if (!tl || !moments[cur]) return [];
    const all = describeTimeline(tl, live, { includeSeed: true });
    const ids = new Set(moments[cur].entries.map((e) => e.event.id));
    return all.filter((l) => ids.has(l.key));
  }, [tl, moments, cur, live]);

  // ---------- slider ----------
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const pct = (i: number) => (last <= 0 ? 100 : (i / last) * 100);
  const fromClientX = useCallback((x: number) => {
    const el = trackRef.current;
    if (!el || last < 0) return;
    const r = el.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (x - r.left) / r.width));
    const i = Math.round(p * last);
    setIdx(i >= last ? null : i);
  }, [last]);
  const step = (d: number) => setIdx((x) => { const n = Math.min(last, Math.max(0, (x ?? last) + d)); return n >= last ? null : n; });
  const jumpEvent = (d: 1 | -1) => {
    let i = cur + d;
    while (i >= 0 && i <= last && moments[i].kind === "seed") i += d;
    if (i < 0 || i > last) return;
    setIdx(i >= last ? null : i);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); e.shiftKey ? jumpEvent(-1) : step(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); e.shiftKey ? jumpEvent(1) : step(1); }
    else if (e.key === "Home") { e.preventDefault(); setIdx(0); }
    else if (e.key === "End") { e.preventDefault(); setIdx(null); }
  };

  // sparkline of pipeline across moments
  const spark = useMemo(() => {
    if (moments.length < 2) return "";
    const vals = moments.map((m) => m.pipeline);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const span = hi - lo || 1;
    return vals.map((v, i) => `${i ? "L" : "M"}${(i / last) * 1000},${26 - ((v - lo) / span) * 22}`).join(" ");
  }, [moments, last]);

  // date labels
  const labels = useMemo(() => {
    if (moments.length < 2) return [];
    const out: { i: number; t: string }[] = [];
    let lastDay = "";
    moments.forEach((m, i) => {
      const d = new Date(m.at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      if (d !== lastDay) { lastDay = d; out.push({ i, t: d }); }
    });
    // thin out
    const minGap = Math.max(1, Math.ceil(moments.length / 9));
    return out.filter((l, k) => k === 0 || l.i - out[k - 1].i >= minGap || k === out.length - 1);
  }, [moments]);

  const m = moments[cur];

  return (
    <div className={s.page}>
      <div className={s.headerRow}>
        <div>
          <div className={s.row}><span className={s.eyebrow}>Time travel · main</span><LiveDot /><MockNotice /></div>
          <h1 className={s.h1}>Rewind main to any point in its history</h1>
          <div className={s.sub}>Main is an append-only log, so any past state is one fold away. Drag the slider; deals and the forecast are recomputed as of that moment.</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className={s.statLabel}>Pipeline forecast {atNow ? "· now" : "· then"}</div>
          <div className={s.bigTotal} style={{ color: atNow ? "var(--text)" : "var(--warn)" }}>{shown ? usd(shownTotal) : "—"}</div>
          {!atNow ? <div className={`${s.delta} ${delta > 0 ? s.deltaUp : s.deltaDown}`}>{delta === 0 ? "same as now" : `${signedUsd(-delta)} since then`}</div> : <div className={`${s.small} ${s.muted}`}>head seq {live?.headSeq ?? "—"}</div>}
        </div>
      </div>

      <div className={`${s.banner} ${atNow ? s.bannerLive : ""}`}>
        {atNow ? (
          <><span className={`${s.dot} ${s.pulse}`} style={{ background: "var(--add)" }} /><span>Viewing main <b>now</b> · following head</span></>
        ) : (
          <>
            <span style={{ fontSize: 16 }}>⏪</span>
            <span>Viewing main as of <b className={s.mono}>{m ? fmtDateLong(m.at) : ""}</b></span>
            <span className={s.muted}>· stop {cur + 1}/{moments.length}</span>
            {loading ? <span className={s.spinner} /> : null}
          </>
        )}
        <span className={s.grow} />
        <button className={`${s.btn}`} onClick={() => jumpEvent(-1)} disabled={cur <= 0} title="Previous change (Shift+←)">◀ prev change</button>
        <button className={`${s.btn}`} onClick={() => jumpEvent(1)} disabled={atNow} title="Next change (Shift+→)">next change ▶</button>
        <button className={`${s.btn} ${s.btnPrimary}`} onClick={() => setIdx(null)} disabled={atNow}>Back to now</button>
      </div>

      <div className={s.panel} style={{ padding: "14px 6px 6px" }}>
        <div
          className={`${s.slider} ${dragging ? s.sliderDragging : ""}`}
          tabIndex={0}
          role="slider"
          aria-valuemin={0}
          aria-valuemax={last}
          aria-valuenow={cur}
          aria-valuetext={m ? fmtDateLong(m.at) : ""}
          onKeyDown={onKey}
          onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); setDragging(true); fromClientX(e.clientX); }}
          onPointerMove={(e) => { if (dragging) fromClientX(e.clientX); }}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
        >
          <div ref={trackRef} style={{ position: "absolute", left: 12, right: 12, top: 0, bottom: 0 }}>
            {spark ? (
              <svg viewBox="0 0 1000 28" preserveAspectRatio="none" style={{ position: "absolute", left: 0, right: 0, top: 2, width: "100%", height: 28, opacity: 0.5, pointerEvents: "none" }}>
                <path d={spark} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
              </svg>
            ) : null}
            {moments.map((mm) => mm.kind === "seed" ? null : (
              <span key={mm.idx} className={`${s.tick} ${s.tickUp}`} title={`${KIND_LABEL[mm.kind]}${mm.pr ? " " + prNum(mm.pr) : ""} · ${fmtDate(mm.at)}`}
                style={{ left: `${pct(mm.idx)}%`, background: mm.color, opacity: mm.idx === cur ? 1 : 0.75, height: mm.kind === "revert" || mm.kind === "direct" ? 24 : 20, top: mm.kind === "revert" || mm.kind === "direct" ? 4 : 8 }} />
            ))}
            <div className={s.sliderTrack} style={{ left: 0, right: 0 }}>
              <div className={s.sliderFill} style={{ width: `${pct(cur)}%`, transition: dragging ? "none" : "width 140ms ease" }} />
            </div>
            <div className={s.sliderThumb} style={{ left: `${pct(cur)}%`, transition: dragging ? "none" : "left 140ms ease" }} />
            {labels.map((l) => <span key={l.i} className={s.tickLabel} style={{ left: `${pct(l.i)}%` }}>{l.t}</span>)}
          </div>
        </div>
        <div className={s.row} style={{ justifyContent: "space-between", padding: "8px 12px 4px" }}>
          <div className={s.legend}>
            <span><i className={s.dot} style={{ background: "var(--agent)" }} />agent PR merged</span>
            <span><i className={s.dot} style={{ background: "var(--human)" }} />human</span>
            <span><i className={s.dot} style={{ background: "var(--muted)" }} />system / auto-merge</span>
            <span><i className={s.dot} style={{ background: "var(--del)" }} />revert</span>
            <span><svg width="16" height="6"><path d="M0,5 L5,2 L10,4 L16,1" stroke="var(--accent)" fill="none" /></svg>forecast</span>
          </div>
          <span className={`${s.tiny} ${s.muted} ${s.mono}`}>← → step · shift+← → jump to change · End = now</span>
        </div>
      </div>

      <div className={s.two} style={{ gridTemplateColumns: "minmax(0, 2.2fr) minmax(0, 1fr)" }}>
        <div className={s.panel}>
          <div className={s.panelHead}>
            <span className={s.panelTitle}>Deals {atNow ? "· now" : "· as of " + (m ? fmtDate(m.at) : "")}</span>
            {!atNow ? <span className={`${s.tiny} ${s.muted}`}><span className={s.dot} style={{ background: "var(--warn)", marginRight: 6 }} />differs from now (hover for current)</span> : null}
          </div>
          {loading && !past ? <div className={s.loadingBar} /> : <div style={{ height: 2, opacity: loading ? 1 : 0 }} className={loading ? s.loadingBar : ""} />}
          {shown ? (
            <div style={{ opacity: loading ? 0.7 : 1, transition: "opacity 120ms" }}>
              <EntityTable state={shown} type="deal" compareTo={atNow ? null : live} newFields={meta.newFields} prByEvent={meta.prByEvent} blame={atNow} />
            </div>
          ) : <div className={`${s.cell} ${s.muted}`}>Loading…</div>}
        </div>
        <div className={s.panel}>
          <div className={s.panelHead}>
            <span className={s.panelTitle}>At this point</span>
            {m ? <span className={`${s.chip}`} style={{ color: m.color, borderColor: m.color }}>{KIND_LABEL[m.kind]}{m.pr ? " " + prNum(m.pr) : ""}</span> : null}
          </div>
          <div style={{ maxHeight: 460, overflow: "auto" }}>
            {m?.kind === "seed" ? (
              <div className={`${s.feedItem}`}><span className={s.feedTime}>{fmtDate(m.at)}</span><span>Initial import: <b>{m.entries.length}</b> events (schema + records).</span></div>
            ) : lines.map((l) => <FeedLineView key={l.key} line={l} />)}
            {m?.pr ? <div style={{ padding: "8px 14px" }}><a href={`/prs/${m.pr}`} className={s.small}>Open PR {prNum(m.pr)} →</a></div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

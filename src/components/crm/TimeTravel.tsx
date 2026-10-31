"use client";
/** OWNER: W10. /timeline — drag through main's history; deals + forecast re-render via api.state({at}). */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CRMState } from "@/core/types";
import type { TimelineEntry } from "@/core/api-contract";
import s from "./crm.module.css";
import { src, useLive } from "./data";
import { describeTimeline, fmtDate, fmtDateLong, foldEvents, pipelineTotal, prNum, signedUsd, usd, type FeedLine } from "./lib";
import { EntityTable } from "./EntityTable";
import { FeedLineView, MockNotice } from "./ui";
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
      cur = { at: ev.ts, from: ev.ts, entries: [], kind, pr, color: KIND_COLOR[kind] };
    }
    cur.entries.push(en);
    cur.at = Math.max(cur.at, ev.ts);
    upto = i + 1;
  });
  flush();
  return out;
}

/** Ticks: agent merges in --blue, reverts --negative, everything else in blue-greys. */
const KIND_COLOR: Record<Moment["kind"], string> = { seed: "var(--series-4)", merge: "var(--blue)", revert: "var(--negative)", direct: "var(--negative)", human: "var(--series-2)", system: "var(--series-3)" };

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
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState<{ id: string; title: string } | null>(null);
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
          <h1 className={s.title}>Time travel</h1>
          <div className={s.sub}><span>Main is an append-only log, so any past state is one fold away. Drag the slider; deals and the forecast are recomputed as of that moment.</span></div>
        </div>
        <div className={s.row} style={{ alignItems: "flex-end", gap: 12 }}>
          <MockNotice />
          <div className={s.stat}>
            <div className={s.statLabel}>Pipeline forecast {atNow ? "· now" : "· then"}</div>
            <div className={s.row} style={{ alignItems: "baseline", gap: 6, flexWrap: "nowrap" }}>
              <span className={s.bigTotal}>{shown ? usd(shownTotal) : "—"}</span>
              {!atNow && delta !== 0 ? <span className={`${s.delta} ${delta > 0 ? s.deltaUp : s.deltaDown}`}>{signedUsd(-delta)}</span> : null}
            </div>
            <div className={s.statHint}>{atNow ? `head seq ${live?.headSeq ?? "—"}` : delta === 0 ? "same as now" : "change since then"}</div>
          </div>
        </div>
      </div>

      {restored ? (
        <div className={`${s.banner} ${s.bannerLive}`} style={{ marginBottom: 12 }}>
          <span className={s.dot} style={{ background: "var(--positive)" }} />
          <span>Restored. Merged as <a href={`/prs/${restored.id}`}><b>{restored.title}</b></a> ({prNum(restored.id)}). Revert that PR to undo it.</span>
          <span className={s.grow} />
          <button className={s.btn} onClick={() => setRestored(null)}>Dismiss</button>
        </div>
      ) : null}
      <div className={`${s.banner} ${atNow ? s.bannerLive : s.bannerPast}`}>
        {atNow ? (
          <><span className={s.dot} style={{ background: "var(--positive)" }} /><span>Viewing main <b>now</b> <span className={s.faint}>· following head</span></span></>
        ) : (
          <>
            <span>Viewing main as of <b>{m ? fmtDateLong(m.at) : ""}</b></span>
            <span>· stop {cur + 1}/{moments.length}</span>
            {loading ? <span className={s.spinner} /> : null}
          </>
        )}
        <span className={s.grow} />
        <button className={s.btn} onClick={() => jumpEvent(-1)} disabled={cur <= 0} title="Previous change (Shift+←)">← Prev change</button>
        <button className={s.btn} onClick={() => jumpEvent(1)} disabled={atNow} title="Next change (Shift+→)">Next change →</button>
        {!atNow && m ? (
          <button
            className={s.btn}
            style={{ color: "var(--negative)", borderColor: "color-mix(in srgb, var(--negative) 35%, var(--line))" }}
            disabled={restoring}
            title="Opens one PR that sets main back to exactly this moment, and merges it. Revert that PR to undo."
            onClick={async () => {
              if (!window.confirm(`Restore the whole CRM to how it was at ${fmtDateLong(m.at)}?\n\nEverything changed since then is undone in one PR. You can revert that PR to undo the restore.`)) return;
              setRestoring(true);
              try {
                const r = await fetch("/api/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ at: m.at, by: "Joel" }) });
                const body = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
                setRestored({ id: body.pr.id, title: body.pr.title });
                cache.current.clear();
                setIdx(null);
              } catch (e) {
                window.alert(`Restore failed: ${e instanceof Error ? e.message : String(e)}`);
              } finally {
                setRestoring(false);
              }
            }}
          >{restoring ? <span className={s.spinner} /> : null}Restore to this point</button>
        ) : null}
        <button className={`${s.btn} ${s.btnPrimary}`} onClick={() => setIdx(null)} disabled={atNow}>Back to now</button>
      </div>

      <div className={s.panel} style={{ padding: "12px 0 4px" }}>
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
          <div ref={trackRef} style={{ position: "absolute", left: 16, right: 16, top: 0, bottom: 0 }}>
            {spark ? (
              <svg viewBox="0 0 1000 28" preserveAspectRatio="none" style={{ position: "absolute", left: 0, right: 0, top: 2, width: "100%", height: 28, pointerEvents: "none" }}>
                <path d={spark} fill="none" stroke="var(--series-3)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
              </svg>
            ) : null}
            {moments.map((mm) => mm.kind === "seed" ? null : (
              <span key={mm.idx} className={`${s.tick} ${s.tickUp}`} title={`${KIND_LABEL[mm.kind]}${mm.pr ? " " + prNum(mm.pr) : ""} · ${fmtDate(mm.at)}`}
                style={{ left: `${pct(mm.idx)}%`, background: mm.color, opacity: mm.idx === cur ? 1 : 0.8, height: mm.kind === "revert" || mm.kind === "direct" ? 20 : 16, top: mm.kind === "revert" || mm.kind === "direct" ? 10 : 14 }} />
            ))}
            <div className={s.sliderTrack} style={{ left: 0, right: 0 }}>
              <div className={s.sliderFill} style={{ width: `${pct(cur)}%`, transition: dragging ? "none" : "width 140ms ease" }} />
            </div>
            <div className={s.sliderThumb} style={{ left: `${pct(cur)}%`, transition: dragging ? "none" : "left 140ms ease" }} />
            {labels.map((l) => <span key={l.i} className={s.tickLabel} style={{ left: `${pct(l.i)}%`, transform: l.i === 0 ? "none" : l.i === last ? "translateX(-100%)" : undefined }}>{l.t}</span>)}
          </div>
        </div>
        <div className={s.row} style={{ justifyContent: "space-between", padding: "10px 16px 8px", borderTop: "var(--hairline)" }}>
          <div className={s.legend}>
            <span><i className={s.swatch} style={{ background: "var(--blue)" }} />Agent PR merged</span>
            <span><i className={s.swatch} style={{ background: "var(--series-2)" }} />Human</span>
            <span><i className={s.swatch} style={{ background: "var(--series-3)" }} />System</span>
            <span><i className={s.swatch} style={{ background: "var(--negative)" }} />Revert / direct write</span>
            <span><svg width="16" height="6" aria-hidden><path d="M0,5 L5,2 L10,4 L16,1" stroke="var(--series-3)" strokeWidth="1.5" fill="none" /></svg>Forecast</span>
          </div>
          <span className={`${s.tiny} ${s.faint}`}>← → step · Shift+← → jump to change · End = now</span>
        </div>
      </div>

      <div className={s.two} style={{ gridTemplateColumns: "minmax(0, 2.6fr) minmax(0, 1fr)" }}>
        <div className={s.panel}>
          <div className={s.panelHead}>
            <span className={s.panelTitle}>Deals {atNow ? "· now" : "· as of " + (m ? fmtDate(m.at) : "")}</span>
            {!atNow ? <span className={s.panelMeta}><span className={s.swatch} style={{ background: "var(--notice-bg)", border: "1px solid var(--notice-ink)", height: 8, width: 12, marginRight: 6, verticalAlign: 0 }} />differs from now (hover for current)</span> : null}
          </div>
          {loading && !past ? <div className={s.loadingBar} /> : <div style={{ height: 2, opacity: loading ? 1 : 0 }} className={loading ? s.loadingBar : ""} />}
          {shown ? (
            <div style={{ opacity: loading ? 0.7 : 1, transition: "opacity 120ms" }}>
              <EntityTable state={shown} type="deal" compareTo={atNow ? null : live} newFields={meta.newFields} prByEvent={meta.prByEvent} blame={atNow} />
            </div>
          ) : <div className={`${s.cell} ${s.faint}`}>Loading…</div>}
        </div>
        <div className={s.panel}>
          <div className={s.panelHead}>
            <span className={s.panelTitle}>At this point</span>
            {m ? <span className={s.chip} style={{ color: m.kind === "merge" || m.kind === "revert" || m.kind === "direct" ? m.color : undefined }}><i className={s.dot} style={{ background: m.color }} />{KIND_LABEL[m.kind]}{m.pr ? " " + prNum(m.pr) : ""}</span> : null}
          </div>
          <div style={{ maxHeight: 460, overflow: "auto" }}>
            {m?.kind === "seed" ? (
              <div className={s.feedItem}><span className={s.tag}>seed</span><div><div className={s.feedTitle}>Initial import: <b>{m.entries.length}</b> events (schema + records)</div><div className={s.feedMeta}>{fmtDate(m.at)}</div></div><span /></div>
            ) : lines.map((l) => <FeedLineView key={l.key} line={l} />)}
            {m?.pr ? <div style={{ padding: "12px 16px" }}><a href={`/prs/${m.pr}`} className={s.btn}>Open PR {prNum(m.pr)}</a></div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

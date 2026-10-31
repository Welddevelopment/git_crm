"use client";
/** OWNER: graph worker. Contract: default export, props below. Overview mounts <BranchGraph height={260} />; PR page may mount <BranchGraph focusPr="pr_4" compact />. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as RME } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/client/api";
import s from "./graph.module.css";
import { layout, type BranchPos, type ChipKind, type MainPos } from "./layout";
import type { GraphData, GraphMainNode } from "./types";

export interface BranchGraphProps { height?: number; focusPr?: string; compact?: boolean }

const KNOWN = ["inbox", "hygiene", "schema", "webwatch"] as const;
const OTHERS = ["var(--g-other1)", "var(--g-other2)", "var(--g-other3)"];
function agentColor(id: string): string {
  if ((KNOWN as readonly string[]).includes(id)) return `var(--g-${id})`;
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return OTHERS[h % OTHERS.length]!;
}
function mainColor(n: GraphMainNode): string {
  switch (n.kind) {
    case "human": return "var(--human)";
    case "merge": return "var(--agent)";
    case "direct": return "var(--del)";
    case "revert": return "var(--del)";
    default: return "var(--muted)";
  }
}
const CHIP_CLASS: Record<ChipKind, string> = {
  stale: s.chipStale!, conflict: s.chipConflict!, outdated: s.chipConflict!, block: s.chipBlock!, auto: s.chipAuto!, review: s.chipReview!, closed: s.chipReview!,
};
const fmtWhen = (ts: number) => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const statusText = (b: BranchPos["b"]) =>
  b.status === "open" ? (b.stale ? "open · stale" : b.conflicts ? `open · ${b.conflicts} conflict(s)` : b.versionConflict ? "open · main moved" : "open")
  : b.status === "merged" ? `merged${b.mergedBy ? ` by ${b.mergedBy}` : ""}` : b.status === "reverted" ? `reverted${b.revertedBy ? ` by #${b.revertedBy.replace(/^pr_/, "")}` : ""}` : "closed";

const EMPTY: GraphData = { main: [], branches: [], headSeq: 0, now: 0 };

type TipBody = { kind: "branch"; b: BranchPos["b"] } | { kind: "main"; n: GraphMainNode };
type Tip = TipBody & { x: number; y: number };

export default function BranchGraph({ height: heightProp, focusPr, compact = false }: BranchGraphProps) {
  const height = heightProp ?? (compact ? 120 : 260);
  const router = useRouter();
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(1200);
  const [tip, setTip] = useState<Tip | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null); // keys drawn already; null until first data paint
  const fresh = useRef<Set<string>>(new Set());
  const stick = useRef(true); // keep scrolled to the right edge ("now") unless the user scrolled away

  // ---- data: fetch + live subscribe (debounced) ----
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/graph", { cache: "no-store" });
      if (!r.ok) throw new Error(`GET /api/graph -> ${r.status}`);
      setData((await r.json()) as GraphData);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    let t: ReturnType<typeof setTimeout> | undefined;
    const unsub = api.subscribe(() => { clearTimeout(t); t = setTimeout(() => void load(), 300); });
    const poll = setInterval(() => void load(), 15_000); // safety net if the stream drops
    return () => { clearTimeout(t); clearInterval(poll); unsub(); };
  }, [load]);

  // ---- width ----
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => { if (e) setWidth(Math.max(320, Math.floor(e.contentRect.width))); });
    ro.observe(el);
    setWidth(Math.max(320, Math.floor(el.clientWidth)));
    return () => ro.disconnect();
  }, []);

  const chrome = compact ? 0 : 36 + 38; // head + legend
  const L = useMemo(() => layout(data ?? EMPTY, { width, height: Math.max(compact ? 60 : 120, height - chrome), compact }), [data, width, height, compact, chrome]);

  // ---- which elements are new since last paint (drives draw-in animation) ----
  const keysNow = useMemo(() => {
    const k: string[] = [];
    for (const b of L.branches) {
      k.push(`f:${b.b.pr}:${b.b.createdAt}`);
      if (b.endPath) k.push(`e:${b.b.pr}:${b.b.createdAt}:${b.b.status}`);
    }
    for (const m of L.main) k.push(`m:${m.node.firstSeq}:${m.node.ts}`);
    return k;
  }, [L]);
  if (data) {
    if (seen.current === null) { seen.current = new Set(keysNow); fresh.current = new Set(); }
    else {
      const f = new Set<string>();
      for (const k of keysNow) if (!seen.current.has(k)) { f.add(k); seen.current.add(k); }
      if (f.size) fresh.current = f;
    }
  }
  const isNew = (k: string) => fresh.current.has(k);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollLeft = el.scrollWidth;
  }, [L.width]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollLeft + el.clientWidth >= el.scrollWidth - 24;
  };

  const showTip = (e: RME, t: TipBody) => {
    const host = wrapRef.current?.getBoundingClientRect();
    if (!host) return;
    const x = Math.min(e.clientX - host.left + 14, host.width - 330);
    setTip({ ...t, x: Math.max(4, x), y: e.clientY - host.top + 14 });
  };
  const go = (pr?: string) => { if (pr) router.push(`/prs/${pr}`); };

  const open = data?.branches.filter((b) => b.status === "open").length ?? 0;
  const merged = data?.branches.filter((b) => b.status === "merged").length ?? 0;
  const reverted = data?.branches.filter((b) => b.status === "reverted").length ?? 0;
  const svgH = L.height;
  const focused = focusPr ? L.branches.find((b) => b.b.pr === focusPr) : undefined;

  return (
    <div className={`${s.root} ${compact ? s.compact : ""}`} style={{ height: compact ? undefined : Math.max(height, svgH + chrome) }}>
      {!compact && (
        <div className={s.head}>
          <div className={s.title}>
            <span>⎇ Branch graph</span>
            <b className="mono">main</b>
          </div>
          <div className={s.meta}>
            <span><span className={s.n}>{open}</span> open</span>
            <span><span className={s.n}>{merged}</span> merged</span>
            {reverted ? <span><span className={s.n}>{reverted}</span> reverted</span> : null}
            <span>head <span className={s.n}>@{data?.headSeq ?? "—"}</span></span>
            <span className={s.live} title="live" />
          </div>
        </div>
      )}
      <div className={s.canvas} ref={wrapRef} onMouseLeave={() => setTip(null)}>
        <div className={s.scroller} ref={scrollRef} onScroll={onScroll}>
          {!data ? (
            <div className={s.status} style={{ height: svgH }}>{error ? <span className={s.err}>graph unavailable: {error}</span> : "loading graph…"}</div>
          ) : (
            <svg className={s.svg} width={L.width} height={svgH} viewBox={`0 0 ${L.width} ${svgH}`} role="img" aria-label={`Branch graph: ${open} open, ${merged} merged`}>
              {/* era divider + day ticks */}
              {L.ticks.map((t) => (
                <g key={`t${t.x}`}>
                  <text className={s.tick} x={t.x} y={L.mainY - 14} textAnchor="start">{t.text}</text>
                </g>
              ))}
              {L.divider && (
                <g className={s.moveable} style={{ transform: `translateX(${L.divider.x}px)` }}>
                  <line className={s.tickLine} x1={0} x2={0} y1={L.mainY - 22} y2={svgH - 4} />
                  {!compact && <text className={s.eraLabel} x={6} y={L.mainY - 14}>{L.divider.label}</text>}
                </g>
              )}

              {/* branches: lines layer, then marks layer on top */}
              {(["lines", "marks"] as const).map((layer) => <g key={layer}>{L.branches.map((bp) => {
                const b = bp.b;
                const c = agentColor(b.author);
                const dim = !!focusPr && b.pr !== focusPr;
                const reverted = b.status === "reverted";
                const closed = b.status === "closed";
                const fNew = isNew(`f:${b.pr}:${b.createdAt}`);
                const eNew = isNew(`e:${b.pr}:${b.createdAt}:${b.status}`);
                const tipFor = (e: RME) => showTip(e, { kind: "branch", b });
                return (
                  <g key={b.pr + layer} className={`${s.branch} ${dim ? s.dim : ""} ${b.pr === focusPr ? s.focus : ""}`}
                    onMouseMove={tipFor} onMouseLeave={() => setTip(null)} onClick={() => go(b.pr)} style={{ cursor: "pointer" }}>
                    {layer === "lines" && <>
                    <path className={`${s.seg} ${fNew ? s.draw : ""}`} d={bp.forkPath} stroke={c} pathLength={1} style={closed ? { opacity: 0.45 } : undefined} />
                    {bp.endPath && (
                      <path className={`${s.seg} ${eNew ? s.draw : ""}`} d={bp.endPath} pathLength={1}
                        stroke={reverted ? "var(--del)" : c}
                        style={eNew ? { animationDelay: fNew ? ".7s" : "0s" } : undefined} />
                    )}
                    {bp.tailPath && <path className={`${s.tail} ${fNew ? s.fadeIn : ""}`} d={bp.tailPath} stroke={c} style={fNew ? { animationDelay: ".6s" } : undefined} />}
                    <path className={s.hit} d={bp.endPath ? `${bp.forkPath} ${bp.endPath}` : `${bp.forkPath} L${bp.chipX},${bp.y}`} />
                    </>}
                    {layer === "marks" && <>
                    {/* PR head */}
                    <g className={fNew ? s.pop : ""} style={fNew ? { animationDelay: ".55s" } : undefined}>
                      {b.pr === focusPr && <circle className={s.headRing} cx={bp.headX} cy={bp.y} r={compact ? 7 : 9} stroke={c} />}
                      <circle className={s.dot} cx={bp.headX} cy={bp.y} r={compact ? 3.4 : 5} fill={closed ? "var(--panel-2)" : c} stroke={closed ? c : undefined} />
                    </g>
                    {!compact && (
                      <rect className={fNew ? s.fadeIn : ""} x={bp.labelX - 3} y={bp.y - 8} width={bp.labelW - 4} height={16} rx={4} fill="var(--panel)" style={fNew ? { animationDelay: ".6s" } : undefined} />
                    )}
                    {!compact && (
                      <text className={`${s.label} ${closed ? s.closed : ""} ${fNew ? s.fadeIn : ""}`} x={bp.labelX} y={bp.y + 3.8} style={fNew ? { animationDelay: ".6s" } : undefined}>
                        <tspan className={s.num}>{bp.label.split(" ")[0]}</tspan> {bp.label.split(" ").slice(1).join(" ")}
                      </text>
                    )}
                    {reverted && bp.mergeX !== undefined && !compact && (
                      <text className={s.revertGlyph} x={bp.mergeX - 22} y={bp.y - 5}>↺</text>
                    )}
                    {bp.chip && !compact && (
                      <g className={`${s.chip} ${CHIP_CLASS[bp.chip.kind]} ${fNew ? s.fadeIn : ""}`} style={{ transform: `translate(${bp.chipX}px, ${bp.y - 8}px)`, ...(fNew ? { animationDelay: ".75s" } : {}) }}>
                        <rect width={bp.chip.w} height={16} rx={8} />
                        <text x={bp.chip.w / 2} y={11.5} textAnchor="middle">{bp.chip.text}</text>
                      </g>
                    )}
                    {bp.chip && compact && (
                      <circle cx={bp.chipX} cy={bp.y} r={2.6}
                        fill={bp.chip.kind === "stale" || bp.chip.kind === "block" ? "var(--del)" : bp.chip.kind === "auto" ? "var(--add)" : "var(--warn)"} />
                    )}
                    </>}
                  </g>
                );
              })}</g>)}

              {/* main line */}
              <path className={s.mainGlow} d={`M${L.mainStart},${L.mainY} L${L.mainEnd},${L.mainY}`} />
              <path className={s.mainLine} d={`M${L.mainStart},${L.mainY} L${L.mainEnd},${L.mainY}`} />
              {!compact && <text className={s.mainLabel} x={L.mainStart - 6} y={L.mainY + 4} textAnchor="end">main</text>}
              {L.main.map((m: MainPos) => {
                const dimMain = !!focused && m.node.pr !== focusPr && !(focused.forkX === m.x);
                const k = `m:${m.node.firstSeq}:${m.node.ts}`;
                return (
                  <g key={k} className={`${s.node} ${m.node.pr ? s.clickable : ""}`} style={dimMain ? { opacity: 0.45 } : undefined}
                    onMouseMove={(e) => showTip(e, { kind: "main", n: m.node })} onMouseLeave={() => setTip(null)}
                    onClick={() => go(m.node.pr)}>
                    <circle cx={m.x} cy={L.mainY} r={12} fill="transparent" />
                    <g className={isNew(k) ? s.pop : ""} style={isNew(k) ? { animationDelay: ".85s" } : undefined}>
                      <circle className={s.dot} cx={m.x} cy={L.mainY} r={m.r} fill={mainColor(m.node)} />
                      {m.node.kind === "revert" && !compact && <text className={s.revertGlyph} x={m.x} y={L.mainY + 20} textAnchor="middle">↺</text>}
                    </g>
                  </g>
                );
              })}
              {/* HEAD marker */}
              {L.main.length > 0 && !compact && (() => {
                const last = L.main[L.main.length - 1]!;
                return (
                  <g className={s.moveable} style={{ transform: `translate(${last.x}px, ${L.mainY}px)` }}>
                    <text className={s.tick} x={0} y={-12} textAnchor="middle" style={{ fill: "var(--accent)" }}>HEAD</text>
                  </g>
                );
              })()}

              {data.branches.length === 0 && !compact && (
                <text className={s.empty} x={L.width / 2} y={L.mainY + 56} textAnchor="middle">
                  <tspan>No agent branches yet. </tspan>
                  <tspan className={s.k}>Run the fleet</tspan>
                  <tspan> — each proposal forks its own branch and opens a PR against main.</tspan>
                </text>
              )}
            </svg>
          )}
        </div>
        {tip && (
          <div className={s.tip} style={{ left: tip.x, top: tip.y }}>
            {tip.kind === "branch" ? (
              <>
                <div className={s.tipTitle}>#{tip.b.pr.replace(/^pr_/, "")} {tip.b.title}</div>
                <div className={s.tipRow}><span>branch</span><span>{tip.b.name}</span></div>
                <div className={s.tipRow}><span>author</span><span style={{ color: agentColor(tip.b.author) }}>{tip.b.authorKind === "agent" ? `agent/${tip.b.author}` : tip.b.author}</span></div>
                <div className={s.tipRow}><span>status</span><span>{statusText(tip.b)}</span></div>
                <div className={s.tipRow}><span>tier</span><span>{tip.b.tier ?? "—"}</span></div>
                <div className={s.tipRow}><span>policy reasons</span><span>{tip.b.reasons}</span></div>
                <div className={s.tipRow}><span>forked at</span><span>main@{tip.b.forkSeq}</span></div>
                <div className={s.tipRow}><span>opened</span><span>{fmtWhen(tip.b.createdAt)}</span></div>
                <div className={s.tipHint}>click to review →</div>
              </>
            ) : (
              <>
                <div className={s.tipTitle}>{tip.n.label}</div>
                <div className={s.tipRow}><span>seq</span><span>{tip.n.firstSeq === tip.n.seq ? `@${tip.n.seq}` : `@${tip.n.firstSeq}–${tip.n.seq}`}</span></div>
                <div className={s.tipRow}><span>actor</span><span>{tip.n.actorName ?? `${tip.n.actorKind}:${tip.n.actorId}`}</span></div>
                <div className={s.tipRow}><span>events</span><span>{tip.n.count}</span></div>
                <div className={s.tipRow}><span>when</span><span>{fmtWhen(tip.n.ts)}</span></div>
                {tip.n.pr && <div className={s.tipHint}>click to open #{tip.n.pr.replace(/^pr_/, "")} →</div>}
              </>
            )}
          </div>
        )}
      </div>
      {!compact && (
        <div className={s.legend}>
          <span className={s.lg}><span className={s.lgLine} style={{ background: "var(--accent)" }} />main</span>
          <span className={s.lg}><span className={s.lgDot} style={{ background: "var(--human)" }} />human</span>
          <span className={s.lg}><span className={s.lgDot} style={{ background: "var(--agent)" }} />agent merge</span>
          <span className={s.lg}><span className={s.lgDot} style={{ background: "var(--muted)" }} />seed / system</span>
          <span className={s.lg}><span className={s.lgDot} style={{ background: "var(--del)" }} />revert</span>
          <span className={s.lgSep} />
          {KNOWN.map((a) => <span key={a} className={s.lg}><span className={s.lgLine} style={{ background: agentColor(a) }} />{a}</span>)}
          <span className={s.lgSep} />
          <span className={`${s.lgChip}`} style={{ color: "var(--warn)" }}>needs review</span>
          <span className={`${s.lgChip}`} style={{ color: "var(--del)" }}>● stale</span>
          <span className={`${s.lgChip}`} style={{ color: "var(--warn)" }}>⚠ conflict</span>
          <span className={`${s.lgChip}`} style={{ color: "var(--add)" }}>✓ auto</span>
        </div>
      )}
    </div>
  );
}

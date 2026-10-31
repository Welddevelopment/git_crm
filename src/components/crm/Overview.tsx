"use client";
/** OWNER: W10. Overview: hero, how it works, live branch graph, live stats, fleet panel, recent activity, differentiators. */
import { useMemo, useRef, useState } from "react";
import s from "./crm.module.css";
import { src, useLive } from "./data";
import { describeTimeline, pipelineTotal, prStats, usd } from "./lib";
import { FeedLineView, FleetPanel, LiveDot, MockNotice, Stat } from "./ui";
import BranchGraph from "@/components/graph/BranchGraph";
import { Hero, HowItWorks, WhyNotQueue } from "@/components/home/sections";
import h from "@/components/home/home.module.css";

export default function Overview() {
  const { data, error } = useLive(async () => {
    const [st, prs, fleet, tl] = await Promise.all([src.state(), src.prs(), src.fleet(), src.timeline()]);
    return { state: st.state, prs: prs.prs, fleet, entries: tl.entries };
  });
  const [busy, setBusy] = useState<null | "governed" | "chaos">(null);
  const [msg, setMsg] = useState<{ text: string; tone: "add" | "del" | "muted" } | null>(null);

  const stats = useMemo(() => prStats(data?.prs || []), [data?.prs]);
  const total = pipelineTotal(data?.state);
  const openDeals = data ? Object.values(data.state.entities).filter((e) => e.type === "deal" && !e.deleted && !e.mergedInto && !/^closed/.test(String(e.attrs.stage))).length : 0;
  const feed = useMemo(() => (data ? describeTimeline(data.entries, data.state).slice(-12).reverse() : []), [data]);
  const seen = useRef<Set<string>>(new Set());
  const firstPaint = useRef(true);
  const freshKeys = new Set<string>();
  if (data) {
    for (const l of feed) if (!seen.current.has(l.key)) { if (!firstPaint.current) freshKeys.add(l.key); seen.current.add(l.key); }
    firstPaint.current = false;
  }

  async function run(mode: "governed" | "chaos") {
    setBusy(mode); setMsg(null);
    try {
      const r = await src.runFleet(undefined, mode);
      setMsg(mode === "chaos"
        ? { text: `Chaos: ${r.directEvents} direct writes to main. No review, no PRs.`, tone: "del" }
        : { text: `Governed: ${r.prs.length} PRs opened on branches.`, tone: "add" });
    } catch (e) { setMsg({ text: String((e as Error).message), tone: "del" }); }
    finally { setBusy(null); }
  }
  const anyRunning = busy !== null || !!data?.fleet.agents.some((a) => a.running);

  return (
    <div className={s.page}>
      <Hero badges={<><LiveDot /><MockNotice /></>} />
      <HowItWorks />

      <section>
        <div className={h.graphHead}>
          <div className={h.graphTitle}>
            <h2>main, live</h2>
            <span className={h.graphHint}>every agent branch, PR and merge as it happens</span>
          </div>
          <div className={s.row}>
            {msg ? <span className={s.small} style={{ color: msg.tone === "add" ? "var(--add)" : msg.tone === "del" ? "var(--del)" : "var(--muted)" }}>{msg.text}</span> : null}
            <button className={`${s.btn} ${s.btnPrimary}`} disabled={anyRunning} onClick={() => run("governed")}>
              {busy === "governed" ? <span className={s.spinner} /> : "⎇"} Run fleet (governed)
            </button>
            <button className={`${s.btn} ${s.btnDanger}`} disabled={anyRunning} onClick={() => run("chaos")}>
              {busy === "chaos" ? <span className={s.spinner} /> : "⚠"} Run fleet (chaos)
            </button>
          </div>
        </div>
        <BranchGraph height={260} />
      </section>
      {error ? <div className={s.err}>{error}</div> : null}

      <div className={s.stats}>
        <Stat big tone="accent" label="Pipeline forecast (main)" value={data ? usd(total) : "—"} hint={data ? `${openDeals} open deals` : " "} />
        <Stat label="Open PRs" value={data ? stats.open : "—"} hint={<a href="/prs">view inbox →</a>} />
        <Stat label="Awaiting review" tone={stats.awaiting ? "warn" : undefined} value={data ? stats.awaiting : "—"} hint="held by policy or conflict" />
        <Stat label="Auto-merged" tone="add" value={data ? stats.autoMerged : "—"} hint="by trust policy" />
        <Stat label="Stale" tone={stats.stale ? "del" : undefined} value={data ? stats.stale : "—"} hint="evidence contradicted" />
      </div>

      <div className={s.two}>
        <FleetPanel fleet={data?.fleet || null} right={<span className={`${s.tiny} ${s.muted}`}>trust earned per merged / reverted PR</span>} />
        <div className={s.panel}>
          <div className={s.panelHead}>
            <span className={s.panelTitle}>Recent activity on main</span>
            <a href="/timeline" className={s.small}>time travel →</a>
          </div>
          <div>
            {data && !feed.length ? <div className={`${s.feedItem} ${s.muted}`}><span /><span>No changes since seed. Run the fleet.</span></div> : null}
            {feed.map((l) => <FeedLineView key={l.key} line={l} fresh={freshKeys.has(l.key)} />)}
          </div>
        </div>
      </div>

      <WhyNotQueue />
    </div>
  );
}

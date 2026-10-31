"use client";
/** OWNER: W10. Overview: hero, how it works, live branch graph, live stats, fleet panel, recent activity, differentiators. */
import { useMemo, useRef, useState } from "react";
import s from "./crm.module.css";
import { src, useLive } from "./data";
import { describeTimeline, pipelineTotal, prStats, signedUsd, usd } from "./lib";
import { FeedLineView, FleetPanel, Kpi, KpiStrip, MockNotice } from "./ui";
import BranchGraph from "@/components/graph/BranchGraph";
import { Hero, HowItWorks, WhyNotQueue } from "@/components/home/sections";

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
  const feed = useMemo(() => (data ? describeTimeline(data.entries, data.state).slice(-6).reverse() : []), [data]);
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

  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

  return (
    <div className={s.page}>
      <div className={s.headerRow}>
        <div style={{ minWidth: 0 }}>
          <h1 className={s.title}>Overview</h1>
          <div className={s.sub}>
            <span>Agents never write to your CRM. <span style={{ color: "var(--blue)" }}>They open PRs against it.</span></span>
          </div>
        </div>
        <div className={s.row} style={{ justifyContent: "flex-end" }}>
          <MockNotice />
          <button className={s.btn} disabled={anyRunning} onClick={() => run("chaos")} title="Agents write straight to main: no branches, no review">
            {busy === "chaos" ? <span className={s.spinner} /> : null}Run chaos
          </button>
          <button className={`${s.btn} ${s.btnPrimary}`} disabled={anyRunning} onClick={() => run("governed")} title="Agents open PRs on branches">
            {busy === "governed" ? <span className={s.spinner} /> : null}Run fleet
          </button>
        </div>
      </div>
      {msg || error ? (
        <div className={s.row} style={{ marginTop: -6 }}>
          {msg ? <span className={`${s.chip} ${msg.tone === "del" ? s.chipDel : msg.tone === "add" ? s.chipAdd : ""}`}>{msg.text}</span> : null}
          {error ? <span className={s.err}>{error}</span> : null}
        </div>
      ) : null}

      <KpiStrip>
        <Kpi label="Pipeline forecast" info="Sum of open deal amounts on main" value={data ? usd(total) : "—"} n={data ? total : undefined}
          fmtDelta={(d) => signedUsd(d)} meta={[data ? `${openDeals} open deals on main` : "—", data ? `head @${data.state.headSeq}` : " "]} />
        <Kpi label="Open PRs" info="Agent pull requests not yet merged or closed" value={data ? stats.open : "—"} n={data ? stats.open : undefined}
          meta={[data ? `${stats.merged} merged all-time` : "—", <a key="i" href="/prs">View inbox →</a>]} />
        <Kpi label="Awaiting review" info="Held by branch-protection policy or an unresolved conflict" value={data ? stats.awaiting : "—"} n={data ? stats.awaiting : undefined} upIs="bad"
          meta={["held by policy or conflict", data ? `${stats.awaiting} of ${stats.open} open` : " "]} />
        <Kpi label="Auto-merged" info="Merged by the trust policy without a human" value={data ? stats.autoMerged : "—"} n={data ? stats.autoMerged : undefined}
          meta={["by trust policy", data ? `${pct(stats.autoMerged, stats.merged)}% of ${stats.merged} merged` : " "]} />
        <Kpi label="Stale" info="Open PRs whose evidence was contradicted by newer documents" value={data ? stats.stale : "—"} n={data ? stats.stale : undefined} upIs="bad"
          meta={["evidence contradicted", "re-checked on new evidence"]} />
      </KpiStrip>

      <section className={s.panel}>
        <div className={s.panelHead}>
          <span className={s.row} style={{ gap: 10 }}>
            <span className={s.panelTitle}>main, live</span>
            <span className={s.panelMeta}>every agent branch, PR and merge as it happens</span>
          </span>
          <a href="/prs" className={s.btn}>Pull requests</a>
        </div>
        <div className={s.graphWrap}><BranchGraph height={260} /></div>
      </section>

      <div className={s.two} style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.2fr)" }}>
        <FleetPanel fleet={data?.fleet || null} right={<span className={s.panelMeta}>trust per merged / reverted PR</span>} />
        <div className={s.panel}>
          <div className={s.panelHead}>
            <span className={s.panelTitle}>Recent activity on main</span>
            <a href="/timeline" className={s.btn}>Time travel</a>
          </div>
          <div>
            {data && !feed.length ? <div className={s.feedEmpty}>No changes since seed. Run the fleet.</div> : null}
            {feed.map((l) => <FeedLineView key={l.key} line={l} fresh={freshKeys.has(l.key)} />)}
          </div>
        </div>
      </div>

      <Hero headline={false} />
      <HowItWorks />
      <WhyNotQueue />
    </div>
  );
}

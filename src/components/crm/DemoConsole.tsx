"use client";
/** OWNER: W10. /demo — presenter console. Big buttons in demo order, one result line each. */
import { useState, type ReactNode } from "react";
import type { CRMState, PullRequest } from "@/core/types";
import s from "./crm.module.css";
import { src, useLive } from "./data";
import { overwriteStats, pipelineTotal, prNum, prStats, signedUsd, usd } from "./lib";
import { FleetPanel, Kpi, KpiStrip, MockNotice } from "./ui";

type Status = "idle" | "running" | "done" | "error";
interface StepState { status: Status; result?: ReactNode }

const INJECT_DOC = "email_inject_acme_pause";

export default function DemoConsole() {
  const { data } = useLive(async () => {
    const [st, prs, fleet] = await Promise.all([src.state(), src.prs(), src.fleet()]);
    return { state: st.state, prs: prs.prs, fleet };
  });
  const [steps, setSteps] = useState<Record<number, StepState>>({});
  const set = (n: number, v: StepState) => setSteps((x) => ({ ...x, [n]: v }));
  const busy = Object.values(steps).some((x) => x.status === "running");

  async function exec(n: number, fn: () => Promise<ReactNode>) {
    set(n, { status: "running" });
    try { set(n, { status: "done", result: await fn() }); }
    catch (e) { set(n, { status: "error", result: <span className={s.err}>{String((e as Error).message || e)}</span> }); }
  }

  const reset = (n: number) => exec(n, async () => {
    await src.reset();
    const st = (await src.state()).state;
    const deals = Object.values(st.entities).filter((e) => e.type === "deal").length;
    return <span>World reseeded: <b>{Object.keys(st.entities).length}</b> records, <b>{deals}</b> deals, forecast <b className={s.num}>{usd(pipelineTotal(st))}</b>. No PRs.</span>;
  });

  const chaos = (n: number) => exec(n, async () => {
    const before: CRMState = (await src.state()).state;
    const r = await src.runFleet(undefined, "chaos");
    const after: CRMState = (await src.state()).state;
    const d = pipelineTotal(after) - pipelineTotal(before);
    const o = overwriteStats(before, after);
    return (
      <div>
        <div className={s.resultBig} style={{ color: d === 0 ? "var(--notice-ink)" : "var(--negative)" }}>Forecast silently changed by {signedUsd(d)}</div>
        <div className={s.small} style={{ marginTop: 4 }}>
          <span className={s.num}>{usd(pipelineTotal(before))}</span> → <span className={s.num} style={{ color: "var(--negative)" }}>{usd(pipelineTotal(after))}</span>
          <span className={s.faint}> · </span><b style={{ color: "var(--negative)" }}>{o.overwritten}</b> fields overwritten
          <span className={s.faint}> · </span><b style={{ color: "var(--negative)" }}>{o.mergedAway}</b> contacts merged away
          <span className={s.faint}> · </span><b>{r.directEvents}</b> direct writes, <b>0</b> reviews
        </div>
      </div>
    );
  });

  const governed = (n: number) => exec(n, async () => {
    const before = (await src.state()).state;
    const r = await src.runFleet(undefined, "governed");
    const [after, all] = await Promise.all([src.state().then((x) => x.state), src.prs().then((x) => x.prs)]);
    const st = prStats(all);
    const d = pipelineTotal(after) - pipelineTotal(before);
    const conflicts = all.filter((p) => p.status === "open" && (p.conflicts || []).some((c) => !c.autoResolved)).length;
    const rebased = all.filter((p) => (p.conflicts || []).some((c) => c.autoResolved)).length;
    return (
      <div>
        <div className={`${s.resultBig} ${s.resultGood}`}>{r.prs.length} PRs opened · forecast {d === 0 ? "unchanged" : signedUsd(d)}</div>
        <div className={s.small} style={{ marginTop: 4 }}>
          <b style={{ color: "var(--positive)" }}>{st.autoMerged}</b> auto-merged by policy
          <span className={s.faint}> · </span><b style={{ color: "var(--notice-ink)" }}>{st.awaiting}</b> awaiting review
          <span className={s.faint}> · </span><b>{conflicts}</b> with conflicts
          <span className={s.faint}> · </span><b>{rebased}</b> auto-rebased
          <span className={s.faint}> · </span><a href="/prs">open PR inbox →</a>
        </div>
      </div>
    );
  });

  const inject = (n: number) => exec(n, async () => {
    const r = await src.inject(INJECT_DOC);
    const prs: PullRequest[] = (await src.prs()).prs;
    const stale = prs.filter((p) => r.affectedPRs.includes(p.id) || (p.status === "open" && p.staleness?.status === "stale"));
    if (!stale.length) return <span className={s.muted}>Email injected. No open PRs depended on it (did you run governed first?).</span>;
    return (
      <div>
        <div className={s.resultBig} style={{ color: "var(--notice-ink)" }}>{stale.length} PR{stale.length > 1 ? "s" : ""} went stale on their own</div>
        {stale.map((p) => (
          <div key={p.id} className={s.prLine}>
            <span className={`${s.chip} ${s.chipWarn}`}>stale</span>
            <a href={`/prs/${p.id}`} className={s.num}>{prNum(p.id)}</a>
            <span>{p.title}</span>
            {p.staleness?.contradictions?.[0] ? <span className={`${s.faint} ${s.small}`}>— {p.staleness.contradictions[0].explanation}</span> : null}
          </div>
        ))}
      </div>
    );
  });

  const STEPS: { n: number; title: string; hint: string; btn: string; tone?: "primary" | "danger"; run?: () => void; links?: { href: string; label: string }[] }[] = [
    { n: 1, title: "Reset world", hint: "Reseed the demo CRM. Clean main, no PRs.", btn: "Reset world", run: () => reset(1) },
    { n: 2, title: "Chaos: agents write to main", hint: "The status quo. 4 agents, direct writes, no review.", btn: "Run chaos", tone: "danger", run: () => chaos(2) },
    { n: 3, title: "Reset", hint: "Undo the damage. Same world, same agents.", btn: "Reset world", run: () => reset(3) },
    { n: 4, title: "Governed: agents open PRs", hint: "Branches, evidence, policy, auto-merge for trusted changes.", btn: "Run governed", tone: "primary", run: () => governed(4) },
    { n: 5, title: "Inject “Acme is pausing” email", hint: "New evidence lands on main. Watch the Acme PR go stale.", btn: "Inject email", run: () => inject(5) },
    { n: 6, title: "Show the receipts", hint: "Review the held PRs, then rewind main and revert the bad dedup.", btn: "", links: [{ href: "/prs", label: "Pull requests →" }, { href: "/timeline", label: "Time travel →" }, { href: "/crm#contact", label: "CRM contacts →" }] },
  ];

  const st = data ? prStats(data.prs) : null;

  return (
    <div className={s.page}>
      <div className={s.headerRow}>
        <div>
          <h1 className={s.title}>Demo console</h1>
          <div className={s.sub}><span>Run-of-show. Click top to bottom; each step reports what actually happened on main.</span></div>
        </div>
        <div className={s.row}>
          <MockNotice />
          <button className={s.btn} onClick={() => setSteps({})} disabled={busy}>Clear results</button>
        </div>
      </div>

      <KpiStrip>
        <Kpi label="Forecast (main)" info="Sum of open deal amounts on main" value={data ? usd(pipelineTotal(data.state)) : "—"} n={data ? pipelineTotal(data.state) : undefined} fmtDelta={(d) => signedUsd(d)} meta={["open deals on main", data ? `head @${data.state.headSeq}` : " "]} />
        <Kpi label="Open PRs" value={st ? st.open : "—"} n={st ? st.open : undefined} meta={[st ? `${st.merged} merged` : "—", " "]} />
        <Kpi label="Awaiting review" value={st ? st.awaiting : "—"} n={st ? st.awaiting : undefined} upIs="bad" meta={["held by policy or conflict", " "]} />
        <Kpi label="Auto-merged" value={st ? st.autoMerged : "—"} n={st ? st.autoMerged : undefined} meta={["by trust policy", " "]} />
        <Kpi label="Stale" value={st ? st.stale : "—"} n={st ? st.stale : undefined} upIs="bad" meta={["evidence contradicted", " "]} />
      </KpiStrip>

      <div className={s.two} style={{ gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr)" }}>
        <div className={s.steps}>
          {STEPS.map((x) => {
            const state = steps[x.n] || { status: "idle" };
            const cls = state.status === "done" ? s.stepDone : state.status === "running" ? s.stepRunning : "";
            return (
              <div key={x.n} className={`${s.step} ${cls}`}>
                <div className={s.stepNum}>{state.status === "done" ? "✓" : state.status === "running" ? <span className={s.spinner} /> : x.n}</div>
                <div>
                  {x.run ? (
                    <button
                      className={`${s.btn} ${s.bigBtn} ${x.tone === "primary" ? s.btnPrimary : x.tone === "danger" ? s.btnDanger : ""}`}
                      disabled={busy}
                      onClick={x.run}
                    >{state.status === "running" ? <span className={s.spinner} /> : null}{x.btn}</button>
                  ) : (
                    <div className={s.row} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                      {x.links?.map((l) => <a key={l.href} href={l.href} className={`${s.btn} ${s.bigBtn}`}>{l.label}</a>)}
                    </div>
                  )}
                </div>
                <div>
                  <div className={s.stepTitle}>{x.title}</div>
                  <div className={s.stepHint}>{x.hint}</div>
                  <div className={s.result} style={{ marginTop: state.result || state.status === "running" ? 8 : 0 }}>
                    {state.status === "running" ? <span className={`${s.faint} ${s.pulse}`}>working…</span> : state.result}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <FleetPanel fleet={data?.fleet || null} />
      </div>
    </div>
  );
}

"use client";
/** OWNER: W10. /crm — main's records, schema-driven, with blame on every cell. */
import { useEffect, useMemo, useState } from "react";
import type { TimelineEntry } from "@/core/api-contract";
import s from "./crm.module.css";
import { src, useLive } from "./data";
import { isLive, pipelineTotal, usd } from "./lib";
import { EntityTable } from "./EntityTable";
import { MockNotice } from "./ui";
import { WatchUrl } from "./WatchUrl";

const TABS = [
  { type: "company", label: "Companies" },
  { type: "contact", label: "Contacts" },
  { type: "deal", label: "Deals" },
] as const;

/** Fields added by a non-seed schema.addField, and main event → PR map. */
export function timelineMeta(entries: TimelineEntry[]) {
  const newFields = new Set<string>();
  const prByEvent: Record<string, string> = {};
  for (const en of entries) {
    const ev = en.event;
    const pr = en.pr || (ev.origin && "pr" in ev.origin ? ev.origin.pr : undefined);
    if (pr) prByEvent[ev.id] = pr;
    if (ev.op.type === "schema.addField" && !(ev.actor.kind === "system" && ev.actor.id === "seed")) newFields.add(`${ev.op.entityType}.${ev.op.field}`);
    if (ev.op.type === "schema.removeField") newFields.delete(`${ev.op.entityType}.${ev.op.field}`);
  }
  return { newFields, prByEvent };
}

export default function CrmView() {
  const [tab, setTab] = useState<string>("company");
  const [showHidden, setShowHidden] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => {
    try { const h = window.location.hash.slice(1); if (TABS.some((t) => t.type === h)) setTab(h); } catch {}
  }, []);
  const pick = (t: string) => { setTab(t); try { history.replaceState(null, "", `${location.pathname}${location.search}#${t}`); } catch {} };

  const { data, error } = useLive(async () => {
    const [st, tl] = await Promise.all([src.state(), src.timeline()]);
    return { state: st.state, entries: tl.entries };
  });
  const meta = useMemo(() => timelineMeta(data?.entries || []), [data?.entries]);
  const counts = useMemo(() => {
    const c: Record<string, { live: number; hidden: number }> = {};
    for (const e of Object.values(data?.state.entities || {})) {
      const x = (c[e.type] ||= { live: 0, hidden: 0 });
      if (isLive(e)) x.live++; else x.hidden++;
    }
    return c;
  }, [data?.state]);
  const hiddenHere = counts[tab]?.hidden || 0;
  const newHere = [...meta.newFields].filter((f) => f.startsWith(tab + ".")).length;

  return (
    <div className={s.page}>
      <div className={s.headerRow}>
        <div>
          <h1 className={s.title}>Records</h1>
          <div className={s.sub}><span>The CRM as branch <b style={{ color: "var(--ink)", fontWeight: 600 }}>main</b> sees it. Click any value for its blame: actor, time, reason, evidence and the PR that landed it.</span></div>
        </div>
        <div className={s.row} style={{ alignItems: "flex-end", gap: 12 }}>
          <MockNotice />
          {data ? (
            <div className={s.stat}>
              <div className={s.statLabel}>Pipeline forecast</div>
              <div className={s.statValue}>{usd(pipelineTotal(data.state))}</div>
              <div className={s.statHint}>head seq {data.state.headSeq}</div>
            </div>
          ) : null}
        </div>
      </div>
      {error ? <div className={s.err}>{error}</div> : null}
      <WatchUrl />

      <div className={s.panel}>
        <div className={s.toolbar}>
          <div className={s.tabs} role="tablist">
            {TABS.map((t) => {
              const nNew = [...meta.newFields].filter((f) => f.startsWith(t.type + ".")).length;
              return (
                <button key={t.type} role="tab" aria-selected={tab === t.type} className={`${s.tab} ${tab === t.type ? s.tabActive : ""}`} onClick={() => pick(t.type)}>
                  {t.label}<span className={s.count}>{counts[t.type]?.live ?? 0}</span>
                  {nNew ? <span className={s.newBadge} style={{ marginLeft: 0 }}>+{nNew} field</span> : null}
                </button>
              );
            })}
          </div>
          <div className={s.row}>
            <input className={s.search} placeholder="Filter rows…" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className={s.toggle}>
              <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
              Show merged / deleted{hiddenHere ? <span className={s.count}>{hiddenHere}</span> : null}
            </label>
          </div>
        </div>
        {newHere ? (
          <div className={s.schemaNote}>
            Schema changed on main: <b>{[...meta.newFields].filter((f) => f.startsWith(tab + ".")).map((f) => f.split(".")[1]).join(", ")}</b> added by an agent PR. Existing records were backfilled.
          </div>
        ) : null}
        {!data ? <div className={s.loadingBar} /> : (
          <EntityTable state={data.state} type={tab} showHidden={showHidden} newFields={meta.newFields} filter={q} prByEvent={meta.prByEvent} />
        )}
      </div>
    </div>
  );
}

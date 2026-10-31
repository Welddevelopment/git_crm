"use client";
/** OWNER: W10. Blame popover: who set this field, when, why, on what evidence, via which PR. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CRMState, FieldProvenance, FieldValue } from "@/core/types";
import s from "./crm.module.css";
import { src } from "./data";
import { actorColor, entityName, fmtDate, fmtValue, prNum, timeAgo } from "./lib";
import { ActorChip } from "./ui";

export interface BlameTarget { entity: string; field: string; value: FieldValue | undefined; rect: DOMRect }

export function BlamePopover({ target, state, onClose, prByEvent }: { target: BlameTarget; state: CRMState; onClose: () => void; prByEvent?: Record<string, string> }) {
  const [hist, setHist] = useState<FieldProvenance[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: target.rect.left, top: target.rect.bottom + 6 });

  useEffect(() => {
    let alive = true;
    setHist(null); setErr(null);
    src.blame(target.entity, target.field)
      .then((r) => { if (alive) setHist([...r.history].sort((a, b) => b.ts - a.ts || b.seq - a.seq)); })
      .catch((e) => { if (alive) setErr(String((e as Error).message)); });
    return () => { alive = false; };
  }, [target.entity, target.field]);

  useLayoutEffect(() => {
    const el = ref.current;
    const w = el?.offsetWidth || 420, h = el?.offsetHeight || 300;
    let left = Math.min(target.rect.left, window.innerWidth - w - 12);
    left = Math.max(12, left);
    let top = target.rect.bottom + 6;
    if (top + h > window.innerHeight - 12) top = Math.max(12, target.rect.top - h - 6);
    setPos({ left, top });
  }, [target.rect, hist]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("[data-blame-cell]")) onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); window.removeEventListener("scroll", onScroll, true); };
  }, [onClose]);

  const prOf = (h: FieldProvenance) => {
    // provenance has no PR id; map main event id → PR via the timeline, else best-effort from branch name
    if (prByEvent?.[h.eventId]) return prByEvent[h.eventId];
    const m = /pr_\d+/.exec(h.branch) || /pr_\d+/.exec(h.reason || "");
    return m?.[0];
  };

  return (
    <div ref={ref} className={s.popover} style={{ left: pos.left, top: pos.top }} role="dialog" aria-label="Field history">
      <div className={s.popHead}>
        <div className={s.row} style={{ justifyContent: "space-between" }}>
          <span className={s.eyebrow}>Blame</span>
          <button className={`${s.btn} ${s.iconBtn}`} onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className={s.popTitle}>
          {entityName(state, target.entity)}<span className={s.faint}> · </span><span style={{ fontWeight: 500, color: "var(--ink-2)" }}>{target.field}</span>
        </div>
        <div className={s.row} style={{ marginTop: 6 }}>
          <span className={`${s.faint} ${s.small}`}>Current</span>
          <span className={s.val}>{fmtValue(target.value, target.field)}</span>
          <span className={`${s.tiny} ${s.faint}`} style={{ marginLeft: "auto" }}>{target.entity}</span>
        </div>
      </div>
      {err ? <div className={s.hist}><span className={s.err}>{err}</span></div> : null}
      {!hist && !err ? <div className={s.hist}><span className={`${s.faint} ${s.pulse}`}>Loading history…</span></div> : null}
      {hist && !hist.length ? <div className={s.hist}><span className={s.faint}>No recorded writes for this field.</span></div> : null}
      {hist?.map((h, i) => {
        const pr = prOf(h);
        const isRevert = h.actor.kind === "system" && h.actor.id === "revert";
        return (
          <div key={h.eventId + i} className={`${s.hist} ${i === 0 ? s.histCurrent : ""}`}>
            <span className={s.histDot} style={{ background: actorColor(h.actor, isRevert) }} />
            <div className={s.row} style={{ gap: 8 }}>
              <ActorChip actor={h.actor} small />
              {i === 0 ? <span className={s.youLabel}>Current</span> : null}
              <span className={`${s.tiny} ${s.faint}`} title={new Date(h.ts).toISOString()}>{fmtDate(h.ts)} · {timeAgo(h.ts)} ago</span>
              <span className={`${s.tiny} ${s.faint}`} style={{ marginLeft: "auto" }}>seq {h.seq}</span>
            </div>
            {h.reason ? <div style={{ marginTop: 5 }}>{h.reason}</div> : null}
            {(h.evidence || []).map((ev, j) => (
              <div key={j} className={s.claim}>
                <div>{ev.claim}</div>
                {ev.quote ? <div className={s.quote}>“{ev.quote}”</div> : null}
                <div className={`${s.tiny} ${s.faint}`} style={{ marginTop: 3 }}>{ev.docId}</div>
              </div>
            ))}
            <div className={`${s.row} ${s.tiny}`} style={{ marginTop: 6, gap: 10 }}>
              <span className={s.faint}>{h.branch}</span>
              {pr ? <a href={`/prs/${pr}`}>PR {prNum(pr)} →</a> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

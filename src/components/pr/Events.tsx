"use client";
/* OWNER: W9. Raw branch events, compact + expandable JSON. */
import { Fragment, useState, type ReactNode } from "react";
import type { Event, PolicyDecision, RiskTier } from "@/core/types";
import { IconChevron } from "./atoms";
import { actorName, plainValue } from "./format";

function summary(e: Event): string {
  const op = e.op;
  switch (op.type) {
    case "field.set":
      return `${op.entity}.${op.field} = ${JSON.stringify(op.value)}${op.prev !== undefined ? `  (was ${JSON.stringify(op.prev)})` : ""}`;
    case "entity.create":
      return `${op.entity} ${JSON.stringify(op.attrs)}`;
    case "entity.delete":
      return op.entity;
    case "entity.merge":
      return `${op.from} → ${op.into}`;
    case "schema.addField":
      return `${op.entityType}.${op.field}: ${op.fieldType}`;
    case "schema.renameField":
      return `${op.entityType}.${op.from} → ${op.to}`;
    case "schema.removeField":
      return `${op.entityType}.${op.field}`;
    case "evidence.attach":
      return `${op.doc.id} "${op.doc.title}"`;
  }
}

/** Tiny JSON syntax highlighter. */
function JsonView({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2);
  const parts: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(-?\d+(?:\.\d+)?)\b|\b(true|false|null)\b/g;
  let at = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > at) parts.push(<Fragment key={i++}>{text.slice(at, m.index)}</Fragment>);
    if (m[1]) parts.push(<span key={i++} className={m[2] ? "k" : "s"}>{m[1]}</span>, m[2] ? <Fragment key={i++}>{m[2]}</Fragment> : null);
    else parts.push(<span key={i++} className="n">{m[0]}</span>);
    at = m.index + m[0].length;
  }
  parts.push(<Fragment key={i++}>{text.slice(at)}</Fragment>);
  return <pre className="pr-json">{parts}</pre>;
}

const TIER_COLOR: Record<RiskTier, string> = { auto: "var(--add)", review: "var(--warn)", block: "var(--del)" };

export function EventsTab({ events, policy, contradicted }: { events: Event[]; policy?: PolicyDecision; contradicted: Set<string> }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOpen = events.length > 0 && open.size === events.length;
  return (
    <section>
      <h2 className="pr-section-title">
        Branch log <span className="pr-muted">· {events.length} immutable events · applied to main in order on merge</span>
        <span className="pr-spacer" />
        <button className="pr-linkbtn" onClick={() => setOpen(allOpen ? new Set() : new Set(events.map((e) => e.id)))}>
          {allOpen ? "collapse all" : "expand all"}
        </button>
      </h2>
      <div className="panel pr-evt">
        <div className="pr-evt-row pr-evt-head">
          <span>seq</span>
          <span className="c-id">id</span>
          <span>op</span>
          <span className="c-ts">actor · ts</span>
          <span>payload</span>
          <span />
        </div>
        {events.map((e) => {
          const t = policy?.perEvent?.[e.id];
          return (
            <Fragment key={e.id}>
              <div className="pr-evt-row" onClick={() => toggle(e.id)}>
                <span className="pr-muted">#{e.seq}</span>
                <span className="c-id pr-muted" style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={e.id}>{e.id}</span>
                <span className="op">{e.op.type}</span>
                <span className="c-ts pr-muted" title={new Date(e.ts).toISOString()}>
                  {actorName(e.actor)} · {new Date(e.ts).toLocaleTimeString("en-US", { hour12: false })}
                </span>
                <span className="sum" title={summary(e)}>
                  {t && <span style={{ color: TIER_COLOR[t.tier], marginRight: 8 }}>[{t.tier}{t.rule ? `:${t.rule}` : ""}]</span>}
                  {contradicted.has(e.id) && <span style={{ color: "var(--del)", marginRight: 8 }}>[stale]</span>}
                  {summary(e)}
                </span>
                <span style={{ display: "inline-flex", color: "var(--muted)", transform: open.has(e.id) ? "rotate(180deg)" : "none" }}>
                  <IconChevron size={12} />
                </span>
              </div>
              {open.has(e.id) && <JsonView value={e} />}
            </Fragment>
          );
        })}
        {events.length === 0 && <div className="pr-empty" style={{ padding: 24 }}>No events on this branch.</div>}
      </div>
    </section>
  );
}

export { plainValue };

"use client";
/* OWNER: W9. "Files changed" — PR changes grouped by entity, GitHub-style. */
import { useState, type ReactNode } from "react";
import type { Change, Conflict, CRMState, EntityId, Event, EvidenceRef, FieldValue, Op } from "@/core/types";
import { IconArrowRight, IconChevron, IconInfo, IconMerged, IconSchema } from "./atoms";
import { DocIcon } from "./Evidence";
import { displayName, entityType, fmtSignedMoney, isEntityRef, isMoneyField, plainValue } from "./format";
import type { EvidenceDoc } from "@/core/types";

/** Fallback when the server didn't include `pr.changes`: derive a reasonable diff from the branch events. */
export function deriveChanges(events: Event[], base?: CRMState | null): Change[] {
  const out: Change[] = [];
  const last = new Map<string, number>();
  for (const e of events) {
    const op = e.op;
    switch (op.type) {
      case "field.set": {
        const k = `${op.entity}::${op.field}`;
        const before = op.prev !== undefined ? op.prev : base?.entities?.[op.entity]?.attrs?.[op.field];
        if (last.has(k)) {
          const c = out[last.get(k)!] as Extract<Change, { kind: "field.changed" }>;
          c.after = op.value;
        } else {
          last.set(k, out.length);
          out.push({ kind: "field.changed", entity: op.entity, field: op.field, before, after: op.value });
        }
        break;
      }
      case "entity.create":
        out.push({ kind: "entity.added", entity: op.entity, entityType: op.entityType, attrs: op.attrs });
        break;
      case "entity.delete":
        out.push({ kind: "entity.removed", entity: op.entity });
        break;
      case "entity.merge":
        out.push({ kind: "entity.merged", from: op.from, into: op.into });
        break;
      case "schema.addField":
        out.push({ kind: "schema.changed", entityType: op.entityType, description: `Add field ${op.field} (${op.fieldType})${op.description ? ` — ${op.description}` : ""}` });
        break;
      case "schema.renameField":
        out.push({ kind: "schema.changed", entityType: op.entityType, description: `Rename field ${op.from} → ${op.to}` });
        break;
      case "schema.removeField":
        out.push({ kind: "schema.changed", entityType: op.entityType, description: `Remove field ${op.field}` });
        break;
      case "evidence.attach":
        out.push({ kind: "evidence.added", docId: op.doc.id });
        break;
    }
  }
  return out;
}

type FieldChange = Extract<Change, { kind: "field.changed" }>;

interface Group {
  entity: EntityId;
  fields: FieldChange[];
  added?: Extract<Change, { kind: "entity.added" }>;
  removed?: boolean;
  mergedInto?: EntityId;
}

export interface DiffProps {
  changes: Change[];
  events: Event[];
  base: CRMState | null;
  conflicts: Conflict[];
  docs: Record<string, EvidenceDoc>;
  names: Record<string, string>;
  onShowEvidence: (eventId: string, idx: number) => void;
  contradicted: Set<string>;
}

function findEvent(events: Event[], pred: (op: Op) => boolean): Event | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (pred(events[i].op)) return events[i];
  return undefined;
}

export function Diff({ changes, events, base, conflicts, docs, names, onShowEvidence, contradicted }: DiffProps) {
  const schema = changes.filter((c): c is Extract<Change, { kind: "schema.changed" }> => c.kind === "schema.changed");
  const evidence = changes.filter((c): c is Extract<Change, { kind: "evidence.added" }> => c.kind === "evidence.added");
  const groups: Group[] = [];
  const byId = new Map<string, Group>();
  const g = (id: EntityId) => {
    let x = byId.get(id);
    if (!x) {
      x = { entity: id, fields: [] };
      byId.set(id, x);
      groups.push(x);
    }
    return x;
  };
  for (const c of changes) {
    if (c.kind === "field.changed") g(c.entity).fields.push(c);
    else if (c.kind === "entity.added") g(c.entity).added = c;
    else if (c.kind === "entity.removed") g(c.entity).removed = true;
    else if (c.kind === "entity.merged") g(c.from).mergedInto = c.into;
  }
  const name = (id?: EntityId) => displayName(id, base, names);
  const rebased = new Map<string, Conflict>();
  conflicts.filter((c) => c.kind === "merged-away" && c.autoResolved && c.entity).forEach((c) => rebased.set(c.entity!, c));

  const schemaOps = events.filter((e) => e.op.type.startsWith("schema."));

  return (
    <section>
      <h2 className="pr-section-title">
        Files changed <span className="pr-muted">· {groups.length} {groups.length === 1 ? "record" : "records"}{schema.length ? ` · ${schema.length} schema` : ""}</span>
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {schema.length > 0 && (
          <div className="panel pr-file pr-schema">
            <div className="pr-file-head" style={{ cursor: "default" }}>
              <IconSchema size={14} />
              <span className="name">Schema migration</span>
              <span className="pr-type">schema</span>
              <span className="pr-spacer" />
              <span className="pr-muted pr-small">applies to every record of the type on merge</span>
            </div>
            {schemaOps.length
              ? schemaOps.map((e) => <SchemaLine key={e.id} op={e.op} />)
              : schema.map((s, i) => (
                  <div key={i} className="pr-schema-line">
                    <span className="op">~</span>
                    <span>{s.entityType}</span>
                    <span className="desc" style={{ width: "auto" }}>{s.description}</span>
                  </div>
                ))}
          </div>
        )}

        {groups.map((gr) => (
          <EntityFile
            key={gr.entity}
            group={gr}
            name={name}
            events={events}
            rebasedTo={rebased.get(gr.entity)}
            onShowEvidence={onShowEvidence}
            contradicted={contradicted}
            isBackfill={schema.length > 0}
            schemaFields={new Set(schemaOps.flatMap((e) => (e.op.type === "schema.addField" ? [`${e.op.entityType}.${e.op.field}`] : [])))}
          />
        ))}

        {evidence.length > 0 && (
          <div className="pr-attached">
            <span>Attaches to main:</span>
            {evidence.map((e) => (
              <span key={e.docId} className="pr-badge neutral" title={docs[e.docId]?.title}>
                <DocIcon kind={docs[e.docId]?.kind} size={11} />
                {docs[e.docId]?.title ?? e.docId}
              </span>
            ))}
          </div>
        )}
        {groups.length === 0 && schema.length === 0 && (
          <div className="panel pr-empty" style={{ padding: 28 }}>
            This PR has no record changes.
          </div>
        )}
      </div>
    </section>
  );
}

function SchemaLine({ op }: { op: Op }) {
  if (op.type === "schema.addField")
    return (
      <div className="pr-schema-line">
        <span className="op" style={{ color: "var(--add)" }}>+ addField</span>
        <span>
          {op.entityType}.<strong>{op.field}</strong>
        </span>
        <span className="pr-type">{op.fieldType}</span>
        {op.description && <span className="desc">{op.description}</span>}
      </div>
    );
  if (op.type === "schema.renameField")
    return (
      <div className="pr-schema-line">
        <span className="op" style={{ color: "var(--warn)" }}>~ renameField</span>
        <span>
          {op.entityType}.{op.from} <IconArrowRight size={12} /> {op.entityType}.<strong>{op.to}</strong>
        </span>
      </div>
    );
  if (op.type === "schema.removeField")
    return (
      <div className="pr-schema-line">
        <span className="op" style={{ color: "var(--del)" }}>− removeField</span>
        <span style={{ textDecoration: "line-through" }}>
          {op.entityType}.{op.field}
        </span>
      </div>
    );
  return null;
}

function EntityFile({
  group, name, events, rebasedTo, onShowEvidence, contradicted, isBackfill, schemaFields,
}: {
  group: Group;
  name: (id?: EntityId) => string;
  events: Event[];
  rebasedTo?: Conflict;
  onShowEvidence: (eventId: string, idx: number) => void;
  contradicted: Set<string>;
  isBackfill: boolean;
  schemaFields: Set<string>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const type = group.added?.entityType ?? entityType(group.entity);
  const adds = group.fields.filter((f) => f.after !== undefined).length + (group.added ? Object.keys(group.added.attrs).length : 0) + (group.mergedInto ? 1 : 0);
  const dels = group.fields.filter((f) => f.before !== undefined && f.before !== "" && !(Array.isArray(f.before) && !f.before.length)).length + (group.removed ? 1 : 0) + (group.mergedInto ? 1 : 0);
  const bars = Math.min(5, adds + dels);
  const aBars = adds + dels ? Math.round((adds / (adds + dels)) * bars) : 0;
  const displayed = group.added ? String(group.added.attrs.name ?? name(group.entity)) : name(group.entity);

  return (
    <div className={`panel pr-file ${collapsed ? "collapsed" : ""}`}>
      <div className="pr-file-head" onClick={() => setCollapsed((c) => !c)}>
        <span className="caret">
          <IconChevron size={14} />
        </span>
        <span className="pr-type">{type}</span>
        <span className="name">{displayed}</span>
        <span className="eid">{group.entity}</span>
        {group.added && <span className="pr-badge auto">new record</span>}
        {group.removed && <span className="pr-badge block">deleted</span>}
        {rebasedTo?.autoResolved && (
          <span className="pr-badge info" title={rebasedTo.autoResolved.note}>
            <IconInfo size={11} /> rebased → {name(rebasedTo.autoResolved.to)}
          </span>
        )}
        <span className="pr-spacer" />
        <span className="pr-stat">
          <span className="a">+{adds}</span>
          <span className="d">−{dels}</span>
          <span className="bars">
            {Array.from({ length: 5 }, (_, i) => (
              <i key={i} className={i < aBars ? "a" : i < bars ? "d" : ""} />
            ))}
          </span>
        </span>
      </div>
      {!collapsed && (
        <div>
          {group.mergedInto && (
            <div className="pr-merge-row">
              <IconMerged size={16} className="pr-icon-merged" />
              <span className="from">{name(group.entity)}</span>
              <span className="pr-muted">→ merged into</span>
              <span className="into">{name(group.mergedInto)}</span>
              <span className="ids">
                {group.entity} is absorbed; references resolve to {group.mergedInto}
              </span>
              <EvidenceNote event={findEvent(events, (op) => op.type === "entity.merge" && op.from === group.entity)} onShow={onShowEvidence} contradicted={contradicted} indent={false} />
            </div>
          )}
          {group.added &&
            Object.entries(group.added.attrs).map(([f, v]) => <FieldRow key={f} field={f} before={undefined} after={v} name={name} />)}
          {group.fields.map((f) => {
            const ev = findEvent(events, (op) => op.type === "field.set" && (op.entity === f.entity || op.entity === rebasedTo?.entity) && op.field === f.field);
            return (
              <FieldBlock key={f.field}>
                <FieldRow
                  field={f.field}
                  before={f.before}
                  after={f.after}
                  name={name}
                  tag={isBackfill && schemaFields.has(`${type}.${f.field}`) ? "backfill" : undefined}
                />
                <EvidenceNote event={ev} onShow={onShowEvidence} contradicted={contradicted} />
              </FieldBlock>
            );
          })}
          {group.removed && !group.fields.length && (
            <div className="pr-merge-row">
              <span className="from">{name(group.entity)}</span>
              <span className="pr-muted">record deleted</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const FieldBlock = ({ children }: { children: ReactNode }) => <>{children}</>;

function EvidenceNote({ event, onShow, contradicted, indent = true }: { event?: Event; onShow: (eventId: string, idx: number) => void; contradicted: Set<string>; indent?: boolean }) {
  if (!event) return null;
  const refs: EvidenceRef[] = event.evidence || [];
  if (!refs.length && !event.reason) return null;
  return (
    <div className="pr-fnote" style={indent ? undefined : { padding: 0, border: 0, width: "100%" }}>
      {refs.length ? (
        refs.map((r, i) => (
          <span key={i} style={{ display: "inline-flex", gap: 6, alignItems: "baseline" }}>
            <span className="claim">{r.claim}</span>
            <button className="pr-linkbtn" onClick={() => onShow(event.id, i)}>
              view source
            </button>
          </span>
        ))
      ) : (
        <span>{event.reason}</span>
      )}
      {contradicted.has(event.id) && (
        <span className="pr-badge stale" style={{ animation: "none", height: 18 }}>
          contradicted
        </span>
      )}
    </div>
  );
}

function numDelta(field: string, before: FieldValue | undefined, after: FieldValue | undefined): ReactNode {
  if (typeof before !== "number" || typeof after !== "number" || before === after) return null;
  const d = after - before;
  const pct = before !== 0 ? Math.round((d / Math.abs(before)) * 100) : null;
  const txt = isMoneyField(field) ? fmtSignedMoney(d) : `${d > 0 ? "+" : "−"}${Math.abs(d).toLocaleString("en-US")}`;
  return (
    <span className={`pr-delta ${d > 0 ? "up" : "down"}`}>
      {txt}
      {pct !== null ? ` (${d > 0 ? "+" : ""}${pct}%)` : ""}
    </span>
  );
}

function Value({ v, field, name, other, side }: { v: FieldValue | undefined; field: string; name: (id?: string) => string; other?: FieldValue; side: "before" | "after" }) {
  if (v === undefined) return <span className="val">not set</span>;
  if (v === "" || (Array.isArray(v) && v.length === 0)) return <span className="val" style={{ fontStyle: "italic", opacity: 0.8 }}>{Array.isArray(v) ? "[ ]" : "empty"}</span>;
  if (Array.isArray(v)) {
    const o = new Set(Array.isArray(other) ? other : []);
    return (
      <span className="pr-arr" style={{ textDecoration: "none" }}>
        {v.map((x) => (
          <span key={x} className={!o.has(x) ? (side === "after" ? "plus" : "minus") : ""}>
            {x}
          </span>
        ))}
      </span>
    );
  }
  if (isEntityRef(v))
    return (
      <span className="val pr-ref">
        {name(v)} <span className="rid">{v}</span>
      </span>
    );
  return <span className="val">{plainValue(v, field)}</span>;
}

export function FieldRow({
  field, before, after, name, tag,
}: {
  field: string;
  before: FieldValue | undefined;
  after: FieldValue | undefined;
  name: (id?: string) => string;
  tag?: string;
}) {
  const noBefore = before === undefined;
  return (
    <div className="pr-frow">
      <div className="f">
        <span style={{ color: "var(--text)" }}>{field}</span>
        {tag && <span className="pr-type" style={{ alignSelf: "flex-start", color: "var(--agent)", borderColor: "color-mix(in srgb,var(--agent) 40%,transparent)" }}>{tag}</span>}
      </div>
      <div className={`v before ${noBefore ? "empty" : ""}`}>
        {!noBefore && <span className="sign">−</span>}
        <Value v={before} field={field} name={name} other={after} side="before" />
      </div>
      <div className="arrow">
        <IconArrowRight size={12} />
      </div>
      <div className={`v after ${after === undefined ? "empty" : ""}`}>
        {after !== undefined && <span className="sign">+</span>}
        <Value v={after} field={field} name={name} other={before} side="after" />
        {numDelta(field, before, after)}
      </div>
    </div>
  );
}

"use client";
/** OWNER: W10. Schema-driven table of one entity type. Click a cell → blame. */
import { useCallback, useMemo, useState } from "react";
import type { CRMState, EntityRecord, FieldValue } from "@/core/types";
import s from "./crm.module.css";
import { columnsFor, entityName, fmtValue, isLive, resolve, sameValue } from "./lib";
import { BlamePopover, type BlameTarget } from "./BlamePopover";

export interface EntityTableProps {
  state: CRMState;
  type: string;
  showHidden?: boolean;
  newFields?: Set<string>; // "type.field"
  filter?: string;
  /** compare to another state: changed cells are highlighted, and the "was" value is shown on hover */
  compareTo?: CRMState | null;
  blame?: boolean;
  prByEvent?: Record<string, string>;
  maxRows?: number;
}

const NUMERIC = new Set(["number"]);

export function EntityTable({ state, type, showHidden, newFields, filter, compareTo, blame = true, prByEvent, maxRows }: EntityTableProps) {
  const [target, setTarget] = useState<BlameTarget | null>(null);
  const close = useCallback(() => setTarget(null), []);
  const cols = useMemo(() => columnsFor(state, type), [state, type]);
  const ftype = useMemo(() => Object.fromEntries((state.schema[type] || []).map((f) => [f.field, f.fieldType])), [state, type]);

  const rows = useMemo(() => {
    const q = (filter || "").trim().toLowerCase();
    let list = Object.values(state.entities).filter((e) => e.type === type && (showHidden || isLive(e)));
    if (q) list = list.filter((e) => e.id.toLowerCase().includes(q) || Object.values(e.attrs).some((v) => fmtValue(v).toLowerCase().includes(q)));
    list.sort((a, b) => Number(!isLive(a)) - Number(!isLive(b)) || String(a.attrs.name ?? a.id).localeCompare(String(b.attrs.name ?? b.id)));
    return maxRows ? list.slice(0, maxRows) : list;
  }, [state, type, showHidden, filter, maxRows]);

  const render = (e: EntityRecord, field: string, v: FieldValue | undefined) => {
    const t = ftype[field];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return <span className={s.empty}>—</span>;
    if (t === "ref" || (typeof v === "string" && /^(company|contact|deal):/.test(v))) {
      const id = String(v);
      const r = resolve(state, id);
      return <span className={s.cellText}>{entityName(state, r)}{r !== id ? <span className={s.faint}> ↳</span> : null}</span>;
    }
    if (Array.isArray(v)) return <span className={s.row} style={{ gap: 4, flexWrap: "nowrap" }}>{v.map((x) => <span key={x} className={s.chip}>{x}</span>)}</span>;
    if (field === "stage") {
      const st = String(v);
      const cls = st === "closed_won" || st === "customer" ? s.chipAdd : st === "closed_lost" || st === "churned" ? s.chipDel : st === "negotiation" ? s.chipWarn : s.chipSystem;
      return <span className={`${s.chip} ${cls}`}>{st.replace("_", " ")}</span>;
    }
    if (typeof v === "number" || NUMERIC.has(t)) return <span className={s.num}>{fmtValue(v, field)}</span>;
    void e;
    return <span className={s.cellText}>{fmtValue(v, field)}</span>;
  };

  return (
    <>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              {cols.map((c) => {
                const isNew = newFields?.has(`${type}.${c}`);
                return <th key={c} className={isNew ? s.newCol : undefined}>{c}{isNew ? <span className={s.newBadge}>New</span> : null}</th>;
              })}
              <th>id</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const ghost = !isLive(e);
              const prevE = compareTo?.entities[e.id];
              return (
                <tr key={e.id} className={ghost ? s.rowGhost : undefined}>
                  {cols.map((c) => {
                    const v = e.attrs[c];
                    const changed = !!compareTo && (!prevE || !sameValue(prevE.attrs[c], v));
                    const active = target?.entity === e.id && target.field === c;
                    const isNew = newFields?.has(`${type}.${c}`);
                    const title = changed && prevE ? `now: ${fmtValue(prevE.attrs[c], c)}` : undefined;
                    return (
                      <td key={c} className={isNew ? s.newCol : undefined}>
                        {blame && !ghost ? (
                          <button
                            data-blame-cell
                            className={`${s.cell} ${s.cellBtn} ${active ? s.cellActive : ""} ${changed ? s.cellChanged : ""}`}
                            title={title || "Click for blame"}
                            onClick={(ev) => {
                              if (active) return setTarget(null);
                              setTarget({ entity: e.id, field: c, value: v, rect: (ev.currentTarget as HTMLElement).getBoundingClientRect() });
                            }}
                          >{render(e, c, v)}</button>
                        ) : (
                          <div className={`${s.cell} ${changed ? s.cellChanged : ""}`} title={title}>{render(e, c, v)}</div>
                        )}
                      </td>
                    );
                  })}
                  <td>
                    <div className={s.idCell}>
                      {e.mergedInto ? <span className={`${s.chip} ${s.chipWarn}`} style={{ textDecoration: "none" }}>merged into {entityName(state, e.mergedInto)}</span>
                        : e.deleted ? <span className={`${s.chip} ${s.chipDel}`}>deleted</span>
                        : e.id}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!rows.length ? <tr><td colSpan={cols.length + 1}><div className={`${s.cell} ${s.faint}`}>No {type}s.</div></td></tr> : null}
          </tbody>
        </table>
      </div>
      {target ? <BlamePopover target={target} state={state} onClose={close} prByEvent={prByEvent} /> : null}
    </>
  );
}

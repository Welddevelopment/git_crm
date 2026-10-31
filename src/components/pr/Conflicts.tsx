"use client";
/* OWNER: W9. Three-way conflict resolution: base / main (ours) / this PR (theirs). */
import type { Conflict, FieldValue } from "@/core/types";
import { IconAlert, IconCheck, IconInfo, IconMerged, IconPerson, IconBot } from "./atoms";
import { isEntityRef, isMoneyField, plainValue } from "./format";

export type Resolution = "ours" | "theirs";

const KIND_LABEL: Record<Conflict["kind"], string> = {
  field: "Both sides changed this field",
  deleted: "Main deleted this record",
  "merged-away": "Main merged this record away",
  schema: "Field no longer exists in main's schema",
};

export function ConflictsPanel({
  conflicts, resolutions, onResolve, name, readOnly, prAuthor,
}: {
  conflicts: Conflict[];
  resolutions: Record<string, Resolution>;
  onResolve: (id: string, r: Resolution | null) => void;
  name: (id?: string) => string;
  readOnly: boolean;
  prAuthor: string;
}) {
  const auto = conflicts.filter((c) => c.autoResolved);
  const manual = conflicts.filter((c) => !c.autoResolved);
  if (!conflicts.length) return null;
  const left = manual.filter((c) => !c.resolution && !resolutions[c.id]).length;

  const show = (v: FieldValue | undefined, field?: string) => {
    if (v === undefined) return <span className="pr-muted" style={{ fontStyle: "italic" }}>not set</span>;
    if (isEntityRef(v)) return <>{name(v)} <span className="pr-muted" style={{ fontSize: 11 }}>{v}</span></>;
    if (typeof v === "number" && isMoneyField(field)) return plainValue(v, field);
    return plainValue(v, field);
  };

  return (
    <section id="pr-conflicts">
      <h2 className="pr-section-title">
        Conflicts{" "}
        <span className="pr-muted">
          · {manual.length ? (left ? `${left} of ${manual.length} need a decision` : `all ${manual.length} resolved`) : "none need a decision"}
          {auto.length ? ` · ${auto.length} auto-resolved` : ""}
        </span>
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {auto.map((c) => (
          <div key={c.id} className="pr-autores">
            <span className="ai">
              <IconInfo />
            </span>
            <div>
              <strong>Rebased onto {name(c.autoResolved!.to)}</strong>
              <span className="pr-muted">
                {" "}· {name(c.entity)} <span className="pr-mono" style={{ fontSize: 11 }}>({c.entity})</span> was merged away on main
                {c.field ? <> — this PR&apos;s <span className="pr-mono">{c.field}</span> change now applies to the survivor</> : null}.
              </span>
              {c.autoResolved!.note && <div className="pr-muted pr-small" style={{ marginTop: 2 }}>{c.autoResolved!.note}</div>}
            </div>
          </div>
        ))}
        {manual.map((c) => {
          const chosen: Resolution | null = resolutions[c.id] ?? (c.resolution === "ours" || c.resolution === "theirs" ? c.resolution : null);
          const pick = (r: Resolution) => onResolve(c.id, chosen === r ? null : r);
          return (
            <div key={c.id} className="panel pr-conf">
              <div className="pr-conf-head">
                {chosen ? <IconCheck className="pr-icon-open" /> : <IconAlert className="pr-icon-reverted" />}
                <span className="what">
                  {name(c.entity)}
                  {c.field && <span className="pr-mono" style={{ fontWeight: 400 }}> · {c.field}</span>}
                </span>
                <span className="pr-muted pr-small">{KIND_LABEL[c.kind]}</span>
                <span className="pr-spacer" />
                <span className="pr-mono pr-muted" style={{ fontSize: 11 }}>{c.id}</span>
              </div>
              <div className="pr-three">
                <div className="col">
                  <span className="lbl">Base <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· when branched</span></span>
                  <span className="val pr-muted">{show(c.base, c.field)}</span>
                </div>
                <div className={`col ours ${chosen === "ours" ? "chosen" : chosen === "theirs" ? "dropped" : ""}`}>
                  <span className="lbl">
                    <IconPerson size={11} /> main <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· ours</span>
                  </span>
                  <span className="val">{c.kind === "deleted" ? <span style={{ color: "var(--del)" }}>record deleted</span> : c.kind === "schema" ? <span style={{ color: "var(--del)" }}>field removed</span> : show(c.ours, c.field)}</span>
                  {!readOnly && (
                    <button className={`btn ${chosen === "ours" ? "on" : ""}`} onClick={() => pick("ours")}>
                      {chosen === "ours" ? <><IconCheck size={12} /> Keeping main</> : "Keep main"}
                    </button>
                  )}
                </div>
                <div className={`col theirs ${chosen === "theirs" ? "chosen" : chosen === "ours" ? "dropped" : ""}`}>
                  <span className="lbl">
                    <IconBot size={11} /> this PR <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· theirs · {prAuthor}</span>
                  </span>
                  <span className="val">{show(c.theirs, c.field)}</span>
                  {!readOnly && (
                    <button className={`btn ${chosen === "theirs" ? "on" : ""}`} onClick={() => pick("theirs")}>
                      {chosen === "theirs" ? <><IconCheck size={12} /> Taking PR</> : <><IconMerged size={12} /> Take PR</>}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

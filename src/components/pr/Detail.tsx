"use client";
/* OWNER: W9. PR detail: header, staleness, policy, diff, conflicts, evidence, actions, raw events. */
import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PRDetail } from "@/core/api-contract";
import type { CRMState, EntityId, Event, EvidenceDoc } from "@/core/types";
import { api } from "@/client/api";
import BranchGraph from "@/components/graph/BranchGraph";
import { ActorChip, IconAlert, IconArrowRight, IconClock, IconDiff, IconList, StatusPill } from "./atoms";
import { ConflictsPanel, type Resolution } from "./Conflicts";
import { deriveChanges, Diff } from "./Diff";
import { collectEvidence, DocIcon, DocView, EvidencePanel } from "./Evidence";
import { EventsTab } from "./Events";
import { actorName, changeCount, displayName, fmtAge, fmtDateTime, pluralize } from "./format";
import { mockApi } from "./mock";
import { BranchBox, computeGate, MergeBox, PolicyBox } from "./Sidebar";
import { errorMessage, prSource, withMock, type Source } from "./source";

const REVIEWER = "Joel";

function richText(s: string): ReactNode {
  return s.split(/(`[^`]+`)/g).map((p, i) => (p.startsWith("`") && p.endsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : <Fragment key={i}>{p}</Fragment>));
}

function entityOf(e: Event): EntityId | undefined {
  const op = e.op;
  if ("entity" in op) return op.entity;
  if (op.type === "entity.merge") return op.from;
  return undefined;
}

export function Detail({ id }: { id: string }) {
  const [detail, setDetail] = useState<PRDetail | null>(null);
  const [source, setSource] = useState<Source>("api");
  const [apiError, setApiError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [main, setMain] = useState<CRMState | null>(null);
  const [tab, setTab] = useState<"review" | "events">("review");
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ReactNode>(null);
  const [openEv, setOpenEv] = useState<Set<string>>(new Set());
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [openContra, setOpenContra] = useState<Set<string>>(new Set());
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await prSource.detail(id);
      setDetail(r.data);
      setSource(r.source);
      setApiError(r.error ?? null);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // main state: for display names of entities created after fork + newer evidence docs (contradictions)
  useEffect(() => {
    let cancelled = false;
    (source === "mock" ? mockApi.state() : api.state())
      .then((r) => !cancelled && setMain(r.state))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [source, detail?.pr.updatedAt, detail?.pr.staleness?.status]);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const unsub = prSource.subscribe(source, () => {
      clearTimeout(t);
      t = setTimeout(() => !busyRef.current && void load(), 200);
    });
    return () => {
      unsub();
      clearTimeout(t);
    };
  }, [source, load]);

  const pr = detail?.pr;
  const events = detail?.events ?? [];
  const base = detail?.baseState ?? null;

  const docs = useMemo(() => {
    const m: Record<string, EvidenceDoc> = { ...(main?.evidence || {}), ...(base?.evidence || {}) };
    for (const d of detail?.docs || []) m[d.id] = d;
    for (const e of events) if (e.op.type === "evidence.attach") m[e.op.doc.id] = e.op.doc;
    return m;
  }, [detail, main, base, events]);

  const names = useMemo(() => {
    const n: Record<string, string> = {};
    for (const [eid, rec] of Object.entries(main?.entities || {})) if (typeof rec.attrs?.name === "string" && rec.attrs.name) n[eid] = rec.attrs.name;
    for (const [eid, rec] of Object.entries(base?.entities || {})) if (typeof rec.attrs?.name === "string" && rec.attrs.name) n[eid] = rec.attrs.name;
    for (const e of events) if (e.op.type === "entity.create" && typeof e.op.attrs.name === "string") n[e.op.entity] = e.op.attrs.name;
    return n;
  }, [main, base, events]);

  const name = useCallback((eid?: EntityId) => displayName(eid, base, names), [base, names]);

  const changes = useMemo(() => (pr?.changes && pr.changes.length ? pr.changes : deriveChanges(events, base)), [pr, events, base]);
  const conflicts = pr?.conflicts ?? [];
  const contradicted = useMemo(() => new Set((pr?.staleness?.contradictions || []).flatMap((c) => c.affectsEvents)), [pr]);
  const evItems = useMemo(() => collectEvidence(events), [events]);

  const showEvidence = (eventId: string, idx: number) => {
    const key = `${eventId}:${idx}`;
    setTab("review");
    setOpenEv((s) => new Set(s).add(key));
    setFlashKey(key);
    setTimeout(() => setFlashKey(null), 1800);
    requestAnimationFrame(() => document.getElementById(`ev-${key}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };

  const run = async (kind: string, fn: () => Promise<ReactNode | void>) => {
    setBusy(kind);
    busyRef.current = true;
    setActionError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      await load();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
      busyRef.current = false;
    }
  };

  if (loadError && !detail)
    return (
      <div className="pr-root">
        <Link href={withMock("/prs")} className="pr-back">← Pull requests</Link>
        <div className="pr-error" style={{ marginTop: 16 }}>Could not load {id}: {loadError}</div>
      </div>
    );
  if (!detail || !pr)
    return (
      <div className="pr-root">
        <div className="pr-loading"><span className="pr-spin" /> Loading {id}…</div>
      </div>
    );

  const gate = computeGate(pr, conflicts, resolutions);
  const st = pr.staleness;
  const isOpen = pr.status === "open";
  const n = changeCount({ ...pr, changes });

  return (
    <div className="pr-root">
      {source === "mock" && (
        <div className="pr-source">
          <span className="pr-badge neutral">mock data</span>
          {apiError ? <>API unavailable ({apiError}) — showing local demo data.</> : <>Showing local demo data (?mock=1).</>}
        </div>
      )}
      <Link href={withMock("/prs")} className="pr-back">← Pull requests</Link>
      <h1 className="pr-h1">
        {pr.title}
        <span className="id">#{pr.id.replace(/^pr_/, "")}</span>
      </h1>
      <div className="pr-headline">
        <StatusPill status={pr.status} />
        <ActorChip actor={pr.author} />
        <span>{pr.status === "open" ? "wants to merge" : pr.status === "closed" ? "proposed" : "merged"} {pluralize(n, "change")}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="pr-branch">{pr.branch}</span>
          <IconArrowRight size={12} />
          <span className="pr-branch">main</span>
        </span>
        <span title={fmtDateTime(pr.createdAt)}>· opened {fmtAge(pr.createdAt)}</span>
      </div>
      {source === "api" && <div style={{ margin: "12px 0 4px" }}><BranchGraph compact focusPr={pr.id} height={110} /></div>}
      {pr.description && <p className="pr-desc">{richText(pr.description)}</p>}

      <div className="pr-dtabs" role="tablist">
        <button className={`pr-dtab ${tab === "review" ? "on" : ""}`} onClick={() => setTab("review")}>
          <IconDiff size={14} /> Review <span className="pr-count">{n}</span>
        </button>
        <button className={`pr-dtab ${tab === "events" ? "on" : ""}`} onClick={() => setTab("events")}>
          <IconList size={14} /> Events <span className="pr-count">{events.length}</span>
        </button>
      </div>

      <div className="pr-grid">
        <div className="pr-main">
          {isOpen && st?.status === "stale" && (
            <div className="pr-banner stale">
              <span className="bi"><IconAlert /></span>
              <div>
                <h4>This PR went stale — newer evidence contradicts it</h4>
                <p className="pr-muted">Something landed on main after the agent opened this PR that undercuts its reasoning. Re-run the agent or close the PR.</p>
                {st.contradictions.map((c) => {
                  const doc = docs[c.docId];
                  const open = openContra.has(c.docId);
                  return (
                    <div key={c.docId} className="pr-contra">
                      <div className="pr-row-flex">
                        <DocIcon kind={doc?.kind} />
                        <span className="t">{c.title || doc?.title || c.docId}</span>
                        {doc && <span className="pr-muted pr-small">{doc.from?.replace(/\s*<.*>/, "")} · {fmtAge(doc.ts)}</span>}
                        <span className="pr-spacer" />
                        <button className="pr-linkbtn" onClick={() => setOpenContra((s) => { const x = new Set(s); if (x.has(c.docId)) x.delete(c.docId); else x.add(c.docId); return x; })}>
                          {open ? "hide" : doc?.kind === "web" ? "view page" : "view email"}
                        </button>
                      </div>
                      <p style={{ marginTop: 6 }}>{c.explanation}</p>
                      {c.affectsEvents.length > 0 && (
                        <p className="pr-muted pr-small">
                          Affects:{" "}
                          {c.affectsEvents.map((eid, i) => {
                            const ev = events.find((e) => e.id === eid);
                            const label = ev?.op.type === "field.set" ? `${name(ev.op.entity)} · ${ev.op.field}` : eid;
                            return (
                              <span key={eid} className="pr-mono">
                                {i ? ", " : ""}
                                {label}
                              </span>
                            );
                          })}
                        </p>
                      )}
                      {open &&
                        (doc ? (
                          <div style={{ marginTop: 8 }} className="pr-doc-inline">
                            <DocView doc={doc} negative />
                          </div>
                        ) : (
                          <p className="pr-muted pr-small">Document <span className="pr-mono">{c.docId}</span> not available.</p>
                        ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {isOpen && st?.status === "version-conflict" && (
            <div className="pr-banner vconf">
              <span className="bi"><IconClock /></span>
              <div>
                <h4>Main changed fields this agent read</h4>
                <p className="pr-muted">The agent based its proposal on values that have since been updated on main.</p>
                <div className="pr-kv" style={{ marginTop: 8, gridTemplateColumns: "auto auto 1fr" }}>
                  {st.changedReads.map((r) => {
                    const [ent, field] = r.key.split("::");
                    return (
                      <Fragment key={r.key}>
                        <span>{name(ent)} · <span className="pr-mono">{field}</span></span>
                        <span className="pr-mono pr-muted">{r.key}</span>
                        <span className="pr-mono" style={{ color: "var(--warn)" }}>v{r.seenVersion} → v{r.currentVersion}</span>
                      </Fragment>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {tab === "review" ? (
            <>
              <ConflictsPanel
                conflicts={conflicts}
                resolutions={resolutions}
                onResolve={(cid, r) => setResolutions((s) => { const x = { ...s }; if (r) x[cid] = r; else delete x[cid]; return x; })}
                name={name}
                readOnly={!isOpen}
                prAuthor={actorName(pr.author)}
              />
              <Diff changes={changes} events={events} base={base} conflicts={conflicts} docs={docs} names={names} onShowEvidence={showEvidence} contradicted={contradicted} />
              <EvidencePanel
                items={evItems}
                docs={docs}
                open={openEv}
                flashKey={flashKey}
                onToggle={(k) => setOpenEv((s) => { const x = new Set(s); if (x.has(k)) x.delete(k); else x.add(k); return x; })}
                contradicted={contradicted}
                entityLabel={(ev) => {
                  const eid = entityOf(ev);
                  const f = ev.op.type === "field.set" ? `.${ev.op.field}` : "";
                  return eid ? `${name(eid)}${f}` : ev.op.type;
                }}
              />
            </>
          ) : (
            <EventsTab events={events} policy={pr.policy} contradicted={contradicted} />
          )}
        </div>

        <aside className="pr-side">
          <MergeBox
            pr={pr}
            gate={gate}
            busy={busy}
            error={actionError}
            notice={notice}
            onMerge={() =>
              run("merge", async () => {
                const r = await prSource.merge(source, pr.id, REVIEWER, Object.keys(resolutions).length ? resolutions : undefined);
                setResolutions({});
                return `Merged into main · ${pluralize(r.events?.length ?? 0, "event")} written.`;
              })
            }
            onClose={() => run("close", async () => { await prSource.close(source, pr.id, REVIEWER, "Closed from review"); return "Closed. Nothing reached main."; })}
            onRevert={() =>
              run("revert", async () => {
                const r = await prSource.revert(source, pr.id, REVIEWER);
                return (
                  <>
                    Reverted via <Link href={withMock(`/prs/${r.revertPr.id}`)} className="pr-mono">{r.revertPr.id}</Link> · {pluralize(r.events?.length ?? 0, "event")} on main.
                  </>
                );
              })
            }
            onRefresh={() => run("refresh", async () => { await prSource.refresh(source, pr.id); })}
          />
          <PolicyBox policy={pr.policy} eventCount={events.length} />
          <BranchBox pr={pr} branch={detail.branch} />
        </aside>
      </div>
    </div>
  );
}

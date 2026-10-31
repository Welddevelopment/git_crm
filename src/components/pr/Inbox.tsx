"use client";
/* OWNER: W9. PR inbox: Open / Merged / Closed / Reverted with live updates and j/k navigation. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PRStatus, PullRequest } from "@/core/types";
import { ActorChip, IconComment, IconDiff, IconPROpen, PRBadges, StatusIcon } from "./atoms";
import { changeCount, fmtAge, fmtDateTime, pluralize } from "./format";
import { errorMessage, prSource, withMock, type Source } from "./source";

const TABS: { key: PRStatus; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "merged", label: "Merged" },
  { key: "closed", label: "Closed" },
  { key: "reverted", label: "Reverted" },
];

function sortPRs(list: PullRequest[], tab: PRStatus): PullRequest[] {
  const key = (p: PullRequest) => (tab === "open" ? p.createdAt : p.mergedAt ?? p.updatedAt ?? p.createdAt);
  return [...list].sort((a, b) => key(b) - key(a));
}

export function Inbox() {
  const router = useRouter();
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  const [source, setSource] = useState<Source>("api");
  const [apiError, setApiError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [tab, setTab] = useState<PRStatus>("open");
  const [sel, setSel] = useState(0);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const seen = useRef<Set<string> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // restore tab from URL
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab") as PRStatus | null;
    if (t && TABS.some((x) => x.key === t)) setTab(t);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await prSource.list();
      const incoming = r.data.prs;
      if (seen.current) {
        const added = incoming.filter((p) => !seen.current!.has(p.id)).map((p) => p.id);
        if (added.length) {
          setFresh((f) => new Set([...f, ...added]));
          setTimeout(() => setFresh((f) => new Set([...f].filter((x) => !added.includes(x)))), 2600);
        }
      }
      seen.current = new Set(incoming.map((p) => p.id));
      setPrs(incoming);
      setSource(r.source);
      setApiError(r.error ?? null);
      setFatal(null);
    } catch (e) {
      setFatal(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // live updates: SSE → refetch (debounced); also a slow poll as a safety net
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const kick = () => {
      clearTimeout(t);
      t = setTimeout(() => void load(), 150);
    };
    const unsub = prSource.subscribe(source, kick);
    const poll = setInterval(() => void load(), source === "api" ? 15000 : 60000);
    const tick = setInterval(() => setNow(Date.now()), 30000);
    return () => {
      unsub();
      clearTimeout(t);
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [source, load]);

  const counts = useMemo(() => {
    const c: Record<PRStatus, number> = { open: 0, merged: 0, closed: 0, reverted: 0 };
    for (const p of prs || []) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [prs]);

  const rows = useMemo(() => sortPRs((prs || []).filter((p) => p.status === tab), tab), [prs, tab]);

  const switchTab = (t: PRStatus) => {
    setTab(t);
    setSel(0);
    const u = new URL(window.location.href);
    if (t === "open") u.searchParams.delete("tab");
    else u.searchParams.set("tab", t);
    window.history.replaceState(null, "", u.toString());
  };

  // keyboard: j/k move, enter/o open, 1-4 tabs
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => Math.min(rows.length - 1, s + 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => Math.max(0, s - 1));
      } else if ((e.key === "Enter" || e.key === "o") && rows[sel]) {
        e.preventDefault();
        router.push(withMock(`/prs/${rows[sel].id}`));
      } else if (["1", "2", "3", "4"].includes(e.key)) {
        switchTab(TABS[Number(e.key) - 1].key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, sel, router]);

  useEffect(() => {
    if (sel >= rows.length && rows.length) setSel(rows.length - 1);
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel, rows.length]);

  const needsAttention = (prs || []).filter((p) => p.status === "open" && (p.staleness?.status === "stale" || p.policy?.tier !== "auto")).length;

  return (
    <div className="pr-root">
      {source === "mock" && (
        <div className="pr-source">
          <span className="pr-badge neutral">mock data</span>
          {apiError ? <>API unavailable ({apiError}) — showing local demo data.</> : <>Showing local demo data (?mock=1).</>}
        </div>
      )}
      <div className="pr-inbox-head">
        <div>
          <h1>Pull requests</h1>
          <div className="pr-muted pr-small" style={{ marginTop: 4 }}>
            Agents never write to your CRM. They open PRs against <span className="pr-branch">main</span>.
            {needsAttention > 0 && <> · <strong style={{ color: "var(--text)" }}>{needsAttention}</strong> need a human</>}
          </div>
        </div>
        <span className="pr-spacer" />
        <span className={`pr-live ${source === "mock" ? "off" : ""}`} title={source === "api" ? "Subscribed to /api/stream" : "Live updates off in mock mode"}>
          <i />
          {source === "api" ? "Live" : "Offline"}
        </span>
      </div>

      {fatal && <div className="pr-error" style={{ marginBottom: 12 }}>Could not load pull requests: {fatal}</div>}

      <div className="panel pr-list">
        <div className="pr-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={`pr-tab ${tab === t.key ? "on" : ""}`} onClick={() => switchTab(t.key)}>
              <StatusIcon status={t.key} size={14} />
              {t.label}
              <span className="pr-count">{prs ? counts[t.key] : "·"}</span>
            </button>
          ))}
          <span className="pr-spacer" />
          <span className="pr-muted pr-small" style={{ paddingRight: 6 }}>
            <span className="pr-kbd">j</span> <span className="pr-kbd">k</span> move · <span className="pr-kbd">↵</span> open
          </span>
        </div>
        <div ref={listRef}>
          {!prs && !fatal && [0, 1, 2, 3].map((i) => <div key={i} className="pr-skel" />)}
          {prs && rows.length === 0 && <Empty tab={tab} />}
          {rows.map((pr, i) => (
            <Row key={pr.id} pr={pr} idx={i} selected={i === sel} fresh={fresh.has(pr.id)} now={now} onHover={() => setSel(i)} />
          ))}
        </div>
      </div>
      <div className="pr-foot">
        <span>{prs ? pluralize(prs.length, "pull request") : ""}</span>
      </div>
    </div>
  );
}

function Row({ pr, idx, selected, fresh, now, onHover }: { pr: PullRequest; idx: number; selected: boolean; fresh: boolean; now: number; onHover: () => void }) {
  const n = changeCount(pr);
  const evidenceN = (pr.changes || []).filter((c) => c.kind === "evidence.added").length;
  const stale = pr.status === "open" && pr.staleness?.status === "stale";
  const when =
    pr.status === "open" ? (
      <>opened {fmtAge(pr.createdAt, now)} by</>
    ) : pr.status === "closed" ? (
      <>closed {fmtAge(pr.updatedAt, now)} · by</>
    ) : (
      <>merged {fmtAge(pr.mergedAt ?? pr.updatedAt, now)} · by</>
    );
  return (
    <Link
      href={withMock(`/prs/${pr.id}`)}
      data-idx={idx}
      className={`pr-row ${selected ? "sel" : ""} ${fresh ? "fresh" : "enter"} ${stale ? "stale-row" : ""}`}
      style={{ animationDelay: fresh ? "0ms" : `${Math.min(idx, 12) * 22}ms` }}
      onMouseEnter={onHover}
    >
      <span className="ico">
        <StatusIcon status={pr.status} />
      </span>
      <div className="pr-row-flex" style={{ gap: 6 }}>
        <span className="title">{pr.title}</span>
        <PRBadges pr={pr} />
      </div>
      <div className="side">
        <span className="n" title={`${n} field/entity changes`}>
          <IconDiff size={13} />
          {n}
        </span>
        <span className="n" title={`${evidenceN} evidence documents attached`} style={{ opacity: evidenceN ? 1 : 0.35 }}>
          <IconComment size={13} />
          {evidenceN}
        </span>
      </div>
      <div className="meta">
        <span className="pr-mono">#{pr.id.replace(/^pr_/, "")}</span>
        <span title={fmtDateTime(pr.createdAt)}>{when}</span>
        <ActorChip actor={pr.status === "merged" || pr.status === "reverted" ? pr.mergedBy ?? pr.author : pr.author} />
        {(pr.status === "merged" || pr.status === "reverted") && pr.mergedBy && pr.mergedBy.id !== pr.author.id && (
          <>
            <span>· authored by</span>
            <ActorChip actor={pr.author} />
          </>
        )}
        <span className="pr-branch" style={{ fontSize: 11 }}>{pr.branch}</span>
      </div>
    </Link>
  );
}

function Empty({ tab }: { tab: PRStatus }) {
  const copy: Record<PRStatus, [string, string]> = {
    open: ["No open pull requests", "Run the agent fleet from the Demo page — their proposals land here for review."],
    merged: ["Nothing merged yet", "Merged PRs appear here, including ones policy auto-merged."],
    closed: ["No closed pull requests", "PRs a reviewer rejected show up here."],
    reverted: ["No reverts", "One-click revert of a merged PR undoes its changes on main."],
  };
  return (
    <div className="pr-empty">
      <IconPROpen size={28} />
      <h3>{copy[tab][0]}</h3>
      <div>{copy[tab][1]}</div>
    </div>
  );
}

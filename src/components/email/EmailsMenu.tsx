"use client";
/* "Connect your email": Gmail (OAuth) + paste-an-email → inbox/schema agents → PRs. Calendly-B styling. */
import { useCallback, useEffect, useRef, useState } from "react";

interface Status { gmail: { configured: boolean; connected: boolean; account: string | null }; pasteEnabled: boolean; docs: number }
interface PRLite { id: string; title: string; status: string }
interface Thread { id: string; subject: string; from: string; snippet: string; date: number; messages: number; match: { entity: string; label: string } | null }

const CSS = `
.em-wrap{position:relative;display:inline-flex}
.em-pop{position:absolute;right:0;top:40px;z-index:40;width:420px;max-width:calc(100vw - 32px);max-height:calc(100vh - 80px);overflow:auto;background:#fff;border:var(--hairline);border-radius:var(--radius-panel);box-shadow:none}
.em-body{display:flex;flex-direction:column}
.em-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:var(--hairline);font-size:14px;font-weight:600;color:var(--ink)}
.em-sec{padding:14px 16px;border-bottom:var(--hairline);display:flex;flex-direction:column;gap:10px}
.em-sec:last-child{border-bottom:0}
.em-title{font-size:13px;font-weight:600;color:var(--ink);display:flex;align-items:center;gap:8px;justify-content:space-between}
.em-meta{font-size:11.5px;color:var(--faint);line-height:1.5}
.em-meta code{font-size:11px;color:var(--ink-2)}
.em-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.em-chip{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:var(--radius-control);background:var(--blue-soft);color:var(--blue);font-size:11px;font-weight:600;white-space:nowrap}
.em-chip.muted{background:#fff;border:var(--hairline);color:var(--faint);font-weight:500}
.em-ta,.em-in{width:100%;font:inherit;font-size:13px;color:var(--ink);background:#fff;border:var(--hairline);border-radius:10px;padding:9px 11px;outline:none;resize:vertical}
.em-in{height:32px;border-radius:var(--radius-control);padding:0 12px}
.em-ta:focus,.em-in:focus{border-color:var(--blue)}
.em-ta{min-height:130px;font-family:var(--font)}
.em-list{display:flex;flex-direction:column;border:var(--hairline);border-radius:10px;max-height:300px;overflow:auto}
.em-item{display:flex;gap:10px;padding:9px 11px;border-bottom:var(--hairline);cursor:pointer;align-items:flex-start}
.em-item:last-child{border-bottom:0}
.em-item:hover{background:var(--blue-soft)}
.em-item input{margin-top:3px;accent-color:var(--blue)}
.em-item .s{font-size:13px;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.em-item .f{font-size:11.5px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.em-item .n{font-size:11.5px;color:var(--faint);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.em-res{font-size:12.5px;color:var(--ink);line-height:1.6}
.em-res a{color:var(--blue);font-weight:500}
.em-err{font-size:12.5px;color:var(--negative)}
.em-ok{color:var(--positive);font-weight:600}
.em-sm{height:28px!important;padding:0 12px!important;font-size:12.5px}
.em-dis{opacity:.55;pointer-events:none}
.em-page{max-width:720px;border:var(--hairline);border-radius:var(--radius-panel);background:#fff}
`;

const prLinks = (prs: PRLite[]) =>
  prs.map((p, i) => (
    <span key={p.id}>{i ? " · " : ""}<a href={`/prs/${encodeURIComponent(p.id)}`}>{p.title.length > 60 ? p.title.slice(0, 58) + "…" : p.title}</a>{p.status === "merged" ? " (auto-merged)" : ""}</span>
  ));

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

function GmailSection({ status, reload }: { status: Status | null; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"list" | "import" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; prs: PRLite[] } | null>(null);

  const load = useCallback(async (query: string) => {
    setBusy("list"); setErr(null);
    try {
      const r = await api<{ threads: Thread[] }>(`/api/integrations/gmail/threads?q=${encodeURIComponent(query)}`);
      setThreads(r.threads);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }, []);

  const g = status?.gmail;
  if (!status) return <div className="em-meta">Loading…</div>;
  if (!g?.configured) {
    return (
      <div className="em-meta">
        Gmail needs <code>GOOGLE_CLIENT_ID</code> / <code>GOOGLE_CLIENT_SECRET</code> on the server (a Google Cloud Web OAuth client with the Gmail API enabled; redirect URI <code>/api/integrations/gmail/callback</code>). Until then, paste an email below.
      </div>
    );
  }
  if (!g.connected) {
    return (
      <div className="em-row">
        <a className="btn primary" href="/api/integrations/gmail/connect" onClick={(e) => { if (window.top !== window.self) { e.preventDefault(); window.open("/api/integrations/gmail/connect", "_blank", "noopener"); } }}>Connect Gmail</a>
        <span className="em-meta">Read-only. Pick which emails the agents see.</span>
      </div>
    );
  }
  const doImport = async () => {
    setBusy("import"); setErr(null); setResult(null);
    try {
      const r = await api<{ imported: number; prs: PRLite[] }>("/api/integrations/gmail/import", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadIds: [...sel] }),
      });
      setResult(r); setSel(new Set()); reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const disconnect = async () => {
    await api("/api/integrations/gmail/disconnect", { method: "POST" }).catch(() => undefined);
    setThreads(null); setOpen(false); reload();
  };
  return (
    <>
      <div className="em-row" style={{ justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, color: "var(--ink)" }}><span className="em-ok">●</span> {g.account || "Connected"}</span>
        <span className="em-row">
          {!open && <button className="btn em-sm" onClick={() => { setOpen(true); void load(q); }}>Choose emails…</button>}
          <button className="btn em-sm" onClick={disconnect} title="Forget the Gmail token">Disconnect</button>
        </span>
      </div>
      {open && (
        <>
          <form className="em-row" onSubmit={(e) => { e.preventDefault(); void load(q); }}>
            <input className="em-in" style={{ flex: 1 }} placeholder="Search Gmail (default: newer_than:30d)" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn em-sm" type="submit" disabled={busy === "list"}>{busy === "list" ? "…" : "Search"}</button>
          </form>
          {threads && (
            threads.length ? (
              <div className="em-list">
                {threads.map((t) => (
                  <label key={t.id} className="em-item">
                    <input type="checkbox" checked={sel.has(t.id)} onChange={(e) => {
                      const n = new Set(sel); if (e.target.checked) n.add(t.id); else n.delete(t.id); setSel(n);
                    }} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span className="em-row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                        <span className="s">{t.subject}</span>
                        {t.match ? <span className="em-chip" title={t.match.entity}>CRM · {t.match.label}</span> : <span className="em-chip muted">not in CRM</span>}
                      </span>
                      <span className="f" style={{ display: "block" }}>{t.from}{t.messages > 1 ? ` · ${t.messages} messages` : ""}{t.date ? ` · ${new Date(t.date).toLocaleDateString()}` : ""}</span>
                      <span className="n">{t.snippet}</span>
                    </span>
                  </label>
                ))}
              </div>
            ) : <div className="em-meta">No threads match.</div>
          )}
          {threads && threads.length > 0 && (
            <div className="em-row" style={{ justifyContent: "space-between" }}>
              <span className="em-meta">{sel.size} selected</span>
              <button className="btn primary em-sm" disabled={!sel.size || busy === "import"} onClick={doImport}>{busy === "import" ? "Importing…" : "Import selected"}</button>
            </div>
          )}
        </>
      )}
      {result && (
        <div className="em-res">
          {result.imported} email{result.imported === 1 ? "" : "s"} imported · {result.prs.length} PR{result.prs.length === 1 ? "" : "s"} opened → <a href="/prs">view</a>
          {result.prs.length > 0 && <div>{prLinks(result.prs)}</div>}
        </div>
      )}
      {err && <div className="em-err">{err}</div>}
    </>
  );
}

function PasteSection({ reload }: { reload: () => void }) {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ title: string; entities: number; prs: PRLite[] } | null>(null);
  const send = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await api<{ doc: { title: string; entities?: string[] }; prs: PRLite[] }>("/api/integrations/email/ingest", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw }),
      });
      setResult({ title: r.doc.title, entities: r.doc.entities?.length ?? 0, prs: r.prs });
      setRaw(""); reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <textarea className="em-ta" value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false}
        placeholder={"From: Priya Sharma <priya@acmerobotics.com>\nSubject: Seats\n\nHi Joel, we'd like 60 seats, total $60,000…"} />
      <div className="em-row" style={{ justifyContent: "space-between" }}>
        <span className="em-meta">Paste headers + body, or just the body.</span>
        <button className="btn primary em-sm" disabled={!raw.trim() || busy} onClick={send}>{busy ? "Agents reading…" : "Send to agents"}</button>
      </div>
      {result && (
        <div className="em-res">
          “{result.title}” added to the inbox · {result.prs.length ? <>{result.prs.length} PR{result.prs.length === 1 ? "" : "s"} opened → {prLinks(result.prs)}</> : <span style={{ color: "var(--ink-2)" }}>no CRM changes found{result.entities ? "" : " (sender not matched to a CRM record)"}</span>}
        </div>
      )}
      {err && <div className="em-err">{err}</div>}
    </>
  );
}

export function EmailsPanel({ onClose }: { onClose?: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const reload = useCallback(() => { api<Status>("/api/integrations/email/status").then(setStatus).catch(() => undefined); }, []);
  useEffect(() => { reload(); }, [reload]);
  return (
    <div className="em-body">
      <style>{CSS}</style>
      <div className="em-head">
        <span>Emails</span>
        <span className="em-row">
          {status && status.docs > 0 && <span className="em-chip muted">{status.docs} added</span>}
          {onClose && <button className="btn em-sm" onClick={onClose} aria-label="Close">Close</button>}
        </span>
      </div>
      <div className="em-sec">
        <div className="em-title">Gmail</div>
        <GmailSection status={status} reload={reload} />
      </div>
      <div className="em-sec">
        <div className="em-title">Paste an email <span className="em-meta" style={{ fontWeight: 400 }}>inbox + schema agents open PRs</span></div>
        <PasteSection reload={reload} />
      </div>
      <div className="em-sec em-dis" aria-disabled="true">
        <div className="em-title">Outlook <span className="em-chip muted">soon</span></div>
      </div>
    </div>
  );
}

/** TopBar pill + popover. Auto-opens after the Gmail OAuth redirect (/?emails=connected). */
export function EmailsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    try {
      const u = new URL(location.href);
      if (u.searchParams.get("emails")) {
        setOpen(true);
        u.searchParams.delete("emails"); u.searchParams.delete("reason");
        history.replaceState(null, "", u.pathname + (u.search === "?" ? "" : u.search) + u.hash);
      }
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <span className="em-wrap" ref={ref}>
      <style>{CSS}</style>
      <button className={`btn${open ? " primary" : ""}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 6.5l8.5 6 8.5-6" /></svg>
        Emails
      </button>
      {open && <div className="em-pop" role="dialog" aria-label="Emails"><EmailsPanel onClose={() => setOpen(false)} /></div>}
    </span>
  );
}

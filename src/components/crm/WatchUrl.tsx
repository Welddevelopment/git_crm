"use client";
/** OWNER: A4 webwatch (UI on W10's /crm). "Watch account by URL": Firecrawl scrape → webwatch opens a PR. */
import { useState, type FormEvent } from "react";
import Link from "next/link";
import s from "./crm.module.css";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; url: string }
  | { kind: "ok"; prId: string; title: string }
  | { kind: "err"; msg: string };

export function WatchUrl() {
  const [url, setUrl] = useState("");
  const [st, setSt] = useState<Status>({ kind: "idle" });
  const busy = st.kind === "busy";

  async function submit(e: FormEvent) {
    e.preventDefault();
    const target = url.trim();
    if (!target || busy) return;
    setSt({ kind: "busy", url: target });
    try {
      const res = await fetch("/api/accounts/watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: target }),
      });
      const body = (await res.json().catch(() => ({}))) as { pr?: { id: string; title: string }; error?: string };
      if (!res.ok || !body.pr) throw new Error(body.error || `Request failed (${res.status})`);
      setSt({ kind: "ok", prId: body.pr.id, title: body.pr.title });
      setUrl("");
    } catch (err) {
      setSt({ kind: "err", msg: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className={`${s.panel} ${s.watch}`}>
      <span className={s.watchLabel}>Watch account by URL</span>
      <form className={s.watchForm} onSubmit={submit}>
        <input
          className={`${s.search} ${s.watchInput}`}
          type="text"
          inputMode="url"
          placeholder="https://company.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          aria-label="Company website URL"
        />
        <button className={`${s.btn} ${s.btnPrimary}`} type="submit" disabled={busy || !url.trim()}>
          {busy ? <span className={s.spinner} /> : <span aria-hidden>🔥</span>} {busy ? "Scraping…" : "Scrape with Firecrawl"}
        </button>
      </form>
      {st.kind === "busy" ? (
        <span className={`${s.watchStatus} ${s.muted}`}>Crawling {st.url} (homepage, careers, pricing, about) — this can take 10–20s…</span>
      ) : st.kind === "ok" ? (
        <span className={`${s.watchStatus} ${s.watchOk}`}>
          <Link href={`/prs/${st.prId}`}>PR opened — review it</Link>
          <span className={s.muted}>{st.title}</span>
        </span>
      ) : st.kind === "err" ? (
        <span className={`${s.watchStatus} ${s.err}`}>{st.msg}</span>
      ) : (
        <span className={`${s.watchStatus} ${s.muted}`}>The agent proposes the account as a PR — nothing lands on main until you merge.</span>
      )}
    </div>
  );
}

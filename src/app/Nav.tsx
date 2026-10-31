"use client";
/* Lead-owned app shell navigation (Calendly-B sidebar). */
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import type React from "react";

const I = {
  overview: <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>,
  prs: <svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V10a3 3 0 0 0-3-3h-4"/><path d="M13 5l-2 2 2 2"/></svg>,
  crm: <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/></svg>,
  time: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg>,
  demo: <svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>,
  ext: <svg viewBox="0 0 24 24"><path d="M10 4h4v3a2 2 0 1 0 4 0V4h2v6h-3a2 2 0 1 0 0 4h3v6h-6v-3a2 2 0 1 0-4 0v3H4v-6h3a2 2 0 1 0 0-4H4V4z"/></svg>,
  settings: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>,
};

const GROUPS: { label: string; items: { href: string; label: string; icon: React.ReactNode }[] }[] = [
  { label: "Home", items: [{ href: "/", label: "Overview", icon: I.overview }] },
  { label: "Review", items: [{ href: "/prs", label: "Pull requests", icon: I.prs }] },
  { label: "CRM", items: [{ href: "/crm", label: "Records (main)", icon: I.crm }, { href: "/timeline", label: "Time travel", icon: I.time }] },
  { label: "Run", items: [{ href: "/demo", label: "Demo console", icon: I.demo }] },
  { label: "Connect", items: [{ href: "/extension", label: "Chrome extension", icon: I.ext }, { href: "/settings", label: "Settings", icon: I.settings }] },
];

const TITLES: [string, string][] = [["/prs", "Pull requests"], ["/crm", "Records"], ["/timeline", "Time travel"], ["/demo", "Demo console"], ["/extension", "Chrome extension"], ["/settings", "Settings"]];

export function Sidebar() {
  const path = usePathname() || "/";
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <aside className="ml-side">
      <a href="/" className="ml-logo"><span className="ml-mark">G</span>Git CRM</a>
      {GROUPS.map((g) => (
        <div key={g.label}>
          <div className="ml-group">{g.label}</div>
          {g.items.map((it) => (
            <a key={it.href} href={it.href} className={`ml-item${active(it.href) ? " active" : ""}`}>{it.icon}{it.label}</a>
          ))}
        </div>
      ))}
    </aside>
  );
}

export function TopBar() {
  const path = usePathname() || "/";
  const title = TITLES.find(([p]) => path.startsWith(p))?.[1] ?? "Overview";
  return (
    <div className="ml-top">
      <span>Git CRM · <span style={{ color: "var(--ink)" }}>{title}</span></span>
      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="live"><i />Live</span>
        <a className="btn" href="/extension">Get the extension</a>
        <a className="btn primary" href="/demo">Run demo</a>
      </span>
    </div>
  );
}

/* Embed mode (`?embed=1`): used by the Chrome extension side panel, which iframes these pages.
   Hides the sidebar + top bar (CSS keyed on html[data-embed="1"]) and keeps embed=1 on
   same-origin link clicks so navigation inside the iframe stays chrome-less. Sticky for the
   iframe's session so client-side router.push() targets stay embedded too. */
const EMBED_KEY = "gitcrm:embed";
export function EmbedMode() {
  const params = useSearchParams();
  const q = params?.get("embed") ?? null;
  useEffect(() => {
    let on = q === "1";
    try {
      if (q === "1") sessionStorage.setItem(EMBED_KEY, "1");
      else if (q === "0") sessionStorage.removeItem(EMBED_KEY);
      else if (sessionStorage.getItem(EMBED_KEY) === "1") on = true;
    } catch { /* storage blocked */ }
    if (on) document.documentElement.dataset.embed = "1";
    else delete document.documentElement.dataset.embed;
  }, [q]);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (document.documentElement.dataset.embed !== "1") return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.hasAttribute("download") || (a.target && a.target !== "_self")) return;
      let u: URL;
      try { u = new URL(a.href, location.href); } catch { return; }
      if (u.origin !== location.origin || u.searchParams.get("embed") === "1") return;
      u.searchParams.set("embed", "1");
      a.href = u.pathname + u.search + u.hash; // rewrite before the browser follows it
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}

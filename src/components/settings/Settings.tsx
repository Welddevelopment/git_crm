"use client";
/** OWNER: settings worker. Settings shell: left sub-nav (hash-synced) + three sections. */
import { useEffect, useState } from "react";
import { Agents } from "./Agents";
import { BranchProtection } from "./BranchProtection";
import { Integrations } from "./Integrations";

const ICONS = {
  integrations: <svg viewBox="0 0 24 24" aria-hidden><path d="M4 8h13M13 4l4 4-4 4" /><path d="M20 16H7M11 12l-4 4 4 4" /></svg>,
  "branch-protection": <svg viewBox="0 0 24 24" aria-hidden><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></svg>,
  agents: <svg viewBox="0 0 24 24" aria-hidden><rect x="5" y="8" width="14" height="11" rx="3" /><path d="M12 4v4M9.5 13h.01M14.5 13h.01" /></svg>,
};

const SECTIONS = [
  { id: "integrations", label: "Integrations" },
  { id: "branch-protection", label: "Branch protection" },
  { id: "agents", label: "Agents & trust" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];
const isSection = (s: string): s is SectionId => SECTIONS.some((x) => x.id === s);

export function Settings() {
  const [section, setSection] = useState<SectionId>("integrations");

  useEffect(() => {
    const sync = () => {
      const h = window.location.hash.replace(/^#/, "");
      if (isSection(h)) setSection(h);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  function go(id: SectionId) {
    setSection(id);
    history.replaceState(null, "", `#${id}`);
  }

  return (
    <div className="st-root">
      <nav className="st-nav" aria-label="Settings sections">
        <div className="st-nav-title">Settings</div>
        {SECTIONS.map((s) => (
          <button key={s.id} className={section === s.id ? "on" : ""} aria-current={section === s.id ? "page" : undefined} onClick={() => go(s.id)}>
            {ICONS[s.id]}
            {s.label}
          </button>
        ))}
        <div className="st-live" style={{ padding: "14px 10px 0" }}><i /> Live</div>
      </nav>
      <section style={{ minWidth: 0 }}>
        {section === "integrations" ? <Integrations /> : section === "branch-protection" ? <BranchProtection /> : <Agents />}
      </section>
    </div>
  );
}

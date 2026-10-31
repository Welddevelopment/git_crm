"use client";
/** OWNER: settings worker. Settings shell: left sub-nav (hash-synced) + three sections. */
import { useEffect, useState } from "react";
import { Agents } from "./Agents";
import { BranchProtection } from "./BranchProtection";
import { Integrations } from "./Integrations";

const SECTIONS = [
  { id: "integrations", label: "Integrations", icon: "⇄" },
  { id: "branch-protection", label: "Branch protection", icon: "⛨" },
  { id: "agents", label: "Agents & trust", icon: "◎" },
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
            <span className="st-muted" style={{ width: 16, textAlign: "center" }}>{s.icon}</span>
            {s.label}
          </button>
        ))}
        <div className="st-live" style={{ padding: "12px 10px 0" }}><i /> live</div>
      </nav>
      <section style={{ minWidth: 0 }}>
        {section === "integrations" ? <Integrations /> : section === "branch-protection" ? <BranchProtection /> : <Agents />}
      </section>
    </div>
  );
}

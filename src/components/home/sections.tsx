/** OWNER: home worker. Static sections of the Overview (home) page: hero, how-it-works strip, differentiators. */
import type { CSSProperties, ReactNode } from "react";
import h from "./home.module.css";

const ic = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

const IconBranch = () => (
  <svg {...ic}><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10M18 10c0 4-6 3-11.2 7.4" /></svg>
);
const IconCheck = () => (
  <svg {...ic}><path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></svg>
);
const IconReview = () => (
  <svg {...ic}><path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" /><circle cx="12" cy="12" r="2.8" /></svg>
);
const IconDb = () => (
  <svg {...ic}><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" /><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" /></svg>
);
const IconPlay = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M4 2.5v11l9-5.5-9-5.5Z" /></svg>
);
const IconPuzzle = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M10 4a2 2 0 1 1 4 0v1h4a1 1 0 0 1 1 1v4h-1a2 2 0 1 0 0 4h1v4a1 1 0 0 1-1 1h-4v-1a2 2 0 1 0-4 0v1H6a1 1 0 0 1-1-1v-4h1a2 2 0 1 0 0-4H5V6a1 1 0 0 1 1-1h4V4Z" />
  </svg>
);
const IconPlug = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0V7ZM12 17v5" />
  </svg>
);

export function Hero({ badges, headline = true }: { badges?: ReactNode; headline?: boolean }) {
  return (
    <section className={h.hero}>
      <div>
        {badges ? <div className={h.eyebrowRow}>{badges}</div> : null}
        {headline ? <h1 className={h.headline}>Agents never write to your CRM. <em>They open PRs against it.</em></h1> : null}
        <p className={h.subhead} style={headline ? undefined : { marginTop: 0 }}>
          A git layer in front of your CRM. Every AI agent works on its own <b>branch</b> and opens a <b>pull request with evidence</b>;
          Git CRM merges them, catches conflicts, holds risky changes for you, and can revert anything.
        </p>
        <div className={h.ctas}>
          <a className={h.cta} href="/demo"><IconPlay /> Run the demo</a>
          <a className={h.cta} href="/extension"><IconPuzzle /> Install the Chrome extension</a>
          <a className={h.cta} href="/settings"><IconPlug /> Connect your CRM</a>
        </div>
      </div>
      <div className={h.works}>
        <span className={h.worksLabel}>Works with</span>
        <div className={h.chips}>
          <span className={h.chip}><i />HubSpot</span>
          <span className={h.chip}><i />Attio</span>
          <span className={`${h.chip} ${h.chipSoon}`}><i />Salesforce <span className={h.soon}>soon</span></span>
          <span className={`${h.chip} ${h.chipSoon}`}><i />Pipedrive <span className={h.soon}>soon</span></span>
          <span className={`${h.chip} ${h.chipApi}`}><i />Any agent via API</span>
        </div>
      </div>
    </section>
  );
}

const STEPS: { title: string; body: string; color: string; icon: ReactNode }[] = [
  { title: "Agents propose", body: "Each agent writes to its own branch and opens a PR, every field backed by evidence.", color: "var(--blue)", icon: <IconBranch /> },
  { title: "Git CRM checks", body: "Three-way merge, conflicts between agents, branch-protection policy, stale evidence.", color: "var(--ink-2)", icon: <IconCheck /> },
  { title: "You review", body: "Approve in the web app, in the Chrome side panel on the CRM record, or by text.", color: "var(--ink-2)", icon: <IconReview /> },
  { title: "Your CRM updates", body: "Write-back to HubSpot or Attio with full history. Revert any change, any time.", color: "var(--positive)", icon: <IconDb /> },
];

export function HowItWorks() {
  return (
    <section className={h.steps} aria-label="How it works">
      {STEPS.map((st, i) => (
        <div key={st.title} className={h.step} style={{ "--c": st.color } as CSSProperties}>
          <span className={h.stepIcon}>{st.icon}</span>
          <span className={h.stepTitle}><span className={h.stepNum}>0{i + 1}</span>{st.title}</span>
          <span className={h.stepBody}>{st.body}</span>
        </div>
      ))}
    </section>
  );
}

const WHY: { title: string; body: ReactNode; color: string }[] = [
  { title: "Concurrency", color: "var(--blue)", body: <>Many agents at once, not one diff at a time. Branches get <b>real three-way merges</b>, and agent-vs-agent <b>conflicts</b> surface like git conflicts.</> },
  { title: "Stale-decision detection", color: "var(--ink-2)", body: <>A PR that was right at 9am re-checks itself when new evidence lands, and flips to <b>stale</b> before anyone merges it at 4pm.</> },
  { title: "Semantic rebase", color: "var(--ink-2)", body: <>An edit to a contact that another agent merged away as a duplicate <b>follows the survivor</b> instead of failing or resurrecting it.</> },
];

export function WhyNotQueue() {
  return (
    <section className={h.whyPanel}>
      <div className={h.whyHead}><span>Why not just an approval queue?</span><span className={h.whyMeta}>three things a queue can’t do</span></div>
      <div className={h.why}>
        {WHY.map((w) => (
          <div key={w.title} className={h.whyCard} style={{ "--c": w.color } as CSSProperties}>
            <h3>{w.title}</h3>
            <p>{w.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

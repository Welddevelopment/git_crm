/* OWNER: extension worker. Install page for the Mainline Chrome extension (served zip: /mainline-extension.zip). */
export const metadata = { title: "Chrome extension — Mainline" };

const CSS = `
.xt{max-width:880px;margin:8px auto 40px;line-height:1.5}
.xt h1{font-size:26px;font-weight:600;letter-spacing:-.015em;margin:6px 0 8px}
.xt .lede{color:var(--muted);font-size:15px;max-width:640px;margin:0}
.xt .eyebrow{display:inline-flex;gap:6px;align-items:center;font-size:12px;color:var(--agent);border:1px solid color-mix(in srgb,var(--agent) 40%,transparent);background:color-mix(in srgb,var(--agent) 10%,transparent);padding:2px 9px;border-radius:999px}
.xt .cta{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:20px 0 28px}
.xt .dl{display:inline-flex;align-items:center;gap:8px;background:var(--add);border:1px solid var(--add);color:#fff;font-weight:600;padding:9px 16px;border-radius:8px}
.xt .dl:hover{filter:brightness(1.1);text-decoration:none}
.xt .fine{font-size:12px;color:var(--muted)}
.xt h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:30px 0 10px;font-weight:600}
.xt .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.xt .card{padding:14px 16px}
.xt .card h3{margin:0 0 4px;font-size:14px}
.xt .card p{margin:0;color:var(--muted);font-size:13px}
.xt ol.steps{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px;counter-reset:s}
.xt ol.steps li{counter-increment:s;display:grid;grid-template-columns:30px 1fr;gap:4px 12px;padding:14px 16px}
.xt ol.steps li::before{content:counter(s);grid-row:1/span 2;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-weight:600;font-size:13px;background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 40%,transparent)}
.xt ol.steps b{font-size:14px}
.xt ol.steps span{color:var(--muted);font-size:13px}
.xt code{font-family:var(--mono);font-size:12px;padding:1px 6px;border-radius:5px;background:var(--panel-2);border:1px solid var(--border);color:var(--text)}
.xt .crms{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.xt .crm{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--c) 45%,transparent);background:color-mix(in srgb,var(--c) 10%,transparent);color:var(--c)}
.xt .crm i{width:6px;height:6px;border-radius:50%;background:currentColor}
.xt .try{padding:14px 16px;display:flex;gap:12px;align-items:flex-start}
.xt .try p{margin:0;font-size:13px}
`;

const CRMS: { name: string; color: string; note: string }[] = [
  { name: "HubSpot", color: "#ff7a59", note: "deals, contacts, companies" },
  { name: "Attio", color: "#9aa6ff", note: "companies, people, deals" },
  { name: "Salesforce", color: "#1ea7e6", note: "Opportunity, Contact, Lead, Account" },
  { name: "Pipedrive", color: "#3ecf8e", note: "deals, persons, organizations" },
  { name: "Mainline", color: "#7c9cff", note: "/crm and /prs pages" },
];

export default function ExtensionPage() {
  return (
    <div className="xt">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <span className="eyebrow">⎇ Chrome extension · side panel</span>
      <h1>Review your agents&apos; CRM changes without leaving your CRM</h1>
      <p className="lede">
        Open any deal, contact or company in your CRM and the Mainline side panel shows what AI agents want to change on that record:
        a field-level diff, the evidence behind it, and whether it&apos;s gone stale. Approve &amp; merge or reject in one click.
      </p>
      <div className="cta">
        <a className="dl" href="/mainline-extension.zip" download>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M8 2v8.5M4.5 7 8 10.5 11.5 7M2.5 13.5h11" />
          </svg>
          Download extension (.zip)
        </a>
        <span className="fine">Manifest V3 · ~30 KB · no tracking · reads only the tab URL, never the page</span>
      </div>

      <h2>Install in 3 steps</h2>
      <ol className="steps">
        <li className="panel">
          <b>Download and unzip</b>
          <span>
            Unzip <code>mainline-extension.zip</code>. You get a folder called <code>mainline-extension</code>.
          </span>
        </li>
        <li className="panel">
          <b>Turn on Developer mode</b>
          <span>
            Go to <code>chrome://extensions</code> and switch on <b>Developer mode</b> (top right).
          </span>
        </li>
        <li className="panel">
          <b>Load unpacked</b>
          <span>
            Click <b>Load unpacked</b> and pick the <code>mainline-extension</code> folder. Pin the violet ⎇ icon and click it to open the side panel.
          </span>
        </li>
      </ol>

      <h2>What you get</h2>
      <div className="grid">
        <div className="panel card">
          <h3>Pending changes, per record</h3>
          <p>“3 pending agent changes” on the deal you&apos;re looking at, each with agent, policy tier, conflict and STALE badges.</p>
        </div>
        <div className="panel card">
          <h3>Diff + evidence</h3>
          <p>Before → after for every field (money formatted), plus the email or page quote the agent relied on.</p>
        </div>
        <div className="panel card">
          <h3>Approve or reject in place</h3>
          <p>Merges go through the same three-way merge, branch protection and conflict checks as the web app.</p>
        </div>
        <div className="panel card">
          <h3>Field history</h3>
          <p>Blame for every field: which agent, human or system wrote it, when, and why.</p>
        </div>
      </div>

      <h2>Works with</h2>
      <div className="crms">
        {CRMS.map((c) => (
          <span key={c.name} className="crm" style={{ ["--c" as string]: c.color }} title={c.note}>
            <i />
            {c.name}
          </span>
        ))}
      </div>
      <p className="fine" style={{ marginTop: 8 }}>
        Records are detected from the URL only. When a record isn&apos;t mirrored in Mainline yet, the panel says so and still shows the global PR queue.
        Elsewhere on the web it shows every open agent PR, so it&apos;s always useful.
      </p>

      <h2>Try it</h2>
      <div className="panel try">
        <span style={{ fontSize: 18 }}>→</span>
        <p>
          Open a deal in HubSpot, or open any record at <a href="/crm">/crm</a> (e.g.{" "}
          <a href="/crm?entity=deal:acme-platform">Acme — Platform rollout</a>) with the side panel open. Then run the agents from the{" "}
          <a href="/demo">Demo</a> page and watch PRs land in the panel within seconds. Settings (gear icon): server URL and the reviewer name recorded on merges.
        </p>
      </div>
    </div>
  );
}

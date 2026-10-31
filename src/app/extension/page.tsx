/* OWNER: extension worker. Install page for the Git CRM Chrome extension (served zip: /mainline-extension.zip). */
export const metadata = { title: "Chrome extension — Git CRM" };

const CSS = `
.xt{max-width:880px;margin:0 auto 40px;line-height:1.5;color:var(--ink)}
.xt h1{font-size:28px;font-weight:600;letter-spacing:-.01em;margin:12px 0 6px;line-height:1.2}
.xt .lede{color:var(--ink-2);font-size:14px;max-width:660px;margin:0}
.xt .eyebrow{display:inline-flex;gap:8px;align-items:center;font-size:12px;font-weight:500;color:var(--ink-2);border:var(--hairline);background:#fff;height:24px;padding:0 10px 0 4px;border-radius:var(--radius-control)}
.xt .eyebrow .mk{width:16px;height:16px;border-radius:5px;background:var(--blue);color:#fff;display:grid;place-items:center;font-size:10px;font-weight:700}
.xt .cta{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:20px 0 32px}
.xt .fine{font-size:11.5px;color:var(--faint)}
.xt h2{font-size:14px;font-weight:600;color:var(--ink);margin:32px 0 12px}
.xt .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0;border:var(--hairline);border-radius:var(--radius-panel);overflow:hidden}
.xt .card{padding:16px;border-right:var(--hairline);border-bottom:var(--hairline)}
.xt .card:nth-child(2n){border-right:0}
.xt .card:nth-last-child(-n+2){border-bottom:0}
@media (max-width:640px){.xt .grid{grid-template-columns:1fr}.xt .card{border-right:0!important;border-bottom:var(--hairline)!important}.xt .card:last-child{border-bottom:0!important}}
.xt .card h3{margin:0 0 4px;font-size:14px;font-weight:600}
.xt .card p{margin:0;color:var(--ink-2);font-size:13px}
.xt ol.steps{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;border:var(--hairline);border-radius:var(--radius-panel);counter-reset:s}
.xt ol.steps li{counter-increment:s;display:grid;grid-template-columns:28px 1fr;gap:2px 14px;padding:14px 16px;border-bottom:var(--hairline)}
.xt ol.steps li:last-child{border-bottom:0}
.xt ol.steps li::before{content:counter(s);grid-row:1/span 2;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-weight:600;font-size:13px;background:var(--blue-soft);color:var(--blue);font-variant-numeric:tabular-nums}
.xt ol.steps b{font-size:14px;font-weight:600}
.xt ol.steps span{color:var(--ink-2);font-size:13px}
.xt ol.steps span b{font-size:13px;color:var(--ink)}
.xt code{font-family:var(--mono);font-size:12px;padding:1px 6px;border-radius:var(--radius-small);background:#fff;border:var(--hairline);color:var(--ink)}
.xt .crms{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.xt .crm{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:500;height:32px;padding:0 14px 0 8px;border-radius:var(--radius-control);border:var(--hairline);background:#fff;color:var(--ink)}
.xt .crm i{width:18px;height:18px;border-radius:5px;background:var(--series-3);color:#fff;font-style:normal;font-size:10px;font-weight:700;display:grid;place-items:center}
.xt .crm.you i{background:var(--blue)}
.xt .crm small{color:var(--faint);font-size:11.5px;font-weight:400}
.xt .try{padding:16px;display:flex;gap:12px;align-items:flex-start}
.xt .try .arr{color:var(--blue);font-size:16px;line-height:1.3}
.xt .try p{margin:0;font-size:14px;color:var(--ink-2)}
`;

const CRMS: { name: string; note: string; you?: boolean }[] = [
  { name: "HubSpot", note: "deals, contacts, companies" },
  { name: "Attio", note: "companies, people, deals" },
  { name: "Salesforce", note: "Opportunity, Contact, Lead, Account" },
  { name: "Pipedrive", note: "deals, persons, organizations" },
  { name: "Git CRM", note: "/crm and /prs pages", you: true },
];

export default function ExtensionPage() {
  return (
    <div className="xt">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <span className="eyebrow"><span className="mk">G</span>Chrome extension · side panel</span>
      <h1>Review your agents&apos; CRM changes without leaving your CRM</h1>
      <p className="lede">
        Open any deal, contact or company in your CRM and the Git CRM side panel shows what AI agents want to change on that record:
        a field-level diff, the evidence behind it, and whether it&apos;s gone stale. Approve &amp; merge or reject in one click.
      </p>
      <div className="cta">
        <a className="btn primary" href="/mainline-extension.zip" download>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M8 2v8.5M4.5 7 8 10.5 11.5 7M2.5 13.5h11" />
          </svg>
          Download extension (.zip)
        </a>
        <span className="fine">Manifest V3 · ~30 KB · no tracking · reads only the tab URL, never the page</span>
      </div>

      <h2>Install in 3 steps</h2>
      <ol className="steps">
        <li>
          <b>Download and unzip</b>
          <span>
            Unzip <code>mainline-extension.zip</code>. You get a folder called <code>mainline-extension</code>.
          </span>
        </li>
        <li>
          <b>Turn on Developer mode</b>
          <span>
            Go to <code>chrome://extensions</code> and switch on <b>Developer mode</b> (top right).
          </span>
        </li>
        <li>
          <b>Load unpacked</b>
          <span>
            Click <b>Load unpacked</b> and pick the <code>mainline-extension</code> folder. Pin the blue <b>G</b> icon and click it to open the side panel.
          </span>
        </li>
      </ol>

      <h2>What you get</h2>
      <div className="grid">
        <div className="card">
          <h3>Pending changes, per record</h3>
          <p>“3 pending agent changes” on the deal you&apos;re looking at, each with agent, policy tier, conflict and STALE badges.</p>
        </div>
        <div className="card">
          <h3>Diff + evidence</h3>
          <p>Before → after for every field (money formatted), plus the email or page quote the agent relied on.</p>
        </div>
        <div className="card">
          <h3>Approve or reject in place</h3>
          <p>Merges go through the same three-way merge, branch protection and conflict checks as the web app.</p>
        </div>
        <div className="card">
          <h3>Field history</h3>
          <p>Blame for every field: which agent, human or system wrote it, when, and why.</p>
        </div>
      </div>

      <h2>Works with</h2>
      <div className="crms">
        {CRMS.map((c) => (
          <span key={c.name} className={`crm${c.you ? " you" : ""}`} title={c.note}>
            <i>{c.name.slice(0, 1)}</i>
            {c.name}
            <small>{c.note}</small>
          </span>
        ))}
      </div>
      <p className="fine" style={{ marginTop: 8 }}>
        Records are detected from the URL only. When a record isn&apos;t mirrored in Git CRM yet, the panel says so and still shows the global PR queue.
        Elsewhere on the web it shows every open agent PR, so it&apos;s always useful.
      </p>

      <h2>Try it</h2>
      <div className="panel try">
        <span className="arr" aria-hidden>→</span>
        <p>
          Open a deal in HubSpot, or open any record at <a href="/crm">/crm</a> (e.g.{" "}
          <a href="/crm?entity=deal:acme-platform">Acme — Platform rollout</a>) with the side panel open. Then run the agents from the{" "}
          <a href="/demo">Demo</a> page and watch PRs land in the panel within seconds. Settings (gear icon): server URL and the reviewer name recorded on merges.
        </p>
      </div>
    </div>
  );
}

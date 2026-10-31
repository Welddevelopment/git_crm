/* Full-width Emails page (also iframed by the Chrome extension side panel as /emails?embed=1). */
import { EmailsPanel } from "@/components/email/EmailsMenu";

export const dynamic = "force-dynamic";

export default function EmailsPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.01em", margin: 0, color: "var(--ink)" }}>Emails</h1>
        <p style={{ margin: "4px 0 0", color: "var(--ink-2)", fontSize: 14 }}>Connect Gmail or paste an email — the inbox agent turns it into evidence-backed PRs.</p>
      </div>
      <div className="em-page"><EmailsPanel /></div>
    </div>
  );
}

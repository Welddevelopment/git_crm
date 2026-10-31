/* Lead-owned shell. Nav links point at routes owned by W9 (/prs) and W10 (/, /crm, /timeline, /demo). */
import "./globals.css";
import type { ReactNode } from "react";
export const metadata = { title: "Mainline — PRs for your CRM agents" };
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en"><body>
      <nav style={{ display: "flex", gap: 20, alignItems: "center", padding: "12px 20px", borderBottom: "1px solid var(--border)" }}>
        <strong>⎇ Mainline</strong>
        <a href="/">Overview</a><a href="/prs">Pull requests</a><a href="/crm">CRM (main)</a><a href="/timeline">Time travel</a><a href="/demo">Demo</a>
      </nav>
      <main style={{ padding: 20 }}>{children}</main>
    </body></html>
  );
}

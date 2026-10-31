/* Lead-owned shell: Calendly-B sidebar + top bar. Pages render inside .ml-content. */
import "./globals.css";
import type { ReactNode } from "react";
import { Sidebar, TopBar } from "./Nav";
export const metadata = { title: "Git CRM — PRs for your CRM agents" };
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en"><body>
      <div className="ml-shell">
        <Sidebar />
        <div className="ml-main">
          <TopBar />
          <main className="ml-content">{children}</main>
        </div>
      </div>
    </body></html>
  );
}

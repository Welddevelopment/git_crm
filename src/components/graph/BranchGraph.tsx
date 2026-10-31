"use client";
/** OWNER: graph worker. Contract: default export, props below. Overview mounts <BranchGraph height={260} />; PR page may mount <BranchGraph focusPr="pr_4" compact />. */
export interface BranchGraphProps { height?: number; focusPr?: string; compact?: boolean }
export default function BranchGraph({ height = 260 }: BranchGraphProps) {
  return <div className="panel" style={{ height, display: "grid", placeItems: "center", color: "var(--muted)" }}>Branch graph loading…</div>;
}

"use client";
/* OWNER: W9. Small shared building blocks: icons, chips, badges. */
import type { ReactNode } from "react";
import type { Actor, PRStatus, PullRequest, RiskTier } from "@/core/types";
import { actorName, changeCount, isAutoMerged, pluralize, unresolvedConflicts } from "./format";

type IconProps = { size?: number; className?: string };
const svg = (path: ReactNode) =>
  function Icon({ size = 16, className }: IconProps) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
        {path}
      </svg>
    );
  };

export const IconPROpen = svg(<path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.12v5.26a2.25 2.25 0 1 1-1.5 0V5.37A2.25 2.25 0 0 1 1.5 3.25Zm5.68-1.03L8.94.47A.25.25 0 0 1 9.37.64V2h1.38A2.75 2.75 0 0 1 13.5 4.75v5.88a2.25 2.25 0 1 1-1.5 0V4.75c0-.69-.56-1.25-1.25-1.25H9.37v1.36a.25.25 0 0 1-.43.18L7.18 3.28a.75.75 0 0 1 0-1.06ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />);
export const IconMerged = svg(<path d="M5.45 5.15A3.5 3.5 0 0 0 8.25 7.5h1.38a2.25 2.25 0 1 1 0 1.5H8.25a4.98 4.98 0 0 1-3-1v2.63a2.25 2.25 0 1 1-1.5 0V5.37a2.25 2.25 0 1 1 1.7-.22ZM4.5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm7.5 5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-8.25 4.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" />);
export const IconClosed = svg(<path d="M3.25 1A2.25 2.25 0 0 1 4 5.37v5.26a2.25 2.25 0 1 1-1.5 0V5.37A2.25 2.25 0 0 1 3.25 1Zm9.03 2.72L13.75 5.2l1.47-1.47a.75.75 0 1 1 1.06 1.06L14.81 6.25l1.47 1.47a.75.75 0 0 1-1.06 1.06l-1.47-1.47-1.47 1.47a.75.75 0 0 1-1.06-1.06l1.47-1.47-1.47-1.47a.75.75 0 0 1 1.06-1.06ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0-9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm10.5 7.25a.75.75 0 0 1 .75.75v.88a2.25 2.25 0 1 1-1.5 0v-.88a.75.75 0 0 1 .75-.75Zm0 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />);
export const IconRevert = svg(<path d="M1.22 6.28a.75.75 0 0 1 0-1.06l3.5-3.5a.75.75 0 0 1 1.06 1.06L3.56 5H9.5A5.5 5.5 0 0 1 15 10.5v1.75a.75.75 0 0 1-1.5 0V10.5a4 4 0 0 0-4-4H3.56l2.22 2.22a.75.75 0 1 1-1.06 1.06l-3.5-3.5Z" />);
export const IconBot = svg(<path d="M8 .5a.75.75 0 0 1 .75.75V2.5h2.5A2.75 2.75 0 0 1 14 5.25v5.5A2.75 2.75 0 0 1 11.25 13.5h-6.5A2.75 2.75 0 0 1 2 10.75v-5.5A2.75 2.75 0 0 1 4.75 2.5h2.5V1.25A.75.75 0 0 1 8 .5ZM4.75 4c-.69 0-1.25.56-1.25 1.25v5.5c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25v-5.5C12.5 4.56 11.94 4 11.25 4h-6.5ZM6 6.75a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm4 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" />);
export const IconPerson = svg(<path d="M10.56 8.53a4.5 4.5 0 1 0-5.12 0A6.5 6.5 0 0 0 1.5 14.25a.75.75 0 0 0 1.5 0 5 5 0 0 1 10 0 .75.75 0 0 0 1.5 0 6.5 6.5 0 0 0-3.94-5.72ZM5 4.75a3 3 0 1 1 6 0 3 3 0 0 1-6 0Z" />);
export const IconGear = svg(<path d="M8 0a1 1 0 0 1 .98.8l.26 1.3c.4.13.79.29 1.15.48l1.1-.73a1 1 0 0 1 1.27.12l.27.27a1 1 0 0 1 .12 1.27l-.73 1.1c.19.36.35.75.48 1.15l1.3.26a1 1 0 0 1 .8.98v.38a1 1 0 0 1-.8.98l-1.3.26c-.13.4-.29.79-.48 1.15l.73 1.1a1 1 0 0 1-.12 1.27l-.27.27a1 1 0 0 1-1.27.12l-1.1-.73c-.36.19-.75.35-1.15.48l-.26 1.3a1 1 0 0 1-.98.8h-.38a1 1 0 0 1-.98-.8l-.26-1.3a6.5 6.5 0 0 1-1.15-.48l-1.1.73a1 1 0 0 1-1.27-.12l-.27-.27a1 1 0 0 1-.12-1.27l.73-1.1a6.5 6.5 0 0 1-.48-1.15l-1.3-.26A1 1 0 0 1 0 8.19v-.38a1 1 0 0 1 .8-.98l1.3-.26c.13-.4.29-.79.48-1.15l-.73-1.1a1 1 0 0 1 .12-1.27l.27-.27a1 1 0 0 1 1.27-.12l1.1.73c.36-.19.75-.35 1.15-.48L6.02.8A1 1 0 0 1 7 0h1Zm0 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />);
export const IconAlert = svg(<path d="M6.46 1.27a1.75 1.75 0 0 1 3.08 0l6.25 11.25A1.75 1.75 0 0 1 14.25 15H1.75a1.75 1.75 0 0 1-1.54-2.48L6.46 1.27ZM8 5a.75.75 0 0 0-.75.75v3a.75.75 0 0 0 1.5 0v-3A.75.75 0 0 0 8 5Zm0 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />);
export const IconCheck = svg(<path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />);
export const IconX = svg(<path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />);
export const IconInfo = svg(<path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm0 6.5a.75.75 0 0 0-.75.75v4a.75.75 0 0 0 1.5 0v-4A.75.75 0 0 0 8 6.5ZM8 5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />);
export const IconShield = svg(<path d="M7.47.22a.75.75 0 0 1 1.06 0c1.6 1.6 3.4 2.28 5.72 2.28a.75.75 0 0 1 .75.75V7c0 4.15-2.53 7.05-6.72 8.7a.75.75 0 0 1-.56 0C3.53 14.05 1 11.15 1 7V3.25a.75.75 0 0 1 .75-.75c2.32 0 4.12-.68 5.72-2.28ZM2.5 3.97V7c0 3.32 1.92 5.68 5.5 7.18 3.58-1.5 5.5-3.86 5.5-7.18V3.97A9.1 9.1 0 0 1 8 1.77a9.1 9.1 0 0 1-5.5 2.2Z" />);
export const IconFile = svg(<path d="M2 1.75C2 .78 2.78 0 3.75 0h6.59c.46 0 .9.18 1.23.51l2.92 2.92c.33.33.51.77.51 1.23v9.59A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .14.11.25.25.25h9.5a.25.25 0 0 0 .25-.25V6H10.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.06v2.69c0 .14.11.25.25.25h2.69Z" />);
export const IconMail = svg(<path d="M1.75 2h12.5c.97 0 1.75.78 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25v-8.5C0 2.78.78 2 1.75 2ZM1.5 12.25c0 .14.11.25.25.25h12.5a.25.25 0 0 0 .25-.25V5.06L8.4 9.2a.75.75 0 0 1-.8 0L1.5 5.06Zm13-8.18v-.32a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25v.32L8 8.24Z" />);
export const IconGlobe = svg(<path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM5.78 8.75a9.64 9.64 0 0 0 1.36 4.81c.28.03.57.04.86.04s.58-.01.86-.04a9.64 9.64 0 0 0 1.36-4.81Zm6.47 0a11.1 11.1 0 0 1-1.16 4.44 6.5 6.5 0 0 0 3.37-4.44Zm-10.68 0a6.5 6.5 0 0 0 3.37 4.44 11.1 11.1 0 0 1-1.16-4.44Zm3.37-5.94a6.5 6.5 0 0 0-3.37 4.44h2.21c.08-1.57.47-3.08 1.16-4.44Zm1.6-.37a9.64 9.64 0 0 0-1.36 4.81h4.44a9.64 9.64 0 0 0-1.36-4.81A6.6 6.6 0 0 0 8 2.4c-.29 0-.58.01-.86.04Zm4.31.37c.69 1.36 1.08 2.87 1.16 4.44h2.21a6.5 6.5 0 0 0-3.37-4.44Z" />);
export const IconChevron = svg(<path d="M12.78 5.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 6.28a.75.75 0 0 1 1.06-1.06L8 8.94l3.72-3.72a.75.75 0 0 1 1.06 0Z" />);
export const IconArrowRight = svg(<path d="M8.22 2.97a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06l2.97-2.97H3.75a.75.75 0 0 1 0-1.5h7.44L8.22 4.03a.75.75 0 0 1 0-1.06Z" />);
export const IconClock = svg(<path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.99l2.06 1.18a.75.75 0 0 1-.75 1.3L7.38 8.83A.75.75 0 0 1 7 8.18V4.75a.75.75 0 0 1 1.5 0Z" />);
export const IconDiff = svg(<path d="M8.75 1.75V5H12a.75.75 0 0 1 0 1.5H8.75v3.25a.75.75 0 0 1-1.5 0V6.5H4a.75.75 0 0 1 0-1.5h3.25V1.75a.75.75 0 0 1 1.5 0ZM4 13h8a.75.75 0 0 1 0 1.5H4A.75.75 0 0 1 4 13Z" />);
export const IconList = svg(<path d="M2 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm3.75-1.5a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5Zm0 5a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5Zm0 5a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5ZM3 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm-1 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />);
export const IconSchema = svg(<path d="M1.75 1h12.5c.97 0 1.75.78 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75C0 1.78.78 1 1.75 1ZM1.5 6.5v6.75c0 .14.11.25.25.25H5v-7Zm5 0v7h7.75a.25.25 0 0 0 .25-.25V6.5Zm8-1.5V2.75a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25V5Z" />);
export const IconComment = svg(<path d="M1 2.75C1 1.78 1.78 1 2.75 1h10.5c.97 0 1.75.78 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.57 2.57A1.46 1.46 0 0 1 4 13.54V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .14.11.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.75.75 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />);

export function StatusIcon({ status, size = 16 }: { status: PRStatus; size?: number }) {
  const cls = `pr-icon-${status}`;
  if (status === "merged") return <IconMerged size={size} className={cls} />;
  if (status === "closed") return <IconClosed size={size} className={cls} />;
  if (status === "reverted") return <IconRevert size={size} className={cls} />;
  return <IconPROpen size={size} className={cls} />;
}

export function StatusPill({ status }: { status: PRStatus }) {
  const label = { open: "Open", merged: "Merged", closed: "Closed", reverted: "Reverted" }[status];
  return (
    <span className={`pr-status ${status}`}>
      {status === "merged" ? <IconMerged /> : status === "closed" ? <IconClosed /> : status === "reverted" ? <IconRevert /> : <IconPROpen />}
      {label}
    </span>
  );
}

export function ActorChip({ actor }: { actor?: Actor }) {
  const kind = actor?.kind ?? "system";
  const Icon = kind === "agent" ? IconBot : kind === "human" ? IconPerson : IconGear;
  const label = actorName(actor);
  return (
    <span className={`pr-chip ${kind}`} title={actor ? `${actor.kind}:${actor.id}` : undefined}>
      <Icon size={12} />
      {kind === "agent" ? `${label}-agent` : label}
    </span>
  );
}

const TIER_LABEL: Record<RiskTier, string> = { auto: "auto", review: "needs review", block: "blocked" };
export function TierBadge({ tier, title }: { tier: RiskTier; title?: string }) {
  return (
    <span className={`pr-badge ${tier}`} title={title}>
      <IconShield size={11} />
      {TIER_LABEL[tier]}
    </span>
  );
}

/** All the at-a-glance badges for a PR row. */
export function PRBadges({ pr }: { pr: PullRequest }) {
  const st = pr.staleness?.status;
  const unresolved = unresolvedConflicts(pr);
  const autoRes = (pr.conflicts || []).filter((c) => c.autoResolved).length;
  return (
    <>
      {pr.policy && pr.status === "open" && <TierBadge tier={pr.policy.tier} title={pr.policy.reasons.join("\n")} />}
      {pr.status === "open" && st === "stale" && (
        <span className="pr-badge stale" title={pr.staleness?.contradictions.map((c) => c.title).join("\n")}>
          <span className="dot" />
          stale
        </span>
      )}
      {pr.status === "open" && st === "version-conflict" && (
        <span className="pr-badge vconf" title="Fields this agent read have changed on main since">
          <IconClock size={11} />
          outdated reads
        </span>
      )}
      {pr.status === "open" && unresolved > 0 && (
        <span className="pr-badge conflict">
          <IconAlert size={11} />
          {pluralize(unresolved, "conflict")}
        </span>
      )}
      {pr.status === "open" && autoRes > 0 && (
        <span className="pr-badge info" title="Auto-rebased onto merge survivor">
          <IconInfo size={11} />
          rebased
        </span>
      )}
      {(pr.status === "merged" || pr.status === "reverted") && isAutoMerged(pr) && (
        <span className="pr-badge auto">
          <IconCheck size={11} />
          auto-merged
        </span>
      )}
      {pr.status === "reverted" && pr.revertedBy && <span className="pr-badge neutral">reverted by {pr.revertedBy}</span>}
    </>
  );
}

export function changeLabel(pr: PullRequest) {
  return pluralize(changeCount(pr), "change");
}

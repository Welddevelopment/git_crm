"use client";
/* OWNER: W9. Evidence list (claim + quote) and the expandable source document with the quote highlighted. */
import { Fragment, type ReactNode } from "react";
import type { Event, EvidenceDoc, EvidenceRef } from "@/core/types";
import { IconChevron, IconFile, IconGlobe, IconMail } from "./atoms";
import { fmtDateTime } from "./format";

export const NEGATIVE_CUES = ["pausing", "paused", "pause", "on hold", "budget freeze", "postpone", "postponed", "not moving forward", "going with another vendor", "cancel", "cancelled", "canceled", "won't be able"];

export function DocIcon({ kind, size = 14 }: { kind?: EvidenceDoc["kind"]; size?: number }) {
  if (kind === "email") return <IconMail size={size} />;
  if (kind === "web") return <IconGlobe size={size} />;
  return <IconFile size={size} />;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Find [start,end) ranges for a quote in a body: exact (case/whitespace-insensitive), else best long fragment. */
function findQuote(body: string, quote: string): [number, number][] {
  const q = quote.trim().replace(/^["“'…\s]+|["”'…\s.]+$/g, "");
  if (!q) return [];
  const flexible = new RegExp(q.split(/\s+/).map(esc).join("\\s+"), "i");
  const m = flexible.exec(body);
  if (m) return [[m.index, m.index + m[0].length]];
  // quote may be paraphrased / joined with "…": highlight each fragment of ≥3 words that matches
  const frags = q.split(/\s*(?:…|\.\.\.)\s*/).filter((f) => f.split(/\s+/).length >= 2);
  const out: [number, number][] = [];
  for (const f of frags) {
    const r = new RegExp(f.split(/\s+/).map(esc).join("\\s+"), "i").exec(body);
    if (r) out.push([r.index, r.index + r[0].length]);
  }
  if (out.length) return out;
  // last resort: longest run of words (≥3) from the quote that appears in body
  const words = q.split(/\s+/);
  for (let len = Math.min(words.length, 8); len >= 3; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      const r = new RegExp(words.slice(i, i + len).map(esc).join("\\s+"), "i").exec(body);
      if (r) return [[r.index, r.index + r[0].length]];
    }
  }
  return [];
}

function findCues(body: string, cues: string[]): [number, number][] {
  const out: [number, number][] = [];
  const re = new RegExp(`\\b(${cues.map(esc).sort((a, b) => b.length - a.length).join("|")})\\b`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push([m.index, m.index + m[0].length]);
  return out;
}

function highlight(body: string, ranges: { r: [number, number]; cls?: string }[]): ReactNode[] {
  const sorted = [...ranges].sort((a, b) => a.r[0] - b.r[0]);
  const out: ReactNode[] = [];
  let at = 0;
  sorted.forEach(({ r: [s, e], cls }, i) => {
    if (s < at) return; // overlapping, skip
    if (s > at) out.push(<Fragment key={`t${i}`}>{body.slice(at, s)}</Fragment>);
    out.push(
      <mark key={`m${i}`} className={cls}>
        {body.slice(s, e)}
      </mark>,
    );
    at = e;
  });
  if (at < body.length) out.push(<Fragment key="end">{body.slice(at)}</Fragment>);
  return out;
}

export function DocView({ doc, quotes = [], negative = false }: { doc: EvidenceDoc; quotes?: string[]; negative?: boolean }) {
  const ranges = [
    ...quotes.flatMap((q) => findQuote(doc.body, q).map((r) => ({ r }))),
    ...(negative ? findCues(doc.body, NEGATIVE_CUES).map((r) => ({ r, cls: "neg" })) : []),
  ];
  return (
    <div className="pr-doc">
      <dl className="pr-doc-head">
        <dt>{doc.kind === "web" ? "Page" : "Subject"}</dt>
        <dd style={{ fontWeight: 600 }}>{doc.title}</dd>
        {doc.from && (
          <>
            <dt>From</dt>
            <dd>{doc.from}</dd>
          </>
        )}
        {doc.to?.length ? (
          <>
            <dt>To</dt>
            <dd>{doc.to.join(", ")}</dd>
          </>
        ) : null}
        {doc.url && (
          <>
            <dt>URL</dt>
            <dd className="pr-mono" style={{ fontSize: 11.5 }}>{doc.url}</dd>
          </>
        )}
        <dt>{doc.kind === "web" ? "Observed" : "Date"}</dt>
        <dd>
          {fmtDateTime(doc.ts)} <span className="pr-muted pr-mono" style={{ fontSize: 11 }}>· {doc.id}</span>
        </dd>
      </dl>
      <pre className="pr-doc-body">{highlight(doc.body, ranges)}</pre>
    </div>
  );
}

export interface EvItem {
  key: string;
  event: Event;
  ref: EvidenceRef;
}

export function collectEvidence(events: Event[]): EvItem[] {
  const out: EvItem[] = [];
  for (const e of events) (e.evidence || []).forEach((ref, i) => out.push({ key: `${e.id}:${i}`, event: e, ref }));
  return out;
}

export function EvidencePanel({
  items, docs, open, onToggle, flashKey, contradicted, entityLabel,
}: {
  items: EvItem[];
  docs: Record<string, EvidenceDoc>;
  open: Set<string>;
  onToggle: (key: string) => void;
  flashKey?: string | null;
  contradicted: Set<string>;
  entityLabel: (ev: Event) => string;
}) {
  if (!items.length) return null;
  const docCount = new Set(items.map((i) => i.ref.docId)).size;
  return (
    <section id="pr-evidence">
      <h2 className="pr-section-title">
        Evidence <span className="pr-muted">· {items.length} claims from {docCount} {docCount === 1 ? "source" : "sources"}</span>
      </h2>
      <div className="panel pr-ev">
        {items.map(({ key, event, ref }) => {
          const doc = docs[ref.docId];
          const isOpen = open.has(key);
          return (
            <div key={key} id={`ev-${key}`} className={`pr-ev-item ${flashKey === key ? "flash" : ""}`}>
              <button className="pr-ev-btn" onClick={() => onToggle(key)} aria-expanded={isOpen}>
                <span className="k">
                  <DocIcon kind={doc?.kind} />
                </span>
                <span className="claim">
                  {ref.claim}
                  {contradicted.has(event.id) && (
                    <span className="pr-badge stale" style={{ marginLeft: 8, animation: "none" }}>
                      contradicted
                    </span>
                  )}
                </span>
                <span className="when">
                  {doc ? fmtDateTime(doc.ts) : ""}{" "}
                  <span style={{ display: "inline-flex", transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .15s", verticalAlign: -3 }}>
                    <IconChevron size={14} />
                  </span>
                </span>
                <span className="src">
                  {doc ? doc.title : <span className="pr-mono">{ref.docId}</span>}
                  {doc?.from ? ` · ${doc.from.replace(/\s*<.*>/, "")}` : ""} · supports <span className="pr-mono">{entityLabel(event)}</span>
                </span>
                {ref.quote && <blockquote className="pr-quote">“{ref.quote}”</blockquote>}
              </button>
              {isOpen &&
                (doc ? (
                  <DocView doc={doc} quotes={ref.quote ? [ref.quote] : []} />
                ) : (
                  <div className="pr-doc" style={{ padding: 12, color: "var(--muted)", fontSize: 12 }}>
                    Source document <span className="pr-mono">{ref.docId}</span> was not included in this PR&apos;s payload.
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

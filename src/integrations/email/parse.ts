/** Email → EvidenceDoc conversion: pasted raw emails, structured fields, and Gmail API threads. Pure (no I/O). */
import type { CRMState, EntityId, EntityRecord, EvidenceDoc, FieldValue } from "../../core/types";

export interface EmailInput {
  from?: string;
  to?: string | string[];
  subject?: string;
  body?: string;
  date?: string | number;
  raw?: string;
}

export interface ParsedEmail {
  from: string;
  to: string[];
  subject: string;
  body: string;
  ts: number;
}

const str = (v: FieldValue | undefined) => (typeof v === "string" ? v : "");
const live = (e: EntityRecord | undefined): e is EntityRecord => !!e && !e.deleted && !e.mergedInto;
const normDomain = (d: string) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();

export function emailOf(s: string | undefined): string {
  if (!s) return "";
  const m = /([^\s<>@,;"']+@[^\s<>@,;"']+\.[A-Za-z]{2,})/.exec(s);
  return m ? m[1].toLowerCase() : "";
}
export const domainOfEmail = (email: string) => emailOf(email).split("@")[1] ?? "";

function splitAddrs(v: string | string[] | undefined): string[] {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : v.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  return arr.map((s) => s.trim()).filter(Boolean);
}

function parseDate(v: string | number | undefined, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v.trim());
    if (Number.isFinite(t)) return t;
  }
  return fallback;
}

/** Decode RFC 2047 encoded-words (=?utf-8?B?...?= / =?utf-8?Q?...?=). Best effort. */
function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, _cs, enc: string, text: string) => {
    try {
      if (enc.toUpperCase() === "B") return Buffer.from(text, "base64").toString("utf8");
      const bytes = text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));
      return Buffer.from(bytes, "latin1").toString("utf8");
    } catch {
      return text;
    }
  });
}

function decodeQuotedPrintable(s: string): string {
  const bin = s.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));
  return Buffer.from(bin, "latin1").toString("utf8");
}

const HEADER_NAMES = /^(from|to|cc|bcc|subject|date|reply-to|sender|message-id|mime-version|content-type|content-transfer-encoding|received|return-path|delivered-to|x-[\w-]+|in-reply-to|references|sent|thread-topic)\s*:/i;

/**
 * Parse a pasted raw email: RFC 822 headers (or the "From: / Sent: / To: / Subject:" block Outlook/Gmail
 * produce when copying) followed by a blank line and the body. If there are no headers the whole text is the body.
 */
export function parseRawEmail(raw: string, now = Date.now()): ParsedEmail {
  const text = raw.replace(/\r\n/g, "\n").replace(/^﻿/, "").trim();
  const lines = text.split("\n");
  const headers: Record<string, string> = {};
  let i = 0;
  let sawHeader = false;
  let last = "";
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      if (sawHeader) { i++; break; }
      continue;
    }
    if (sawHeader && /^[ \t]/.test(line) && last) {
      headers[last] += " " + line.trim();
      continue;
    }
    if (HEADER_NAMES.test(line)) {
      const idx = line.indexOf(":");
      last = line.slice(0, idx).trim().toLowerCase();
      if (!(last in headers)) headers[last] = line.slice(idx + 1).trim();
      sawHeader = true;
      continue;
    }
    // first non-header line: body starts here (no blank line separator, e.g. copied from a mail client)
    break;
  }
  if (!sawHeader) i = 0;
  let body = lines.slice(i).join("\n");
  const cte = (headers["content-transfer-encoding"] ?? "").toLowerCase();
  if (cte.includes("quoted-printable")) body = decodeQuotedPrintable(body);
  else if (cte.includes("base64") && /^[A-Za-z0-9+/=\s]+$/.test(body)) {
    try { body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8"); } catch { /* keep */ }
  }
  if (/<(html|body|div|p|br)\b/i.test(body) && !/\n\S/.test(body.replace(/<[^>]+>/g, ""))) body = htmlToText(body);
  return {
    from: decodeWords(headers.from ?? headers.sender ?? ""),
    to: splitAddrs(decodeWords(headers.to ?? "")),
    subject: decodeWords(headers.subject ?? headers["thread-topic"] ?? ""),
    body: body.trim(),
    ts: parseDate(headers.date ?? headers.sent, now),
  };
}

/** Merge structured fields with an optional raw paste (explicit fields win). */
export function normalizeInput(input: EmailInput, now = Date.now()): ParsedEmail {
  const fromRaw = input.raw && input.raw.trim() ? parseRawEmail(input.raw, now) : null;
  const subject = (input.subject ?? "").trim() || fromRaw?.subject || "";
  const body = (input.body ?? "").trim() || fromRaw?.body || "";
  const from = (input.from ?? "").trim() || fromRaw?.from || "";
  const to = splitAddrs(input.to).length ? splitAddrs(input.to) : fromRaw?.to ?? [];
  const ts = input.date !== undefined && input.date !== "" ? parseDate(input.date, fromRaw?.ts ?? now) : fromRaw?.ts ?? now;
  return { from, to, subject: subject || firstLine(body) || "(no subject)", body, ts };
}

const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 80) ?? "";

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- entity inference ----------

export function companyForDomain(state: CRMState, domain: string): EntityRecord | undefined {
  const d0 = normDomain(domain);
  if (!d0) return undefined;
  return Object.values(state.entities).find((e) => {
    if (e.type !== "company" || !live(e)) return false;
    const d = normDomain(str(e.attrs.domain));
    return !!d && (d0 === d || d0.endsWith("." + d));
  });
}

export function contactForEmail(state: CRMState, email: string): EntityRecord | undefined {
  const em = emailOf(email);
  if (!em) return undefined;
  return Object.values(state.entities).find((e) => e.type === "contact" && live(e) && str(e.attrs.email).trim().toLowerCase() === em);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (hay: string, name: string) => name.length >= 3 && new RegExp(`\\b${escapeRe(name)}\\b`, "i").test(hay);

/** Best-effort entities: sender contact, sender company (by domain), and companies / deals named in the text. */
export function inferEntities(state: CRMState, p: Pick<ParsedEmail, "from" | "to" | "subject" | "body">): EntityId[] {
  const out: EntityId[] = [];
  const add = (id: EntityId | undefined) => { if (id && !out.includes(id)) out.push(id); };
  const hay = `${p.subject}\n${p.body}`;
  const companies: EntityId[] = [];
  const contact = contactForEmail(state, p.from);
  const cc = contact && typeof contact.attrs.company === "string" ? contact.attrs.company : undefined;
  const byDomain = companyForDomain(state, domainOfEmail(p.from))?.id;
  if (cc) companies.push(cc);
  if (byDomain && !companies.includes(byDomain)) companies.push(byDomain);
  // a company named in the text (only when the sender doesn't already pin one, e.g. internal forwards)
  if (!companies.length) {
    for (const e of Object.values(state.entities)) {
      if (e.type !== "company" || !live(e)) continue;
      const name = str(e.attrs.name);
      const short = name.split(/\s+/)[0] ?? "";
      if (mentions(hay, name) || (short.length >= 4 && mentions(hay, short))) companies.push(e.id);
    }
  }
  // deals: named in the text, scoped to the sender's company when known
  const deals = Object.values(state.entities).filter((e) => e.type === "deal" && live(e));
  const named = deals.filter((d) => {
    const name = str(d.attrs.name);
    if (!name || !mentions(hay, name)) return false;
    return !companies.length || companies.includes(str(d.attrs.company));
  });
  for (const d of named) add(d.id);
  for (const c of companies) add(c);
  if (contact) add(contact.id);
  return out;
}

export function makeEmailDoc(state: CRMState, p: ParsedEmail, id: string): EvidenceDoc {
  return {
    id,
    kind: "email",
    ts: p.ts,
    title: p.subject,
    ...(p.from ? { from: p.from } : {}),
    ...(p.to.length ? { to: p.to } : {}),
    body: p.body,
    entities: inferEntities(state, p),
  };
}

// ---------- Gmail API payloads ----------

export interface GmailHeader { name: string; value: string }
export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}
export interface GmailMessage { id: string; threadId?: string; internalDate?: string; snippet?: string; payload?: GmailPart }
export interface GmailThread { id: string; snippet?: string; messages?: GmailMessage[] }

export function b64url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
export const header = (m: GmailMessage, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

function collect(part: GmailPart | undefined, mime: string, out: string[]) {
  if (!part) return;
  if (part.mimeType === mime && part.body?.data && !part.filename) out.push(b64url(part.body.data));
  for (const p of part.parts ?? []) collect(p, mime, out);
}

/** text/plain parts, falling back to stripped text/html. */
export function messageText(m: GmailMessage): string {
  const plain: string[] = [];
  collect(m.payload, "text/plain", plain);
  if (plain.length) return plain.join("\n").trim();
  const html: string[] = [];
  collect(m.payload, "text/html", html);
  if (html.length) return htmlToText(html.join("\n"));
  return (m.snippet ?? "").trim();
}

export function gmailMessageToParsed(m: GmailMessage): ParsedEmail {
  const ts = Number(m.internalDate) || parseDate(header(m, "Date"), Date.now());
  return {
    from: header(m, "From"),
    to: splitAddrs(header(m, "To")),
    subject: header(m, "Subject") || "(no subject)",
    body: messageText(m),
    ts,
  };
}

export function gmailThreadToDocs(state: CRMState, t: GmailThread): EvidenceDoc[] {
  return (t.messages ?? [])
    .map((m) => ({ m, p: gmailMessageToParsed(m) }))
    .filter(({ p }) => p.body.trim().length > 0)
    .map(({ m, p }) => makeEmailDoc(state, p, `email_gmail_${m.id}`));
}

/** Does this address belong to a CRM contact or company? Returns a short label for the UI chip. */
export function crmMatch(state: CRMState, from: string): { entity: EntityId; label: string } | null {
  const c = contactForEmail(state, from);
  if (c) return { entity: c.id, label: str(c.attrs.name) || emailOf(from) };
  const co = companyForDomain(state, domainOfEmail(from));
  if (co) return { entity: co.id, label: str(co.attrs.name) || co.id };
  return null;
}

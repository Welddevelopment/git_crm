/** OWNER: W8 (seed world + demo scenario). Signatures are contract. */
import type { Actor, EvidenceDoc, FieldType, FieldValue, NewEvent } from "../core/types";
import { COMPANIES, CONTACTS, DEALS, HUMAN_EDITS } from "./world";
import { DAY, buildInbox, buildInjectable } from "./emails";
import { buildWeb } from "./web";

export { COMPANIES, CONTACTS, DEALS, HUMAN_EDITS } from "./world";

const SEED: Actor = { kind: "system", id: "seed" };
const human = (name: string): Actor => ({ kind: "human", id: name.toLowerCase(), name });

const SCHEMA: { entityType: string; field: string; fieldType: FieldType; description: string }[] = [
  { entityType: "company", field: "name", fieldType: "string", description: "Company name" },
  { entityType: "company", field: "domain", fieldType: "string", description: "Primary web domain" },
  { entityType: "company", field: "industry", fieldType: "string", description: "Industry" },
  { entityType: "company", field: "employees", fieldType: "number", description: "Headcount" },
  { entityType: "company", field: "stage", fieldType: "enum", description: "lead | customer | churned" },
  { entityType: "company", field: "signals", fieldType: "string[]", description: "Buying signals, e.g. hiring:data-engineering" },
  { entityType: "contact", field: "name", fieldType: "string", description: "Full name" },
  { entityType: "contact", field: "email", fieldType: "string", description: "Work email" },
  { entityType: "contact", field: "title", fieldType: "string", description: "Job title" },
  { entityType: "contact", field: "company", fieldType: "ref", description: "Company (entity id)" },
  { entityType: "contact", field: "phone", fieldType: "string", description: "Phone number" },
  { entityType: "deal", field: "name", fieldType: "string", description: "Deal name" },
  { entityType: "deal", field: "company", fieldType: "ref", description: "Company (entity id)" },
  { entityType: "deal", field: "amount", fieldType: "number", description: "Amount (USD)" },
  { entityType: "deal", field: "stage", fieldType: "enum", description: "discovery | demo | proposal | negotiation | closed_won | closed_lost" },
  { entityType: "deal", field: "closeDate", fieldType: "date", description: "Expected close date (YYYY-MM-DD)" },
  { entityType: "deal", field: "owner", fieldType: "string", description: "Account owner" },
  { entityType: "deal", field: "nextStep", fieldType: "string", description: "Next step" },
];

/** Initial main log: schema + 10 companies, 25 contacts, 10 deals, then organic human edits. Ascending ts. */
export function seedMainEvents(now: number = Date.now()): NewEvent[] {
  const events: NewEvent[] = [];
  // Import happens 14 days ago, one event per minute so ordering is strict.
  const t0 = now - 14 * DAY;
  let tick = 0;
  const importTs = () => t0 + tick++ * 60_000;

  for (const s of SCHEMA) {
    events.push({ actor: SEED, ts: importTs(), op: { type: "schema.addField", ...s }, reason: "CRM import: schema" });
  }
  for (const c of COMPANIES) {
    const { id, owner: _owner, ...attrs } = c;
    events.push({ actor: SEED, ts: importTs(), op: { type: "entity.create", entity: id, entityType: "company", attrs: { ...attrs, signals: [...attrs.signals] } }, reason: "CRM import" });
  }
  for (const c of CONTACTS) {
    const { id, ...attrs } = c;
    events.push({ actor: SEED, ts: importTs(), op: { type: "entity.create", entity: id, entityType: "contact", attrs }, reason: "CRM import" });
  }
  for (const d of DEALS) {
    const { id, ...attrs } = d;
    events.push({ actor: SEED, ts: importTs(), op: { type: "entity.create", entity: id, entityType: "deal", attrs }, reason: "CRM import" });
  }

  // Organic edits by the sales team. Track current values to fill `prev`.
  const cur = new Map<string, FieldValue>();
  for (const e of events) {
    if (e.op.type === "entity.create") for (const [k, v] of Object.entries(e.op.attrs)) cur.set(`${e.op.entity}::${k}`, v);
  }
  let last = events[events.length - 1]!.ts!;
  for (const h of HUMAN_EDITS) {
    const key = `${h.entity}::${h.field}`;
    const ts = Math.max(Math.round(now - h.daysAgo * DAY), last + 1);
    last = ts;
    events.push({ actor: human(h.who), ts, op: { type: "field.set", entity: h.entity, field: h.field, value: h.value, prev: cur.get(key) ?? null }, reason: h.reason });
    cur.set(key, h.value);
  }
  return events;
}

/** Inbox the agents read: 30 emails over the past 2 weeks. */
export function seedInbox(now: number = Date.now()): EvidenceDoc[] {
  return buildInbox(now);
}

/** Web snapshots the webwatch agent reads (careers/pricing/about pages). */
export function seedWeb(now: number = Date.now()): EvidenceDoc[] {
  return buildWeb(now);
}

/** Docs held back and injected live during the demo (e.g. "Acme is pausing the project"). */
export function injectableDocs(now: number = Date.now()): EvidenceDoc[] {
  return buildInjectable(now);
}

export const SEED_SUMMARY = `### Seed world
A B2B sales team (Joel & Mia) with **10 companies, 25 contacts, 10 deals — $600k open pipeline**, imported 14 days ago, then edited by hand (stage moves, next steps). Agents read **30 emails** and **7 website snapshots**.

**Planted collisions**
1. **Priya @ Acme** (2 days ago): "send over the MSA … 45 seats, total $45,000" → inbox moves *Acme — Platform rollout* discovery→negotiation, $20k→$45k. Policy holds it for review.
2. **Duplicate Priya**: \`p.sharma@acmerobotics.com\` ("Priya S.") signs as "Priya Sharma — VP Engineering". Inbox sets her title; hygiene merges her into \`contact:priya-acme\` → the loser PR is auto-rebased onto the survivor.
3. **Northwind headcount**: Dana emails "we're now 250 people", the about page says "220 employees" → inbox vs webwatch **field conflict** on \`employees\`.
4. **Two Alex Chens** (Kestrel CISO vs Lumen CEO, different domains) → hygiene's exact-name merge is wrong. Revert it.
5. **Procurement contacts** in 4 emails (Kestrel, Vantage, Tidewater, Orbital) → schema agent adds \`deal.procurementContact\` and backfills.
6. **Web signals**: Acme careers lists 3 Data Engineer roles; Brightline pricing adds an Enterprise tier.
7. **Injected live**: "Platform rollout — on hold" (budget freeze, pausing until Q1) → the open Acme PR goes **stale**.

Also: "book a demo" (Brightline), "send a proposal" (Lumen), "close by November 20" (Vantage), messy phone formats, a lowercase-able domain and an "Inc." suffix for hygiene.`;

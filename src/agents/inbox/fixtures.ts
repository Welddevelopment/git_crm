/** Hand-built world + emails for inbox agent tests (mirrors STORY.md; independent of src/seed). */
import type { CRMState, EntityRecord, EvidenceDoc, FieldValue } from "../../core/types";

const DAY = 86_400_000;
export const NOW = Date.parse("2026-10-30T17:00:00-07:00");

function ent(id: string, attrs: Record<string, FieldValue>): EntityRecord {
  return { id, type: id.split(":")[0], attrs };
}

export function fixtureState(): CRMState {
  const list: EntityRecord[] = [
    ent("company:acme", { name: "Acme Robotics", domain: "acmerobotics.com", employees: 400, stage: "lead", signals: [] }),
    ent("deal:acme-platform", { name: "Acme — Platform rollout", company: "company:acme", amount: 20000, stage: "discovery", closeDate: "2026-12-15", owner: "Joel", nextStep: "" }),
    ent("contact:priya-acme", { name: "Priya Sharma", email: "priya@acmerobotics.com", title: "Engineering Manager", company: "company:acme" }),
    ent("contact:priya-sharma", { name: "Priya S.", email: "p.sharma@acmerobotics.com", title: "", company: "company:acme" }),
    ent("company:northwind", { name: "Northwind Freight", domain: "northwindfreight.com", employees: 180, stage: "lead", signals: [] }),
    ent("deal:northwind-fleet", { name: "Northwind — Fleet tracking", company: "company:northwind", amount: 60000, stage: "proposal", closeDate: "2026-11-30", owner: "Joel" }),
    ent("contact:dana-northwind", { name: "Dana Ortiz", email: "dana@northwindfreight.com", title: "Head of Logistics", company: "company:northwind" }),
  ];
  const entities = Object.fromEntries(list.map((e) => [e.id, e]));
  return { schema: {}, entities, aliases: {}, evidence: {}, provenance: {}, versions: {}, headSeq: list.length };
}

export const EMAIL_PRIYA_MSA: EvidenceDoc = {
  id: "email_priya_msa",
  kind: "email",
  ts: NOW - 2 * DAY,
  title: "Re: Platform rollout — next steps",
  from: "Priya Sharma <priya@acmerobotics.com>",
  to: ["joel@mainline.dev"],
  body: `Hi Joel,

Thanks for the walkthrough. The team is convinced. Could you please send over the MSA? We'd like 45 seats, total $45,000 for year one.
We're aiming to close by November 15 so we can start in December.

Next step: Joel to send MSA and order form by Friday

Priya Sharma — Engineering Manager
Acme Robotics`,
  entities: ["company:acme", "deal:acme-platform", "contact:priya-acme"],
};

/** Older Acme email: its earlier $30k mention must lose to the later $45,000 total. */
export const EMAIL_PRIYA_OLD: EvidenceDoc = {
  id: "email_priya_old",
  kind: "email",
  ts: NOW - 9 * DAY,
  title: "Platform rollout pricing",
  from: "priya@acmerobotics.com",
  body: `Hi Joel, budget-wise we were thinking around $30k at $1,000 per seat. Can you book a demo for the wider team?

Priya`,
  entities: ["company:acme", "deal:acme-platform"],
};

export const EMAIL_PSHARMA_SIG: EvidenceDoc = {
  id: "email_psharma_sig",
  kind: "email",
  ts: NOW - 3 * DAY,
  title: "Security questionnaire",
  from: "p.sharma@acmerobotics.com",
  body: `Joel — attaching our security questionnaire answers for your team.

Thanks,
Priya Sharma — VP Engineering
Acme Robotics`,
  entities: ["company:acme", "contact:priya-sharma"],
};

export const EMAIL_DANA_HEADCOUNT: EvidenceDoc = {
  id: "email_dana_headcount",
  kind: "email",
  ts: NOW - 4 * DAY,
  title: "Fleet tracking rollout scope",
  from: "Dana Ortiz <dana@northwindfreight.com>",
  body: `Hi Joel,

Quick update: we're now 250 people after the acquisition, so the rollout will need to cover the new depots too.

Dana Ortiz — Head of Logistics
Northwind Freight`,
  entities: ["company:northwind", "deal:northwind-fleet", "contact:dana-northwind"],
};

export const EMAIL_NEW_SENDER: EvidenceDoc = {
  id: "email_new_sender",
  kind: "email",
  ts: NOW - 1 * DAY,
  title: "Re: Fleet tracking rollout scope",
  from: "Marco Bellini <marco@northwindfreight.com>",
  body: `Hi Joel, Dana looped me in. I'll own the depot integration on our side.

Marco Bellini — IT Director
Northwind Freight

On Mon, Oct 26, 2026 at 9:00 AM Dana Ortiz <dana@northwindfreight.com> wrote:
> we're now 999 people`,
  entities: ["company:northwind"],
};

export const ALL_EMAILS = [EMAIL_PRIYA_OLD, EMAIL_PRIYA_MSA, EMAIL_PSHARMA_SIG, EMAIL_DANA_HEADCOUNT, EMAIL_NEW_SENDER];

/** OWNER: W8. Seeded inbox. Phrase conventions follow STORY.md so deterministic agents fire. */
import type { EvidenceDoc } from "../core/types";
import { COMPANIES, CONTACTS, OWNER_EMAIL } from "./world";

export const DAY = 24 * 60 * 60 * 1000;

interface EmailSpec {
  daysAgo: number;
  from: string; // contact id
  fromEmail?: string; // override (defaults to contact email)
  to: "Joel" | "Mia";
  subject: string;
  body: string;
  /** signature override; default "<Name> — <Title>\n<Company>"; "" = none */
  sig?: string;
  /** extra entity ids beyond sender contact + its company */
  also?: string[];
}

const contact = (id: string) => {
  const c = CONTACTS.find((x) => x.id === id);
  if (!c) throw new Error(`seed: unknown contact ${id}`);
  return c;
};
const companyName = (id: string) => COMPANIES.find((x) => x.id === id)?.name ?? id;

export const EMAIL_SPECS: EmailSpec[] = [
  { daysAgo: 13.5, from: "contact:tom-becker", to: "Joel", subject: "Intro — platform evaluation", also: ["deal:acme-platform"],
    body: "Hi Joel,\n\nPriya Sharma on our engineering side is leading the evaluation of your platform. I'm looping her in so you two can find time for an intro call this week. I'll own the IT review once there's a shortlist." },
  { daysAgo: 13.2, from: "contact:isaac-stern", to: "Mia", subject: "Quick intro", also: ["deal:quill-starter"],
    body: "Hi Mia,\n\nA colleague at another firm recommended you. We're a small litigation practice and our client records live in four different spreadsheets. Do you have 30 minutes Thursday or Friday for an intro?" },
  { daysAgo: 12.8, from: "contact:alex-chen-lumen", to: "Mia", subject: "Dashboard walkthrough?", also: ["deal:lumen-pilot"],
    body: "Mia,\n\nBefore we scope anything I want to see the grid dashboard with real substation data. Can your team put together a walkthrough early next week? Jade will coordinate calendars." },
  { daysAgo: 12.4, from: "contact:alex-chen-kestrel", to: "Joel", subject: "SIEM connector scope", also: ["deal:kestrel-security"],
    body: "Joel,\n\nFollowing the scoping call: we need the SIEM connector module included in the order, our SOC can't adopt a tool that doesn't feed Splunk. Devon will send the security questionnaire separately." },
  { daysAgo: 11.6, from: "contact:luis-moreno", to: "Joel", subject: "Dashboard feedback session", also: ["deal:orbital-supply"],
    body: "Hi Joel,\n\nThe regional managers have been playing with the supply chain dashboards. Could we do a feedback session Wednesday at 2pm Mountain? I'll bring the two plant leads." },
  { daysAgo: 11.0, from: "contact:grace-liu", to: "Joel", subject: "Questions on the routing proposal", also: ["deal:tidewater-routing"],
    body: "Joel,\n\nThanks for the proposal. Two questions: does the route optimizer handle mixed refrigerated and dry loads, and can dispatchers override a suggested route without breaking the model? Happy to jump on a call." },
  { daysAgo: 10.5, from: "contact:ethan-park", to: "Mia", subject: "Pricing works for us", also: ["deal:vantage-stores"],
    body: "Mia,\n\nWe reviewed the store rollout pricing internally and it works for us. I'm looping in our legal team to review the terms next. Chloe will handle the IT and vendor side." },
  { daysAgo: 10.1, from: "contact:priya-acme", to: "Joel", subject: "Walkthrough recap", also: ["deal:acme-platform"], sig: "Priya",
    body: "Hi Joel,\n\nThanks for the intro call. Could we do a technical walkthrough with my team next Tuesday? We mostly care about the API, SSO and how permissions work across sites." },
  { daysAgo: 9.6, from: "contact:leah-grant", to: "Joel", subject: "Adding the analytics team", also: ["contact:mateo-silva", "deal:harbor-expansion"],
    body: "Hi Joel,\n\nMateo's analytics group wants access too, so we'd like to expand beyond the data team. Can you update the order form to include them? Noah will review the commercials." },
  { daysAgo: 9.0, from: "contact:dana-northwind", to: "Mia", subject: "Thanks for the demo", also: ["deal:northwind-fleet"],
    body: "Mia,\n\nThanks for the demo yesterday, the dispatch team loved the live map and the ETA alerts. Looking forward to your proposal. Ravi will have a few integration questions." },
  { daysAgo: 8.5, from: "contact:ravi-patel", to: "Mia", subject: "Integration with our TMS", also: ["deal:northwind-fleet"],
    body: "Hi Mia,\n\nWe run our own TMS on Postgres. Is there a webhook or batch export for shipment events, or do we need to poll your API? Our engineers want to estimate the integration work." },
  { daysAgo: 7.8, from: "contact:isaac-stern", to: "Mia", subject: "Permissions questions", also: ["deal:quill-starter"],
    body: "Mia,\n\nTwo questions from our partners: can we restrict a matter to the attorneys staffed on it, and is there an audit log of who viewed a client record? Both are must-haves for us." },
  { daysAgo: 7.2, from: "contact:chloe-martin", to: "Mia", subject: "Vendor onboarding", also: ["deal:vantage-stores"],
    body: "Hi Mia,\n\nFor vendor onboarding please work with our procurement contact, Marcus Bell (marcus.bell@vantageretail.com). He'll need your W-9 and insurance certificate." },
  { daysAgo: 6.7, from: "contact:luis-moreno", to: "Joel", subject: "ROI numbers", also: ["deal:orbital-supply"],
    body: "Joel,\n\nThe steering committee meets next Thursday. Can you share the ROI model before then? They'll want to see inventory carrying cost savings for the two new plants." },
  { daysAgo: 6.1, from: "contact:morgan-hale", to: "Joel", subject: "Paperwork next steps", also: ["deal:kestrel-security"],
    body: "Joel,\n\nRisk is comfortable with the scope. For the paperwork, please loop in our procurement contact, Sam Lee (sam.lee@kestrelbank.com), who runs vendor contracts for the bank." },
  { daysAgo: 5.8, from: "contact:jade-kim", to: "Mia", subject: "Scheduling the scoping session", also: ["deal:lumen-pilot"],
    body: "Hi Mia,\n\nAlex is free Tuesday or Wednesday afternoon for the pilot scoping session. Could you send a calendar invite for 90 minutes? I'll make sure our field lead joins." },
  { daysAgo: 5.4, from: "contact:sofia-reyes", to: "Joel", subject: "Budget timing", also: ["deal:tidewater-routing"],
    body: "Joel,\n\nQuick heads-up: our budget approval moved to next week, so expect a short delay on our side. Meanwhile our procurement contact, Rita Gomez (rita.gomez@tidewaterlogistics.com), can start vendor setup." },
  { daysAgo: 4.9, from: "contact:priya-sharma", to: "Joel", subject: "Security docs for the platform rollout",
    sig: "Priya Sharma — VP Engineering\nAcme Robotics",
    body: "Hi Joel,\n\nSending this from my other address. Attached are our data handling requirements. Can you confirm SSO via Okta and US-only data residency? Our engineering org will need both." },
  { daysAgo: 4.5, from: "contact:noah-fisher", to: "Joel", subject: "Order form review", also: ["deal:harbor-expansion"],
    body: "Hi Joel,\n\nI'm reviewing the updated order form. Can we move to quarterly invoicing instead of annual upfront? Otherwise the terms look fine." },
  { daysAgo: 4.0, from: "contact:hannah-cole", to: "Joel", subject: "Vendor setup for the expansion", also: ["deal:orbital-supply"],
    body: "Hi Joel,\n\nLuis asked me to get the expansion set up in our vendor system. I'm your procurement contact, Hannah Cole (hannah.cole@orbitalfoods.com), for anything contract related." },
  { daysAgo: 3.6, from: "contact:nora-feld", to: "Mia", subject: "Seeing it in action", also: ["deal:brightline-care"],
    body: "Hi Mia,\n\nThe discovery call was really useful. We'd like to book a demo for my care ops leads next week so they can see the scheduling workflow in action." },
  { daysAgo: 3.0, from: "contact:dana-northwind", to: "Mia", subject: "Scope update", also: ["deal:northwind-fleet"],
    body: "Mia,\n\nQuick update on our side: we're now 250 people after the acquisition of Bayline Carriers, so the fleet rollout will cover their trucks too. Can we revisit the scope?" },
  { daysAgo: 2.7, from: "contact:ben-ito", to: "Mia", subject: "SSO requirements", also: ["deal:brightline-care"],
    body: "Hi Mia,\n\nBefore the demo, can you confirm you support SAML SSO with Azure AD and that PHI is encrypted at rest? Our compliance team will ask on the call." },
  { daysAgo: 2.4, from: "contact:alex-chen-lumen", to: "Mia", subject: "Pilot next steps", also: ["deal:lumen-pilot"],
    body: "Mia,\n\nThe scoping session was great. Could you send a proposal for the three-site pilot? We'd like to start with the Austin, Waco and Temple substations." },
  { daysAgo: 2.0, from: "contact:priya-acme", to: "Joel", subject: "Next steps on the platform rollout", also: ["deal:acme-platform"], sig: "Priya",
    body: "Hi Joel,\n\nThe team loved the walkthrough and we're ready to move ahead. Please send over the MSA so legal can start reviewing. We'd like 45 seats, total $45,000 for the first year." },
  { daysAgo: 1.6, from: "contact:ethan-park", to: "Mia", subject: "Rollout timeline", also: ["deal:vantage-stores"],
    body: "Mia,\n\nLegal is nearly through the terms. We'd like to close by November 20 so the first stores are live before Black Friday. Can your onboarding team hold that week?" },
  { daysAgo: 1.2, from: "contact:owen-brooks", to: "Joel", subject: "Driver app feedback", also: ["deal:tidewater-routing"],
    body: "Joel,\n\nI had three of our drivers try the mobile app during the trial. They liked turn-by-turn but want offline maps for the rural routes. Is that on the roadmap?" },
  { daysAgo: 0.8, from: "contact:mateo-silva", to: "Joel", subject: "Training session", also: ["deal:harbor-expansion"],
    body: "Hi Joel,\n\nOnce the expansion goes through, can we set up a training session for the analytics group? Mornings Pacific work best for us." },
  { daysAgo: 0.5, from: "contact:devon-wu", to: "Joel", subject: "Security questionnaire", also: ["deal:kestrel-security"],
    body: "Joel,\n\nThe security questionnaire is underway on our side. I'll have answers on the encryption and logging sections by Monday." },
  { daysAgo: 0.2, from: "contact:ava-lowe", to: "Mia", subject: "Billing details for the starter plan", also: ["deal:quill-starter"],
    body: "Hi Mia,\n\nIsaac asked me to send our billing address and the name for invoices. Should I send these to you or to your finance team?" },
];

function render(spec: EmailSpec, idx: number, now: number): EvidenceDoc {
  const c = contact(spec.from);
  const sig = spec.sig ?? `${c.name} — ${c.title}\n${companyName(c.company)}`;
  const body = sig ? `${spec.body}\n\n${sig}` : spec.body;
  const entities = [...new Set([c.company, c.id, ...(spec.also ?? [])])];
  return {
    id: `email_${String(idx + 1).padStart(2, "0")}`,
    kind: "email",
    ts: Math.round(now - spec.daysAgo * DAY),
    title: spec.subject,
    from: spec.fromEmail ?? c.email,
    to: [OWNER_EMAIL[spec.to]!],
    body,
    entities,
  };
}

export function buildInbox(now: number): EvidenceDoc[] {
  return EMAIL_SPECS.map((s, i) => render(s, i, now));
}

export function buildInjectable(now: number): EvidenceDoc[] {
  return [
    {
      id: "email_inject_acme_pause",
      kind: "email",
      ts: now,
      title: "Platform rollout — on hold",
      from: "priya@acmerobotics.com",
      to: [OWNER_EMAIL.Joel!],
      body:
        "Hi Joel,\n\nI'm sorry to do this after the last email. Finance just announced a budget freeze, so we're pausing the platform rollout until Q1. Please hold off on the MSA for now.\n\nPriya",
      entities: ["company:acme", "deal:acme-platform", "contact:priya-acme"],
    },
    {
      id: "email_inject_quill_hello",
      kind: "email",
      ts: now,
      title: "Thanks!",
      from: "isaac@quill-legal.com",
      to: [OWNER_EMAIL.Mia!],
      body: "Mia,\n\nJust wanted to say thanks for the quick answers on permissions. The partners are happy. Talk soon.\n\nIsaac Stern — Managing Partner\nQuill Legal",
      entities: ["company:quill", "contact:isaac-stern"],
    },
  ];
}

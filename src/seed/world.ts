/** OWNER: W8. The seeded CRM world (companies, contacts, deals). Ids are exact per STORY.md. */
import type { FieldValue } from "../core/types";

export const SELLER_DOMAIN = "mainline.example";
export const OWNER_EMAIL: Record<string, string> = { Joel: `joel@${SELLER_DOMAIN}`, Mia: `mia@${SELLER_DOMAIN}` };

export interface CompanySeed {
  id: string;
  name: string;
  domain: string;
  industry: string;
  employees: number;
  stage: "lead" | "customer" | "churned";
  signals: string[];
  owner: "Joel" | "Mia";
}

export const COMPANIES: CompanySeed[] = [
  { id: "company:acme", name: "Acme Robotics", domain: "acmerobotics.com", industry: "Industrial Robotics", employees: 140, stage: "lead", signals: [], owner: "Joel" },
  { id: "company:northwind", name: "Northwind Freight", domain: "northwindfreight.com", industry: "Freight & Logistics", employees: 180, stage: "lead", signals: [], owner: "Mia" },
  { id: "company:kestrel", name: "Kestrel Bank", domain: "kestrelbank.com", industry: "Banking", employees: 2400, stage: "lead", signals: [], owner: "Joel" },
  { id: "company:lumen", name: "Lumen Grid", domain: "lumengrid.io", industry: "Energy Software", employees: 35, stage: "lead", signals: [], owner: "Mia" },
  { id: "company:brightline", name: "Brightline Health", domain: "brightlinehealth.com", industry: "Healthcare", employees: 600, stage: "lead", signals: [], owner: "Mia" },
  { id: "company:orbital", name: "Orbital Foods", domain: "orbitalfoods.com", industry: "Food & Beverage", employees: 900, stage: "customer", signals: ["hiring:sales"], owner: "Joel" },
  { id: "company:tidewater", name: "Tidewater Logistics", domain: "tidewaterlogistics.com", industry: "Logistics", employees: 320, stage: "lead", signals: [], owner: "Joel" },
  // planted normalization work for hygiene: mixed-case domain
  { id: "company:vantage", name: "Vantage Retail", domain: "VantageRetail.com", industry: "Retail", employees: 1500, stage: "customer", signals: [], owner: "Mia" },
  { id: "company:quill", name: "Quill Legal", domain: "quill-legal.com", industry: "Legal Services", employees: 60, stage: "lead", signals: [], owner: "Mia" },
  // planted normalization work for hygiene: "Inc." suffix
  { id: "company:harbor", name: "Harbor Analytics, Inc.", domain: "harboranalytics.io", industry: "Data & Analytics", employees: 85, stage: "customer", signals: [], owner: "Joel" },
];

export interface ContactSeed {
  id: string;
  name: string;
  email: string;
  title: string;
  company: string;
  phone: string;
}

export const CONTACTS: ContactSeed[] = [
  // Acme — priya-sharma is a DUPLICATE of priya-acme (the correct dedup)
  { id: "contact:priya-acme", name: "Priya Sharma", email: "priya@acmerobotics.com", title: "Engineering Manager", company: "company:acme", phone: "+1 (415) 555-0142" },
  { id: "contact:priya-sharma", name: "Priya S.", email: "p.sharma@acmerobotics.com", title: "", company: "company:acme", phone: "" },
  { id: "contact:tom-becker", name: "Tom Becker", email: "tom.becker@acmerobotics.com", title: "Head of IT", company: "company:acme", phone: "" },
  // Northwind
  { id: "contact:dana-northwind", name: "Dana Ortiz", email: "dana@northwindfreight.com", title: "Head of Logistics", company: "company:northwind", phone: "+1 (312) 555-0187" },
  { id: "contact:ravi-patel", name: "Ravi Patel", email: "ravi.patel@northwindfreight.com", title: "COO", company: "company:northwind", phone: "312.555.0110" },
  { id: "contact:kim-torres", name: "Kim Torres", email: "kim.torres@northwindfreight.com", title: "Vendor Manager", company: "company:northwind", phone: "" },
  // Kestrel — alex-chen-kestrel and alex-chen-lumen are DIFFERENT people (the BAD dedup)
  { id: "contact:alex-chen-kestrel", name: "Alex Chen", email: "alex.chen@kestrelbank.com", title: "CISO", company: "company:kestrel", phone: "+1 (212) 555-0100" },
  { id: "contact:morgan-hale", name: "Morgan Hale", email: "morgan.hale@kestrelbank.com", title: "VP Risk", company: "company:kestrel", phone: "(212) 555 0177" },
  { id: "contact:devon-wu", name: "Devon Wu", email: "devon.wu@kestrelbank.com", title: "Security Engineer", company: "company:kestrel", phone: "" },
  // Lumen
  { id: "contact:alex-chen-lumen", name: "Alex Chen", email: "achen@lumengrid.io", title: "Founder & CEO", company: "company:lumen", phone: "+1 (512) 555-0133" },
  { id: "contact:jade-kim", name: "Jade Kim", email: "jade@lumengrid.io", title: "Head of Operations", company: "company:lumen", phone: "" },
  // Brightline
  { id: "contact:nora-feld", name: "Nora Feld", email: "nora.feld@brightlinehealth.com", title: "Director of Care Operations", company: "company:brightline", phone: "+1 (617) 555-0164" },
  { id: "contact:ben-ito", name: "Ben Ito", email: "ben.ito@brightlinehealth.com", title: "IT Manager", company: "company:brightline", phone: "6175550123" },
  // Orbital
  { id: "contact:luis-moreno", name: "Luis Moreno", email: "luis.moreno@orbitalfoods.com", title: "VP Supply Chain", company: "company:orbital", phone: "+1 (303) 555-0121" },
  { id: "contact:hannah-cole", name: "Hannah Cole", email: "hannah.cole@orbitalfoods.com", title: "Procurement Manager", company: "company:orbital", phone: "" },
  // Tidewater
  { id: "contact:grace-liu", name: "Grace Liu", email: "grace.liu@tidewaterlogistics.com", title: "Director of Operations", company: "company:tidewater", phone: "+1 (757) 555-0150" },
  { id: "contact:owen-brooks", name: "Owen Brooks", email: "owen.brooks@tidewaterlogistics.com", title: "Fleet Manager", company: "company:tidewater", phone: "" },
  { id: "contact:sofia-reyes", name: "Sofia Reyes", email: "sofia.reyes@tidewaterlogistics.com", title: "CFO", company: "company:tidewater", phone: "+1 (757) 555-0199" },
  // Vantage
  { id: "contact:ethan-park", name: "Ethan Park", email: "ethan.park@vantageretail.com", title: "VP Retail Operations", company: "company:vantage", phone: "+1 (206) 555-0108" },
  { id: "contact:chloe-martin", name: "Chloe Martin", email: "chloe.martin@vantageretail.com", title: "IT Director", company: "company:vantage", phone: "" },
  // Quill
  { id: "contact:isaac-stern", name: "Isaac Stern", email: "isaac@quill-legal.com", title: "Managing Partner", company: "company:quill", phone: "+1 (646) 555-0119" },
  { id: "contact:ava-lowe", name: "Ava Lowe", email: "ava.lowe@quill-legal.com", title: "Office Manager", company: "company:quill", phone: "" },
  // Harbor
  { id: "contact:leah-grant", name: "Leah Grant", email: "leah.grant@harboranalytics.io", title: "Head of Data", company: "company:harbor", phone: "+1 (503) 555-0172" },
  { id: "contact:noah-fisher", name: "Noah Fisher", email: "noah.fisher@harboranalytics.io", title: "CFO", company: "company:harbor", phone: "" },
  { id: "contact:mateo-silva", name: "Mateo Silva", email: "mateo.silva@harboranalytics.io", title: "Analytics Lead", company: "company:harbor", phone: "" },
];

export type DealStage = "discovery" | "demo" | "proposal" | "negotiation" | "closed_won" | "closed_lost";
export interface DealSeed {
  id: string;
  name: string;
  company: string;
  amount: number;
  stage: DealStage;
  closeDate: string;
  owner: "Joel" | "Mia";
  nextStep: string;
}

/**
 * Deals as CREATED. A few later get organic human edits (see HUMAN_EDITS) so the final
 * values on main match FINAL_DEALS / STORY.md. Final pipeline = $600,000.
 */
export const DEALS: DealSeed[] = [
  { id: "deal:acme-platform", name: "Acme — Platform rollout", company: "company:acme", amount: 20000, stage: "discovery", closeDate: "2026-12-15", owner: "Joel", nextStep: "Intro call with Priya" },
  { id: "deal:northwind-fleet", name: "Northwind — Fleet visibility", company: "company:northwind", amount: 60000, stage: "demo", closeDate: "2026-11-30", owner: "Mia", nextStep: "Demo for Dana's dispatch team" },
  { id: "deal:kestrel-security", name: "Kestrel — Security analytics", company: "company:kestrel", amount: 100000, stage: "negotiation", closeDate: "2026-12-01", owner: "Joel", nextStep: "Finish security questionnaire" },
  { id: "deal:lumen-pilot", name: "Lumen — Grid pilot", company: "company:lumen", amount: 25000, stage: "discovery", closeDate: "2026-12-20", owner: "Mia", nextStep: "Scope pilot with Alex" },
  { id: "deal:brightline-care", name: "Brightline — Care ops", company: "company:brightline", amount: 55000, stage: "discovery", closeDate: "2027-01-15", owner: "Mia", nextStep: "Discovery call with Nora" },
  { id: "deal:orbital-supply", name: "Orbital — Supply chain expansion", company: "company:orbital", amount: 70000, stage: "demo", closeDate: "2026-12-10", owner: "Joel", nextStep: "Dashboard feedback session" },
  { id: "deal:tidewater-routing", name: "Tidewater — Route optimization", company: "company:tidewater", amount: 85000, stage: "proposal", closeDate: "2026-11-30", owner: "Joel", nextStep: "Review proposal with Grace" },
  { id: "deal:vantage-stores", name: "Vantage — Store rollout", company: "company:vantage", amount: 95000, stage: "proposal", closeDate: "2026-11-25", owner: "Mia", nextStep: "Pricing review with Ethan" },
  { id: "deal:harbor-expansion", name: "Harbor — Team expansion", company: "company:harbor", amount: 40000, stage: "proposal", closeDate: "2026-11-14", owner: "Joel", nextStep: "Send order form" },
  { id: "deal:quill-starter", name: "Quill — Starter plan", company: "company:quill", amount: 30000, stage: "discovery", closeDate: "2027-01-31", owner: "Mia", nextStep: "Intro call with Isaac" },
];

export interface HumanEdit {
  daysAgo: number;
  who: "Joel" | "Mia";
  entity: string;
  field: string;
  value: FieldValue;
  reason: string;
}

/** Organic edits by the sales team after import, oldest first. `prev` is computed. */
export const HUMAN_EDITS: HumanEdit[] = [
  { daysAgo: 12.2, who: "Mia", entity: "deal:lumen-pilot", field: "stage", value: "demo", reason: "Alex wants to see the grid dashboard before scoping" },
  { daysAgo: 11.1, who: "Joel", entity: "deal:kestrel-security", field: "amount", value: 120000, reason: "Added SIEM connector module after scoping call" },
  { daysAgo: 10.3, who: "Joel", entity: "deal:acme-platform", field: "nextStep", value: "Technical walkthrough with Priya's team", reason: "Intro call done" },
  { daysAgo: 9.4, who: "Mia", entity: "deal:vantage-stores", field: "stage", value: "negotiation", reason: "Ethan accepted pricing; legal review next" },
  { daysAgo: 8.2, who: "Mia", entity: "deal:northwind-fleet", field: "stage", value: "proposal", reason: "Demo went well; proposal sent" },
  { daysAgo: 8.1, who: "Mia", entity: "deal:northwind-fleet", field: "nextStep", value: "Follow up on proposal with Dana", reason: "Proposal sent" },
  { daysAgo: 7.3, who: "Mia", entity: "deal:quill-starter", field: "nextStep", value: "Answer permissions questions from Isaac", reason: "Isaac emailed questions" },
  { daysAgo: 6.2, who: "Joel", entity: "deal:orbital-supply", field: "nextStep", value: "Share ROI model with Luis", reason: "Luis asked for ROI numbers" },
  { daysAgo: 5.3, who: "Joel", entity: "deal:tidewater-routing", field: "closeDate", value: "2026-12-05", reason: "Grace's budget sign-off slipped a week" },
  { daysAgo: 4.2, who: "Joel", entity: "deal:harbor-expansion", field: "stage", value: "negotiation", reason: "Noah reviewing order form" },
  { daysAgo: 3.4, who: "Mia", entity: "deal:brightline-care", field: "nextStep", value: "Schedule care ops demo", reason: "Nora asked to see the product" },
  { daysAgo: 2.6, who: "Joel", entity: "deal:acme-platform", field: "nextStep", value: "Send pricing for the full engineering team", reason: "Walkthrough done; Priya wants pricing" },
  { daysAgo: 1.3, who: "Mia", entity: "contact:jade-kim", field: "phone", value: "+1 (512) 555-0156", reason: "Got Jade's direct line" },
];

/** OWNER: W8. Web snapshots for the webwatch agent. */
import type { EvidenceDoc } from "../core/types";
import { DAY } from "./emails";

interface WebSpec { id: string; company: string; url: string; title: string; daysAgo: number; body: string }

export const WEB_SPECS: WebSpec[] = [
  {
    id: "web_acme_careers", company: "company:acme", url: "https://acmerobotics.com/careers", title: "Careers at Acme Robotics", daysAgo: 1.5,
    body: [
      "# Careers at Acme Robotics",
      "Build the robots that build everything else.",
      "## Open roles",
      "- Data Engineer — Pipelines (San Francisco)",
      "- Data Engineer — Streaming Telemetry (Remote, US)",
      "- Senior Data Engineer — Warehouse (San Francisco)",
      "- Mechanical Design Engineer (Fremont)",
      "- Field Service Technician (Austin)",
      "We offer competitive equity, a hardware stipend and a lab full of robots.",
    ].join("\n"),
  },
  {
    id: "web_brightline_pricing", company: "company:brightline", url: "https://brightlinehealth.com/pricing", title: "Brightline Health — Pricing", daysAgo: 1.2,
    body: [
      "# Plans for every care team",
      "## Clinic",
      "Scheduling and patient messaging for single-site clinics.",
      "## Network",
      "Multi-site scheduling, referrals and reporting.",
      "## Enterprise",
      "New: the Enterprise tier adds SSO, dedicated support and custom integrations for health systems. Contact sales.",
    ].join("\n"),
  },
  {
    id: "web_northwind_about", company: "company:northwind", url: "https://northwindfreight.com/about", title: "About Northwind Freight", daysAgo: 1.0,
    body: [
      "# About Northwind Freight",
      "Founded in 2009 in Chicago, Northwind Freight moves temperature-sensitive cargo across the Midwest.",
      "Today we are 220 employees across 6 terminals, running a fleet of 400 trucks.",
      "Our mission: on time, every time.",
    ].join("\n"),
  },
  {
    id: "web_orbital_home", company: "company:orbital", url: "https://orbitalfoods.com/", title: "Orbital Foods", daysAgo: 2.5,
    body: "# Orbital Foods\nSnacks made with real ingredients, shipped to grocers nationwide.\nFind our products in your local store.",
  },
  {
    id: "web_tidewater_home", company: "company:tidewater", url: "https://tidewaterlogistics.com/", title: "Tidewater Logistics", daysAgo: 2.2,
    body: "# Tidewater Logistics\nPort-to-door drayage and regional distribution from Norfolk.\nRequest a quote today.",
  },
  {
    id: "web_harbor_blog", company: "company:harbor", url: "https://harboranalytics.io/blog/q3-product-update", title: "Harbor Analytics — Q3 product update", daysAgo: 3.1,
    body: "# Q3 product update\nThis quarter we shipped faster dashboards, scheduled exports and a refreshed query editor.\nThanks to every customer who sent feedback.",
  },
  {
    id: "web_quill_home", company: "company:quill", url: "https://quill-legal.com/", title: "Quill Legal", daysAgo: 4.0,
    body: "# Quill Legal\nLitigation and employment counsel for growing companies.\nSchedule a consultation with our partners.",
  },
];

export function buildWeb(now: number): EvidenceDoc[] {
  return WEB_SPECS.map((w) => ({
    id: w.id,
    kind: "web" as const,
    ts: Math.round(now - w.daysAgo * DAY),
    title: w.title,
    url: w.url,
    body: w.body,
    entities: [w.company],
  }));
}

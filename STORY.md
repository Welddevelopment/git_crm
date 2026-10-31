# Demo storyline (shared by W8 seed + all 4 agents + UI). Lead-owned.

World (ids are exact):
- company:acme  "Acme Robotics" acmerobotics.com — deal:acme-platform "Acme — Platform rollout" $20,000, stage discovery, closeDate 2026-12-15, owner "Joel"
  - contact:priya-acme  "Priya Sharma" priya@acmerobotics.com, title "Engineering Manager"
  - contact:priya-sharma "Priya S." p.sharma@acmerobotics.com, title "" (DUPLICATE of priya-acme — correct dedup)
- company:northwind "Northwind Freight" — employees 180 — deal:northwind-fleet $60,000 proposal
  - contact:dana-northwind "Dana Ortiz" Head of Logistics
- company:kestrel "Kestrel Bank" — contact:alex-chen-kestrel "Alex Chen" alex.chen@kestrelbank.com, "CISO"
- company:lumen "Lumen Grid" — contact:alex-chen-lumen "Alex Chen" achen@lumengrid.io, "Founder & CEO"  (DIFFERENT person — the BAD dedup)
- company:brightline "Brightline Health", company:orbital "Orbital Foods", company:tidewater "Tidewater Logistics",
  company:vantage "Vantage Retail", company:quill "Quill Legal", company:harbor "Harbor Analytics" — each with 1–3 contacts, most with a deal.

Collisions the agents must produce (deterministically, no API key):
1. INBOX: email from Priya (Oct 28) "please send over the MSA … we'd like 45 seats, total $45,000" → deal:acme-platform stage discovery→negotiation, amount 20000→45000. Policy holds it for review (amount delta + stage).
2. INBOX: email signature from p.sharma@acmerobotics.com "Priya Sharma — VP Engineering" → field.set contact:priya-sharma title "VP Engineering".
   HYGIENE: entity.merge contact:priya-sharma → contact:priya-acme (same name/company domain). Whichever merges first, the other PR touches a merged-away entity → auto-rebased onto priya-acme.
3. INBOX: Dana email "we're now 250 people after the acquisition" → company:northwind employees 250.
   WEBWATCH: Northwind careers/about page "220 employees" → company:northwind employees 220.  ⇒ FIELD CONFLICT (both changed same field since fork).
4. HYGIENE (bad): exact-name match merges contact:alex-chen-lumen → contact:alex-chen-kestrel. Its own PR (one PR per merge). This is the one we REVERT in the demo.
5. SCHEMA: ≥3 emails mention a procurement contact ("loop in our procurement contact, Sam Lee (sam@…)") → schema.addField deal.procurementContact (string) + field.set backfill on those deals.
6. WEBWATCH: Acme careers page lists 3 "Data Engineer" roles → company:acme signals += "hiring:data-engineering"; Brightline pricing page adds an "Enterprise" tier → signals += "pricing:enterprise-tier".
7. INJECTED (held back, injected live): email from Priya, ts = now, "we're pausing the platform rollout until Q1 — budget freeze" with entities [company:acme, deal:acme-platform, contact:priya-acme] → the open Acme PR from (1) becomes STALE.

Phrase conventions so deterministic parsers work (W8 writes emails using these; A1/A3 parse them):
- Money: "$45,000" or "$45k". Seats: "45 seats".
- Stage cues: "send over the MSA" / "ready to sign" / "redlines" → negotiation; "book a demo" → demo; "send a proposal" → proposal; "signed" → closed_won; "going with another vendor" → closed_lost.
- Dates: "close by November 15" / "target 2026-11-15".
- Headcount: "we're now 250 people" / "250 employees".
- Signature block: last lines "<Name> — <Title>\n<Company>".
- Procurement: "procurement contact, <Name> (<email>)".
- Negative cues (staleness heuristic): "pausing", "on hold", "budget freeze", "postpone", "not moving forward", "going with another vendor", "cancel".
Every email's EvidenceDoc.entities lists the company/contact/deal ids it's about.
Timestamps: relative to Date.now() at seed time (seed spans the past 14 days; Oct 28 email = now - 2 days).

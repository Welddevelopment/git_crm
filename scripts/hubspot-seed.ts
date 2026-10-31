/**
 * Push Git CRM's demo world (10 companies, 25 contacts, 10 deals, with company associations) INTO your HubSpot
 * portal, so the HubSpot side of the demo looks real. Idempotent: records are matched by company domain,
 * contact email and deal name first; re-running only patches what differs.
 *
 * Usage (token comes from the environment only; never put it in a file):
 *   HUBSPOT_TOKEN=pat-na1-... npx tsx scripts/hubspot-seed.ts
 *   HUBSPOT_TOKEN=... npx tsx scripts/hubspot-seed.ts --json      # machine-readable output
 *
 * Token: HubSpot > Settings > Integrations > Private apps > Create, scopes:
 *   crm.objects.companies.read/write, crm.objects.contacts.read/write, crm.objects.deals.read/write
 * Deals go into the default pipeline (stages: discovery->qualifiedtobuy, demo->presentationscheduled,
 * proposal->decisionmakerboughtin, negotiation->contractsent, closed_won->closedwon, closed_lost->closedlost).
 *
 * No local shell? The deployed app does the same: POST /api/integrations/hubspot/seed (uses the server's
 * HUBSPOT_TOKEN, then imports so main records each hubspotId).
 */
import { seedHubSpot } from "../src/integrations/hubspot/seed";

async function main() {
  if (!process.env.HUBSPOT_TOKEN?.trim()) {
    console.error("HUBSPOT_TOKEN is not set. Run: HUBSPOT_TOKEN=<private app token> npx tsx scripts/hubspot-seed.ts");
    process.exit(1);
  }
  const asJson = process.argv.includes("--json");
  const r = await seedHubSpot({ log: asJson ? undefined : (m) => console.log(m) });
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`\nportal ${r.portalId ?? "?"}: ${r.created.length} created, ${r.updated.length} updated, ${r.unchanged} unchanged, ${r.errors.length} error(s)`);
    console.log("\nMainline id -> HubSpot id");
    for (const [entity, id] of Object.entries(r.ids)) console.log(`  ${entity.padEnd(32)} ${id}`);
    if (r.portalId) {
      const acme = r.ids["deal:acme-platform"];
      if (acme) console.log(`\nAcme deal in HubSpot: https://app.hubspot.com/contacts/${r.portalId}/record/0-3/${acme}`);
    }
    for (const e of r.errors) console.error(`error: ${e}`);
  }
  process.exit(r.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

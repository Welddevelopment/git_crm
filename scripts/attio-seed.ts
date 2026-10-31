/**
 * Push Mainline's seed world (src/seed: 10 companies, 25 people, 10 deals) into YOUR Attio workspace.
 *
 * Usage:
 *   ATTIO_TOKEN=<token> npx tsx scripts/attio-seed.ts
 *
 * - Idempotent: companies are matched by domain, people by email, deals by name. Existing records are only
 *   PATCHed for fields that differ; missing ones are created. Re-running is safe.
 * - Deals are skipped (with a note) if the workspace has no "deals" object.
 * - Needs an Attio access token with read-write scope on records (+ read on workspace members for deal owners).
 * - The token is read from the environment only; it is never printed or written anywhere.
 * - Then on the deployed app: POST /api/integrations/attio/import (or /seed, which does both server-side)
 *   so main records attrs.attioId for every mirrored entity.
 */
import { AttioClient } from "../src/integrations/attio/client";
import { seedAttio } from "../src/integrations/attio/seed";

async function main() {
  if (!process.env.ATTIO_TOKEN?.trim()) {
    console.error("ATTIO_TOKEN is not set. Usage: ATTIO_TOKEN=<token> npx tsx scripts/attio-seed.ts");
    process.exit(1);
  }
  const res = await seedAttio({ client: new AttioClient(), log: (m) => console.log(m) });
  console.log("");
  console.log(`workspace: ${res.workspace ?? "(unknown)"}  deals: ${res.deals}`);
  console.log(`created ${res.created.length}, updated ${res.updated.length}, unchanged ${res.unchanged}, errors ${res.errors.length}`);
  console.log("\nMainline entity -> Attio record_id");
  for (const [entity, rid] of Object.entries(res.ids)) console.log(`  ${entity.padEnd(32)} ${rid}`);
  if (res.errors.length) {
    console.error("\nErrors:");
    for (const e of res.errors) console.error(`  ${e}`);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

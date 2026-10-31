export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * POST -> push Mainline's current main (the seeded demo world + anything merged since) into the HubSpot portal
 * behind HUBSPOT_TOKEN (idempotent: matched by domain / email / deal name), record each entity's hubspotId on
 * main, then run a full import. Returns {ok, created, updated, unchanged, ids, portalId, import, errors}.
 */
import { getRepo } from "@/server/repo";
import { handle, json } from "@/server/http";
import { HUBSPOT_SYSTEM, hubspotToken, importFromHubSpot } from "@/integrations/hubspot";
import { seedHubSpot } from "@/integrations/hubspot/seed";
import type { NewEvent } from "@/core/types";

export const POST = handle(async () => {
  if (!hubspotToken()) return json({ error: "HUBSPOT_TOKEN not set on the server" }, 400);
  const repo = await getRepo();
  const state = await repo.state();
  const seeded = await seedHubSpot({ state });
  const link: NewEvent[] = [];
  for (const [entity, hsId] of Object.entries(seeded.ids)) {
    const cur = state.entities[entity]?.attrs.hubspotId;
    if (cur !== undefined && cur !== null && String(cur) === hsId) continue;
    link.push({ actor: HUBSPOT_SYSTEM, op: { type: "field.set", entity, field: "hubspotId", value: hsId, prev: cur ?? null }, reason: `Linked to HubSpot record ${hsId}` });
  }
  if (link.length) await repo.commitToMain(link);
  const imported = await importFromHubSpot(repo, { mode: "full" });
  const { ensureHubSpotSync } = await import("@/integrations/hubspot/boot");
  ensureHubSpotSync(repo);
  return json(
    { ...seeded, linked: link.length, import: imported, ok: seeded.ok && imported.ok },
    seeded.ok ? 200 : 502,
  );
});

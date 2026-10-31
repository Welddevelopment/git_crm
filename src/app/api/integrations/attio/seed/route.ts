export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * POST -> push Mainline's seed world into the Attio workspace behind ATTIO_TOKEN (idempotent: matched by
 * domain / email / deal name), then import so main records each entity's attioId.
 * Returns {ok, workspace, deals, created, updated, unchanged, ids, import, errors}.
 */
import { getRepo } from "@/server/repo";
import { handle, json } from "@/server/http";
import { attioToken, importFromAttio, startAttioSync } from "@/integrations/attio";
import { seedAttio } from "@/integrations/attio/seed";

export const POST = handle(async () => {
  if (!attioToken()) return json({ error: "ATTIO_TOKEN not set on the server" }, 400);
  const repo = await getRepo();
  // Push main as it stands (seeded world + whatever was merged since), so ids line up with live entities.
  const seeded = await seedAttio({ state: await repo.state() });
  const imported = await importFromAttio(repo, { mode: "full" });
  startAttioSync(repo);
  return json({ ...seeded, import: imported, ok: seeded.ok && imported.ok }, seeded.ok ? 200 : 502);
});

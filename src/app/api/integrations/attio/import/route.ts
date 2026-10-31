export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** POST -> pull companies/people/deals from Attio onto main (actor "Attio"), then keep polling every 20s. */
import { getRepo } from "@/server/repo";
import { handle, json } from "@/server/http";
import { attioToken, importFromAttio, startAttioSync } from "@/integrations/attio";

export const POST = handle(async () => {
  if (!attioToken()) return json({ error: "ATTIO_TOKEN not set on the server" }, 400);
  const repo = await getRepo();
  const result = await importFromAttio(repo, { mode: "full" });
  const sync = startAttioSync(repo);
  return json({ ...result, sync }, result.ok ? 200 : 502);
});

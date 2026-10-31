export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** POST -> run a full HubSpot import now (companies, contacts, deals -> main). Body {mode?: "full"|"changes"}. */
import { getRepo } from "@/server/repo";
import { handle, json, readBody } from "@/server/http";
import { hubspotToken, importFromHubSpot } from "@/integrations/hubspot";

export const POST = handle(async (req: Request) => {
  if (!hubspotToken()) return json({ error: "HUBSPOT_TOKEN not set on the server" }, 400);
  const body = await readBody<{ mode?: unknown }>(req);
  const repo = await getRepo();
  const result = await importFromHubSpot(repo, { mode: body.mode === "changes" ? "changes" : "full" });
  const { ensureHubSpotSync } = await import("@/integrations/hubspot/boot");
  ensureHubSpotSync(repo);
  return json(result, result.ok ? 200 : 502);
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** GET -> {connected, portalId, lastSync, counts, sync, lastImport, proxyBase}. Starts the 20s poller if HUBSPOT_TOKEN is set. */
import { getRepo } from "@/server/repo";
import { handle, json } from "@/server/http";
import { hubspotRuntime, hubspotToken, mirroredCounts, portalInfo } from "@/integrations/hubspot";

export const GET = handle(async () => {
  const repo = await getRepo();
  const configured = !!hubspotToken();
  let portalId: number | null = null;
  let uiDomain: string | null = null;
  let error: string | null = null;
  if (configured) {
    try {
      ({ portalId, uiDomain } = await portalInfo());
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  const { ensureHubSpotSync } = await import("@/integrations/hubspot/boot");
  const sync = ensureHubSpotSync(repo);
  const rt = hubspotRuntime();
  const state = await repo.state();
  return json({
    crm: "hubspot",
    configured,
    connected: configured && !error && rt.lastError === undefined,
    portalId,
    uiDomain,
    error: error ?? rt.lastError ?? null,
    lastSync: rt.lastSync ?? null,
    counts: mirroredCounts(state),
    sync,
    lastImport: rt.lastResult ?? null,
    proxyBase: "/api/proxy/hubspot",
  });
});

/**
 * Lazy HubSpot boot hook. Imported (dynamically) by /api/records/lookup, the HubSpot proxy and the
 * /api/integrations/hubspot/* routes so the 20s poller starts on first use without touching src/server/repo.ts.
 * Idempotent and a no-op without HUBSPOT_TOKEN.
 */
import type { Repo } from "../../server/repo";
import { hubspotToken, startHubSpotSync, type SyncStatus } from "./index";

export function ensureHubSpotSync(repo: Pick<Repo, "state" | "commitToMain" | "refreshOpenPRs">): SyncStatus {
  if (!hubspotToken()) return { started: false, reason: "HUBSPOT_TOKEN not set" };
  return startHubSpotSync(repo);
}

/** Convenience for routes: boot the process repo and start syncing. */
export async function bootHubSpot(): Promise<SyncStatus> {
  const { getRepo } = await import("../../server/repo");
  return ensureHubSpotSync(await getRepo());
}

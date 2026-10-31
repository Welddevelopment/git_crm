export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** GET -> {configured, workspace, sync, lastImport, mirrored}. Starts the 20s poller if ATTIO_TOKEN is set. */
import { getRepo } from "@/server/repo";
import { handle, json } from "@/server/http";
import { AttioClient, attioRuntime, attioToken, mirroredCounts, startAttioSync } from "@/integrations/attio";

export const GET = handle(async () => {
  const repo = await getRepo();
  const state = await repo.state();
  const rt = attioRuntime();
  const configured = !!attioToken();
  let workspace: { id: string | null; name: string | null; slug: string | null } | null = null;
  let error: string | null = null;
  if (configured) {
    try {
      const self = await new AttioClient().self();
      workspace = {
        id: (self.workspace_id as string | undefined) ?? null,
        name: (self.workspace_name as string | undefined) ?? null,
        slug: (self.workspace_slug as string | undefined) ?? null,
      };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  const sync = configured ? startAttioSync(repo) : { started: false, reason: "ATTIO_TOKEN not set" };
  return json({
    crm: "attio",
    configured,
    workspace,
    error,
    hasDeals: rt.hasDeals ?? null,
    sync: { ...sync, lastRunAt: rt.lastRunAt ?? null, lastError: rt.lastError ?? null },
    lastImport: rt.lastResult ?? null,
    mirrored: mirroredCounts(state),
    proxyBase: "/api/proxy/attio/v2",
  });
});

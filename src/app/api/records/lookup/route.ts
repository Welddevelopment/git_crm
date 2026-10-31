export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * GET /api/records/lookup?crm=hubspot|attio|mainline&objectType=0-3|deals|deal&id=<external or Mainline id>
 * -> RecordLookup (see src/core/api-contract.ts). CORS-open: called by the Chrome extension side panel.
 */
import { getRepo } from "@/server/repo";
import { errorResponse } from "@/server/http";
import { lookupRecord } from "@/integrations/hubspot/lookup";
import { requestOrigin } from "@/integrations/hubspot/proxy";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

function out(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
}

export async function GET(req: Request): Promise<Response> {
  try {
    const q = new URL(req.url).searchParams;
    const id = (q.get("id") ?? "").trim();
    if (!id) return out({ error: "id is required" }, 400);
    const crm = (q.get("crm") ?? "mainline").trim().toLowerCase();
    if (!["hubspot", "attio", "mainline"].includes(crm)) return out({ error: `unknown crm ${crm} (hubspot | attio | mainline)` }, 400);
    const repo = await getRepo();
    if (crm === "hubspot") void import("@/integrations/hubspot/boot").then((m) => m.ensureHubSpotSync(repo)).catch(() => undefined);
    return out(await lookupRecord(repo, { crm, objectType: q.get("objectType"), id, origin: requestOrigin(req) }));
  } catch (e) {
    const r = errorResponse(e);
    for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
    return r;
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * HubSpot-compatible proxy: point an agent's HubSpot base URL at <mainline>/api/proxy/hubspot.
 *   PATCH /crm/v3/objects/{deals|contacts|companies|0-x}/{id}   update -> Mainline PR (202)
 *   POST  /crm/v3/objects/{type}                                create -> Mainline PR (202)
 *   GET   /crm/v3/objects/{type}[/{id}], POST .../search        read from main
 * Headers: x-mainline-agent (default "external-agent"), x-mainline-reason. Authorization is ignored.
 */
import { getRepo } from "@/server/repo";
import { errorResponse, readBody } from "@/server/http";
import { handleHubSpotProxy, requestOrigin } from "@/integrations/hubspot/proxy";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-mainline-agent, x-mainline-reason",
  "access-control-max-age": "86400",
};

type Ctx = { params: Promise<{ objectType: string; id?: string[] }> };

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
}

async function handler(req: Request, { params }: Ctx): Promise<Response> {
  try {
    const { objectType, id } = await params;
    const body = req.method === "GET" || req.method === "DELETE" ? undefined : await readBody(req);
    const repo = await getRepo();
    void import("@/integrations/hubspot/boot").then((m) => m.ensureHubSpotSync(repo)).catch(() => undefined);
    const r = await handleHubSpotProxy(repo, {
      method: req.method,
      objectType,
      rest: id ?? [],
      body,
      agent: req.headers.get("x-mainline-agent"),
      reason: req.headers.get("x-mainline-reason"),
      origin: requestOrigin(req),
    });
    return withCors(new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } }));
  } catch (e) {
    return withCors(errorResponse(e));
  }
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * Attio-compatible proxy: point an agent's Attio base URL at <mainline>/api/proxy/attio/v2.
 *   POST  /objects/{object}/records            create  -> Git CRM PR (202)
 *   PATCH /objects/{object}/records/{id}       update  -> Git CRM PR (202)
 *   GET   /objects/{object}/records/{id}       read from main
 *   POST  /objects/{object}/records/query      list from main
 * Headers: x-mainline-agent (default "external-agent"), x-mainline-reason. Authorization is ignored.
 */
import { getRepo } from "@/server/repo";
import { errorResponse, readBody } from "@/server/http";
import { handleAttioProxy, requestOrigin } from "@/integrations/attio/proxy";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-mainline-agent, x-mainline-reason",
  "access-control-max-age": "86400",
};

type Ctx = { params: Promise<{ object: string; id?: string[] }> };

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
}

async function handler(req: Request, { params }: Ctx): Promise<Response> {
  try {
    const { object, id } = await params;
    const body = req.method === "GET" ? undefined : await readBody(req);
    const repo = await getRepo();
    const r = await handleAttioProxy(repo, {
      method: req.method,
      object,
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
export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

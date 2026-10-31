export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** GET ?code&state → exchange code, keep tokens in memory, redirect to /?emails=connected. */
import { completeOAuth, publicOrigin } from "@/integrations/email";

export async function GET(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const origin = publicOrigin(req);
  const back = (q: string) => new Response(null, { status: 302, headers: { location: `${origin}/?${q}`, "cache-control": "no-store" } });
  const err = u.searchParams.get("error");
  if (err) return back(`emails=error&reason=${encodeURIComponent(err)}`);
  const code = u.searchParams.get("code");
  if (!code) return back("emails=error&reason=missing_code");
  try {
    await completeOAuth(req, code, u.searchParams.get("state"));
    return back("emails=connected");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[mainline] gmail oauth failed:", msg);
    return back(`emails=error&reason=${encodeURIComponent(msg.slice(0, 160))}`);
  }
}

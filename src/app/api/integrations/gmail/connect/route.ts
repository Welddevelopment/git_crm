export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** GET → 302 to Google's OAuth consent screen (gmail.readonly + email). */
import { handle, json } from "@/server/http";
import { authUrl, gmailConfigured } from "@/integrations/email";

export const GET = handle(async (req: Request) => {
  if (!gmailConfigured()) return json({ error: "Gmail needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server" }, 503);
  return new Response(null, { status: 302, headers: { location: authUrl(req), "cache-control": "no-store" } });
});

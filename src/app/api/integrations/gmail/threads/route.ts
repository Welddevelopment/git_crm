export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** GET ?q= → {threads: [{id, subject, from, snippet, date, messages, match}]} (default q newer_than:30d). */
import { getRepo } from "@/server/repo";
import { handle, json } from "@/server/http";
import { listThreads } from "@/integrations/email";

export const GET = handle(async (req: Request) => {
  const q = new URL(req.url).searchParams.get("q") ?? undefined;
  return json({ threads: await listThreads(await getRepo(), q) });
});

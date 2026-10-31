export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** POST {threadIds} → {imported, prs}. */
import { getRepo } from "@/server/repo";
import { handle, json, readBody } from "@/server/http";
import { importThreads } from "@/integrations/email";

export const POST = handle(async (req: Request) => {
  const b = await readBody<{ threadIds?: unknown }>(req);
  const ids = Array.isArray(b.threadIds) ? b.threadIds.filter((x): x is string => typeof x === "string") : [];
  if (!ids.length) return json({ error: "threadIds required" }, 400);
  const { imported, prs } = await importThreads(await getRepo(), ids);
  return json({ imported, prs });
});

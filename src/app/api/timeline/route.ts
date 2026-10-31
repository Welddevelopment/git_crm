export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { getRepo } from "@/server/repo";
import { handle, json } from "@/server/http";

export const GET = handle(async () => {
  const repo = await getRepo();
  return json({ entries: await repo.timeline() });
});

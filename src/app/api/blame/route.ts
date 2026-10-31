export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { getRepo } from "@/server/repo";
import { handle, json } from "@/server/http";

export const GET = handle(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const entity = q.get("entity");
  const field = q.get("field");
  if (!entity || !field) return json({ error: "entity and field are required" }, 400);
  const repo = await getRepo();
  return json({ history: await repo.blame(entity, field) });
});

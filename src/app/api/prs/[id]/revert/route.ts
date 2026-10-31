export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { getRepo } from "@/server/repo";
import { actorFrom, handle, json, readBody } from "@/server/http";

export const POST = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await readBody<{ by?: string }>(req);
  const repo = await getRepo();
  return json(await repo.revert(id, actorFrom(body.by)));
});

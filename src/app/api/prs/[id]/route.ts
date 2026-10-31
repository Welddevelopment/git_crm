export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { getRepo } from "@/server/repo";
import { handle, json } from "@/server/http";

export const GET = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const repo = await getRepo();
  return json(await repo.prDetail(id));
});

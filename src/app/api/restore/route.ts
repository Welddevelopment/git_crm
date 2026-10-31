export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { getRepo } from "@/server/repo";
import { actorFrom, handle, json, readBody } from "@/server/http";

/** POST {at: epoch ms, by?} -> restore main to that moment as one merged (revertible) PR. */
export const POST = handle(async (req: Request) => {
  const body = await readBody<{ at?: number; by?: string }>(req);
  const repo = await getRepo();
  return json(await repo.restore(Number(body.at), actorFrom(body.by)));
});

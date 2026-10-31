export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { getRepo } from "@/server/repo";
import { handle, json } from "@/server/http";

export const GET = handle(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const atRaw = q.get("at");
  const at = atRaw !== null && atRaw !== "" ? Number(atRaw) : undefined;
  if (at !== undefined && !Number.isFinite(at)) return json({ error: "at must be epoch ms" }, 400);
  const branch = q.get("branch") || undefined;
  const repo = await getRepo();
  return json({ state: await repo.state({ at, branch }) });
});

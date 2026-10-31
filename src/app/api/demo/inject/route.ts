export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { findInjectable, getRepo } from "@/server/repo";
import { handle, json, readBody } from "@/server/http";

export const POST = handle(async (req: Request) => {
  const { docId } = await readBody<{ docId?: string }>(req);
  if (!docId) return json({ error: "docId is required" }, 400);
  const doc = findInjectable(docId);
  if (!doc) return json({ error: `unknown injectable doc ${docId}` }, 404);
  const repo = await getRepo();
  const before = new Map((await repo.listPRs("open")).map((p) => [p.id, p.staleness?.status]));
  await repo.addDocs([{ ...doc, ts: Date.now() }], true);
  const after = await repo.listPRs("open");
  const affectedPRs = after
    .filter((p) => p.staleness?.status === "stale" && before.get(p.id) !== "stale")
    .map((p) => p.id);
  return json({ ok: true, affectedPRs });
});

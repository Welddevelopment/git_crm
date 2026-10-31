export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { getRepo } from "@/server/repo";
import { handle, json } from "@/server/http";
import type { PullRequest } from "@/core/types";

const STATUSES = new Set(["open", "merged", "closed", "reverted"]);

export const GET = handle(async (req: Request) => {
  const s = new URL(req.url).searchParams.get("status");
  if (s && !STATUSES.has(s)) return json({ error: `unknown status ${s}` }, 400);
  const repo = await getRepo();
  return json({ prs: await repo.listPRs((s || undefined) as PullRequest["status"] | undefined) });
});

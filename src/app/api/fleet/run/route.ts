export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { getRepo } from "@/server/repo";
import { runFleet } from "@/server/fleet";
import { handle, json, readBody } from "@/server/http";
import type { AgentId } from "@/core/types";

export const POST = handle(async (req: Request) => {
  const body = await readBody<{ agents?: AgentId[]; mode?: "governed" | "chaos" }>(req);
  const mode = body.mode === "chaos" ? "chaos" : "governed";
  const repo = await getRepo();
  return json(await runFleet(repo, Array.isArray(body.agents) ? body.agents : undefined, mode));
});

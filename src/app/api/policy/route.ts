export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { getRepo } from "@/server/repo";
import { handle, json, readBody } from "@/server/http";
import type { PolicyRule } from "@/core/types";

export const GET = handle(async () => {
  const repo = await getRepo();
  return json({ rules: await repo.rules() });
});

export const PUT = handle(async (req: Request) => {
  const body = await readBody<{ rules?: PolicyRule[] }>(req);
  if (!Array.isArray(body.rules)) return json({ error: "rules must be an array" }, 400);
  const repo = await getRepo();
  return json({ rules: await repo.setRules(body.rules) });
});

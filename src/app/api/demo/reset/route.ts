export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { resetRepo } from "@/server/repo";
import { handle, json } from "@/server/http";

export const POST = handle(async () => {
  await resetRepo();
  return json({ ok: true });
});

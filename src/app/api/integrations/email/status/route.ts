export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { handle, json } from "@/server/http";
import { emailStatus } from "@/integrations/email";

export const GET = handle(async () => json(emailStatus()));

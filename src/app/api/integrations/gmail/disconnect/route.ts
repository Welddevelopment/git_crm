export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { handle, json } from "@/server/http";
import { disconnectGmail, emailStatus } from "@/integrations/email";

export const POST = handle(async () => {
  disconnectGmail();
  return json(emailStatus());
});

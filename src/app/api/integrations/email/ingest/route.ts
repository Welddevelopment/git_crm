export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** POST {from, to?, subject, body, date?} or {raw} → {doc, prs}. Runs the inbox + schema agents on just this email. */
import { getRepo } from "@/server/repo";
import { handle, json, readBody } from "@/server/http";
import { ingestEmail, type EmailInput } from "@/integrations/email";

export const POST = handle(async (req: Request) => {
  const b = await readBody<Record<string, unknown>>(req);
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
  const to = Array.isArray(b.to) ? b.to.filter((x): x is string => typeof x === "string") : s("to");
  const date = typeof b.date === "number" ? b.date : s("date");
  const input: EmailInput = { from: s("from"), to, subject: s("subject"), body: s("body"), date, raw: s("raw") };
  return json(await ingestEmail(await getRepo(), input));
});

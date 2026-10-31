export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** POST {url} → scrape the site with Firecrawl → open ONE webwatch PR (new lead, or update if the domain exists). */
import { getRepo } from "@/server/repo";
import { handle, json, readBody } from "@/server/http";
import { makeLLM } from "@/agents/llm";
import { crawlCompany, hasFirecrawlKey } from "@/agents/webwatch/firecrawl";
import { proposeFromUrl } from "@/agents/webwatch/fromUrl";

/** Accepts "https://x.com", "http://x.com/about", or a bare "x.com" (→ https). Returns null for anything else. */
function normalizeUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw || raw.length > 2048) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".") || u.username || u.password) return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

export const POST = handle(async (req: Request) => {
  const body = await readBody<{ url?: unknown }>(req);
  const url = normalizeUrl(body.url);
  if (!url) return json({ error: "Provide a valid http(s) URL, e.g. https://example.com" }, 400);
  if (!hasFirecrawlKey()) return json({ error: "FIRECRAWL_API_KEY not set on the server" }, 400);

  const docs = await crawlCompany(url);
  if (!docs.length) return json({ error: `Firecrawl could not scrape ${url}` }, 502);

  const repo = await getRepo();
  const state = await repo.state();
  const proposal = await proposeFromUrl(state, docs, url, makeLLM());
  const pr = await repo.propose("webwatch", proposal);
  return json({ pr });
});

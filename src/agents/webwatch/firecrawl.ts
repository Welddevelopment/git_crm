/** OWNER: A4 webwatch. Firecrawl v1 scrape client. Never throws: any failure / missing key → null. */
import type { EvidenceDoc } from "../../core/types";

export const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v1/scrape";
const TIMEOUT_MS = 20_000;
const MAX_BODY = 20_000;
/** Extra pages tried (best effort) by crawlCompany, relative to the site origin. */
export const CRAWL_PATHS = ["/careers", "/pricing", "/about"] as const;

/** EvidenceDoc plus page metadata useful for naming the account. Strip the extras before storing. */
export interface ScrapedPage extends EvidenceDoc {
  siteName?: string;
  description?: string;
}

interface FirecrawlResponse {
  success?: boolean;
  data?: {
    markdown?: string;
    metadata?: {
      title?: string | string[];
      description?: string | string[];
      sourceURL?: string;
      url?: string;
      ogSiteName?: string | string[];
      ogTitle?: string | string[];
      ogDescription?: string | string[];
      statusCode?: number;
    };
  };
}

/** Firecrawl sometimes returns repeated meta tags as arrays. */
const str = (v: string | string[] | undefined): string | undefined => {
  const s = Array.isArray(v) ? v.find((x) => typeof x === "string" && x.trim()) : v;
  return typeof s === "string" && s.trim() ? s.trim().replace(/\s+/g, " ") : undefined;
};

export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

function pathSlug(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  } catch {
    return "";
  }
}

/** Doc id: web_live_<host>_<ts> for the homepage, web_live_<host>_<path>_<ts> for sub-pages. */
export function liveDocId(url: string, ts: number): string {
  const host = hostOf(url) ?? "unknown";
  const p = pathSlug(url);
  return `web_live_${host}${p ? `_${p}` : ""}_${ts}`;
}

function apiKey(): string | undefined {
  const k = typeof process !== "undefined" ? process.env.FIRECRAWL_API_KEY : undefined;
  return k && k.trim() ? k.trim() : undefined;
}

export const hasFirecrawlKey = () => apiKey() !== undefined;

/** Scrape one URL as markdown via Firecrawl. Returns null on missing key, HTTP error, 4xx/5xx page, timeout or empty body. */
export async function scrapeUrl(url: string, opts: { now?: number } = {}): Promise<ScrapedPage | null> {
  const key = apiKey();
  if (!key) return null;
  const host = hostOf(url);
  if (!host) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as FirecrawlResponse;
    if (!json || json.success === false) return null;
    const md = json.data?.markdown;
    if (typeof md !== "string" || !md.trim()) return null;
    const meta = json.data?.metadata ?? {};
    if (typeof meta.statusCode === "number" && meta.statusCode >= 400) return null;
    const ts = opts.now ?? Date.now();
    const doc: ScrapedPage = {
      id: liveDocId(url, ts),
      kind: "web",
      ts,
      title: str(meta.title) ?? str(meta.ogTitle) ?? host,
      url,
      body: md.length > MAX_BODY ? md.slice(0, MAX_BODY) : md,
    };
    const siteName = str(meta.ogSiteName);
    const description = str(meta.description) ?? str(meta.ogDescription);
    if (siteName) doc.siteName = siteName;
    if (description) doc.description = description;
    return doc;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scrape the given URL plus (best effort, in parallel) /careers, /pricing, /about on the same origin.
 * Sub-page failures are ignored; sub-pages that redirect back to the homepage content are dropped.
 * Returns [] when nothing could be scraped.
 */
export async function crawlCompany(url: string, opts: { now?: number } = {}): Promise<ScrapedPage[]> {
  let origin: string;
  let start: string;
  try {
    const u = new URL(url);
    origin = u.origin;
    start = u.href;
  } catch {
    return [];
  }
  const now = opts.now ?? Date.now();
  const startPath = new URL(start).pathname.replace(/\/+$/, "");
  const extra = CRAWL_PATHS.filter((p) => p !== startPath).map((p) => `${origin}${p}`);
  const results = await Promise.all([start, ...extra].map((u) => scrapeUrl(u, { now }).catch(() => null)));
  const out: ScrapedPage[] = [];
  const seen = new Set<string>();
  for (const d of results) {
    if (!d) continue;
    const sig = d.body.trim();
    if (seen.has(sig)) continue; // /pricing → 302 → homepage etc.
    seen.add(sig);
    out.push(d);
  }
  return out;
}

/** Drop the ScrapedPage-only fields so the stored EvidenceDoc matches the contract shape. */
export function toEvidenceDoc(d: EvidenceDoc): EvidenceDoc {
  const { siteName: _s, description: _d, ...doc } = d as ScrapedPage;
  return doc;
}

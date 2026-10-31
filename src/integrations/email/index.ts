/**
 * "Connect your email": paste an email or import Gmail threads → EvidenceDocs in the inbox the agents read,
 * then run the inbox + schema agents (governed) scoped to just those docs. State is in-memory (globalThis).
 */
import type { CRMAgent, EvidenceDoc, PullRequest } from "../../core/types";
import type { Repo } from "../../server/repo";
import { inboxAgent } from "../../agents/inbox";
import { schemaAgent } from "../../agents/schema";
import { runGoverned } from "../../agents/runtime";
import { crmMatch, gmailThreadToDocs, header, makeEmailDoc, normalizeInput, type EmailInput, type GmailThread } from "./parse";

export * from "./parse";

// ---------- in-memory state ----------
export interface GmailTokens { access_token: string; refresh_token?: string; expires_at: number; scope?: string }
interface EmailRuntime {
  gmail?: { tokens: GmailTokens; account: string; connectedAt: number };
  oauthStates: Map<string, number>;
  userDocIds: Set<string>;
  seq: number;
}
type G = typeof globalThis & { __mainlineEmail?: EmailRuntime };
const g = globalThis as G;
export const emailRuntime = (): EmailRuntime => (g.__mainlineEmail ??= { oauthStates: new Map(), userDocIds: new Set(), seq: 0 });

// ---------- agents ----------
/** Same agent id (trust + attribution unchanged) but it only sees the given docs. */
function scoped(agent: CRMAgent, ids: Set<string>): CRMAgent {
  return { ...agent, run: (ctx) => agent.run({ ...ctx, docs: ctx.docs.filter((d) => ids.has(d.id)) }) };
}

export async function ingestDocs(repo: Repo, docs: EvidenceDoc[]): Promise<PullRequest[]> {
  if (!docs.length) return [];
  await repo.addDocs(docs, false);
  const rt = emailRuntime();
  for (const d of docs) rt.userDocIds.add(d.id);
  const ids = new Set(docs.map((d) => d.id));
  const opened = await runGoverned(repo, [scoped(inboxAgent, ids), scoped(schemaAgent, ids)], { staggerMs: 0 });
  return Promise.all(opened.map(async (p) => (await repo.deps.store.getPR(p.id)) ?? p));
}

export async function ingestEmail(repo: Repo, input: EmailInput): Promise<{ doc: EvidenceDoc; prs: PullRequest[] }> {
  const parsed = normalizeInput(input);
  if (!parsed.body.trim()) throw Object.assign(new Error("email body is empty"), { status: 400 });
  const rt = emailRuntime();
  const doc = makeEmailDoc(await repo.state(), parsed, `email_user_${Date.now()}_${++rt.seq}`);
  const prs = await ingestDocs(repo, [doc]);
  return { doc, prs };
}

// ---------- Gmail OAuth ----------
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "email"];
export const gmailConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

/** Public origin of the request (Railway sits behind a proxy, so honour x-forwarded-*). */
export function publicOrigin(req: Request): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const u = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? u.host;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
    ?? (/^(localhost|127\.|0\.0\.0\.0)/.test(host) ? "http" : u.protocol.replace(":", ""));
  return `${proto}://${host.split(",")[0]!.trim()}`;
}
export const redirectUri = (req: Request) => `${publicOrigin(req)}/api/integrations/gmail/callback`;

export function authUrl(req: Request): string {
  const rt = emailRuntime();
  const state = crypto.randomUUID();
  const now = Date.now();
  for (const [k, t] of rt.oauthStates) if (now - t > 15 * 60_000) rt.oauthStates.delete(k);
  rt.oauthStates.set(state, now);
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

type Fetch = typeof fetch;

async function tokenRequest(params: Record<string, string>, f: Fetch): Promise<GmailTokens & { id_token?: string }> {
  const res = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "", ...params }),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof j.access_token !== "string") {
    throw Object.assign(new Error(`Google token exchange failed: ${String(j.error_description ?? j.error ?? res.status)}`), { status: 502 });
  }
  return {
    access_token: j.access_token,
    ...(typeof j.refresh_token === "string" ? { refresh_token: j.refresh_token } : {}),
    expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60_000,
    ...(typeof j.scope === "string" ? { scope: j.scope } : {}),
    ...(typeof j.id_token === "string" ? { id_token: j.id_token } : {}),
  };
}

export async function completeOAuth(req: Request, code: string, state: string | null, f: Fetch = fetch): Promise<string> {
  const rt = emailRuntime();
  if (!state || !rt.oauthStates.has(state)) throw Object.assign(new Error("invalid or expired OAuth state — try Connect Gmail again"), { status: 400 });
  rt.oauthStates.delete(state);
  const tok = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri(req) }, f);
  const { id_token: _idt, ...tokens } = tok;
  let account = "";
  try {
    const prof = await gmailGet<{ emailAddress?: string }>("users/me/profile", tokens.access_token, f);
    account = prof.emailAddress ?? "";
  } catch { /* fall through */ }
  rt.gmail = { tokens, account, connectedAt: Date.now() };
  return account;
}

export function disconnectGmail(): void {
  emailRuntime().gmail = undefined;
}

async function accessToken(f: Fetch): Promise<string> {
  const conn = emailRuntime().gmail;
  if (!conn) throw Object.assign(new Error("Gmail is not connected"), { status: 401 });
  if (Date.now() < conn.tokens.expires_at) return conn.tokens.access_token;
  if (!conn.tokens.refresh_token) throw Object.assign(new Error("Gmail session expired — reconnect"), { status: 401 });
  const fresh = await tokenRequest({ refresh_token: conn.tokens.refresh_token, grant_type: "refresh_token" }, f);
  conn.tokens = { ...fresh, refresh_token: fresh.refresh_token ?? conn.tokens.refresh_token };
  return conn.tokens.access_token;
}

async function gmailGet<T>(path: string, token: string, f: Fetch): Promise<T> {
  const res = await f(`https://gmail.googleapis.com/gmail/v1/${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw Object.assign(new Error(`Gmail API ${res.status}: ${t.slice(0, 200)}`), { status: res.status === 401 ? 401 : 502 });
  }
  return (await res.json()) as T;
}

export interface ThreadSummary {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  date: number;
  messages: number;
  match: { entity: string; label: string } | null;
}

export async function listThreads(repo: Repo, q: string | undefined, f: Fetch = fetch): Promise<ThreadSummary[]> {
  const token = await accessToken(f);
  const query = q && q.trim() ? q.trim() : "newer_than:30d";
  const list = await gmailGet<{ threads?: { id: string; snippet?: string }[] }>(
    `users/me/threads?${new URLSearchParams({ maxResults: "20", q: query })}`, token, f);
  const state = await repo.state();
  const threads = list.threads ?? [];
  const out = await Promise.all(threads.map(async (t): Promise<ThreadSummary | null> => {
    try {
      const full = await gmailGet<GmailThread>(
        `users/me/threads/${encodeURIComponent(t.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, token, f);
      const msgs = full.messages ?? [];
      const first = msgs[0];
      const last = msgs[msgs.length - 1];
      if (!first || !last) return null;
      const from = header(last, "From") || header(first, "From");
      const match = msgs.map((m) => crmMatch(state, header(m, "From"))).find(Boolean) ?? null;
      return {
        id: t.id,
        subject: header(first, "Subject") || "(no subject)",
        from,
        snippet: (last.snippet ?? t.snippet ?? "").slice(0, 200),
        date: Number(last.internalDate) || Date.parse(header(last, "Date")) || 0,
        messages: msgs.length,
        match,
      };
    } catch {
      return null;
    }
  }));
  return out.filter((x): x is ThreadSummary => !!x);
}

export async function importThreads(repo: Repo, threadIds: string[], f: Fetch = fetch): Promise<{ imported: number; docs: EvidenceDoc[]; prs: PullRequest[] }> {
  const token = await accessToken(f);
  const ids = [...new Set(threadIds.filter((x) => typeof x === "string" && x))].slice(0, 50);
  const state = await repo.state();
  const threads = await Promise.all(ids.map((id) => gmailGet<GmailThread>(`users/me/threads/${encodeURIComponent(id)}?format=full`, token, f)));
  const docs = threads.flatMap((t) => gmailThreadToDocs(state, t));
  const prs = await ingestDocs(repo, docs);
  return { imported: docs.length, docs, prs };
}

export function emailStatus() {
  const rt = emailRuntime();
  return {
    gmail: { configured: gmailConfigured(), connected: !!rt.gmail, account: rt.gmail?.account ?? null },
    pasteEnabled: true,
    docs: rt.userDocIds.size,
  };
}

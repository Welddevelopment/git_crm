"use client";
/** OWNER: settings worker. Integrations: live CRM connectors (HubSpot, Attio), coming-soon CRMs, and the any-agent API proxy. */
import { useEffect, useState, type ReactNode } from "react";
import { copyText, errMsg, fmtAgo, http, HttpError, useLive } from "./lib";

type CrmKey = "hubspot" | "attio";

/** Loose union of the Attio status shape and (assumed-equivalent) HubSpot shape. */
interface IntegrationStatus {
  crm?: string;
  configured?: boolean;
  workspace?: { id?: string | number | null; name?: string | null; slug?: string | null } | string | null;
  portal?: { id?: string | number | null; name?: string | null; uiDomain?: string | null } | null;
  portalId?: number | string | null;
  uiDomain?: string | null;
  connected?: boolean;
  counts?: Record<string, number> | null;
  error?: string | null;
  hasDeals?: boolean | null;
  sync?: { started?: boolean; reason?: string; intervalMs?: number; lastRunAt?: number | null; lastError?: string | null; lastSync?: number | null } | null;
  lastImport?: { ok?: boolean; at?: number; events?: number; created?: string[]; linked?: string[]; updated?: unknown[]; errors?: string[] } | null;
  lastSync?: number | null;
  mirrored?: Record<string, number> | null;
  proxyBase?: string;
}

type Load = { kind: "ok"; status: IntegrationStatus } | { kind: "missing" } | { kind: "error"; message: string };

interface CrmMeta {
  key: CrmKey;
  name: string;
  letter: string;
  color: string;
  env: string;
  scopesTitle: string;
  scopes: string[];
  tokenHelp: string;
}

const CRMS: CrmMeta[] = [
  {
    key: "hubspot",
    name: "HubSpot",
    letter: "H",
    color: "var(--series-2)",
    env: "HUBSPOT_TOKEN",
    scopesTitle: "Private app scopes",
    scopes: [
      "crm.objects.companies.read",
      "crm.objects.companies.write",
      "crm.objects.contacts.read",
      "crm.objects.contacts.write",
      "crm.objects.deals.read",
      "crm.objects.deals.write",
    ],
    tokenHelp: "HubSpot → Settings → Integrations → Private apps → Create app → copy the access token.",
  },
  {
    key: "attio",
    name: "Attio",
    letter: "A",
    color: "var(--series-2)",
    env: "ATTIO_TOKEN",
    scopesTitle: "API key scopes",
    scopes: ["Records: Read-write", "Object configuration: Read"],
    tokenHelp: "Attio → Workspace settings → Developers → New access token.",
  },
];

function workspaceLabel(s: IntegrationStatus): string | null {
  if (s.portal && typeof s.portal === "object") {
    const p = s.portal;
    return [p.name, p.id != null ? `portal ${p.id}` : null, p.uiDomain].filter(Boolean).join(" · ") || null;
  }
  if (s.portalId != null) return [`portal ${s.portalId}`, s.uiDomain].filter(Boolean).join(" · ");
  if (typeof s.workspace === "string") return s.workspace;
  if (s.workspace && typeof s.workspace === "object") {
    const w = s.workspace;
    return [w.name, w.slug && w.slug !== w.name ? w.slug : null].filter(Boolean).join(" · ") || (w.id != null ? String(w.id) : null);
  }
  return null;
}

function lastSyncOf(s: IntegrationStatus): number | null {
  return s.sync?.lastRunAt ?? s.sync?.lastSync ?? s.lastSync ?? s.lastImport?.at ?? null;
}

// ---------- result summaries for seed / import ----------
type Rec = Record<string, unknown>;
const arrLen = (v: unknown) => (Array.isArray(v) ? v.length : typeof v === "number" ? v : 0);

function summarize(kind: "seed" | "import", body: unknown): { lines: string[]; errors: string[]; ok: boolean } {
  const b = (body && typeof body === "object" ? body : {}) as Rec;
  const errors = (Array.isArray(b.errors) ? (b.errors as unknown[]).map(String) : []).slice(0, 5);
  const ok = b.ok !== false;
  const lines: string[] = [];
  const importLine = (r: Rec) => {
    const counts = (r.fetched || r.objects) as Rec | undefined;
    const fetched = counts ? Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") : null;
    if (fetched) lines.push(`Fetched ${fetched}`);
    lines.push(`${arrLen(r.created)} created · ${arrLen(r.linked)} linked · ${arrLen(r.updated)} updated on main · ${arrLen(r.events)} events`);
    if (Array.isArray(r.errors)) errors.push(...(r.errors as unknown[]).map(String).slice(0, 3));
  };
  if (kind === "seed") {
    lines.push(`Pushed to CRM: ${arrLen(b.created)} created · ${arrLen(b.updated)} updated · ${arrLen(b.unchanged)} unchanged`);
    if (b.deals === "missing") lines.push("Deals object not enabled in this workspace, so deals were skipped");
    if (b.import && typeof b.import === "object") importLine(b.import as Rec);
  } else {
    importLine(b);
  }
  return { lines, errors: [...new Set(errors)], ok };
}

// ---------- UI atoms ----------
function Spinner() {
  return <span className="st-spin" aria-hidden />;
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState<null | boolean>(null);
  useEffect(() => {
    if (done === null) return;
    const t = setTimeout(() => setDone(null), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button className="st-btn sm ghost" onClick={async () => setDone(await copyText(text))}>
      {done === true ? "Copied" : done === false ? "Copy failed" : label}
    </button>
  );
}

function Snippet({ title, code, right }: { title: ReactNode; code: string; right?: ReactNode }) {
  return (
    <div className="st-snippet">
      <div className="st-snippet-head">
        <span>{title}</span>
        <span className="st-spacer" />
        {right}
        <CopyButton text={code} />
      </div>
      <pre>{code}</pre>
    </div>
  );
}

// ---------- live CRM card ----------
function CrmCard({ meta }: { meta: CrmMeta }) {
  const { data, reload } = useLive<Load>(async () => {
    try {
      return { kind: "ok", status: await http<IntegrationStatus>(`/api/integrations/${meta.key}/status`) };
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return { kind: "missing" };
      return { kind: "error", message: errMsg(e) };
    }
  });
  const [busy, setBusy] = useState<null | "seed" | "import">(null);
  const [result, setResult] = useState<{ kind: "seed" | "import"; ok: boolean; lines: string[]; errors: string[] } | null>(null);

  async function act(kind: "seed" | "import") {
    setBusy(kind);
    setResult(null);
    try {
      const body = await http(`/api/integrations/${meta.key}/${kind}`, { method: "POST", body: "{}" });
      setResult({ kind, ...summarize(kind, body) });
    } catch (e) {
      if (e instanceof HttpError && e.body && typeof e.body === "object" && !("error" in (e.body as Rec) && Object.keys(e.body as Rec).length === 1)) {
        const s = summarize(kind, e.body);
        setResult({ kind, ...s, ok: false, errors: s.errors.length ? s.errors : [e.message] });
      } else {
        setResult({ kind, ok: false, lines: [], errors: [e instanceof HttpError && e.status === 404 ? `${meta.name} connector is not deployed yet` : errMsg(e)] });
      }
    } finally {
      setBusy(null);
      void reload();
    }
  }

  const s = data?.kind === "ok" ? data.status : null;
  const connected = !!s?.configured && !s.error && s.connected !== false;
  const deployed = data?.kind !== "missing";
  const ws = s ? workspaceLabel(s) : null;
  const mirrored = s?.mirrored || s?.counts || null;
  const syncErr = s?.sync?.lastError || null;

  let badge: ReactNode;
  if (!data) badge = <span className="st-badge"><Spinner /> checking</span>;
  else if (data.kind === "missing") badge = <span className="st-badge">not deployed yet</span>;
  else if (data.kind === "error") badge = <span className="st-badge del"><span className="dot" />error</span>;
  else if (!s?.configured) badge = <span className="st-badge warn"><span className="dot" />not connected</span>;
  else if (s.error || s.connected === false) badge = <span className="st-badge del"><span className="dot" />token rejected</span>;
  else badge = <span className="st-badge add"><span className="dot" />connected</span>;

  return (
    <div className="st-card">
      <div className="st-card-head">
        <div className="st-logo" style={{ ["--c" as string]: meta.color }}>{meta.letter}</div>
        <div>
          <div className="st-card-title">{meta.name}</div>
          <div className="st-card-sub">Two-way mirror · agent writes become PRs · merges push back</div>
        </div>
        <span className="st-spacer" />
        {badge}
      </div>
      <div className="st-card-body">
        {data?.kind === "missing" ? (
          <div className="st-muted st-small">
            The {meta.name} connector routes (<span className="st-code-inline">/api/integrations/{meta.key}/*</span>) aren&apos;t deployed on this server yet. This card lights up as soon as they are.
          </div>
        ) : null}
        {data?.kind === "error" ? <div className="st-err">{data.message}</div> : null}

        {s ? (
          <dl className="st-kv">
            <dt>{meta.key === "hubspot" ? "Portal" : "Workspace"}</dt>
            <dd>{ws ? <span className="st-mono">{ws}</span> : <span className="st-muted">—</span>}</dd>
            <dt>Last sync</dt>
            <dd>
              {fmtAgo(lastSyncOf(s))}
              {s.sync?.started && s.sync.intervalMs ? <span className="st-muted"> · polling every {Math.round(s.sync.intervalMs / 1000)}s</span> : null}
            </dd>
            <dt>Mirrored</dt>
            <dd>
              {mirrored ? (
                <div className="st-counts">
                  {Object.entries(mirrored).map(([k, v]) => (
                    <span key={k} className="st-countbox"><b>{v}</b>{k}{v === 1 ? "" : k.endsWith("y") ? "" : "s"}</span>
                  ))}
                </div>
              ) : <span className="st-muted">—</span>}
            </dd>
            {meta.key === "attio" && s.hasDeals === false ? (<><dt>Deals</dt><dd className="st-muted">Deals object not enabled in this workspace</dd></>) : null}
          </dl>
        ) : null}

        {s?.error ? <div className="st-err">{s.error}</div> : null}
        {syncErr && !s?.error ? <div className="st-err">Last sync error: {syncErr}</div> : null}

        {s && !s.configured ? (
          <div className="st-setup">
            Set <code>{meta.env}</code> in your server environment, then restart.
            <div className="st-small st-muted" style={{ marginTop: 4 }}>{meta.tokenHelp}</div>
            <div className="st-small" style={{ marginTop: 8 }}>{meta.scopesTitle}:</div>
            <ul className="st-small">
              {meta.scopes.map((sc) => <li key={sc}><code>{sc}</code></li>)}
            </ul>
          </div>
        ) : null}

        {result ? (
          <div className={`st-result ${result.ok && !result.errors.length ? "good" : result.ok ? "" : "bad"}`}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{result.kind === "seed" ? `Seed into ${meta.name}` : "Import"}: {result.ok ? "done" : "failed"}</div>
            {result.lines.map((l, i) => <div key={i}>{l}</div>)}
            {result.errors.map((l, i) => <div key={`e${i}`} className="st-err">{l}</div>)}
          </div>
        ) : null}
      </div>
      <div className="st-card-foot">
        <button className="st-btn accent" disabled={!!busy || !connected || !deployed} onClick={() => act("seed")} title={connected ? undefined : `Set ${meta.env} first`}>
          {busy === "seed" ? <Spinner /> : null} Seed demo data into {meta.name}
        </button>
        <button className="st-btn" disabled={!!busy || !connected || !deployed} onClick={() => act("import")}>
          {busy === "import" ? <Spinner /> : null} Import now
        </button>
        <span className="st-spacer" />
        {s?.proxyBase ? <span className="st-tiny st-muted st-mono">proxy: {s.proxyBase}</span> : null}
      </div>
    </div>
  );
}

function SoonCard({ name, letter }: { name: string; letter: string }) {
  return (
    <div className="st-card disabled" aria-disabled>
      <div className="st-card-head">
        <div className="st-logo mute">{letter}</div>
        <div>
          <div className="st-card-title">{name}</div>
          <div className="st-card-sub">Same model: mirror, branch, PR, push back on merge</div>
        </div>
        <span className="st-spacer" />
        <span className="st-badge">coming soon</span>
      </div>
      <div className="st-card-foot">
        <button className="st-btn" disabled>Connect</button>
      </div>
    </div>
  );
}

// ---------- API proxy card ----------
interface ProxyMeta { status?: string; pr?: string | null; prUrl?: string | null; tier?: string | null; reasons?: string[] }

function ProxyCard() {
  const [origin, setOrigin] = useState("http://localhost:3000");
  useEffect(() => setOrigin(window.location.origin), []);
  const hub = `curl -X PATCH ${origin}/api/proxy/hubspot/crm/v3/objects/deals/acme-platform \\
  -H 'content-type: application/json' \\
  -H 'x-mainline-agent: my-agent' \\
  -d '{"properties":{"amount":"45000"}}'`;
  const attio = `curl -X PATCH ${origin}/api/proxy/attio/v2/objects/deals/records/acme-platform \\
  -H 'content-type: application/json' \\
  -H 'x-mainline-agent: my-agent' \\
  -d '{"data":{"values":{"value":45000}}}'`;

  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; status: number; meta?: ProxyMeta; text?: string } | null>(null);

  async function tryIt() {
    setBusy(true);
    setRes(null);
    try {
      const r = await fetch("/api/proxy/hubspot/crm/v3/objects/deals/acme-platform", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-mainline-agent": "my-agent", "x-mainline-reason": "Tried from Settings → Any agent (API proxy)" },
        body: JSON.stringify({ properties: { amount: "45000" } }),
        cache: "no-store",
      });
      const text = await r.text();
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { /* not json */ }
      const meta = body && typeof body === "object" && "mainline" in body ? ((body as { mainline: ProxyMeta }).mainline) : undefined;
      const err = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : undefined;
      setRes({ ok: r.ok, status: r.status, meta, text: r.status === 404 && !meta ? "HubSpot proxy is not deployed on this server yet" : err || (meta ? undefined : text.slice(0, 300)) });
    } catch (e) {
      setRes({ ok: false, status: 0, text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  const prHref = res?.meta?.pr ? `/prs/${encodeURIComponent(res.meta.pr)}` : res?.meta?.prUrl || null;
  const statusTone = res?.meta?.status === "auto_merged" ? "add" : res?.meta?.status === "blocked" ? "del" : res?.meta?.status === "no_change" ? "" : "warn";

  return (
    <div className="st-card wide">
      <div className="st-card-head">
        <div className="st-logo" style={{ ["--c" as string]: "var(--blue)" }}>G</div>
        <div>
          <div className="st-card-title">Any agent (API proxy)</div>
          <div className="st-card-sub">HubSpot- and Attio-compatible endpoints. Reads come from main; writes open PRs.</div>
        </div>
        <span className="st-spacer" />
        <span className="st-badge agent"><span className="dot" />always on</span>
      </div>
      <div className="st-card-body">
        <div className="st-tagline">Your agents don&apos;t change. <em>Swap one base URL and every write becomes a reviewable PR.</em></div>
        <div className="st-small st-muted">
          Point the agent&apos;s CRM base URL at <span className="st-code-inline">{origin}/api/proxy/hubspot</span> or <span className="st-code-inline">{origin}/api/proxy/attio/v2</span>.
          Name it with <span className="st-code-inline">x-mainline-agent</span>; add <span className="st-code-inline">x-mainline-reason</span> to explain the change. The CRM&apos;s auth header is ignored.
        </div>
        <Snippet title="HubSpot-compatible" code={hub} />
        <Snippet title="Attio-compatible" code={attio} />
        {res ? (
          <div className={`st-result ${res.ok ? "good" : "bad"}`}>
            {res.meta ? (
              <div className="st-row">
                <span className={`st-badge ${statusTone}`}>{(res.meta.status || "ok").replace(/_/g, " ")}</span>
                {res.meta.tier ? <span className="st-muted">tier: <b>{res.meta.tier}</b></span> : null}
                {prHref ? <a href={prHref} style={{ fontWeight: 600 }}>Open {res.meta.pr} →</a> : null}
                <span className="st-muted st-mono">HTTP {res.status}</span>
              </div>
            ) : (
              <div className="st-row"><span className="st-mono">HTTP {res.status || "—"}</span></div>
            )}
            {res.meta?.reasons?.length ? <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{res.meta.reasons.slice(0, 4).map((r, i) => <li key={i}>{r}</li>)}</ul> : null}
            {res.text ? <div className="st-err" style={{ marginTop: 4 }}>{res.text}</div> : null}
          </div>
        ) : null}
      </div>
      <div className="st-card-foot">
        <button className="st-btn primary" disabled={busy} onClick={tryIt}>
          {busy ? <Spinner /> : "▶"} Try it: send the HubSpot PATCH
        </button>
        <span className="st-small st-muted">Sets <span className="st-mono">deal:acme-platform</span> amount to $45,000 as agent <span className="st-mono">my-agent</span>. A $25k jump, so it lands as a PR for review.</span>
      </div>
    </div>
  );
}

export function Integrations() {
  return (
    <>
      <div className="st-head">
        <div>
          <h1>Integrations</h1>
          <p>Git CRM sits in front of the CRM you already use. It mirrors records onto main, routes agent writes through PRs, and pushes merged changes back.</p>
        </div>
      </div>
      <div className="st-cards">
        {CRMS.map((m) => <CrmCard key={m.key} meta={m} />)}
        <SoonCard name="Salesforce" letter="S" />
        <SoonCard name="Pipedrive" letter="P" />
        <ProxyCard />
      </div>
    </>
  );
}

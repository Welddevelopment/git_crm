/** Lead-owned typed client for the UI. Matches src/core/api-contract.ts. */
import type { ApiRoutes, FleetStatus, PRDetail, TimelineEntry } from "../core/api-contract";
import type { AgentId, CRMState, FieldProvenance, PolicyRule, PullRequest, Event } from "../core/types";

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) }, cache: "no-store" });
  if (!r.ok) throw new Error(`${init?.method || "GET"} ${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
}
const qs = (o: Record<string, unknown>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join("&")}` : "";
};
export const api = {
  state: (q: { at?: number; branch?: string } = {}) => j<{ state: CRMState }>(`/api/state${qs(q)}`),
  timeline: () => j<{ entries: TimelineEntry[] }>(`/api/timeline`),
  blame: (entity: string, field: string) => j<{ history: FieldProvenance[] }>(`/api/blame${qs({ entity, field })}`),
  prs: (status?: PullRequest["status"]) => j<{ prs: PullRequest[] }>(`/api/prs${qs({ status })}`),
  pr: (id: string) => j<PRDetail>(`/api/prs/${id}`),
  merge: (id: string, by: string, resolutions?: Record<string, unknown>) =>
    j<{ pr: PullRequest; events: Event[] }>(`/api/prs/${id}/merge`, { method: "POST", body: JSON.stringify({ by, resolutions }) }),
  close: (id: string, by: string, reason?: string) => j<{ pr: PullRequest }>(`/api/prs/${id}/close`, { method: "POST", body: JSON.stringify({ by, reason }) }),
  revert: (id: string, by: string) => j<{ revertPr: PullRequest; events: Event[] }>(`/api/prs/${id}/revert`, { method: "POST", body: JSON.stringify({ by }) }),
  refresh: (id: string) => j<{ pr: PullRequest }>(`/api/prs/${id}/refresh`, { method: "POST", body: "{}" }),
  fleet: () => j<FleetStatus>(`/api/fleet`),
  runFleet: (agents?: AgentId[], mode: "governed" | "chaos" = "governed") =>
    j<{ prs: PullRequest[]; directEvents: number }>(`/api/fleet/run`, { method: "POST", body: JSON.stringify({ agents, mode }) }),
  policy: () => j<{ rules: PolicyRule[] }>(`/api/policy`),
  setPolicy: (rules: PolicyRule[]) => j<{ rules: PolicyRule[] }>(`/api/policy`, { method: "PUT", body: JSON.stringify({ rules }) }),
  reset: (scenario?: string) => j<{ ok: true }>(`/api/demo/reset`, { method: "POST", body: JSON.stringify({ scenario }) }),
  inject: (docId: string) => j<{ ok: true; affectedPRs: string[] }>(`/api/demo/inject`, { method: "POST", body: JSON.stringify({ docId }) }),
  /** Subscribe to server changes; returns unsubscribe. */
  subscribe(fn: () => void): () => void {
    if (typeof window === "undefined") return () => {};
    const es = new EventSource("/api/stream");
    es.onmessage = () => fn();
    return () => es.close();
  },
};
export type { ApiRoutes };

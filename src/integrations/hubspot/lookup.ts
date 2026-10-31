/**
 * Record lookup for the Chrome extension side panel (GET /api/records/lookup). CRM-agnostic:
 *   crm=mainline  id is a Mainline entity id (or a bare slug, resolved per objectType)
 *   crm=hubspot   objectType 0-1|0-2|0-3|contacts|companies|deals, id = HubSpot record id (attrs.hubspotId)
 *   crm=attio     objectType people|companies|deals, id = Attio record id (attrs.attioId)
 * pendingPRs = open PRs whose branch events touch the entity, resolved through main's merge aliases, so a PR
 * that edits a duplicate which has since been merged into this record still shows up here.
 */
import type { RecordLookup } from "../../core/api-contract";
import type { CRMState, EntityId, Event, FieldProvenance, PullRequest } from "../../core/types";
import { blame } from "../../core/engine/state";
import { resolveAttioRecord } from "../attio";
import { normalizeObject, OBJECT_TYPE, resolveAlias, resolveHubSpotRecord } from "./map";

export interface LookupRepo {
  state(): Promise<CRMState>;
  mainEvents(): Promise<Event[]>;
  listPRs(status?: PullRequest["status"]): Promise<PullRequest[]>;
  deps: { store: { events(branch: string): Promise<Event[]> } };
}

export const HISTORY_PER_FIELD = 5;

/** Entity ids an event touches (raw, unresolved). */
export function touchedIds(e: Event): EntityId[] {
  const op = e.op;
  switch (op.type) {
    case "entity.create":
    case "field.set":
    case "entity.delete":
      return [op.entity];
    case "entity.merge":
      return [op.from, op.into];
    case "evidence.attach":
      return op.doc.entities ?? [];
    default:
      return [];
  }
}

/** Mainline id from a `crm=mainline` id: full id, or slug + objectType. */
function resolveMainline(state: CRMState, objectType: string | null, id: string): EntityId | null {
  const t = normalizeObject(objectType);
  const type = t ? OBJECT_TYPE[t] : objectType?.trim().toLowerCase() || null;
  const candidates = id.includes(":") ? [id] : type ? [`${type}:${id}`] : ["deal", "contact", "company"].map((x) => `${x}:${id}`);
  for (const c of candidates) {
    if (state.entities[c] || state.aliases[c]) return resolveAlias(state, c);
  }
  return null;
}

export function resolveRecord(state: CRMState, crm: string, objectType: string | null, id: string): EntityId | null {
  if (!id) return null;
  if (crm === "hubspot") return resolveHubSpotRecord(state, objectType, id);
  if (crm === "attio") return resolveAttioRecord(state, objectType, id);
  return resolveMainline(state, objectType, id);
}

/** Open PRs touching `entityId` (directly, or via an entity that main has merged into it). Newest first. */
export async function pendingPRsFor(repo: LookupRepo, state: CRMState, entityId: EntityId): Promise<PullRequest[]> {
  const open = await repo.listPRs("open");
  const out: PullRequest[] = [];
  for (const pr of open) {
    let hit = false;
    try {
      const events = await repo.deps.store.events(pr.branch);
      hit = events.some((e) => e.op.type !== "evidence.attach" && touchedIds(e).some((t) => resolveAlias(state, t) === entityId));
    } catch { /* branch missing: fall back to cached changes */ }
    if (!hit) {
      hit = (pr.changes ?? []).some((c) => {
        const ids = "entity" in c ? [c.entity] : "from" in c ? [c.from, c.into] : [];
        return ids.some((t) => resolveAlias(state, t) === entityId);
      });
    }
    if (hit) out.push(pr);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function historyFor(mainEvents: Event[], state: CRMState, entityId: EntityId): Record<string, FieldProvenance[]> {
  const ent = state.entities[entityId];
  if (!ent) return {};
  const fields = new Set([...Object.keys(ent.attrs), ...Object.keys(state.provenance[entityId] ?? {})]);
  const out: Record<string, FieldProvenance[]> = {};
  for (const f of fields) {
    const h = blame(mainEvents, entityId, f);
    if (h.length) out[f] = h.slice(-HISTORY_PER_FIELD).reverse(); // newest first
  }
  return out;
}

export async function lookupRecord(
  repo: LookupRepo,
  q: { crm: string; objectType: string | null; id: string; origin: string },
): Promise<RecordLookup> {
  const crm = (["hubspot", "attio", "mainline"].includes(q.crm) ? q.crm : "mainline") as RecordLookup["crm"];
  const [state, mainEvents] = await Promise.all([repo.state(), repo.mainEvents()]);
  const entityId = resolveRecord(state, crm, q.objectType, q.id);
  const entity = entityId ? state.entities[entityId] ?? null : null;
  if (!entityId || !entity) {
    return { crm, entityId: null, entity: null, displayName: null, pendingPRs: [], history: {}, mainlineUrl: `${q.origin}/crm` };
  }
  const name = entity.attrs.name;
  return {
    crm,
    entityId,
    entity,
    displayName: typeof name === "string" && name ? name : entityId,
    pendingPRs: await pendingPRsFor(repo, state, entityId),
    history: historyFor(mainEvents, state, entityId),
    mainlineUrl: `${q.origin}/crm?entity=${encodeURIComponent(entityId)}`,
  };
}

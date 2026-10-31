/**
 * Push a set of Mainline entities (the seed world, or current main) INTO a HubSpot portal, so the demo has a
 * realistic HubSpot. Idempotent: each record is searched by natural key first (company domain, contact email,
 * deal name); existing records are PATCHed only for properties that differ, missing ones are created with
 * their company association. Shared by scripts/hubspot-seed.ts and POST /api/integrations/hubspot/seed.
 */
import type { CRMState, EntityId, EntityRecord, Event, NewEvent } from "../../core/types";
import { fold } from "../../core/engine/state";
import { seedMainEvents } from "../../seed";
import { HubSpotClient, HubSpotError, type HubSpotObjectRecord } from "./client";
import { ASSOC_TO_COMPANY, TYPE_OBJECT, attrsToProperties, propertiesToAttrs, resolveAlias, sameValue, READ_PROPERTIES, type HubSpotObject } from "./map";
import { markCreated, markEcho } from "./runtime";

export interface HubSpotSeedResult {
  ok: boolean;
  portalId: number | null;
  created: { entity: EntityId; object: HubSpotObject; id: string }[];
  updated: { entity: EntityId; object: HubSpotObject; id: string; properties: string[] }[];
  unchanged: number;
  /** Mainline entity id -> HubSpot record id */
  ids: Record<EntityId, string>;
  errors: string[];
}

/** Mainline's seed world as it stands after the seeded human edits (no network, no repo). */
export function seedWorldState(now = Date.now()): CRMState {
  const events: Event[] = seedMainEvents(now).map((e: NewEvent, i) => ({
    ...e, id: `seed_${i + 1}`, branch: "main", seq: i + 1, ts: e.ts ?? now,
  }));
  return fold(events);
}

const ORDER: Record<string, number> = { company: 0, contact: 1, deal: 2 };
const SEARCH_KEY: Record<string, string> = { company: "domain", contact: "email", deal: "dealname" };

function keyOf(e: EntityRecord): string | undefined {
  const v = e.type === "company" ? e.attrs.domain : e.type === "contact" ? e.attrs.email : e.attrs.name;
  if (typeof v !== "string" || !v.trim()) return undefined;
  return e.type === "deal" ? v.trim() : v.trim().toLowerCase();
}

async function findExisting(client: HubSpotClient, object: HubSpotObject, type: string, key: string): Promise<HubSpotObjectRecord | null> {
  const res = await client.request<{ results?: HubSpotObjectRecord[] }>("POST", `/crm/v3/objects/${object}/search`, {
    filterGroups: [{ filters: [{ propertyName: SEARCH_KEY[type]!, operator: "EQ", value: key }] }],
    properties: READ_PROPERTIES[object],
    limit: 1,
  });
  return res?.results?.[0] ?? null;
}

export async function seedHubSpot(
  opts: { client?: HubSpotClient; state?: CRMState; log?: (msg: string) => void; delayMs?: number } = {},
): Promise<HubSpotSeedResult> {
  const client = opts.client ?? new HubSpotClient();
  const log = opts.log ?? (() => undefined);
  const state = opts.state ?? seedWorldState();
  const delay = opts.delayMs ?? 120; // HubSpot search API: ~5 req/s per portal
  const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());
  const result: HubSpotSeedResult = { ok: true, portalId: null, created: [], updated: [], unchanged: 0, ids: {}, errors: [] };

  try {
    const info = await client.accountInfo();
    result.portalId = typeof info.portalId === "number" ? info.portalId : Number(info.portalId) || null;
  } catch (e) {
    if (e instanceof HubSpotError && e.status === 401) {
      result.ok = false;
      result.errors.push("HubSpot rejected HUBSPOT_TOKEN (401). Use a private-app token with crm.objects.{companies,contacts,deals}.read/write scopes.");
      return result;
    }
    // account-info needs no special scope but may be unavailable on some tokens: carry on
  }

  const entities = Object.values(state.entities)
    .filter((e) => !e.deleted && !e.mergedInto && TYPE_OBJECT[e.type])
    .sort((a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9) || a.id.localeCompare(b.id));

  for (const e of entities) {
    const object = TYPE_OBJECT[e.type]!;
    const key = keyOf(e);
    const properties = attrsToProperties(e.type, e.attrs);
    if (e.type === "deal") properties.pipeline = "default";
    try {
      let existing: HubSpotObjectRecord | null = null;
      const known = e.attrs.hubspotId ? String(e.attrs.hubspotId) : null;
      if (known) {
        try {
          existing = await client.request<HubSpotObjectRecord>("GET", `/crm/v3/objects/${object}/${encodeURIComponent(known)}?properties=${READ_PROPERTIES[object].join(",")}`);
        } catch (err) {
          if (!(err instanceof HubSpotError && err.status === 404)) throw err;
        }
      }
      if (!existing && key) {
        existing = await findExisting(client, object, e.type, key);
        await sleep(delay);
      }
      const companyHs = typeof e.attrs.company === "string" ? result.ids[resolveAlias(state, e.attrs.company)] : undefined;

      if (existing) {
        const hsId = String(existing.id);
        result.ids[e.id] = hsId;
        const have = propertiesToAttrs(e.type, existing.properties ?? {}).attrs;
        const want = propertiesToAttrs(e.type, properties).attrs;
        const diff: Record<string, string> = {};
        const changedFields = Object.keys(want).filter((f) => !sameValue(f, want[f], have[f]));
        if (changedFields.length) {
          const subset: Record<string, unknown> = {};
          for (const f of changedFields) subset[f] = e.attrs[f];
          Object.assign(diff, attrsToProperties(e.type, subset as Record<string, never>));
        }
        if (Object.keys(diff).length) {
          markEcho(object, hsId, propertiesToAttrs(e.type, diff).attrs);
          await client.update(object, hsId, diff);
          result.updated.push({ entity: e.id, object, id: hsId, properties: Object.keys(diff) });
          log(`updated ${object}/${hsId} ${e.id} (${Object.keys(diff).join(", ")})`);
        } else {
          result.unchanged++;
          log(`ok      ${object}/${hsId} ${e.id}`);
        }
        if (companyHs && (object === "contacts" || object === "deals")) {
          try { await client.associateCompany(object, hsId, companyHs); } catch { /* association already exists / not critical */ }
        }
        continue;
      }

      const assocType = ASSOC_TO_COMPANY[e.type];
      const associations = companyHs && assocType
        ? [{ to: { id: companyHs }, types: [{ associationCategory: "HUBSPOT_DEFINED" as const, associationTypeId: assocType }] }]
        : undefined;
      const created = await client.create(object, properties, associations);
      const hsId = String(created.id);
      result.ids[e.id] = hsId;
      markCreated(object, hsId);
      markEcho(object, hsId, propertiesToAttrs(e.type, properties).attrs);
      result.created.push({ entity: e.id, object, id: hsId });
      log(`created ${object}/${hsId} ${e.id}`);
    } catch (err) {
      result.ok = false;
      result.errors.push(`${e.id}: ${err instanceof Error ? err.message : String(err)}`);
      log(`FAILED  ${e.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

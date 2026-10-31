/**
 * HubSpot target adapter. Pushes merged main changes to HubSpot CRM v3, using the same field mapping as the
 * importer and the proxy (src/integrations/hubspot/map.ts), so the round trip is lossless:
 *  - field.set on an entity with `attrs.hubspotId` -> one coalesced PATCH /crm/v3/objects/{type}/{id}
 *    (deal stages are translated to HubSpot's default pipeline ids: negotiation -> contractsent, ...)
 *  - field.set company on a contact/deal -> PUT default association to that company
 *  - entity.create of a company/contact/deal with no hubspotId -> POST /crm/v3/objects/{type} (with its company
 *    association), then record the new id on main (`field.set hubspotId`, actor system:hubspot)
 * Every pushed value is remembered for 60s so the HubSpot poller doesn't re-import it as a human edit.
 * Without HUBSPOT_TOKEN it does nothing and says so.
 */
import type { Actor, CRMState, EntityType, Event, FieldValue, NewEvent, TargetAdapter } from "../core/types";
import {
  ASSOC_TO_COMPANY, TYPE_OBJECT, attrsToProperties, hubspotProperty as mapProperty, propertiesToAttrs, resolveAlias,
  type HubSpotObject,
} from "../integrations/hubspot/map";
import { HubSpotClient } from "../integrations/hubspot/client";
import { markCreated, markEcho } from "../integrations/hubspot/runtime";

/** our field -> HubSpot property (contact.name maps to firstname + lastname). */
export function hubspotProperty(entityType: EntityType, field: string): string | undefined {
  return mapProperty(entityType, field);
}

const HUBSPOT_SYSTEM: Actor = { kind: "system", id: "hubspot" };

export interface HubSpotOptions {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** where to commit `hubspotId` for newly created records (default: the process repo's main) */
  commit?: (events: NewEvent[]) => Promise<unknown>;
}

async function defaultCommit(events: NewEvent[]) {
  const { getRepo } = await import("../server/repo");
  return (await getRepo()).commitToMain(events);
}

const hsIdIn = (attrs: Record<string, FieldValue> | undefined): string | undefined => {
  const v = attrs?.hubspotId;
  return v === undefined || v === null || v === "" ? undefined : String(v);
};

export function createHubSpotAdapter(opts: HubSpotOptions = {}): TargetAdapter {
  return {
    id: "hubspot",
    name: "HubSpot",
    async push(events: Event[], state: CRMState) {
      const token = opts.token ?? process.env.HUBSPOT_TOKEN;
      if (!token) return { ok: true, pushed: 0, errors: ["HUBSPOT_TOKEN not set"] };
      const client = new HubSpotClient({ token, baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });
      const commit = opts.commit ?? defaultCommit;
      const errors: string[] = [];
      let pushed = 0;

      const newIds = new Map<string, string>(); // entity -> HubSpot id created in this push
      const hsIdOf = (id: string): string | undefined => {
        const rid = resolveAlias(state, id);
        return newIds.get(rid) ?? hsIdIn(state.entities[rid]?.attrs);
      };

      // 1) creates (companies first so contacts/deals can associate). Uses current main attrs.
      const toCreate: string[] = [];
      for (const ev of events) {
        if (ev.op.type !== "entity.create") continue;
        const id = resolveAlias(state, ev.op.entity);
        const rec = state.entities[id];
        if (!rec || rec.deleted || rec.mergedInto || !TYPE_OBJECT[rec.type] || hsIdOf(id) || toCreate.includes(id)) continue;
        toCreate.push(id);
      }
      const order: Record<string, number> = { company: 0, contact: 1, deal: 2 };
      toCreate.sort((a, b) => (order[state.entities[a]!.type] ?? 9) - (order[state.entities[b]!.type] ?? 9));
      const createdNow = new Set<string>();
      const idEvents: NewEvent[] = [];
      for (const id of toCreate) {
        const rec = state.entities[id]!;
        const object = TYPE_OBJECT[rec.type]!;
        const properties = attrsToProperties(rec.type, rec.attrs);
        const companyRef = typeof rec.attrs.company === "string" ? hsIdOf(rec.attrs.company) : undefined;
        const assocType = ASSOC_TO_COMPANY[rec.type];
        const associations = companyRef && assocType
          ? [{ to: { id: companyRef }, types: [{ associationCategory: "HUBSPOT_DEFINED" as const, associationTypeId: assocType }] }]
          : undefined;
        try {
          const created = await client.create(object, properties, associations);
          const hsId = String(created.id);
          newIds.set(id, hsId);
          createdNow.add(id);
          markCreated(object, hsId);
          markEcho(object, hsId, { ...propertiesToAttrs(rec.type, properties).attrs, ...(companyRef ? { company: rec.attrs.company } : {}) });
          idEvents.push({ actor: HUBSPOT_SYSTEM, op: { type: "field.set", entity: id, field: "hubspotId", value: hsId, prev: null }, reason: `Created in HubSpot (${object}/${hsId})` });
          pushed += 1;
        } catch (err) {
          errors.push(`create ${object} ${id}: ${(err as Error).message}`);
        }
      }
      if (idEvents.length) {
        try { await commit(idEvents); } catch (err) { errors.push(`record hubspotId: ${(err as Error).message}`); }
      }

      // 2) updates: coalesce one PATCH per HubSpot object with the latest value of each property.
      const batches = new Map<string, { object: HubSpotObject; type: EntityType; hsId: string; attrs: Record<string, FieldValue>; company?: string }>();
      for (const ev of events) {
        if (ev.op.type !== "field.set") continue;
        const entityId = resolveAlias(state, ev.op.entity);
        if (createdNow.has(entityId)) continue; // just created with its current attrs
        const rec = state.entities[entityId];
        if (!rec || rec.deleted) continue;
        const object = TYPE_OBJECT[rec.type];
        if (!object) continue;
        const hsId = hsIdOf(entityId);
        if (!hsId) continue;
        const key = `${object}/${hsId}`;
        const b = batches.get(key) ?? { object, type: rec.type, hsId, attrs: {} };
        if (ev.op.field === "company" && rec.type !== "company") {
          if (typeof ev.op.value === "string") b.company = resolveAlias(state, ev.op.value);
        } else if (mapProperty(rec.type, ev.op.field)) {
          b.attrs[ev.op.field] = ev.op.value;
        } else continue;
        batches.set(key, b);
      }

      for (const b of batches.values()) {
        const properties = attrsToProperties(b.type, b.attrs);
        try {
          if (Object.keys(properties).length) {
            markEcho(b.object, b.hsId, propertiesToAttrs(b.type, properties).attrs);
            await client.update(b.object, b.hsId, properties);
          }
          if (b.company && (b.object === "contacts" || b.object === "deals")) {
            const cid = hsIdOf(b.company);
            if (cid) {
              markEcho(b.object, b.hsId, { company: b.company });
              await client.associateCompany(b.object, b.hsId, cid);
            }
          }
          pushed += 1;
        } catch (err) {
          errors.push(`${b.object}/${b.hsId}: ${(err as Error).message}`);
        }
      }
      return { ok: errors.length === 0, pushed, ...(errors.length ? { errors } : {}) };
    },
  };
}

export const hubspotAdapter: TargetAdapter = createHubSpotAdapter();

/**
 * HubSpot target adapter (stretch). Maps merged `field.set` events on deals/contacts/companies to
 * HubSpot CRM v3 PATCH calls. Our entity -> HubSpot id comes from the entity attr `hubspotId`.
 * Without HUBSPOT_TOKEN it does nothing and says so.
 */
import type { CRMState, EntityType, Event, FieldValue, TargetAdapter } from "../core/types";

const OBJECT_PATH: Record<string, string> = { deal: "deals", contact: "contacts", company: "companies" };

/** our field -> HubSpot property, per entity type */
const PROPERTY_MAP: Record<string, Record<string, string>> = {
  deal: { amount: "amount", stage: "dealstage", closeDate: "closedate", name: "dealname" },
  contact: { name: "firstname", title: "jobtitle", email: "email", phone: "phone" },
  company: { name: "name", employees: "numberofemployees", domain: "domain", industry: "industry" },
};

export function hubspotProperty(entityType: EntityType, field: string): string | undefined {
  return PROPERTY_MAP[entityType]?.[field];
}

function toHubSpotValue(v: FieldValue): string {
  if (v === null) return "";
  if (Array.isArray(v)) return v.join(";");
  return String(v);
}

function resolve(state: CRMState, id: string): string {
  let cur = id;
  for (let i = 0; i < 20 && state.aliases?.[cur]; i++) cur = state.aliases[cur]!;
  return cur;
}

export interface HubSpotOptions {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createHubSpotAdapter(opts: HubSpotOptions = {}): TargetAdapter {
  const baseUrl = opts.baseUrl ?? process.env.HUBSPOT_BASE_URL ?? "https://api.hubapi.com";
  return {
    id: "hubspot",
    name: "HubSpot",
    async push(events: Event[], state: CRMState) {
      const token = opts.token ?? process.env.HUBSPOT_TOKEN;
      if (!token) return { ok: true, pushed: 0, errors: ["HUBSPOT_TOKEN not set"] };
      const doFetch = opts.fetchImpl ?? fetch;

      // Coalesce: one PATCH per HubSpot object with the latest value of each property.
      const batches = new Map<string, { path: string; hsId: string; properties: Record<string, string> }>();
      const errors: string[] = [];
      for (const ev of events) {
        if (ev.op.type !== "field.set") continue;
        const entityId = resolve(state, ev.op.entity);
        const rec = state.entities?.[entityId];
        if (!rec || rec.deleted) continue;
        const objPath = OBJECT_PATH[rec.type];
        if (!objPath) continue;
        const hsId = rec.attrs.hubspotId;
        if (hsId === undefined || hsId === null || hsId === "") continue;
        const prop = hubspotProperty(rec.type, ev.op.field);
        if (!prop) continue;
        const key = `${objPath}/${hsId}`;
        const b = batches.get(key) ?? { path: objPath, hsId: String(hsId), properties: {} };
        b.properties[prop] = toHubSpotValue(ev.op.value);
        batches.set(key, b);
      }

      let pushed = 0;
      for (const b of batches.values()) {
        try {
          const res = await doFetch(`${baseUrl}/crm/v3/objects/${b.path}/${encodeURIComponent(b.hsId)}`, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ properties: b.properties }),
          });
          if (res.ok) pushed += 1;
          else errors.push(`${b.path}/${b.hsId}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
        } catch (err) {
          errors.push(`${b.path}/${b.hsId}: ${(err as Error).message}`);
        }
      }
      return { ok: errors.length === 0, pushed, ...(errors.length ? { errors } : {}) };
    },
  };
}

export const hubspotAdapter: TargetAdapter = createHubSpotAdapter();

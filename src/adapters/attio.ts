/**
 * Attio target adapter. Pushes merged main changes to Attio REST v2:
 *  - field.set on an entity with `attrs.attioId` -> one coalesced PATCH /objects/{object}/records/{id}
 *  - entity.create of a company/contact/deal with no attioId -> find by natural key (domain/email/name) or
 *    POST create, then record the Attio id on main (`field.set attioId`, actor system:attio).
 * Every write is marked as an echo so the Attio poller doesn't re-import it as a human edit.
 * Without ATTIO_TOKEN it does nothing and says so (same contract as the HubSpot adapter).
 */
import type { CRMState, Event, FieldValue, NewEvent, TargetAdapter } from "../core/types";
import {
  AttioClient, AttioError, SLUG_FIELD, TYPE_OBJECT, attioRuntime, markEcho, naturalKeyFilter, ownerResolver,
  resolveAlias, toAttioValues, writeWithOptionFallback, type AttioMember, type AttioObject,
} from "../integrations/attio";

export interface AttioAdapterOptions {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** where to commit `attioId` for newly created records (default: the process repo's main) */
  commit?: (events: NewEvent[]) => Promise<unknown>;
}

const ATTIO_SYSTEM = { kind: "system", id: "attio" } as const;

async function defaultCommit(events: NewEvent[]) {
  const { getRepo } = await import("../server/repo");
  return (await getRepo()).commitToMain(events);
}

export function createAttioAdapter(opts: AttioAdapterOptions = {}): TargetAdapter {
  return {
    id: "attio",
    name: "Attio",
    async push(events: Event[], state: CRMState) {
      const client = new AttioClient({ token: opts.token, baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });
      if (!client.configured) return { ok: true, pushed: 0, errors: ["ATTIO_TOKEN not set"] };
      const commit = opts.commit ?? defaultCommit;
      const errors: string[] = [];
      let pushed = 0;

      const newIds = new Map<string, string>(); // entity -> Attio id created in this push
      const attioIdOf = (id: string): string | undefined => {
        const rid = resolveAlias(state, id);
        if (newIds.has(rid)) return newIds.get(rid);
        const v = state.entities[rid]?.attrs.attioId;
        return v === undefined || v === null || v === "" ? undefined : String(v);
      };
      let members: AttioMember[] | undefined;
      const ctx = async () => ({ attioIdOf, ownerMemberId: ownerResolver((members ??= await client.members())) });

      // 1) creates: entities born in this batch that Attio doesn't know yet (use current main attrs)
      const created = new Set<string>();
      const toCreate: string[] = [];
      for (const ev of events) {
        if (ev.op.type !== "entity.create") continue;
        const id = resolveAlias(state, ev.op.entity);
        const rec = state.entities[id];
        if (!rec || rec.deleted || rec.mergedInto || !TYPE_OBJECT[rec.type] || attioIdOf(id) || toCreate.includes(id)) continue;
        toCreate.push(id);
      }
      // companies first so people/deals can reference them
      const order = { company: 0, contact: 1, deal: 2 } as Record<string, number>;
      toCreate.sort((a, b) => (order[state.entities[a]!.type] ?? 9) - (order[state.entities[b]!.type] ?? 9));
      const linkEvents: NewEvent[] = [];
      for (const id of toCreate) {
        const rec = state.entities[id]!;
        const object = TYPE_OBJECT[rec.type] as AttioObject;
        try {
          if (object === "deals" && attioRuntime().hasDeals === false) continue;
          const values = toAttioValues(rec.type, rec.attrs, await ctx());
          const key = rec.type === "company" ? rec.attrs.domain : rec.type === "contact" ? rec.attrs.email : rec.attrs.name;
          let rid: string | undefined;
          if (typeof key === "string" && key) {
            const found = await client.query(object, { limit: 1, filter: naturalKeyFilter(object, key) });
            rid = found[0]?.id.record_id;
          }
          if (rid) {
            markEcho(rid, [...Object.keys(values).map((s) => SLUG_FIELD[s] ?? s), "__record"]);
            await writeWithOptionFallback(values, (v) => client.update(object, rid!, v));
          } else {
            const r = await writeWithOptionFallback(values, (v) => client.create(object, v));
            rid = r.id.record_id;
            markEcho(rid, [...Object.keys(values).map((s) => SLUG_FIELD[s] ?? s), "__record"]);
          }
          newIds.set(id, rid); // later refs in this batch resolve
          linkEvents.push({ actor: ATTIO_SYSTEM, op: { type: "field.set", entity: id, field: "attioId", value: rid, prev: null }, reason: `Created in Attio (${object})` });
          created.add(id);
          pushed += 1;
        } catch (e) {
          if (object === "deals" && e instanceof AttioError && e.status === 404) {
            attioRuntime().hasDeals = false;
            continue; // workspace has no deals object
          }
          errors.push(`${object} create ${id}: ${(e as Error).message}`);
        }
      }
      if (linkEvents.length) {
        try { await commit(linkEvents); } catch (e) { errors.push(`record attioId: ${(e as Error).message}`); }
      }

      // 2) updates: coalesce latest value per field per record
      const batches = new Map<string, { object: AttioObject; rid: string; type: string; attrs: Record<string, FieldValue> }>();
      for (const ev of events) {
        if (ev.op.type !== "field.set" || ev.op.field === "attioId") continue;
        const id = resolveAlias(state, ev.op.entity);
        if (created.has(id)) continue; // created with current attrs already
        const rec = state.entities[id];
        if (!rec || rec.deleted) continue;
        const object = TYPE_OBJECT[rec.type];
        const rid = attioIdOf(id);
        if (!object || !rid) continue;
        const b = batches.get(rid) ?? { object, rid, type: rec.type, attrs: {} };
        b.attrs[ev.op.field] = ev.op.value;
        batches.set(rid, b);
      }
      for (const b of batches.values()) {
        try {
          const values = toAttioValues(b.type, b.attrs, await ctx());
          if (!Object.keys(values).length) continue;
          markEcho(b.rid, Object.keys(values).map((s) => SLUG_FIELD[s] ?? s));
          await writeWithOptionFallback(values, (v) => client.update(b.object, b.rid, v));
          pushed += 1;
        } catch (e) {
          errors.push(`${b.object}/${b.rid}: ${(e as Error).message}`);
        }
      }
      return { ok: errors.length === 0, pushed, ...(errors.length ? { errors } : {}) };
    },
  };
}

export const attioAdapter: TargetAdapter = createAttioAdapter();

/** The Attio adapter (no-op without ATTIO_TOKEN, like the HubSpot one). Lead: add to getAdapters() when ATTIO_TOKEN is set. */
export function getAttioAdapter(): TargetAdapter {
  return attioAdapter;
}

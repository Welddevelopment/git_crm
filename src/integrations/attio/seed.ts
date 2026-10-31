/**
 * Push a set of Git CRM entities (the seed world, or current main) into an Attio workspace. Idempotent:
 * each record is looked up by natural key first (company domain, person email, deal name); existing records
 * are PATCHed only for fields that differ, missing ones are created. Deals are skipped if the workspace has
 * no deals object. Shared by scripts/attio-seed.ts and POST /api/integrations/attio/seed.
 */
import type { CRMState, EntityId, EntityRecord, Event, NewEvent } from "../../core/types";
import { fold } from "../../core/engine/state";
import { seedMainEvents } from "../../seed";
import { AttioClient, AttioError, naturalKeyFilter, ownerResolver, writeWithOptionFallback } from "./client";
import { SLUG_FIELD, TYPE_OBJECT, mapAttioRecord, resolveAlias, sameValue, toAttioValues, type AttioObject } from "./map";
import { attioRuntime, markEcho } from "./runtime";

export interface AttioSeedResult {
  ok: boolean;
  workspace: string | null;
  deals: "pushed" | "missing";
  created: { entity: EntityId; object: AttioObject; recordId: string }[];
  updated: { entity: EntityId; object: AttioObject; recordId: string; fields: string[] }[];
  unchanged: number;
  /** Git CRM entity id -> Attio record id */
  ids: Record<EntityId, string>;
  errors: string[];
}

/** Git CRM's seed world as it stands after the seeded human edits (no network, no repo). */
export function seedWorldState(now = Date.now()): CRMState {
  const events: Event[] = seedMainEvents(now).map((e: NewEvent, i) => ({
    ...e, id: `seed_${i + 1}`, branch: "main", seq: i + 1, ts: e.ts ?? now,
  }));
  return fold(events);
}

const ORDER: Record<string, number> = { company: 0, contact: 1, deal: 2 };
const keyOf = (e: EntityRecord): string | undefined => {
  const v = e.type === "company" ? e.attrs.domain : e.type === "contact" ? e.attrs.email : e.attrs.name;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

export async function seedAttio(opts: { client?: AttioClient; state?: CRMState; log?: (msg: string) => void } = {}): Promise<AttioSeedResult> {
  const client = opts.client ?? new AttioClient();
  const state = opts.state ?? seedWorldState();
  const log = opts.log ?? (() => {});
  const res: AttioSeedResult = { ok: true, workspace: null, deals: "pushed", created: [], updated: [], unchanged: 0, ids: {}, errors: [] };

  const self = await client.self();
  res.workspace = (self.workspace_name as string | undefined) ?? (self.workspace_slug as string | undefined) ?? null;
  const hasDeals = await client.hasObject("deals");
  attioRuntime().hasDeals = hasDeals;
  if (!hasDeals) res.deals = "missing";
  const members = hasDeals ? await client.members() : [];

  const entities = Object.values(state.entities)
    .filter((e) => !e.deleted && !e.mergedInto && TYPE_OBJECT[e.type] && (hasDeals || e.type !== "deal"))
    .sort((a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9));

  // Prefer ids main already knows.
  for (const e of entities) if (e.attrs.attioId) res.ids[e.id] = String(e.attrs.attioId);
  const ctx = {
    attioIdOf: (id: string) => res.ids[resolveAlias(state, id)],
    ownerMemberId: ownerResolver(members),
  };

  for (const e of entities) {
    const object = TYPE_OBJECT[e.type] as AttioObject;
    const values = toAttioValues(e.type, e.attrs, ctx);
    try {
      let rid = res.ids[e.id];
      let existing = rid ? await client.get(object, rid).catch((err) => (err instanceof AttioError && err.status === 404 ? undefined : Promise.reject(err))) : undefined;
      if (!existing) {
        const key = keyOf(e);
        existing = key ? (await client.query(object, { limit: 1, filter: naturalKeyFilter(object, key) }))[0] : undefined;
      }
      if (!existing) {
        const rec = await writeWithOptionFallback(values, (v) => client.create(object, v));
        rid = rec.id.record_id;
        markEcho(rid, ["__record", ...Object.keys(values).map((s) => SLUG_FIELD[s] ?? s)]);
        res.ids[e.id] = rid;
        res.created.push({ entity: e.id, object, recordId: rid });
        log(`created ${object.padEnd(9)} ${rid}  ${e.id}`);
        continue;
      }
      rid = existing.id.record_id;
      res.ids[e.id] = rid;
      // PATCH only fields that differ (refs compared by Attio record id).
      const m = mapAttioRecord(object, existing);
      const diff: Record<string, unknown> = {};
      for (const [slug, v] of Object.entries(values)) {
        const field = SLUG_FIELD[slug] ?? slug;
        if (field === "company") {
          const want = ctx.attioIdOf(String(e.attrs.company));
          if (want && m.refs.company !== want) diff[slug] = v;
        } else if (field === "owner") {
          continue; // never reassign owners of existing deals
        } else if (!sameValue(m, field, e.attrs[field])) {
          diff[slug] = v;
        }
      }
      if (!Object.keys(diff).length) {
        res.unchanged += 1;
        log(`ok      ${object.padEnd(9)} ${rid}  ${e.id}`);
        continue;
      }
      markEcho(rid, Object.keys(diff).map((s) => SLUG_FIELD[s] ?? s));
      await writeWithOptionFallback(diff, (v) => client.update(object, rid!, v));
      const fields = Object.keys(diff).map((s) => SLUG_FIELD[s] ?? s);
      res.updated.push({ entity: e.id, object, recordId: rid, fields });
      log(`updated ${object.padEnd(9)} ${rid}  ${e.id} (${fields.join(", ")})`);
    } catch (err) {
      res.ok = false;
      res.errors.push(`${object} ${e.id}: ${(err as Error).message}`);
      log(`ERROR   ${object.padEnd(9)} ${e.id}: ${(err as Error).message}`);
    }
  }
  return res;
}

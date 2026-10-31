import { beforeEach, describe, expect, it } from "vitest";
import { AttioClient, AttioError, writeWithOptionFallback } from "./client";
import { resolveStageTitle } from "./schema";
import { seedAttio, seedWorldState } from "./seed";
import { resetAttioRuntime } from "./index";

beforeEach(() => resetAttioRuntime());

type Call = { method: string; path: string; body?: any };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A strict fake of a fresh Attio workspace: deals require stage (custom pipeline) + owner; categories has no options. */
function strictAttio(statuses = ["Prospecting", "Qualified", "Contract Sent", "Closed Won", "Closed Lost"]) {
  const calls: Call[] = [];
  let n = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace(/^\/v2/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (path === "/self") return json(200, { active: true, workspace_name: "Fresh" });
    if (path === "/workspace_members") return json(200, { data: [{ id: { workspace_member_id: "wm_first" }, first_name: "Ada", last_name: "L", email_address: "ada@x.com" }] });
    if (path === "/objects/deals/attributes") {
      return json(200, { data: [
        { api_slug: "name", type: "text", is_required: true, is_writable: true },
        { api_slug: "stage", type: "status", is_required: true, is_writable: true },
        { api_slug: "owner", type: "actor-reference", is_required: true, is_writable: true },
        { api_slug: "value", type: "currency", is_required: false, is_writable: true },
        { api_slug: "close_date", type: "date", is_required: true, is_writable: true },
      ] });
    }
    if (path === "/objects/deals/attributes/stage/statuses") return json(200, { data: statuses.map((title) => ({ title, is_archived: false })) });
    if (/^\/objects\/(companies|people|deals)$/.test(path)) return json(200, { data: {} });
    if (path.endsWith("/records/query")) return json(200, { data: [] });
    const m = path.match(/^\/objects\/(companies|people|deals)\/records$/);
    if (m && method === "POST") {
      const v = body.data.values as Record<string, unknown>;
      if (m[1] === "companies" && "categories" in v) return json(400, { message: `Cannot find select option with title "${(v.categories as string[])[0]}".` });
      if (m[1] === "deals") {
        for (const req of ["stage", "owner", "close_date"]) if (!(req in v)) return json(400, { message: `Required value for attribute with ID "${req}" was not provided.` });
        if (!statuses.includes(v.stage as string)) return json(400, { message: `Cannot find Status with title "${v.stage}".` });
      }
      return json(200, { data: { id: { record_id: `rec_${m[1]}_${++n}` }, values: {} } });
    }
    return json(404, { message: "not found" });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("Attio deal schema", () => {
  it("sends required owner + stage (+ other required attrs) on every deal create", async () => {
    const fake = strictAttio();
    const r = await seedAttio({ client: new AttioClient({ token: "t", fetchImpl: fake.fetchImpl }), state: seedWorldState() });
    expect(r.errors).toEqual([]);
    const creates = fake.calls.filter((c) => c.method === "POST" && c.path === "/objects/deals/records");
    expect(creates.length).toBe(10);
    for (const c of creates) {
      const v = c.body.data.values;
      expect(v.owner).toEqual([{ referenced_actor_type: "workspace-member", referenced_actor_id: "wm_first" }]);
      expect(["Prospecting", "Qualified", "Contract Sent", "Closed Won", "Closed Lost"]).toContain(v.stage);
      expect(v.close_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(fake.calls.filter((c) => c.path === "/objects/deals/attributes")).toHaveLength(1); // schema fetched once
  });

  it("maps our stage to an existing status title", () => {
    const custom = ["Prospecting", "Qualified", "In Progress", "Contract Sent", "Closed Won", "Closed Lost"];
    expect(resolveStageTitle("discovery", custom)).toBe("Prospecting");
    expect(resolveStageTitle("negotiation", custom)).toBe("In Progress");
    expect(resolveStageTitle("closed_won", custom)).toBe("Closed Won");
    expect(resolveStageTitle("closed_lost", custom)).toBe("Closed Lost");
    expect(resolveStageTitle("closed_won", ["Lead", "In Progress", "Won 🎉", "Lost"])).toBe("Won 🎉");
    expect(resolveStageTitle("discovery", ["lead", "Won", "Lost"])).toBe("lead");
    expect(resolveStageTitle("weird", ["A", "B"])).toBe("A");
    expect(resolveStageTitle("proposal", ["A", "B", "C", "Won", "Lost"])).toBe("B");
    expect(resolveStageTitle("demo", [])).toBe("In Progress");
  });

  it("drops unknown categories on 400 and never strips required attributes", async () => {
    const fake = strictAttio();
    const client = new AttioClient({ token: "t", fetchImpl: fake.fetchImpl });
    const rec = await writeWithOptionFallback({ name: "Acme", categories: ["Industrial Robotics"] }, (v) => client.create("companies", v));
    expect(rec.id.record_id).toMatch(/^rec_companies/);
    const posts = fake.calls.filter((c) => c.path === "/objects/companies/records");
    expect(posts.map((c) => c.body.data.values)).toEqual([{ name: "Acme", categories: ["Industrial Robotics"] }, { name: "Acme" }]);

    // PATCH of only an unknown category: skipped instead of failing
    const bad = () => Promise.reject(new AttioError(400, `Attio PATCH: HTTP 400 Cannot find select option with title "X"`));
    await expect(writeWithOptionFallback({ categories: ["X"] }, bad, { skipIfEmpty: true })).resolves.toBeUndefined();

    // a required stage is never stripped
    const seen: Record<string, unknown>[] = [];
    const w = (v: Record<string, unknown>) => { seen.push(v); return Promise.reject(new AttioError(400, "bad status")); };
    await expect(writeWithOptionFallback({ name: "D", stage: "Nope", categories: ["x"] }, w, { protect: ["stage"] })).rejects.toThrow();
    expect(seen[1]).toEqual({ name: "D", stage: "Nope" });
  });
});

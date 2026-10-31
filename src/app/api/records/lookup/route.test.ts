import { describe, expect, it } from "vitest";
import { GET, OPTIONS } from "./route";
import { PATCH, OPTIONS as PROXY_OPTIONS } from "../../proxy/hubspot/crm/v3/objects/[objectType]/[[...id]]/route";

describe("lookup + HubSpot proxy routes (process repo, seeded on boot)", () => {
  it("CORS preflight", async () => {
    expect(OPTIONS().headers.get("access-control-allow-origin")).toBe("*");
    const p = PROXY_OPTIONS();
    expect(p.status).toBe(204);
    expect(p.headers.get("access-control-allow-headers")).toContain("x-mainline-agent");
  });

  it("PATCH via proxy then lookup shows the pending PR", async () => {
    const req = new Request("http://localhost:3000/api/proxy/hubspot/crm/v3/objects/deals/acme-platform", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-mainline-agent": "sdr-bot", "x-mainline-reason": "Priya wants 45 seats", authorization: "Bearer ignored" },
      body: JSON.stringify({ properties: { amount: "45000", dealstage: "contractsent" } }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ objectType: "deals", id: ["acme-platform"] }) });
    expect(res.status).toBe(202);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json();
    expect(body.mainline).toMatchObject({ status: "pending_review", tier: "review" });
    expect(body.mainline.prUrl).toBe(`http://localhost:3000/prs/${body.mainline.pr}`);

    const lk = await GET(new Request("http://localhost:3000/api/records/lookup?crm=mainline&objectType=deal&id=acme-platform"));
    expect(lk.status).toBe(200);
    expect(lk.headers.get("access-control-allow-origin")).toBe("*");
    const j = await lk.json();
    expect(j.entityId).toBe("deal:acme-platform");
    expect(j.pendingPRs.map((p: { id: string }) => p.id)).toContain(body.mainline.pr);

    const bad = await GET(new Request("http://localhost:3000/api/records/lookup?crm=mainline"));
    expect(bad.status).toBe(400);
  });
});

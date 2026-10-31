import { describe, expect, it, vi } from "vitest";
import type { CRMState, Event, PullRequest } from "../core/types";
import { builtinAdapter } from "./builtin";
import { createHubSpotAdapter } from "./hubspot";
import { formatPRMessage, createPhotonNotifier } from "../notify/photon";

const state = {
  schema: {},
  entities: {
    "deal:acme": { id: "deal:acme", type: "deal", attrs: { hubspotId: "123" } },
    "deal:nohs": { id: "deal:nohs", type: "deal", attrs: {} },
  },
  aliases: { "deal:old": "deal:acme" },
  evidence: {},
  provenance: {},
  versions: {},
  headSeq: 3,
} as CRMState;
const mk = (entity: string, field: string, value: number | string, seq: number): Event => ({
  id: `evt_${seq}`, branch: "main", seq, ts: seq, actor: { kind: "system", id: "merge" },
  op: { type: "field.set", entity, field, value },
});

describe("adapters", () => {
  it("builtin is a no-op", async () => {
    expect(await builtinAdapter.push([mk("deal:acme", "amount", 1, 1)], state)).toEqual({ ok: true, pushed: 1 });
  });

  it("hubspot without token reports it", async () => {
    const a = createHubSpotAdapter({ token: "" });
    const prev = process.env.HUBSPOT_TOKEN;
    delete process.env.HUBSPOT_TOKEN;
    expect(await a.push([], state)).toEqual({ ok: true, pushed: 0, errors: ["HUBSPOT_TOKEN not set"] });
    if (prev) process.env.HUBSPOT_TOKEN = prev;
  });

  it("hubspot coalesces PATCHes and maps fields, skipping missing hubspotId", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const a = createHubSpotAdapter({ token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await a.push(
      [mk("deal:acme", "amount", 50000, 1), mk("deal:old", "stage", "negotiation", 2), mk("deal:nohs", "amount", 1, 3)],
      state,
    );
    expect(r).toEqual({ ok: true, pushed: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.hubapi.com/crm/v3/objects/deals/123");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ properties: { amount: "50000", dealstage: "contractsent" } });
  });
});

describe("photon notifier", () => {
  const pr = {
    id: "pr_7", title: "Acme → Negotiation", description: "", branch: "b",
    author: { kind: "agent", id: "inbox", name: "Inbox agent" }, status: "open", createdAt: 1, updatedAt: 1,
    policy: { tier: "review", reasons: ["deal.amount +$25k > $10k"], perEvent: {} },
  } as PullRequest;
  it("formats the message", () => {
    expect(formatPRMessage(pr)).toBe(
      'Git CRM: Inbox agent opened PR #7 "Acme → Negotiation" — deal.amount +$25k > $10k. Reply Y to merge, N to close.',
    );
  });
  it("posts {to, text} when configured, no-op otherwise", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await createPhotonNotifier({ apiKey: "k", to: "+1555", endpoint: "https://x.test/send", fetchImpl: fetchImpl as unknown as typeof fetch }).notify(pr, "");
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).to).toBe("+1555");
    const none = vi.fn();
    const prev = { ...process.env };
    delete process.env.PHOTON_API_KEY;
    await createPhotonNotifier({ fetchImpl: none as unknown as typeof fetch }).notify(pr, "");
    expect(none).not.toHaveBeenCalled();
    process.env = prev;
  });
});

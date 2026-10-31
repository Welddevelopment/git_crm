import { describe, expect, it } from "vitest";
import type { FieldValue, NewEvent } from "../core/types";
import { SEED_SUMMARY, injectableDocs, seedInbox, seedMainEvents, seedWeb } from "./index";

const NOW = Date.parse("2026-10-30T17:00:00-07:00");
const DAY = 86_400_000;
const events = seedMainEvents(NOW);
const inbox = seedInbox(NOW);
const web = seedWeb(NOW);
const inject = injectableDocs(NOW);

/** Tiny local fold (no engine import): final attrs per entity. */
function fold(evs: NewEvent[]) {
  const ents: Record<string, { type: string; attrs: Record<string, FieldValue> }> = {};
  for (const e of evs) {
    if (e.op.type === "entity.create") ents[e.op.entity] = { type: e.op.entityType, attrs: { ...e.op.attrs } };
    if (e.op.type === "field.set") ents[e.op.entity]!.attrs[e.op.field] = e.op.value;
  }
  return ents;
}
const world = fold(events);
const created = new Set(Object.keys(world));

describe("seed world", () => {
  it("contains every STORY.md id with the right facts", () => {
    for (const id of [
      "company:acme", "company:northwind", "company:kestrel", "company:lumen", "company:brightline", "company:orbital",
      "company:tidewater", "company:vantage", "company:quill", "company:harbor",
      "contact:priya-acme", "contact:priya-sharma", "contact:dana-northwind", "contact:alex-chen-kestrel", "contact:alex-chen-lumen",
      "deal:acme-platform", "deal:northwind-fleet",
    ]) expect(created.has(id), id).toBe(true);
    expect(world["deal:acme-platform"]!.attrs).toMatchObject({ amount: 20000, stage: "discovery", closeDate: "2026-12-15", owner: "Joel", company: "company:acme" });
    expect(world["deal:northwind-fleet"]!.attrs).toMatchObject({ amount: 60000, stage: "proposal" });
    expect(world["company:northwind"]!.attrs.employees).toBe(180);
    expect(world["company:acme"]!.attrs.domain).toBe("acmerobotics.com");
    expect(world["contact:priya-acme"]!.attrs).toMatchObject({ name: "Priya Sharma", email: "priya@acmerobotics.com", title: "Engineering Manager" });
    expect(world["contact:priya-sharma"]!.attrs).toMatchObject({ name: "Priya S.", email: "p.sharma@acmerobotics.com", title: "" });
    expect(world["contact:alex-chen-kestrel"]!.attrs).toMatchObject({ name: "Alex Chen", email: "alex.chen@kestrelbank.com", title: "CISO" });
    expect(world["contact:alex-chen-lumen"]!.attrs).toMatchObject({ name: "Alex Chen", email: "achen@lumengrid.io", title: "Founder & CEO" });
  });

  it("has the right shape and ~$600k pipeline", () => {
    const of = (t: string) => Object.values(world).filter((e) => e.type === t);
    expect(of("company")).toHaveLength(10);
    expect(of("contact").length).toBeGreaterThanOrEqual(24);
    expect(of("deal")).toHaveLength(10);
    const pipeline = of("deal").reduce((s, d) => s + Number(d.attrs.amount), 0);
    expect(pipeline).toBe(600_000);
    for (const c of of("company")) expect(["lead", "customer", "churned"]).toContain(c.attrs.stage);
    for (const c of [...of("contact"), ...of("deal")]) expect(created.has(String(c.attrs.company))).toBe(true);
  });

  it("schema comes first, actors are right, timestamps ascending within 14 days", () => {
    const firstCreate = events.findIndex((e) => e.op.type === "entity.create");
    expect(events.slice(0, firstCreate).every((e) => e.op.type === "schema.addField")).toBe(true);
    expect(events.some((e) => e.op.type === "schema.addField" && e.op.entityType === "company" && e.op.field === "signals" && e.op.fieldType === "string[]")).toBe(true);
    for (const e of events) {
      if (e.op.type === "field.set") expect(e.actor.kind).toBe("human");
      else expect(e.actor).toEqual({ kind: "system", id: "seed" });
    }
    const ts = events.map((e) => e.ts!);
    for (let i = 1; i < ts.length; i++) expect(ts[i]!).toBeGreaterThan(ts[i - 1]!);
    expect(ts[0]!).toBeGreaterThanOrEqual(NOW - 14 * DAY);
    expect(ts[ts.length - 1]!).toBeLessThan(NOW);
    expect(events.filter((e) => e.actor.kind === "human").length).toBeGreaterThanOrEqual(8);
  });
});

describe("seed docs", () => {
  const all = [...inbox, ...web, ...inject];
  it("ids, kinds, timestamps and entity refs are valid", () => {
    expect(inbox.length).toBeGreaterThanOrEqual(28);
    expect(new Set(all.map((d) => d.id)).size).toBe(all.length);
    inbox.forEach((d, i) => {
      expect(d.id).toBe(`email_${String(i + 1).padStart(2, "0")}`);
      expect(d.kind).toBe("email");
      expect(d.from && d.to?.length && d.title && d.body).toBeTruthy();
      if (i) expect(d.ts).toBeGreaterThan(inbox[i - 1]!.ts);
      expect(d.ts).toBeGreaterThan(NOW - 14 * DAY);
    });
    for (const d of web) {
      expect(d.kind).toBe("web");
      expect(d.id).toMatch(/^web_[a-z]+_[a-z]+$/);
      expect(d.url).toMatch(/^https:\/\//);
    }
    for (const d of all) {
      expect(d.entities?.length, d.id).toBeGreaterThan(0);
      for (const id of d.entities!) expect(created.has(id), `${d.id} -> ${id}`).toBe(true);
    }
  });

  const find = (re: RegExp) => inbox.filter((d) => re.test(d.body));

  it("plants the Priya MSA email 2 days ago", () => {
    const [m] = find(/send over the MSA/);
    expect(m).toBeDefined();
    expect(m!.from).toBe("priya@acmerobotics.com");
    expect(m!.body).toMatch(/45 seats/);
    expect(m!.body).toMatch(/\$45,000/);
    expect(Math.abs(m!.ts - (NOW - 2 * DAY))).toBeLessThan(DAY / 4);
    expect(m!.entities).toEqual(expect.arrayContaining(["company:acme", "contact:priya-acme", "deal:acme-platform"]));
  });

  it("plants the duplicate-Priya signature", () => {
    const m = inbox.find((d) => d.from === "p.sharma@acmerobotics.com");
    expect(m!.body.endsWith("Priya Sharma — VP Engineering\nAcme Robotics")).toBe(true);
    expect(m!.entities).toContain("contact:priya-sharma");
  });

  it("plants Dana's headcount and Northwind's 220 employees page", () => {
    const [m] = find(/we're now 250 people/);
    expect(m!.entities).toEqual(expect.arrayContaining(["company:northwind", "contact:dana-northwind"]));
    const page = web.find((d) => d.id === "web_northwind_about")!;
    expect(page.body).toMatch(/220 employees/);
    expect(page.entities).toEqual(["company:northwind"]);
  });

  it("has >=3 procurement contacts on different deals", () => {
    const re = /procurement contact, ([A-Z][\w'-]*(?: [A-Z][\w'-]*)*) \(([^\s()@]+@[^\s()]+)\)/;
    const deals = new Set(find(re).map((d) => d.entities!.find((e) => e.startsWith("deal:"))));
    deals.delete(undefined);
    expect(deals.size).toBeGreaterThanOrEqual(3);
  });

  it("has filler cues for other agents, and no stray negative cues", () => {
    expect(find(/send a proposal/)).toHaveLength(1);
    expect(find(/book a demo/)).toHaveLength(1);
    expect(find(/close by November 20/)).toHaveLength(1);
    expect(find(/pausing|on hold|budget freeze|postpone|not moving forward|another vendor|cancel/i)).toHaveLength(0);
    expect(find(/redlines|ready to sign|\bsigned\b/i)).toHaveLength(0);
  });

  it("web signals are planted", () => {
    const acme = web.find((d) => d.id === "web_acme_careers")!;
    expect(acme.url).toBe("https://acmerobotics.com/careers");
    expect(acme.body.match(/Data Engineer/g)).toHaveLength(3);
    expect(web.find((d) => d.id === "web_brightline_pricing")!.body).toMatch(/Enterprise tier/);
    expect(web.length).toBeGreaterThanOrEqual(6);
  });

  it("injectables: Acme pause (now) + harmless Quill", () => {
    const p = inject.find((d) => d.id === "email_inject_acme_pause")!;
    expect(p.title).toBe("Platform rollout — on hold");
    expect(p.ts).toBe(NOW);
    expect(p.body).toMatch(/pausing the platform rollout until Q1/);
    expect(p.body).toMatch(/budget freeze/);
    expect(p.entities).toEqual(["company:acme", "deal:acme-platform", "contact:priya-acme"]);
    const q = inject.find((d) => d.id === "email_inject_quill_hello")!;
    expect(q.body).not.toMatch(/pausing|on hold|budget freeze|postpone|cancel/i);
  });

  it("exports a summary", () => {
    expect(SEED_SUMMARY).toMatch(/\$600k/);
  });

  it("defaults to Date.now()", () => {
    const evs = seedMainEvents();
    expect(evs[evs.length - 1]!.ts!).toBeLessThanOrEqual(Date.now());
    expect(seedInbox()[0]!.ts).toBeGreaterThan(Date.now() - 14 * DAY);
  });
});

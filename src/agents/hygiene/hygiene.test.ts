import { describe, expect, it } from "vitest";
import type { AgentContext, CRMState, EntityRecord, FieldValue } from "../../core/types";
import { hygieneAgent, normalizePhone, normalizeCompanyName } from "./index";

const ent = (id: string, attrs: Record<string, FieldValue>, extra: Partial<EntityRecord> = {}): EntityRecord => ({
  id,
  type: id.split(":")[0],
  attrs,
  ...extra,
});

function mkState(records: EntityRecord[]): CRMState {
  const entities: CRMState["entities"] = {};
  const versions: CRMState["versions"] = {};
  let seq = 0;
  for (const r of records) {
    entities[r.id] = r;
    for (const f of Object.keys(r.attrs)) versions[`${r.id}::${f}`] = ++seq;
  }
  return { schema: {}, entities, aliases: {}, evidence: {}, provenance: {}, versions, headSeq: seq };
}

function storyState(): CRMState {
  return mkState([
    ent("company:acme", { name: "Acme Robotics", domain: "acmerobotics.com", industry: "Robotics", employees: 120, stage: "lead", signals: [] }),
    ent("company:kestrel", { name: "Kestrel Bank", domain: "kestrelbank.com", industry: "Banking", employees: 900, stage: "customer", signals: [] }),
    ent("company:lumen", { name: "Lumen Grid", domain: "lumengrid.io", industry: "Energy", employees: 40, stage: "lead", signals: [] }),
    ent("company:northwind", { name: "Northwind Freight", domain: "northwind.com", industry: "Logistics", employees: 180, stage: "customer", signals: [] }),
    ent("contact:priya-acme", { name: "Priya Sharma", email: "priya@acmerobotics.com", title: "Engineering Manager", company: "company:acme", phone: "+1 (415) 555-0101" }),
    ent("contact:priya-sharma", { name: "Priya S.", email: "p.sharma@acmerobotics.com", title: "", company: "company:acme", phone: "" }),
    ent("contact:alex-chen-kestrel", { name: "Alex Chen", email: "alex.chen@kestrelbank.com", title: "CISO", company: "company:kestrel", phone: "+1 (212) 555-0144" }),
    ent("contact:alex-chen-lumen", { name: "Alex Chen", email: "achen@lumengrid.io", title: "Founder & CEO", company: "company:lumen", phone: "+1 (650) 555-0199" }),
    ent("contact:dana-northwind", { name: "Dana Ortiz", email: "dana@northwind.com", title: "Head of Logistics", company: "company:northwind", phone: "+1 (312) 555-0123" }),
    ent("deal:acme-platform", { name: "Acme — Platform rollout", company: "company:acme", amount: 20000, stage: "discovery", closeDate: "2026-12-15", owner: "Joel", nextStep: "" }),
  ]);
}

function ctx(state: CRMState, llm: AgentContext["llm"] = async () => null): AgentContext {
  return { agent: "hygiene", state, docs: [], llm, now: () => 1_793_404_800_000, log: () => {} };
}

const merges = (ps: Awaited<ReturnType<typeof hygieneAgent.run>>) =>
  ps.flatMap((p) => p.events.map((e) => e.op)).filter((op) => op.type === "entity.merge");

describe("hygiene agent", () => {
  it("has the contract identity", () => {
    expect(hygieneAgent.id).toBe("hygiene");
    expect(hygieneAgent.name).toBe("Hygiene agent");
    expect(hygieneAgent.description).toBe("Deduplicates and normalizes records");
  });

  it("merges Priya S. into priya-acme (more filled fields)", async () => {
    const ps = await hygieneAgent.run(ctx(storyState()));
    const pr = ps.find((p) => p.title === "Merge duplicate contact: Priya S. → Priya Sharma");
    expect(pr).toBeDefined();
    expect(pr!.events).toHaveLength(1);
    const op = pr!.events[0].op;
    expect(op).toMatchObject({ type: "entity.merge", from: "contact:priya-sharma", into: "contact:priya-acme" });
    expect(pr!.events[0].reason).toContain("@acmerobotics.com");
    expect(pr!.events[0].actor).toEqual({ kind: "agent", id: "hygiene", name: "Hygiene agent" });
    expect(pr!.readSet?.["contact:priya-sharma::title"]).toBeDefined();
  });

  it("proposes the (bad) Alex Chen merge with honest weak-evidence reason", async () => {
    const ps = await hygieneAgent.run(ctx(storyState()));
    const pr = ps.find((p) => p.events.some((e) => e.op.type === "entity.merge" && e.op.from === "contact:alex-chen-lumen"));
    expect(pr).toBeDefined();
    expect(pr!.events[0].op).toMatchObject({ into: "contact:alex-chen-kestrel" });
    expect(pr!.events[0].reason).toContain("exact name match: 'Alex Chen'");
    expect(pr!.title).not.toContain("[low confidence]");
  });

  it("emits one proposal per merge", async () => {
    const ps = await hygieneAgent.run(ctx(storyState()));
    const mergePRs = ps.filter((p) => p.events.some((e) => e.op.type === "entity.merge"));
    expect(mergePRs).toHaveLength(2);
    for (const p of mergePRs) expect(p.events).toHaveLength(1);
  });

  it("flags merges Claude disagrees with as low confidence, still proposes", async () => {
    const llm: AgentContext["llm"] = async ({ prompt }) =>
      prompt.includes("Alex Chen") ? "DIFFERENT\nDifferent companies and roles." : "SAME\nSame domain and first name.";
    const ps = await hygieneAgent.run(ctx(storyState(), llm));
    expect(merges(ps)).toHaveLength(2);
    const alex = ps.find((p) => p.title.includes("Alex Chen"))!;
    expect(alex.title.startsWith("[low confidence] ")).toBe(true);
    const priya = ps.find((p) => p.title.includes("Priya"))!;
    expect(priya.title).toBe("Merge duplicate contact: Priya S. → Priya Sharma");
  });

  it("produces no normalization on clean story data", async () => {
    const ps = await hygieneAgent.run(ctx(storyState()));
    expect(ps.filter((p) => p.events.some((e) => e.op.type === "field.set"))).toHaveLength(0);
  });

  it("normalizes only dirty fields in one combined proposal", async () => {
    const s = storyState();
    s.entities["company:orbital"] = ent("company:orbital", { name: "orbital foods, Inc.", domain: "OrbitalFoods.com ", employees: 50 });
    s.entities["company:quill"] = ent("company:quill", { name: "Quill Legal Inc", domain: "quill.law" });
    s.entities["contact:sam-orbital"] = ent("contact:sam-orbital", { name: " Sam Ruiz ", email: "Sam.Ruiz@OrbitalFoods.com", phone: "415.555.0177", company: "company:orbital" });
    const ps = await hygieneAgent.run(ctx(s));
    const norm = ps.filter((p) => p.events.some((e) => e.op.type === "field.set"));
    expect(norm).toHaveLength(1);
    const sets = Object.fromEntries(
      norm[0].events.map((e) => (e.op.type === "field.set" ? [`${e.op.entity}.${e.op.field}`, e.op.value] : ["", ""])),
    );
    expect(sets).toEqual({
      "company:orbital.name": "Orbital Foods",
      "company:orbital.domain": "orbitalfoods.com",
      "company:quill.name": "Quill Legal",
      "contact:sam-orbital.name": "Sam Ruiz",
      "contact:sam-orbital.email": "sam.ruiz@orbitalfoods.com",
      "contact:sam-orbital.phone": "+1 (415) 555-0177",
    });
    for (const e of norm[0].events) if (e.op.type === "field.set") expect(e.op.prev).not.toBe(e.op.value);
  });

  it("is idempotent on a clean, deduped state", async () => {
    const s = storyState();
    s.entities["contact:priya-sharma"] = { ...s.entities["contact:priya-sharma"], mergedInto: "contact:priya-acme" };
    s.entities["contact:alex-chen-lumen"] = { ...s.entities["contact:alex-chen-lumen"], deleted: true };
    s.aliases["contact:priya-sharma"] = "contact:priya-acme";
    expect(await hygieneAgent.run(ctx(s))).toEqual([]);
  });

  it("dedups companies with identical domains", async () => {
    const s = storyState();
    s.entities["company:acme-2"] = ent("company:acme-2", { name: "Acme", domain: "www.AcmeRobotics.com" });
    const ps = await hygieneAgent.run(ctx(s));
    const pr = ps.find((p) => p.title.startsWith("Merge duplicate company"));
    expect(pr!.events[0].op).toMatchObject({ type: "entity.merge", from: "company:acme-2", into: "company:acme" });
  });

  it("does not pair contacts sharing a domain but different first names", async () => {
    const s = storyState();
    s.entities["contact:pete-acme"] = ent("contact:pete-acme", { name: "Pete S.", email: "pete@acmerobotics.com" });
    const ps = await hygieneAgent.run(ctx(s));
    expect(merges(ps).some((m) => m.type === "entity.merge" && m.from === "contact:pete-acme")).toBe(false);
  });

  it("formats helpers", () => {
    expect(normalizePhone("(415) 555-0101")).toBe("+1 (415) 555-0101");
    expect(normalizePhone("1-415-555-0101")).toBe("+1 (415) 555-0101");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+44 20 7946 0958");
    expect(normalizeCompanyName("harbor analytics")).toBe("Harbor Analytics");
    expect(normalizeCompanyName("Vantage Retail, Inc.")).toBe("Vantage Retail");
    expect(normalizeCompanyName("Acme Robotics")).toBe("Acme Robotics");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentContext, CRMState, EntityRecord, EvidenceDoc, FieldValue, Op } from "../../core/types";
import { webwatchAgent, detect } from "./index";

const NOW = Date.parse("2026-10-30T17:00:00-07:00");
const DAY = 86_400_000;

function company(slug: string, attrs: Record<string, FieldValue>): EntityRecord {
  return { id: `company:${slug}`, type: "company", attrs };
}

function makeState(recs: EntityRecord[], aliases: Record<string, string> = {}): CRMState {
  return {
    schema: {},
    entities: Object.fromEntries(recs.map((r) => [r.id, r])),
    aliases,
    evidence: {},
    provenance: {},
    versions: {},
    headSeq: 10,
  };
}

const WORLD = () =>
  makeState([
    company("acme", { name: "Acme Robotics", domain: "acmerobotics.com", industry: "Robotics", employees: 120, stage: "customer", signals: [] }),
    company("brightline", { name: "Brightline Health", domain: "brightlinehealth.com", employees: 400, stage: "lead", signals: ["security:soc2"] }),
    company("northwind", { name: "Northwind Freight", domain: "northwindfreight.com", employees: 180, stage: "customer", signals: [] }),
    company("kestrel", { name: "Kestrel Bank", domain: "kestrelbank.com", employees: 5000, stage: "lead" }),
  ]);

const web = (id: string, entity: string, title: string, url: string, body: string, ts = NOW - DAY): EvidenceDoc => ({
  id,
  kind: "web",
  ts,
  title,
  url,
  body,
  entities: [entity],
});

const ACME_CAREERS = web(
  "web_acme_careers_2026-10-29",
  "company:acme",
  "Careers — Acme Robotics",
  "https://acmerobotics.com/careers",
  `# Join Acme Robotics
We're building the data platform behind autonomous warehouses.

## Open roles
- Senior Data Engineer — Pittsburgh
- Data Engineer, Streaming — Remote
- Staff Data Engineer — Pittsburgh
- Robotics Technician — Austin
`,
);

const BRIGHTLINE_PRICING = web(
  "web_brightline_pricing_2026-10-29",
  "company:brightline",
  "Pricing — Brightline Health",
  "https://brightlinehealth.com/pricing",
  `# Plans for every clinic
## Starter — $49/mo
Up to 5 providers.
## Growth — $199/mo
Up to 50 providers.
## Enterprise
New: custom pricing, SSO, dedicated success manager. SOC 2 Type II certified.
`,
);

const NORTHWIND_ABOUT = web(
  "web_northwind_about_2026-10-29",
  "company:northwind",
  "About — Northwind Freight",
  "https://northwindfreight.com/about",
  `# About Northwind Freight
Founded in 2011 in Columbus, Ohio. Today our team of 220 employees moves freight across 14 states.
We're now serving the Pacific Northwest.`,
);

function ctx(docs: EvidenceDoc[], state = WORLD(), llm: AgentContext["llm"] = async () => null): AgentContext {
  return { agent: "webwatch", state, docs, llm, now: () => NOW, log: () => {} };
}

type FieldSet = Extract<Op, { type: "field.set" }>;
const sets = (events: { op: Op }[]) => events.map((e) => e.op).filter((o): o is FieldSet => o.type === "field.set");

const words = (s: string) => s.trim().split(/\s+/).length;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("webwatch agent", () => {
  it("has the contract identity", () => {
    expect(webwatchAgent.id).toBe("webwatch");
    expect(webwatchAgent.name).toBe("Web watcher");
  });

  it("Acme careers page with 3 Data Engineer roles → +hiring:data-engineering", async () => {
    const props = await webwatchAgent.run(ctx([ACME_CAREERS]));
    expect(props).toHaveLength(1);
    const [p] = props;
    expect(p!.title).toBe("Acme Robotics: +hiring:data-engineering");
    const [s] = sets(p!.events);
    expect(s).toMatchObject({ entity: "company:acme", field: "signals", value: ["hiring:data-engineering"], prev: [] });
    const ev = p!.events[0]!;
    expect(ev.reason).toBe("Careers page lists 3 Data Engineer roles");
    expect(ev.evidence![0]!.docId).toBe(ACME_CAREERS.id);
    expect(ACME_CAREERS.body).toContain(ev.evidence![0]!.quote!);
    expect(words(ev.evidence![0]!.quote!)).toBeLessThan(25);
    expect(ev.actor).toEqual({ kind: "agent", id: "webwatch", name: "Web watcher" });
  });

  it("Brightline pricing page with Enterprise tier → +pricing:enterprise-tier (union with existing, sorted)", async () => {
    const [p, ...rest] = await webwatchAgent.run(ctx([BRIGHTLINE_PRICING]));
    expect(rest).toHaveLength(0);
    expect(p!.title).toBe("Brightline Health: +pricing:enterprise-tier");
    const [s] = sets(p!.events);
    expect(s!.value).toEqual(["pricing:enterprise-tier", "security:soc2"]);
    expect(s!.prev).toEqual(["security:soc2"]);
    // "Up to 50 providers" on a pricing page must NOT be read as headcount
    expect(sets(p!.events).some((e) => e.field === "employees")).toBe(false);
    const q = p!.events[0]!.evidence![0]!.quote!;
    expect(BRIGHTLINE_PRICING.body).toContain(q);
    expect(q).toMatch(/Enterprise/);
  });

  it("Northwind about page '220 employees' → employees 180→220 (collision #3 with inbox) + expansion signal", async () => {
    const [p] = await webwatchAgent.run(ctx([NORTHWIND_ABOUT]));
    const emp = sets(p!.events).find((e) => e.field === "employees");
    expect(emp).toMatchObject({ entity: "company:northwind", value: 220, prev: 180 });
    const empEvent = p!.events.find((e) => e.op.type === "field.set" && e.op.field === "employees")!;
    expect(empEvent.reason).toBe("About page says 220 employees");
    expect(NORTHWIND_ABOUT.body).toContain(empEvent.evidence![0]!.quote!);
    const sig = sets(p!.events).find((e) => e.field === "signals");
    expect(sig!.value).toEqual(["expansion:pacific-northwest"]);
    expect(p!.title).toBe("Northwind Freight: +expansion:pacific-northwest, employees 180→220");
  });

  it("one proposal per company, every event carries evidence", async () => {
    const extra = web("web_acme_about", "company:acme", "About Acme", "https://acmerobotics.com/about", "Acme is SOC 2 Type II compliant.");
    const props = await webwatchAgent.run(ctx([ACME_CAREERS, extra, BRIGHTLINE_PRICING, NORTHWIND_ABOUT]));
    expect(props.map((p) => p.title.split(":")[0])).toEqual(["Acme Robotics", "Brightline Health", "Northwind Freight"]);
    expect(props[0]!.title).toBe("Acme Robotics: +hiring:data-engineering, +security:soc2");
    for (const p of props) for (const e of p.events) {
      expect(e.evidence?.length).toBeGreaterThan(0);
      for (const r of e.evidence!) {
        expect(r.claim).toBeTruthy();
        expect(words(r.quote!)).toBeLessThan(25);
      }
    }
  });

  it("no-op when every detected signal is already present", async () => {
    const state = WORLD();
    state.entities["company:acme"]!.attrs.signals = ["hiring:data-engineering"];
    state.entities["company:brightline"]!.attrs.signals = ["pricing:enterprise-tier", "security:soc2"];
    const props = await webwatchAgent.run(ctx([ACME_CAREERS, BRIGHTLINE_PRICING], state));
    expect(props).toEqual([]);
  });

  it("no-op for non-web docs and for headcount that already matches", async () => {
    const email: EvidenceDoc = { ...ACME_CAREERS, id: "email_1", kind: "email" };
    const state = WORLD();
    state.entities["company:northwind"]!.attrs.employees = 220;
    state.entities["company:northwind"]!.attrs.signals = ["expansion:pacific-northwest"];
    expect(await webwatchAgent.run(ctx([email, NORTHWIND_ABOUT], state))).toEqual([]);
  });

  it("follows merge aliases and falls back to URL domain when entities is missing", async () => {
    const state = WORLD();
    state.aliases["company:acme-old"] = "company:acme";
    const viaAlias = { ...ACME_CAREERS, entities: ["company:acme-old"] };
    const [a] = await webwatchAgent.run(ctx([viaAlias], state));
    expect(sets(a!.events)[0]!.entity).toBe("company:acme");
    const viaUrl = { ...ACME_CAREERS, entities: undefined, url: "https://www.acmerobotics.com/careers" };
    const [b] = await webwatchAgent.run(ctx([viaUrl], state));
    expect(sets(b!.events)[0]!.entity).toBe("company:acme");
  });

  it("makes no network calls without FIRECRAWL_API_KEY", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "");
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const props = await webwatchAgent.run(ctx([])); // no web docs at all, companies have domains
    expect(props).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("live mode: never scrapes seeded domains — only companies with attrs.watchUrl", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const { url } = JSON.parse(String(init!.body)) as { url: string };
      if (url === "https://kestrel.example/") {
        return new Response(JSON.stringify({ success: true, data: { markdown: "# Kestrel Bank\nNow serving customers in Canada. SOC 2 audited.", metadata: { title: "Kestrel Bank", sourceURL: url } } }));
      }
      return new Response("nope", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    // no watchUrl anywhere → zero network calls even with a key
    expect(await webwatchAgent.run(ctx([ACME_CAREERS]))).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    const state = WORLD();
    state.entities["company:kestrel"]!.attrs.watchUrl = "https://kestrel.example/";
    state.entities["company:northwind"]!.attrs.watchUrl = "https://northwind.example/";
    const props = await webwatchAgent.run(ctx([ACME_CAREERS], state));
    const scraped = fetchSpy.mock.calls.map((c) => JSON.parse(String(c[1]!.body)).url).sort();
    expect(scraped).toEqual(["https://kestrel.example/", "https://northwind.example/"]);
    expect(fetchSpy.mock.calls[0]![0]).toBe("https://api.firecrawl.dev/v1/scrape");
    expect((fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe("Bearer fc-test");
    const kestrel = props.find((p) => p.title.startsWith("Kestrel Bank"))!;
    expect(kestrel.title).toBe("Kestrel Bank: +expansion:canada, +security:soc2");
    expect(kestrel.events[0]!.op.type).toBe("evidence.attach");
    expect(props).toHaveLength(2); // acme (seed doc) + kestrel; northwind failure skipped silently
  });

  it("live mode: fetch throwing is swallowed", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    const state = WORLD();
    state.entities["company:acme"]!.attrs.watchUrl = "https://acme.example/";
    await expect(webwatchAgent.run(ctx([], state))).resolves.toEqual([]);
  });

  it("LLM mode prepends a summary; LLM failure falls back silently", async () => {
    const llm = vi.fn(async () => "Acme is staffing up a data team — pitch the pipeline add-on.");
    const [p] = await webwatchAgent.run(ctx([ACME_CAREERS], WORLD(), llm));
    expect(p!.description.startsWith("Acme is staffing up a data team")).toBe(true);
    expect(llm).toHaveBeenCalledOnce();
    const [q] = await webwatchAgent.run(ctx([ACME_CAREERS], WORLD(), async () => { throw new Error("boom"); }));
    expect(q!.description).toMatch(/^Website changes detected/);
  });
});

describe("detectors", () => {
  it("≥2 sales roles → hiring:sales; 1 is not enough", () => {
    const d = (body: string) => web("w", "company:acme", "Careers", "https://acmerobotics.com/careers", body);
    expect(detect(d("- Account Executive, Mid-Market\n- Sales Development Representative")).map((f) => f.kind === "signal" && f.signal)).toContain("hiring:sales");
    expect(detect(d("- Account Executive, Mid-Market"))).toEqual([]);
  });

  it("counts multiple titles per line and '(3 openings)' phrasing; no double count across families", () => {
    const d = (body: string) => web("w", "company:acme", "Careers", "https://acmerobotics.com/careers", body);
    expect(detect(d("Open roles: Data Engineer, Senior Data Engineer, Staff Data Engineer"))[0]).toMatchObject({ claim: "Careers page lists 3 Data Engineer roles" });
    expect(detect(d("- Data Engineer (3 openings)"))[0]).toMatchObject({ signal: "hiring:data-engineering" });
    expect(detect(d("- Data Platform Engineer\n- Data Platform Engineer\n- Data Platform Engineer")).map((f) => f.kind === "signal" && f.signal)).toEqual(["hiring:data-engineering"]);
  });

  it("counts '3 open Data Engineer roles' phrasing", () => {
    const f = detect(web("w", "company:acme", "Careers", "https://acmerobotics.com/careers", "We have 3 open Data Engineer roles."));
    expect(f[0]).toMatchObject({ signal: "hiring:data-engineering", claim: "Careers page lists 3 Data Engineer roles" });
  });

  it("'launched in <region>' → expansion:<region>; ranges are not headcount", () => {
    const f = detect(web("w", "company:x", "Blog", "https://x.com/news", "Today we launched in Germany. Built for teams of 50-200 employees."));
    expect(f.map((x) => (x.kind === "signal" ? x.signal : `emp:${x.value}`))).toEqual(["expansion:germany"]);
  });
});

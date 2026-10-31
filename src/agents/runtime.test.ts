import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext, AgentProposal, CRMAgent, CRMState, EvidenceDoc, NewEvent, PullRequest } from "../core/types";
import type { Repo } from "../server/repo";
import { computeReadSet, isRunning, makeLLM, runChaos, runGoverned } from "./runtime";
import { extractJSON } from "./llm";

// ---------- fixtures (no W6 internals) ----------
function fakeState(versions: Record<string, number> = {}): CRMState {
  return { schema: {}, entities: {}, aliases: {}, evidence: {}, provenance: {}, versions, headSeq: 10 };
}
const docs: EvidenceDoc[] = [{ id: "email_1", kind: "email", ts: 1, title: "hi", body: "hello" }];
const set = (entity: string, field: string, value: string | number): NewEvent => ({
  actor: { kind: "agent", id: "x" },
  op: { type: "field.set", entity, field, value },
});

function fakeRepo(versions: Record<string, number> = {}) {
  const proposed: { agent: string; proposal: AgentProposal }[] = [];
  const mainWrites: NewEvent[] = [];
  let n = 0;
  const repo = {
    deps: { store: { listDocs: vi.fn(async () => docs) } },
    state: vi.fn(async () => fakeState(versions)),
    propose: vi.fn(async (agent: string, proposal: AgentProposal) => {
      proposed.push({ agent, proposal });
      return { id: `pr_${++n}`, title: proposal.title, author: { kind: "agent", id: agent } } as PullRequest;
    }),
    commitToMain: vi.fn(async (events: NewEvent[]) => {
      mainWrites.push(...events);
      return events.map((_, i) => ({ id: `e${mainWrites.length + i}` }));
    }),
    autoMerge: vi.fn(async () => []),
  };
  return { repo: repo as unknown as Repo, raw: repo, proposed, mainWrites };
}

function agent(id: string, run: (ctx: AgentContext) => Promise<AgentProposal[]>): CRMAgent {
  return { id, name: id, description: id, run };
}

const prop = (title: string, events: NewEvent[], readSet?: Record<string, number>): AgentProposal => ({
  title,
  description: title,
  events,
  readSet,
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- tests ----------
describe("runGoverned", () => {
  it("runs agents concurrently", async () => {
    const { repo } = fakeRepo();
    let active = 0;
    let peak = 0;
    const slow = (id: string) =>
      agent(id, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
        return [];
      });
    await runGoverned(repo, [slow("a"), slow("b"), slow("c")], { staggerMs: 0 });
    expect(peak).toBe(3);
  });

  it("gives agents state, docs, now, log, llm and tracks isRunning", async () => {
    const { repo } = fakeRepo({ "deal:x::amount": 4 });
    let seen: AgentContext | undefined;
    let runningDuring = false;
    await runGoverned(
      repo,
      [
        agent("inbox", async (ctx) => {
          seen = ctx;
          runningDuring = isRunning("inbox");
          ctx.log("hello");
          return [];
        }),
      ],
      { staggerMs: 0 },
    );
    expect(seen?.agent).toBe("inbox");
    expect(seen?.state.versions["deal:x::amount"]).toBe(4);
    expect(seen?.docs).toEqual(docs);
    expect(typeof seen?.now()).toBe("number");
    expect(typeof seen?.llm).toBe("function");
    expect(runningDuring).toBe(true);
    expect(isRunning("inbox")).toBe(false);
  });

  it("computes readSet from field.set events when missing, keeps provided readSet", async () => {
    const { repo, proposed } = fakeRepo({ "deal:acme::amount": 7, "deal:acme::stage": 3 });
    await runGoverned(
      repo,
      [
        agent("inbox", async () => [
          prop("acme", [
            set("deal:acme", "amount", 45000),
            set("deal:acme", "stage", "negotiation"),
            set("company:new", "name", "New"),
            { actor: { kind: "agent", id: "inbox" }, op: { type: "entity.merge", from: "contact:a", into: "contact:b" } },
          ]),
          prop("given", [set("deal:acme", "amount", 1)], { "custom::k": 99 }),
        ]),
      ],
      { staggerMs: 0 },
    );
    expect(proposed).toHaveLength(2);
    expect(proposed[0].agent).toBe("inbox");
    expect(proposed[0].proposal.readSet).toEqual({
      "deal:acme::amount": 7,
      "deal:acme::stage": 3,
      "company:new::name": 0,
    });
    expect(proposed[1].proposal.readSet).toEqual({ "custom::k": 99 });
  });

  it("an agent that throws does not kill the others; autoMerge still runs", async () => {
    const { repo, raw, proposed } = fakeRepo();
    const prs = await runGoverned(
      repo,
      [
        agent("bad", async () => {
          throw new Error("boom");
        }),
        agent("good", async () => [prop("ok", [set("company:acme", "employees", 250)])]),
      ],
      { staggerMs: 0 },
    );
    expect(prs.map((p) => p.id)).toEqual(["pr_1"]);
    expect(proposed[0].agent).toBe("good");
    expect(raw.autoMerge).toHaveBeenCalledTimes(1);
    expect(isRunning("bad")).toBe(false);
  });

  it("a failing propose does not drop later proposals", async () => {
    const { repo, raw } = fakeRepo();
    raw.propose.mockRejectedValueOnce(new Error("nope"));
    const prs = await runGoverned(
      repo,
      [agent("a", async () => [prop("1", [set("c:1", "f", 1)]), prop("2", [set("c:2", "f", 2)])])],
      { staggerMs: 0 },
    );
    expect(prs).toHaveLength(1);
    expect(prs[0].title).toBe("2");
  });

  it("staggers proposals within an agent", async () => {
    const { repo } = fakeRepo();
    const t0 = Date.now();
    await runGoverned(
      repo,
      [agent("a", async () => [prop("1", [set("c:1", "f", 1)]), prop("2", [set("c:2", "f", 2)])])],
      { staggerMs: 40 },
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
  });
});

describe("runChaos", () => {
  it("commits every event straight to main, interleaved, never opens PRs", async () => {
    const { repo, raw, mainWrites } = fakeRepo();
    const n = await runChaos(
      repo,
      [
        agent("inbox", async () => [prop("i", [set("company:northwind", "employees", 250), set("deal:a", "amount", 45000)])]),
        agent("webwatch", async () => [prop("w", [set("company:northwind", "employees", 220)])]),
        agent("bad", async () => {
          throw new Error("boom");
        }),
      ],
      { staggerMs: 0 },
    );
    expect(n).toBe(3);
    expect(raw.propose).not.toHaveBeenCalled();
    expect(raw.autoMerge).not.toHaveBeenCalled();
    // round-robin: inbox[0], webwatch[0], inbox[1] → webwatch overwrote inbox's headcount (last write wins)
    const vals = mainWrites.map((e) => (e.op.type === "field.set" ? e.op.value : null));
    expect(vals).toEqual([250, 220, 45000]);
  });
});

describe("computeReadSet", () => {
  it("defaults unseen fields to 0", () => {
    expect(computeReadSet(prop("x", [set("a:1", "f", 1)]), fakeState())).toEqual({ "a:1::f": 0 });
  });
});

describe("makeLLM / extractJSON", () => {
  it("returns null without an API key", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(await makeLLM()({ system: "s", prompt: "p" })).toBeNull();
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("extracts JSON from fences, prose, and arrays", () => {
    expect(extractJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJSON('Sure! Here you go: {"a":{"b":"}"}} hope that helps')).toEqual({ a: { b: "}" } });
    expect(extractJSON("result: [1, 2, 3]")).toEqual([1, 2, 3]);
    expect(extractJSON("no json here")).toBeNull();
    expect(extractJSON(null)).toBeNull();
  });
});

/**
 * OWNER: W7. Sanity-check the agent fleet end to end on a fresh in-memory repo.
 *   npx tsx scripts/run-fleet.ts           # governed: branches + PRs, then autoMerge
 *   npx tsx scripts/run-fleet.ts --chaos   # chaos: everything straight to main
 *   npx tsx scripts/run-fleet.ts inbox hygiene   # only some agents
 */
import { MemoryStore } from "../src/store/memory";
import * as repoModule from "../src/server/repo";
import { Repo } from "../src/server/repo";
import { seedInbox, seedMainEvents, seedWeb } from "../src/seed";
import { AGENTS } from "../src/agents";
import { runChaos, runGoverned } from "../src/agents/runtime";
import type { PullRequest } from "../src/core/types";

async function seed(repo: Repo) {
  // Prefer W6's own seeding helper if it exports one (keeps us identical to getRepo()).
  const helper = (repoModule as Record<string, unknown>)["seedRepo"];
  if (typeof helper === "function") {
    await (helper as (r: Repo) => Promise<void>)(repo);
    return;
  }
  await repo.commitToMain(seedMainEvents());
  await repo.addDocs([...seedInbox(), ...seedWeb()]);
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function row(pr: PullRequest) {
  const conflicts = pr.conflicts ?? [];
  const unresolved = conflicts.filter((c) => !c.autoResolved && !c.resolution).length;
  const st = pr.staleness;
  return {
    id: pr.id,
    author: pr.author.id,
    status: pr.status,
    title: cut(pr.title, 48),
    tier: pr.policy?.tier ?? "-",
    conflicts: conflicts.length
      ? `${conflicts.length} (${conflicts.map((c) => c.kind + (c.autoResolved ? "*" : "")).join(",")})${unresolved ? "" : " ok"}`
      : "0",
    staleness: st ? st.status + (st.contradictions.length ? ` [${st.contradictions.length} contra]` : "") : "-",
  };
}

async function main() {
  const args = process.argv.slice(2);
  const chaos = args.includes("--chaos");
  const only = args.filter((a) => !a.startsWith("--"));
  const agents = only.length ? AGENTS.filter((a) => only.includes(a.id)) : AGENTS;

  const repo = new Repo({ store: new MemoryStore() });
  await seed(repo);
  const before = await repo.state();
  console.log(
    `seeded: ${Object.keys(before.entities).length} entities, headSeq ${before.headSeq}, ` +
      `${(await repo.deps.store.listDocs()).length} docs; agents: ${agents.map((a) => a.id).join(", ")}; ` +
      `LLM: ${process.env.ANTHROPIC_API_KEY ? "on" : "off (deterministic)"}`,
  );

  if (chaos) {
    const n = await runChaos(repo, agents, { staggerMs: 0 });
    const after = await repo.state();
    console.log(`chaos: ${n} events written straight to main (headSeq ${before.headSeq} → ${after.headSeq})`);
    return;
  }

  const opened = await runGoverned(repo, agents, { staggerMs: 0 });
  await repo.refreshOpenPRs().catch(() => []);
  const all = await repo.listPRs();
  const ids = new Set(opened.map((p) => p.id));
  const prs = all.filter((p) => ids.has(p.id)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  console.log(`governed: ${opened.length} PRs opened, ${prs.filter((p) => p.status === "merged").length} auto-merged`);
  console.table(prs.map(row));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

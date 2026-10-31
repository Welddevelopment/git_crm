# Mainline — team contract (read fully before writing code)

**Product:** a layer in front of your CRM. AI agents never write to the CRM directly — they work on branches and open pull requests. Humans (or trusted agents, by policy) merge. Three-way merge, conflicts, revert, time travel, blame, and PRs that detect when their own evidence went stale.

**Pitch line:** "Agents never write to your CRM. They open PRs against it."

**Deadline:** submissions 9:00pm. Must be LIVE on a public URL (not localhost). We record the demo ourselves, but it must be functional.

## Deployment (non-negotiable constraints)
- Target: **Railway, single long-running Node instance** (`next build` + `next start -p $PORT`). NOT serverless.
- State lives in-process (memory store, optional JSON snapshot to `MAINLINE_DATA_DIR`). On boot: if store empty → seed. `/api/demo/reset` reseeds.
- Realtime = Server-Sent Events from `/api/stream`. No websockets, no Convex for the MVP.
- No secrets required to run. `ANTHROPIC_API_KEY` optional: every agent and the staleness judge MUST work deterministically without it.
- Never read the filesystem outside `MAINLINE_DATA_DIR`. Never bind to a hardcoded port.
- Node 22. Next 15 App Router. React 19. TypeScript strict. Tests: vitest. Path alias `@/*` → `src/*`.

## Contract files (lead-owned — DO NOT EDIT)
- `src/core/types.ts` — every domain type.
- `src/core/api-contract.ts` — HTTP routes + response shapes.
- `src/store/store.ts` — Store interface.
- `src/client/api.ts` — typed fetch client for the UI.
- `src/agents/index.ts` — agent registry.
- `src/app/layout.tsx`, `src/app/globals.css` — shell + design tokens.
- Function **signatures** in stub files (`state.ts`, `merge.ts`, `staleness.ts`, `policy.ts`, `repo.ts`, `runtime.ts`, `seed/index.ts`) are contract. Bodies belong to the owner.

Need a contract change? Append it to `CONTRACT_REQUESTS.md` (who, what, why) and keep going with a local extension type in your own folder. The lead integrates.

## Ownership (only write inside your own paths)
| Worker | Owns | Builds |
|---|---|---|
| W1 state engine | `src/core/engine/state.ts`, `state.test.ts` | fold, applyEvent, stateAt, branchState, resolveId, blame, diffStates, versions/provenance |
| W2 merge engine | `src/core/engine/merge.ts`, `merge.test.ts` | threeWayMerge (field / deleted / merged-away auto-rebase / schema conflicts), resolutions, revertEvents |
| W3 staleness | `src/core/staleness.ts`, `staleness.test.ts` | readSet version conflicts + evidence contradictions (heuristic judge + LLM judge) |
| W4 policy & trust | `src/core/policy.ts`, `policy.test.ts` | DEFAULT_RULES, evaluatePolicy, computeTrust (probation → trusted → autonomous) |
| W5 store & integrations | `src/store/memory.ts`, `src/store/file.ts`, `src/adapters/**`, `src/notify/**` | in-memory Store, JSON snapshot persistence, builtin + HubSpot TargetAdapter, console + iMessage(Photon) Notifier |
| W6 repo + API | `src/server/**`, `src/app/api/**` | Repo service, every route in api-contract, SSE stream, singleton + seed-on-boot |
| W7 agent runtime | `src/agents/runtime.ts`, `src/agents/runtime.test.ts`, `scripts/run-fleet.ts` | makeLLM, runGoverned, runChaos, running state |
| W8 seed & scenario | `src/seed/**` | realistic world + scripted collisions that make the demo land |
| W9 PR UI | `src/app/prs/**`, `src/components/pr/**` | PR inbox, PR detail: diff, evidence, conflicts, staleness, policy, merge/close/revert |
| W10 CRM UI | `src/app/page.tsx`, `src/app/crm/**`, `src/app/timeline/**`, `src/app/demo/**`, `src/components/crm/**` | overview, CRM table + blame, time-travel slider, fleet panel, demo console |
| A1 inbox agent | `src/agents/inbox/**` | emails → contacts, deals, stage/amount/close-date changes with evidence |
| A2 hygiene agent | `src/agents/hygiene/**` | dedup (entity.merge), normalization |
| A3 schema agent | `src/agents/schema/**` | notices info with no field → schema.addField + backfill |
| A4 webwatch agent | `src/agents/webwatch/**` | web snapshots → signals on companies |

## Rules of the road
1. **Never block on someone else.** Build against the signatures; write your own small fixtures/mocks inside your folder. Do not import another worker's *implementation* in tests — construct Events by hand.
2. Pure functions in `src/core/**` (no I/O, no Date.now() — take `now` as input where needed).
3. Every core module ships with vitest tests. `npx tsc --noEmit` and your tests must pass before you finish.
4. Don't run `npm install` for new packages without a very good reason; if you must, note it in `CONTRACT_REQUESTS.md`.
5. Keep it demoable: clear names, readable diffs, short reasons. Evidence quotes < 25 words.
6. Finish with a short report: what works, what's stubbed, anything the integrator must know.

## Seed world conventions (W8 defines, everyone may assume)
- Entity ids: `company:<slug>`, `contact:<slug>`, `deal:<slug>`.
- company fields: name, domain, industry, employees, stage(lead|customer|churned), signals(string[])
- contact fields: name, email, title, company (ref EntityId), phone
- deal fields: name, company (ref), amount (number, USD), stage (discovery|demo|proposal|negotiation|closed_won|closed_lost), closeDate (YYYY-MM-DD), owner, nextStep
- Demo "now" = 2026-10-30T17:00:00-07:00. Seed events are timestamped across the previous 14 days.

## The demo we're building toward (90s)
1. Chaos mode: 4 agents write straight to main → forecast silently inflates, bad dedup wrecks contacts, agents overwrite each other.
2. Reset, governed mode: agents fan out on branches, PRs stream in live.
3. A field conflict between inbox + hygiene; a merged-away entity auto-rebased; a $ amount change held for review by policy.
4. Inject the "Acme is pausing" email → the open Acme PR flips to **stale** on its own.
5. Schema agent proposes a new field → merge → existing records backfill.
6. Time-travel slider rewinds main; one-click revert of the bad dedup.

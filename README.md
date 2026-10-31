# Git CRM

**Agents never write to your CRM. They open pull requests against it.**

Git CRM is a version-control layer that sits in front of a CRM. Every AI agent that wants to change customer data (an inbox agent, a dedup agent, an enrichment agent, a schema agent) works on its own **branch** and opens a **pull request**. Git CRM three-way-merges those PRs into `main`, catches conflicts between agents, holds risky changes for a human, flags PRs whose evidence has gone **stale**, and lets you **revert**, **blame** and **time-travel** the whole CRM.

> 🔗 **Live app:** https://gitcrm-production.up.railway.app · **Landing page:** [`/landing`](https://gitcrm-production.up.railway.app/landing)
> Built in one evening at **Night Hack by Founders, Inc.** (Oct 30, 2026). No API keys needed to try it. **[Try it today ↓](#try-it-today)**

---

## The problem

Companies are adding AI agents to their CRM fast: call-notes agents, enrichment tools, AI SDRs, inbox agents, cleanup bots. They all write to the same records, and today that means **last write wins**:

- the enrichment tool silently overwrites a title a rep just corrected,
- one agent bumps a deal from $20k to $45k and the board forecast changes with nobody signing off,
- a dedup bot merges two different people named "Alex Chen", and unpicking it is miserable,
- a change that was right at 9am ("move Acme to Negotiation") gets approved at 4pm, after Acme emailed to say they're pausing.

Existing tools offer an **approve-this-diff queue**: one agent, one proposal at a time, against live data. That doesn't survive many agents working **concurrently**. Git CRM gives a team of agents what a team of engineers already has: branches, merges, review and history.

## What Git CRM does

| | |
|---|---|
| **Branches per agent** | Agents read `main` and write only to their own branch. They can't corrupt the source of truth. |
| **Pull requests with evidence** | Every changed field cites the email, web page or call that justifies it, with a verbatim quote. |
| **Three-way merge** | base = `main` at fork, ours = `main` now, theirs = branch. Field-level conflicts surface like git merge conflicts, and you pick a side. |
| **Semantic rebase** | If an agent edited a contact that another agent has since merged away as a duplicate, the edit rebases onto the surviving record automatically. |
| **Stale-decision detection** | A PR re-checks itself when new evidence lands. *"Move Acme to Negotiation"* flips to **STALE** the moment Acme's "we're pausing" email arrives, and the merge is blocked. |
| **Branch protection for revenue** | 20 default rules, editable in Settings. Enrichment auto-merges; deal amount, stage, close date and identity merges need a human; deletes are blocked. |
| **Agents earn trust** | Each agent has a track record (merged / reverted / stale) and moves from probation → trusted → autonomous. Money, pipeline stage, identity merges and schema always need a human. |
| **Schema is data** | Schema changes live in the same event log, so "add `deal.procurementContact` and backfill 4 deals" is a PR you can review, merge and revert. |
| **Revert, blame, time travel** | Every field has a full history (who, when, why, evidence). Revert any merged PR, auto-merged ones included, with inverse events; a reverted agent drops back to probation. Drag a slider to see the CRM as it was at any point. |
| **Restore to a point in time** | On the time-travel page, pick a moment and click *Restore to this point*. Everything since is undone as one merged PR (fields set back, deleted and merged-away records brought back, newer records removed). History is never rewritten, and reverting that PR undoes the restore. Schema additions are kept. |
| **Triage at agent scale** | Every PR is categorized from its diff (money & stage, merges & deletes, schema, deal updates, new records, data cleanup, enrichment). Filter by category or *Needs you*, group by category or agent, and approve a whole group in one click. Bulk approve skips stale, conflicting and blocked PRs; record merges and schema changes are always one at a time. |
| **Live branch graph** | `main` and every agent branch drawn as a git graph that forks, merges and reverts as PRs stream in. |

## The agents

Four reference agents ship with Git CRM. Each works with no API key using deterministic rules; with `ANTHROPIC_API_KEY` set, Claude fills in what the rules miss. None of them can write to the CRM: they can only open PRs.

| Agent | What it does | Example PR from the demo |
|---|---|---|
| **Inbox** | Reads email threads and keeps contacts, deals and stages current, quoting the email as evidence | Acme: Discovery → Negotiation, $20k → $45k |
| **Hygiene** | Finds duplicate contacts and normalizes names, titles, phones | Merge "Priya S." into "Priya Sharma" |
| **Schema** | Notices information the CRM has no field for and proposes the field with a backfill | Add `deal.procurementContact`, fill 4 deals |
| **Web watcher** | Watches account websites (careers, pricing, about) and turns changes into signals; scrapes real sites via Firecrawl | Northwind headcount 180 → 220 (auto-merges) |

Where users reach them: **Demo console** (`/demo`, run all four in chaos or governed mode), **Records → Watch account by URL** (`/crm`, sends the web watcher to any real website), **Settings → Agents & trust** (level, score, merged and reverted PRs) and **Settings → Branch protection** (what auto-merges). Agents you already run plug in through the [drop-in API proxy](#use-it-with-your-crm); their writes get the same policy, trust, conflict and revert rules.

## Demo (90 seconds)

1. **Chaos mode:** four agents write straight to the CRM. 22 direct writes later, the forecast has quietly gone from $600k to $625k and a bad dedup has merged two different Alex Chens.
2. **Governed mode:** same agents, same data, now on branches. 12 PRs stream in; low-risk web-watcher updates auto-merge.
3. The hygiene agent merges *Priya S.* into *Priya Sharma*, and the inbox agent's open edit to that contact **auto-rebases** onto the survivor.
4. The Acme PR is **held for review**: a stage change plus *$20,000 → $45,000 (+$25,000) exceeds the $10k threshold*.
5. Inject the *"Acme is pausing"* email from the demo console, and the open Acme PR flips to **stale** on its own.
6. Merge, then **one-click revert**, the bad Alex Chen merge. Both contacts come back.
7. The schema agent proposes `deal.procurementContact`; merging it backfills 4 deals.
8. A **conflict** on Northwind headcount (220 from the web watcher vs 250 from the inbox agent): pick a side, merge.
9. **Time travel** `main` back to before chaos mode, then **Restore to this point**: the forecast is back to $600k, and the restore is itself one revertible PR.

## Pages

| Route | What's there |
|---|---|
| [`/`](https://gitcrm-production.up.railway.app/) | Overview: the pitch, live branch graph, agent fleet |
| [`/landing`](https://gitcrm-production.up.railway.app/landing) | Marketing landing page |
| [`/prs`](https://gitcrm-production.up.railway.app/prs) | PR inbox with category filters, *Needs you*, group by category/agent and bulk approve; each PR shows the diff, evidence, conflicts, staleness and policy, with merge / close / revert |
| [`/crm`](https://gitcrm-production.up.railway.app/crm) | The CRM as it is on `main`, with per-field blame |
| [`/timeline`](https://gitcrm-production.up.railway.app/timeline) | Time-travel slider over the event log, with *Restore to this point* |
| [`/demo`](https://gitcrm-production.up.railway.app/demo) | Demo console: run chaos / governed fleets, inject documents, reset |
| [`/settings`](https://gitcrm-production.up.railway.app/settings) | Integrations (HubSpot, Attio, API proxy), editable branch protection, agents and trust |
| [`/extension`](https://gitcrm-production.up.railway.app/extension) | Chrome extension install guide |

## How it works

```mermaid
flowchart LR
  subgraph World
    E[Inbox emails]
    W[Websites]
  end
  subgraph Agents
    A1[Inbox agent]
    A2[Hygiene agent]
    A3[Schema agent]
    A4[Web watcher]
  end
  E --> A1 & A3
  W --> A4
  A1 & A2 & A3 & A4 -->|branch + PR| M{Merge engine}
  M -->|policy, trust,<br/>conflicts, staleness| R[Human review]
  R -->|merge| MAIN[(main event log)]
  M -->|auto tier| MAIN
  MAIN -->|adapter| CRM[Built-in CRM / HubSpot / Attio]
```

- **Event-sourced core.** Nothing is ever overwritten. Every change is an immutable `Event` (`entity.create`, `field.set`, `entity.delete`, `entity.merge`, `schema.*`, `evidence.attach`) with its actor, reason and evidence. CRM state is a fold of the log.
- **Merge engine** (`src/core/engine/merge.ts`): rebases branch events onto `main`, classifies conflicts (`field`, `deleted`, `merged-away`, `schema`), applies resolutions, and generates inverse events for revert.
- **Staleness** (`src/core/staleness.ts`): read-set version checks plus an evidence judge (deterministic heuristics, or Claude when an API key is present).
- **Policy and trust** (`src/core/policy.ts`): branch-protection rules over fields and op types, adjusted by each agent's track record.
- **Agents** (`src/agents/*`): every agent runs **deterministically without an API key** and uses Claude for extraction and judgement when one is set. The web watcher scrapes real sites through Firecrawl when a key is set.
- **Adapters** (`src/adapters/*`, `src/integrations/*`): merged changes on `main` are written to the target CRM. The built-in CRM is the default; HubSpot and Attio connectors sync both ways.

The LLM only ever **proposes**. Correctness comes from the engine.

## Try it today

### 1. Live demo (2 minutes, nothing to install)

A synthetic CRM (10 companies, 25 contacts, 10 deals, $600k pipeline) on our server. It's one shared world, so click **Reset world** first.

1. Open the [demo console](https://gitcrm-production.up.railway.app/demo) and click **Reset world**.
2. **Run chaos**: four agents write straight to the CRM. The forecast drifts to $625k and two different Alex Chens get merged.
3. **Reset world**, then **Run governed**: same agents, now on branches. PRs stream in; low-risk ones auto-merge.
4. Open [Pull requests](https://gitcrm-production.up.railway.app/prs): filter by *Needs you*, group by category, resolve the Northwind conflict, merge or close.
5. Back in the console, **Inject email**: "Acme is pausing" lands and the open Acme PR flips to stale on its own.
6. Open [Time travel](https://gitcrm-production.up.railway.app/timeline): drag back and **Restore to this point**. Revert any merged PR from its page.

### 2. On your laptop (5 minutes, Node 20+)

```bash
git clone https://github.com/Welddevelopment/git_crm
cd git_crm
npm install
npm run dev          # http://localhost:3000/demo, then follow the steps above
```

No keys needed. Put `ANTHROPIC_API_KEY` in `.env.local` to switch agents and the staleness judge to Claude.

### 3. With your own Attio or HubSpot (~15 minutes)

Self-host one copy per workspace; your team keeps working in their CRM.

1. **Deploy your own copy.** Railway works out of the box (`railway.json` is included), or any Node host: `npm run build && npm start`.
2. **Create a CRM token and set it on the server.** Attio: an access token with *records read-write* and *object configuration read* → `ATTIO_TOKEN`. HubSpot: a private app with companies, contacts and deals read + write → `HUBSPOT_TOKEN`.
3. **Settings → Integrations → Import now.** Pulls your companies, people and deals into `main`, then syncs edits from your CRM every 20 seconds.
4. **Install the Chrome extension** ([guide](https://gitcrm-production.up.railway.app/extension)) and set *Git CRM server* to your URL. Pending PRs appear next to the record in Attio or HubSpot.
5. **Route your agents through the proxy:** swap their base URL for `https://<your-host>/api/proxy/attio/v2/…` (or `/api/proxy/hubspot/…`) and add an `x-mainline-agent: <name>` header.

**Once it's connected:** your team edits in Attio or HubSpot as normal and their edits sync onto `main` within ~20 seconds (which is what makes conflicts and staleness real). Agents get a `202` and a PR number instead of writing. Low-risk changes auto-merge; money, stage, dedups and schema wait for a person. You approve in Git CRM or on the record via the side panel, and approved changes, reverts and restores are written back to your CRM.

**Not there yet:**

- **One workspace per deployment, no login.** The CRM token is a server setting and anyone with your URL can merge. "Connect Attio" OAuth and accounts are next.
- **Only agents routed through the proxy are governed.** An agent holding its own CRM token can still bypass Git CRM.
- **The proxy covers companies, people and deals** on core fields (name, domain, headcount, industry, email, title, phone, amount, stage). Notes, tasks, lists and custom attributes pass by.
- **The inbox agent reads the demo emails**; there's no Gmail connection yet. Human edits made directly in your CRM sync straight to `main` (they aren't PRs), but restore-to-a-point covers them.
- **Without `MAINLINE_DATA_DIR`** and a volume, history lives in memory and resets on restart.

## Use it with your CRM

Git CRM is a layer, not a new CRM. Reps keep working in HubSpot or Attio; agents keep calling what looks like their CRM's API.

**1. Chrome extension: review agent changes on the CRM record itself.**
Open any deal, contact or company in HubSpot or Attio (Salesforce and Pipedrive pages are recognised too) and the Git CRM side panel shows that record's pending agent PRs: field diff, evidence quotes, policy and staleness, **Approve & merge / Reject**, plus per-field history. It reads only the tab URL, never the page.

- Download: [`/mainline-extension.zip`](https://gitcrm-production.up.railway.app/mainline-extension.zip) (or the [`extension/`](extension) folder)
- Install: unzip → `chrome://extensions` → **Developer mode** → **Load unpacked** → pick the unzipped folder → click the violet icon
- Guide: [`/extension`](https://gitcrm-production.up.railway.app/extension). Not on the Chrome Web Store yet (store review takes days).

**2. Connectors: mirror your CRM into `main`, write merged PRs back.**
Set `HUBSPOT_TOKEN` (private app, `crm.objects.companies/contacts/deals` read + write) and/or `ATTIO_TOKEN` (records read-write, object configuration read). Git CRM imports records, polls for human edits (which is what makes conflicts and staleness real), and writes merged changes back. **Settings → Integrations** has one-click *Seed demo data* and *Import now*.

**3. Drop-in API proxy: your existing agents don't change.**
Swap one base URL and every write becomes a reviewable PR:

```bash
curl -X PATCH https://gitcrm-production.up.railway.app/api/proxy/hubspot/crm/v3/objects/deals/acme-platform \
  -H 'content-type: application/json' -H 'x-mainline-agent: sdr-bot' \
  -d '{"properties":{"amount":"45000","dealstage":"contractsent"}}'
# → 202 {"mainline":{"status":"pending_review","pr":"pr_1","tier":"review","reasons":["deal.amount $20,000 → $45,000 (+$25,000) exceeds $10k threshold", …]}}
```

An Attio-compatible proxy lives at `/api/proxy/attio/v2/objects/{object}/records/{id}`. (The `x-mainline-*` headers and `mainline` response key are from the project's working name and are kept for compatibility.)

## Built with

- **Claude (Anthropic API):** agent reasoning and extraction, plus the staleness judge. The project itself was built with Claude: the architecture and contract were written first, then the work was split across parallel Claude workers that each owned one module (see [`CONTRACT.md`](CONTRACT.md)).
- **Firecrawl:** live account scraping for the web watcher ("Watch account by URL").
- **Photon:** optional iMessage notification when a PR needs review (`src/notify/photon.ts`).
- Next.js 15 (App Router), TypeScript, server-sent events for live updates, Vitest, HubSpot CRM v3 and Attio v2 connectors, Manifest V3 Chrome extension. Deployed on Railway as a single Node process.

## Run it

```bash
npm install
npm run dev                          # http://localhost:3000
npm test                             # 225 tests: engine, agents, store, API, integrations, restore, triage
npm run typecheck
npx tsx scripts/run-fleet.ts         # run the governed agent fleet from the terminal
npx tsx scripts/run-fleet.ts --chaos # same agents writing straight to the CRM
```

Everything works without any keys: agents and the staleness judge fall back to deterministic logic. Optional env vars:

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | LLM mode for agents and the staleness judge |
| `MAINLINE_MODEL` | Claude model to use (default `claude-sonnet-4-5`) |
| `FIRECRAWL_API_KEY` | Web watcher scrapes real sites |
| `HUBSPOT_TOKEN`, `ATTIO_TOKEN` | Two-way sync with HubSpot / Attio |
| `PHOTON_API_KEY`, `PHOTON_TO`, `PHOTON_ENDPOINT` | iMessage notifications for PRs that need review |
| `MAINLINE_DATA_DIR` | Persist the event log to disk (otherwise in-memory, re-seeded on boot) |

## Repo map

```
src/core/types.ts                  domain model (events, branches, PRs, conflicts, policy)
src/core/engine/state.ts           fold, time travel, blame, diff
src/core/engine/merge.ts           three-way merge, conflicts, semantic rebase, revert
src/core/engine/restore.ts         point-in-time restore plan
src/core/staleness.ts              stale-decision detection
src/core/policy.ts                 branch protection + agent trust
src/server/repo.ts                 application service (branch → PR → analyze → merge)
src/app/api/**                     HTTP API + SSE stream
src/agents/{inbox,hygiene,schema,webwatch}
src/seed/**                        demo world: 10 companies, 25 contacts, 10 deals, 30 emails, 7 web pages
src/app/**                         UI: overview, PRs, CRM, time travel, demo console, settings
src/components/graph/              live branch graph
src/components/pr/categorize.ts    PR triage: categories, needs-you, bulk-approve rules
src/integrations/{hubspot,attio}   sync, mapping, API-compatible proxies, seeding
src/adapters/**                    write-back to the target CRM on merge
extension/                         Chrome extension (MV3 side panel, no build step)
public/landing.html                landing page (served at /landing)
```

## What was built tonight

Everything in this repo was written during the Night Hack sprint (4:15pm–9pm, Oct 30, 2026), starting from an empty folder. The demo world (companies, contacts, emails, web pages) is **synthetic** and seeded on boot; the collisions in it are planted on purpose so the demo is reproducible. See [`STORY.md`](STORY.md) for how it came together.

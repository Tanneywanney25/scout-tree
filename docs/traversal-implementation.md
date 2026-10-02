# Section-scoped level-order traversal: implementation report

Branch `traversal/section-bfs`, cut from `main` at `eb053f4`. Started 2026-10-02.

Sampled players are referred to by row label only. Member ids, names and
handles of subjects are deliberately kept out of this file: the repository is
public (same rule as `docs/traversal-investigation.md`).

## Summary

_Pending — written last._

## Production changes made by this session

Running log, in order. "Production" means the Supabase project
`xqyszdjczchlgyisvtvo` (secrets, functions, database).

| # | When (UTC, 2026-10-02) | Change | Reverse with |
|---|---|---|---|
| P1 | 19:46 | Secret `AI_PROXY_BASE_URL` set to a cloudflared quick tunnel on this laptop. It was absent before. | `supabase secrets unset AI_PROXY_BASE_URL` |
| P2 | ~20:20 | Deployed a temporary function `egress-probe` (token-gated, `--no-verify-jwt`; token never committed) to measure edge egress and wall clock. Redeployed once with a streaming mode. It sent ~1,200 MUIR and ~400 Chess.com requests from edge addresses. | — |
| P3 | ~20:45 | Deleted `egress-probe` (`supabase functions delete`). `functions list` afterwards shows only the original three. | — |

## Phase 0 — Environment

### 0.1 Orphaned cloudflared

`Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'"` at session
start returned **zero** processes. Nothing to kill. (The ADR recorded four
retry-looping orphans at the start of a previous session; none survived to
this one.)

### 0.2 FreeLLMAPI origin, tunnel, `AI_PROXY_BASE_URL`

| Step | Result |
|---|---|
| Origin on `127.0.0.1:31415` at start | Not listening. |
| Start | FreeLLMAPI is the Electron desktop app at `%LOCALAPPDATA%\Programs\freellmapi-desktop\FreeLLMAPI.exe`. Started it; `GET /v1/models` answered **401** (healthy, no key) after 2 s. |
| Tunnel | `cloudflared tunnel --url http://127.0.0.1:31415`, started detached with `Start-Process` (pid 44944) so it is not tied to a tool shell. One edge connection registered; `GET /v1/models` through the tunnel: 401 in 0.77 s / 0.10 s / 0.11 s. |
| Secret | `AI_PROXY_BASE_URL` was **absent** at start (cleared by the previous session). Set to the tunnel origin, no `/v1`, no trailing slash, not localhost. `AI_PROXY_API_KEY` was already set (updated 2026-10-01 22:50). |
| Verify | Deployed health check `{"health":true,"aiCheck":true}`, three calls: `aiBackends.proxy: true`, `ai.backend: "proxy:google/gemini-3.5-flash-lite"`, then `"proxy:google/gemini-robotics-er-2-preview"` twice, 0.95–1.11 s each. Before setting the secret the same check returned `gemini-direct` in 2.56 s. |

The tunnel is a quick tunnel on this laptop. It will die when the laptop
sleeps, FreeLLMAPI closes, or cloudflared loses edge registration. With 0.3
deployed, that failure costs one round trip and then a 60 s skip instead of
25 s per call, so leaving the secret set is no longer the "worst state" the
brief describes. Whether the tunnel is still alive at the end of this session
is recorded in the production-changes log.

### 0.3 Fail-fast for an unreachable optional backend

Commit `36caace`. On `main` the two retry branches the brief cites are at
`supabase/functions/_shared/ai.ts:218-224` (thrown fetch) and `:226-239` (5xx),
not `:256-262` / `:266-277`; those line numbers belong to the shelved branch.

Measured by bundling `ai.ts` with esbuild and calling `callAI` under Node
with `AI_PROXY_*` pointed at three dead targets and no direct key, so the
number is the proxy's own cost:

| Failure mode | Before (n=3) | After, first call (n=5) | After, next 4 calls |
|---|---|---|---|
| Hostname does not resolve (`*.invalid`) | 25,012 / 25,022 / 25,023 ms | 77 ms | 0 ms |
| Dead quick-tunnel hostname (a fresh probe of one returned DNS failure in 28 ms, so this is the same path) | 25,019 / 25,021 / 25,022 ms | 71 ms | 0 ms |
| Live tunnel, no origin (Cloudflare 502) | 25,102 / 25,120 / 25,328 ms | 213 ms | 0 ms |

The before numbers match the ADR's 25.6 s figure. Change: `geminiFetch` takes
`{ optional: true }` from `callProxy`; a thrown fetch or any 5xx ends the
attempt and marks the proxy host down for `AI_OPTIONAL_DOWN_MS` (60 s), during
which `callProxy` returns 503 without a network call and `callAI` falls through
to the direct key. 429 handling is unchanged. The direct Gemini and Anthropic
paths keep their retries because nothing stands behind them.

Not measured: a healthy proxy after the change, from Node. I do not hold the
proxy key locally. It is verified after deployment in the production log.

### 0.4 Grounding cap and search quota

`supabase secrets list` returns SHA-256 digests, not values.
`GEMINI_GROUNDING_DAILY_CAP` has digest `5feceb66…57e9`, which is
`sha256("0")`. **The cap is "0".** `ai.ts:312` returns before any network
call when it is.

`GOOGLE_CSE_KEY` and `GOOGLE_CSE_ID` are **not set** (absent from the secret
list; the health check reports `googleCse: false`). Today's Programmable
Search budget is therefore **0 queries**, not 100. Phase 2 is built against an
explicit budget that reads 0 now and 100 if a key is added.

Also present: `GEMINI_API_KEY` was re-pushed by the deploy workflow at
12:06 UTC today and that run's live check says `GEMINI: valid, AI: ok`. The
key that the 2026-09-26 memory note called dead has been replaced.

### 0.5 Everything else touched

| Item | State |
|---|---|
| Docker | Running. One container, `searxng` (`searxng/searxng:latest`), up 20 h. Left running; not mine. |
| `SEARXNG_URL`, `SEARXNG_TOKEN` | Set in production. No cloudflared process other than mine exists, so whatever tunnel `SEARXNG_URL` names is dead. Nothing on `main` reads either secret (`grep -rn SEARXNG supabase/functions src` is empty), so they are stale but inert. Not changed. |
| Deployed `resolve-identity` | Version 98, deployed 2026-10-02 12:06:45 UTC by the workflow run for `244bb38` on `main`. Function code at `244bb38` is identical to `eb053f4` (that commit only added a doc), so production ran this branch's base until my first deploy. The run is marked failed only because its live check reports `DISCOVERY: broken`, which is the grounding cap doing its job. |
| Migrations | `supabase migration list`: all six local migrations applied, plus `20261001000000` (the shelved branch's `search_cache` / `quota_ledger`) applied remotely with no local file. Copied that file onto this branch unchanged (`51bdaa9`) so `db push` can run. |
| `resolved_handles` | 11 rows, all `source = engine`, confidence 0.985 on every row, oldest 2026-07-27, newest 2026-09-28, none superseded. Matches the brief. |
| `handle_optouts` | 0 rows. |
| `search_cache` | 4 rows, all `kind = identity`, all `expires_at` null. |
| `quota_ledger` | 2026-10-02: `gemini_grounding` 3, `gemini_generate` 8 (written by the shelved branch's code before main was redeployed). |
| `muir_cache` | 4,416 section, 2,521 crosstable, 1,148 games pages, 853 event, 194 events pages, 93 member-search, 22 member. |
| `event_platform_cache` | **0 rows.** No discovery answer has ever been persisted. |
| Shelved branch | No worktree and no stash exists, so it cannot hold uncommitted work. Nothing carried over except the migration file above.

## Phase 1 — Request budget and allocator

All probes ran 2026-10-02 between 19:50 and 20:45 UTC. Scripts and raw JSON
are in the session scratchpad (`p1/`), not in the repo.

### 1.1 Egress identity

From the code, the Find Player search runs in the browser tab:
`huntStore.startDiscovery` (`src/lib/identity/huntStore.ts:238`) →
`discoverAccounts` (`resolver.ts:282`) → `runGraphTraversal`
(`resolver.ts:650`) → `politeFetch` (`net.ts`) → the browser's own `fetch`.
**Every Chess.com and Lichess request leaves from the end user's address.**
MUIR (`supabase/functions/resolve-identity/uscf.ts`), AI calls and the
cookie-authenticated friends scrape leave from the edge function.

What the edge's egress actually is was measured with a temporary function
(P2/P3 in the production log):

| Observation | Result |
|---|---|
| Six invocations, us-east-1 | Six different AWS addresses. |
| Four invocations with `x-region: us-east-2` | Four different AWS addresses. |
| One invocation | One address for its whole life (the rate tests below tripped at a consistent count). |
| `resolve-identity` itself | Served from **us-east-1** (`x-sb-edge-region: us-east-1` on its health response) although `supabase/config.toml` pins `region = "us-east-2"`. |

So the edge is **not one shared address**: each invocation draws from a pool
of AWS addresses that other Supabase tenants presumably share. The ceiling is
per address, the limiter in a warm isolate is per process, and I did not
design anything that relies on rotating through that pool to exceed a
per-address limit.

This laptop's address is the egress for the Node harness, standing in for one
end user.

### 1.2–1.3 Measured ceilings

| Service, egress | Test | Result |
|---|---|---|
| Chess.com, laptop | Open-loop paced ladder 15→20→25→28→31 req/s, 15 s per step, 25 s cooldowns, distinct profile/stats/archive-list URLs from a 470-player pool | 15, 20, 25, 28/s: 1,320 requests, **zero** 429. 31/s: first 429 at **9.7 s after 301 requests**. Ladder stopped there. |
| Chess.com, laptop | One deliberate burst at 60/s, then probes every 0.5 s across endpoint classes | First 429 after **302 requests at 5.0 s**. The block had lifted 0.54 s later (archive month, leaderboards, club and a 404 profile all answered normally), so this probe could not test block scope. |
| Chess.com, one edge address | 31/s | First 429 after **392 requests at 12.6 s**. Latency p50 33 ms vs 87–98 ms from the laptop. |
| Chess.com headers | every 429 | `cf-mitigated: challenge`. **No `Retry-After`, no rate-limit headers** on any response before or after. |
| Chess.com payload | 20 archive months, 0–2.5 MB, 5/s | All 200. Time to first byte rises **328 ms per MB** (r = 0.95). Size costs latency, not success. |
| Lichess `/api/user`, laptop | 1/s ×15, 2/s ×20, 4/s ×24, serial | 59 requests, **zero** 429, p50 100 ms, no rate headers. |
| Lichess `/api/games/user`, laptop | 0.5/s ×12, rest 30 s, then 1/s | 0.5/s clean. At 1/s, **429 on the 14th request** (13.8 s). **The 429 carried no `Retry-After`.** The next probe, 7 s later, was a 200. |
| MUIR, laptop | 2→3→4→5→6 req/s, 15 s per step, 20 s rests | 2–5/s: 210 requests clean, p50 ~50 ms. 6/s: 429 at request 42 of that step. Locked out **18–21 s**. No rate headers. |
| MUIR, edge | 6/s for 16 s | 97 requests, clean. |
| MUIR, edge | 10/s; 5/s; 3/s (fresh address each) | 429 on **exactly request 101** each time: at 10.0 s, 20.0 s and 33.3 s. |
| MUIR, edge | 1.6/s for 125 s | **201 requests, zero 429.** |

Readings:

- **Chess.com** is a count per window per address: ~300 requests (301, 302,
  392), whatever the rate. Today's block cleared in under a second both
  times; the previous session saw 8–11 s after harder bursts. All endpoints
  being pooled is the previous session's measurement; I could not re-test it
  because the block lifted before a second class was probed.
- **Lichess** profile lookups had no limit I could reach serially. The games
  export behaves like a bucket of about 7–9 refilling about 0.5/s: solving the
  previous session's three trip points (18th at 1/s, 10th at 2/s, 9th at 3/s)
  for `k(1 − r/R) = B` gives r = 0.5/s, B = 7.5; today's 14th-at-1/s after a
  full bucket gives B = 7.
- **MUIR is not a 3–5 req/s service.** It allows 100 requests and then refuses,
  at any rate from 3/s to 10/s, and runs clean indefinitely at 1.6/s. That is
  **about 100 requests per minute per address**, consistent with the laptop's
  numbers if the window is a fixed minute. This contradicts the inherited
  "3–5 req/s sustained" figure, which only holds for bursts shorter than ~20 s.

### 1.4 Edge wall clock and the execution model

| Request held open | Result |
|---|---|
| 140 s, silent | 200 at 140.4 s |
| 155, 300, 420 s, silent | `504 {"code":"IDLE_TIMEOUT","message":"Request idle timeout limit (150s) reached"}` at 150.2–150.4 s |
| 200 s, silent | `546 {"code":"WORKER_RESOURCE_LIMIT"}` at 150.3 s |
| 200 s, streaming a line every 10 s | Cut at **150.4 s** (last line `t=140`, no `done`) |
| 420 s, streaming | Cut at **64.5 s** |

The edge function cannot hold a search for more than 150 s, streaming does not
extend that, and an isolate can be lost well before it. **A search with no
wall-clock cap cannot run inside the edge function.**

Choice: **client-side orchestration, the edge as a stateless helper, and the
database as the checkpoint.** Defence:

1. It is where the code already is, and the platform limits are per address.
   Running the traversal in the user's tab spends the user's own Chess.com and
   Lichess budget; a server worker would spend one shared budget for everyone.
2. Every edge call the traversal makes is a bounded unit (one section's
   crosstable, one batch of footprints, one alignment record), well under the
   60 s at which an isolate was observed to die.
3. "Survive a request dying" is met by persistence rather than a job runner:
   every identity an alignment proves is written immediately (Phase 3), every
   exhausted section is negative-cached (Phase 4), and the next search reads
   both before doing any work. A closed tab loses the frontier, not the
   evidence; re-running resumes from what was proven.
4. A job table with a worker was the alternative. With the edge capped at
   150 s, its worker would have to be `pg_cron` slices or an always-on host.
   The first adds a scheduler for no gain over the client loop; the second is
   paid hosting or this laptop. Neither is in scope at zero dollars.

The 240 s stop the brief cites is **not in the product**. The production path
uses a 6 h ceiling plus a 90 s no-log stall watchdog
(`resolver.ts:625-626`). The 240 s was the previous session's harness
soft-stop (`docs/traversal-investigation.md`, decision 9). The new traversal
has neither: it ends on evidence, frontier exhaustion or its request budget.

### 1.5 The allocator (`src/lib/identity/net.ts`, commit `8f5dd6d`)

| Host / class | Measured wall | Configured | Headroom |
|---|---|---|---|
| Chess.com, all endpoints | ~300 per window; 28/s for 15 s clean | bucket 60, **20/s**, floor 4/s, +2/s per clean 15 s; in-flight cap 12 | 20/s is 67% of 30/s; a full 60-burst plus 10 s of refill is 260 < 300 |
| Chess.com speculative share | — | ≤ 50% of the current rate | proven work always has ≥ 10/s |
| Lichess `/api/user`, `/api/users`, autocomplete | ≥ 4/s serial clean | bucket 4, **2/s** | 50% |
| Lichess `/api/games/user` | bucket ~7–9, refill ~0.5/s | bucket 6, **0.4/s** | 20–25% |
| Lichess tournament/team exports | (one at a time, per Lichess) | bucket 2, 0.5/s, single-file lanes kept | — |
| Lichess 429 | no `Retry-After`; cleared ≤ 7 s | Retry-After if present, else 6 s ×2ⁿ⁻¹, ±20% jitter, ≤ 60 s, per endpoint class | — |
| MUIR (edge, per isolate) | ~100 per minute per address | bucket 30, **1.25/s** (75/min) — wired in Phase 2 (`uscf.ts`) | 25% |

Behaviour:

- **Priority lanes.** Proven work dequeues first; speculative work only takes
  tokens no proven request is waiting for, capped at half the rate. The
  engine marks speculative work by running seed hunting under a derived
  `AbortSignal` (`speculativeSignal()`), so no fetch signature changed.
  Speculative: unverified Google leads, guessed handles, their archive pulls,
  Lichess autocomplete, the bulk-existence prefilter. Proven: everything
  traced from a mapped player, every tournament/bracket fetch, every
  alignment, the target's own leads.
- **Adaptive rate.** A 429, or in a browser three opaque fetch failures within
  2 s (what a Cloudflare challenge looks like to a page), halves the rate and
  pauses the bucket 3 s; each clean 15 s adds 2/s back.
- **Fan-out bounded by the limiter.** Workers never send directly; the bucket
  is the only path to the wire. `allocatorSaturated()` reports proven-lane
  backlog so the section fan-out (Phase 4) stops spawning workers when the
  queue, not the worker count, is the constraint.
- **User-Agent.** `ScoutTree/1.0 (+https://chess-scout.vercel.app)` on every
  request from Node or Deno. Browsers send their own and forbid overriding it
  (doing so would also force a CORS preflight), so it is left alone there.
- **Accounting.** `getNetStats()` counts every request by platform, lane,
  status and endpoint class, with each request's queue wait.

`scripts/test-allocator.mjs` (stubbed fetch, 7 scenarios) passes: a 100/s
bucket ran at 95/s; **4 workers and 64 workers both took 2,015 ms** for the same
205 requests; 10 proven requests queued behind 30 speculative ones all
finished within the first 12 completions; speculative-only traffic ran at
34/s against a 50/s share; a scripted 429 paused the bucket 3,003 ms; the
Lichess backoff sequence is 6, 12, 24, 48, 60 s, Retry-After 17 → 17 s; lane
accounting attributed 12/7 requests and all six 404s correctly. The existing
`test-net`, `test-conductor`, `test-align`, `test-targetedge` and `test-tc`
still pass.

`conductor.netEvent()` now ignores Lichess events (it resized the Chess.com
gate on a Lichess 429). The Lichess backoff (brief item 5.4) landed in the
same commit as the allocator because both live in one function; Phase 5
cross-references it.

## Phase 2 — Portal-side pivot ranking

_Pending._

## Phase 3 — Persistence and safety

_Pending._

## Phase 4 — The traversal

_Pending._

## Phase 5 — The measured bugs

_Pending._

## Acceptance

_Pending._

## Decisions and assumptions

_Pending._

## Disagreements between the brief and the measurements

_Pending._

## Errors I made this session

_Pending._

## What remains undetermined

_Pending._

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
| P4 | 20:47 | `supabase db push`: applied `20261002000000_identity_graph.sql` (new tables `identity_edge`, `section_link`, `section_negative`, `series_platform`; new columns `status`, `status_reason`, `revalidated_at`, `tier` on `resolved_handles`; functions `record_identity_edges`, `clear_section_negatives`, `sweep_search_cache`). Additive only; no existing row changed. | Drop the four tables, three functions and four columns. |
| P5 | 20:48 | Deployed `resolve-identity` from this branch (commit `48f29d5`), replacing version 98 from `main`. All existing modes keep their request and response shapes. | `gh workflow run deploy-supabase-functions.yml --ref main` |
| P6 | ~20:55 | Redeployed `resolve-identity` with the 10 s optional-proxy bound (`ai.ts`). | as P5 |
| P7 | ~21:00 | Redeployed with the Chess.com slug fix, then ran one production harvest (`recordAlignment`) on the prior investigation's seed section: 36 identities written to `identity_edge`, 23 verdicts mirrored into `resolved_handles`, one `section_link`, one `event_platform_cache` row, one `series_platform` row. | Delete rows with `source = 'alignment'`. |

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

### 2.1 The ranking input (`supabase/functions/resolve-identity/footprint.ts`, `dc592df`)

The brief's premise needs one correction: **the USCF ratings API does not
name the platform.** A section's MUIR record carries `isOnline`,
`ratingSystem`, `timeControl`, `roundCount` and so on, and no platform field
(read from the 4,416 cached section payloads in production). The only
platform signal is the event or section title. Measured on the 761 online
sections cached in production on 2026-10-02:

| Title names | Sections | Events |
|---|---|---|
| nothing | 350 (46%) | 188 |
| ICC | 330 (43%) | 111 |
| Chess.com | 75 (10%) | 75 |
| ChessKid | 5 | 1 |
| Lichess | 1 | 1 |

(That cache is biased toward whoever was searched. The investigation's
900-member sample puts official "…on Chess.com" events at 36% of online
sections and the unnamed WNZ and PCA series at 39%.) A title-only rule would
score most real online players zero. So `memberFootprint()` reads each
section's platform in order of trust:

1. **stored** — `event_platform_cache`, now written whenever the server
   verifies an alignment (Phase 3.2);
2. **series** — `series_platform`, learned per event series
   (`seriesKey()` strips dates, numbers and round words), also written by the
   harvest, so one aligned "PCA Rapid Event" teaches every other one;
3. **title** — the existing standalone-`chess.com`/`lichess`/`icc` regex;
4. otherwise **unknown**.

Per member: total online-rated sections, Chess.com, Lichess, other
(ICC + ChessKid), unknown, most recent date, and the member's Chess.com /
Lichess / unknown sections newest-first (the expansion frontier). Source: the
MUIR games feed (each row names event, section and rating system), 2 pages
(200 most recent games), no date cutoff.

Live check, 8 members of one aligned section, cold cache: 7.3 s for 8
footprints. The series learning was already visible: after one harvest of a
"US Chess Rapid on Chess.com" section, 54 of one member's 73 sections were
classified through the learned series rather than the title.

### 2.2 The ranking function (`src/lib/identity/sectionBfs.ts`, `pivotRank`)

```
rank(P) = 1000                                  if P's handle is already known
        = −∞                                    if P has no Chess.com, Lichess or unknown-host section
        = 3.0·log2(1 + sections on this section's platform)
        + 1.0·log2(1 + sections on the other supported platform)
        + 0.5·log2(1 + unknown-host sections)
        + 1.0·nameUniqueness(name)              (the engine's existing rarity, ~0–1.35)
```

Members ranked −∞ are **excluded, not ranked last**: the engine's seed scouts
never touch them (`seedPolicy.rank`, commit `cfc41a9`), so they cost no
search query, no profile lookup, no guess.

Why these weights, from measurement rather than taste:

- **Same platform dominates** because a pivot is only useful through the
  handle on the section's own platform: a Lichess handle cannot seed a
  Chess.com bracket, and alignment is per platform.
- **Log scale** because the footprint distribution is extreme (online
  members: median 11 sections, p99 507; investigation §5.3); linear weights
  would let one hub outrank everyone.
- **Rarity is a tie-breaker** because the channel it sharpens has a budget of
  zero today (no Programmable Search key, grounding off; Phase 0.4), and
  name-derived guessing accepts the true handle for 4.7% of Chess.com players
  regardless of the name (investigation §3.3).
- **Unknown hosts at half weight** because some unknown hosts are ICC; the
  investigation found 96% of online members have at least one section that is
  not ICC/ChessKid, so most unknowns are alignable.

I did not have the data to fit these by regression; the acceptance section
reports how far down the ranked list the first resolved pivot sat, which is
the measurement that would tell whether the order is right.

### 2.3 Caching

- Footprints: `muir_cache` kind `footprint`, 3 days. Games-feed pages: 6 h
  (existing). Crosstables, sections, events: 30 days (existing).
- Client: one footprint per member per search (deduplicated across
  sections; a member in five sections is fetched once).
- Cost control from Phase 1's MUIR measurement (~100 requests/min/address):
  MUIR's edge pacer is now a bucket of 30 refilling 1.25/s per isolate
  (`b664d65`); footprints read 2 pages, not 5; level 0 waits only for direct
  opponents plus the first 30 section-mates and streams the rest while the
  engine works, re-reading ranks at every seed pick (`18b49e7`). In the first
  smoke run, ranking 61 section-mates up front took **59 s**; after the change
  the second smoke run started platform work **11 s** after ranking began.

### 2.4 Search quota as an explicit budget (`921c662`)

- Every Programmable Search query is taken from `quota_ledger`
  (`provider = 'google_cse'`, cap `GOOGLE_CSE_DAILY_CAP`, default 100) before
  it is sent; the ledger RPC is the shelved branch's `increment_quota()`,
  already in production.
- Pivots ask for `maxQueries: 2` (the two site-restricted exact-name rungs,
  page 1 only); the target's own search keeps the full ladder.
- **Today the budget is zero**, because no CSE key is set. The edge now says so
  (`disabled: true`) instead of returning a failure that every client retried,
  and the client stops asking for 10 minutes. "How far down the ranked list a
  typical search gets before a resolvable pivot" is therefore measured on the
  remaining paths (stored links, guessing within the cap, pairing chains) —
  see Acceptance.

## Phase 3 — Persistence and safety

All of it landed before the traversal was switched on (commits `ae112d7`
through `48f29d5`, deployed P4–P5), and the migration was exercised against a
local `postgres:16` before it touched production.

### 3.1 Eviction and revalidation

`superseded_by` (declared, read at `identityStore.ts:225` on `main`, not
`:184` — that line number is the shelved branch's) was never written. Now:

- `resolved_handles` has `status` (`active` / `superseded` / `conflict` /
  `gone`), `status_reason`, `revalidated_at` and `tier`. A retired row also
  gets `superseded_by = its own id`. With `unique (uscf_id, platform)` in
  place, a replacement for the same member and platform has to reuse the row,
  so the self-reference is what keeps readers that only know the old contract
  (`superseded_by is null`, e.g. `main`'s `getResolvedHandles`) from showing a
  retired row. The full history lives in `identity_edge`.
- **Age policy.** Chess.com allows a username change every 90 days, and a
  renamed or closed account stops answering under the old name. So a row
  unchecked for **30 days** is revalidated when it is read (one profile
  request, at most three per read; 404/410 or a closed/disabled profile
  retires the row and every edge for that handle), and a row unchecked for
  **90 days** that cannot be revalidated right now is served as a *lead*,
  never as a verdict. 30 days keeps the cost to about one request per
  member-month; 90 matches the platform's own rename window, beyond which a
  silent rename becomes likely enough to stop asserting.
- **Contradictions** retire rows through the same model as 4.6 (below).
- The 11 pre-existing rows (all `source = engine`, oldest 2026-07-27) are past
  30 days and will be revalidated the next time each is read. They are
  browser-asserted, so they are served as leads, not verdicts.

### 3.2 Harvest (`harvest.ts`, `6b00d36`)

The browser only says *which* tournament it believes hosted a section. The
edge then fetches the crosstable (`muir_cache`) and the tournament's games
itself (one Lichess export, or a Chess.com bracket walk of at most 40
requests), re-runs `alignSectionBest` from the shared pure core
(`supabase/functions/_shared/sectionAlignCore.ts`, `04d26b8`), records the
section ↔ tournament verdict either way (`section_link`, verified or
rejected), and on a trusted alignment writes **every** assignment with its
tier through `record_identity_edges()`, plus the event's platform
(`event_platform_cache`) and its series (`series_platform`). Opted-out
members are filtered inside the SQL function, by id and by handle.

Production check (P7), the investigation's seed section: 36 of 36 players
aligned, **23 strong / 13 weak, 36 identities written, 23 verdicts mirrored**
into `resolved_handles`, 2.8 s. Previously that section would have stored one
row at most.

### 3.3 Read the store before discovery (`f6aaf7a`)

- **Short circuit.** `discoverAccounts` calls `storedIdentity` for the member
  before anything else; a server-verified verdict returns immediately with no
  discovery request. Smoke check: a player whose section had been harvested
  answered from the store (acceptance "repeat" runs measure it).
- **Free seeds.** `fetchResolvedHandles()` (no caller on `main`) stays as it
  is, but its job is done by `seedEdges`, which returns stored verdicts for a
  batch of crosstable members, and the traversal injects them as engine seeds.
  **Tension, recorded rather than resolved:** `seedEdges` is a bulk read, and
  the `main` security fix (`767bd5a`) made bulk reads signed-in only because
  USCF ids are sequential and an open bulk read is a de-anonymisation endpoint.
  So anonymous searches get the short circuit (a single-member read, the same
  disclosure `memberPreview` already makes) but not section-mate seeds. The
  harvest offsets most of the cost: a section aligned by anyone stores every
  member, so a later anonymous search for any of them hits the short circuit.
  A server-side "align this section from stored seeds and return only the
  target" mode would close the rest without a bulk read; I did not build it.

### 3.4 `claimHandle`, constrained (`252406e`)

Traced every caller first: the only one is
`huntStore.persistConfirmedHandles` → `storeResolvedHandle`, `source:
"engine"`, confidence 0.75–0.985, at most 12 evidence items, run after any
hunt including anonymous ones. `"user-correction"` and `"claim"` have **no
caller** (only a re-export in `src/lib/identity/index.ts`).

| Rule | Effect on the legitimate path |
|---|---|
| `source: "engine"` accepted without a session | unchanged |
| engine confidence must be a number ≤ 0.985 (the engine's own `scoreFromEvidence` clamp) | unchanged: the engine cannot produce more |
| evidence must be ≤ 12 items of `{kind, weight, label, source}` with slug-shaped kind/source and |weight| ≤ 10; labels truncated to 300 | unchanged: that is exactly what `persistConfirmedHandles` sends |
| an engine row can never replace an `alignment`, `user-correction` or `claim` row | new precedence; the engine row is dropped |
| `user-correction` / `claim` require a signed-in caller | no caller today |

The anonymous hunt flow is preserved exactly. No legitimate path broke.

### 3.5 Rate limits (`48f29d5`)

Per caller (forwarded IP), per warm isolate, sliding window: `claimHandle`
30 per 10 min; `aiCheck` 6/min (it spends model quota on every call);
`findUsername` and `discoverEvent` 60/min; `storedIdentity` 60/min;
`seedEdges` 60/min (and signed-in only); `sectionGraph` 40/min;
`memberFootprints` 30/min; `recordAlignment` 20 per 10 min;
`sectionNegatives` 60/min. `memberSearch` keeps its 25 per 10 s. A per-isolate
limiter is not a distributed one; it bounds a single client hammering one
warm isolate, which is the realistic abuse, and costs no database round trip.

### 3.6 `search_cache` sweeper

`search_cache` exists in production (the shelved branch's migration ran; 4
`identity` rows, all with `expires_at` null). It is not on `main` at all, so
`store.ts:181` does not exist here. `sweep_search_cache(90)` deletes expired
rows and identity rows older than 90 days; the edge calls it at most once an
hour per isolate, off the request path. Nothing on this branch writes
`search_cache`, so the four rows are the whole backlog.

## Phase 4 — The traversal

### 4.1 Section-scoped level-order walk (`src/lib/identity/sectionBfs.ts`, `a149189`)

- **Frontier is a set of sections** keyed `eventId#section`. Level 0 is the
  target's online sections whose platform is Chess.com, Lichess or unknown;
  ICC and ChessKid sections are dropped (a target with only those gets "no
  alignable online-rated section" without a platform request). Level k+1 is
  every other online section of level-k members, taken from their footprints,
  best-ranked members first, newest sections first, deduplicated against
  everything explored. **Level k+1 is built only after level k is drained.**
- **Members are deduplicated** across sections: one footprint, one rank, one
  handle per member per search.
- **Inside a section**, the existing engine does the work, with: stored
  handles as seeds, the portal ranking as seed order (re-read at every pick),
  members ranked −∞ never scouted, a cap on how many members may have handles
  guessed (8 at level 0, 3 deeper), and every alignment reported back
  (`onSectionAligned`) and harvested server-side. The engine's own opponent
  pivot (depth-1 dives) is not used: the level structure replaces it.
- Each deeper section is walked *for its bridge* — the member who links it to
  its parent — with that member as the engine's root, so a crown or an
  alignment that maps the bridge immediately pays off upstream.

### 4.2 Fan-out bounded by the allocator

A level's sections are walked concurrently. A new section worker starts only
while proven Chess.com requests are not already queuing
(`allocatorSaturated()`: ≥ 8 proven Chess.com waiters, or a backed-up Lichess
export/games bucket) and never more than six at once. Every worker's requests
go through the same buckets (Phase 1.5), so extra workers past the ceiling
only lengthen the queue; `test-allocator` scenario 2 is the proof that the
request rate does not move with the worker count (4 and 64 workers: 2,015 ms
both).

### 4.3 Backtracking: did the old code collapse a chain? No. Built and proven.

From the code on `main`: the engine's only multi-hop path is the opponent
pivot, capped at one hop by three gates (`uscfGraphEngine.ts:1494, :4619,
:4650` on `main`), and a dive's sub-traversal is started without the parent's
seeds (`seedMappings` is not passed to it), so a handle known two sections
away is invisible to it.

What was built: `learnHandle()` in `sectionBfs.ts` re-queues every explored,
unaligned section that lists a newly mapped member; a section walked for its
bridge re-walks its parent as soon as the bridge resolves; repeated up the
chain to level 0.

**Worked case, live data** (scratch `chain/`): a real chain found by
`find-chain.mjs` — section H (harvested in P7, 36 handles stored) ∋ B2 →
S1 (61 players, 2026-06-24) ∋ B1 → S0 (40 players, 2026-09-09) ∋ T, with B1
not in H and T in neither S1 nor H. The search for T was restricted to S0 at
level 0, **all scouting and guessing was switched off for every member**, and
level-1 expansion was restricted to S1 (B1's real footprint; others' section
lists emptied), so the only possible route is the collapse.

| Run | Seeds given | Result | Requests |
|---|---|---|---|
| Control | none | not resolved (2 sections walked, 0 aligned) | 0 |
| Seeded | B2's stored handle only (two sections from T) | **resolved**: S1 aligned from B2's seed and mapped 11 members who also sit in S0; S0 was re-walked with all 11 as seeds (1 backtrack); T crowned 34 s in from a fully aligned round-4 board | 258 proven, 0 speculative |

The collapse was wider than the brief's single chain: S1's alignment mapped
eleven of S0's forty players at once, and the re-walk of S0 used all of them.

### 4.4 Negative cache

`section_negative` (TTL **30 days**), written when a deeper section is walked
without resolving its bridge or aligning, with the member list read from the
crosstable **server-side**. Read when a level is built: negatives go to the
back of their level. **Invalidation:** `record_identity_edges()` calls
`clear_section_negatives()` for every member it stores, so a dead end that a
newly resolved member could open is reopened the moment that member is
stored, wherever in the product that happened. Tested locally: a negative
listing a newly stored member was deleted, one listing only other members was
kept. Defence of the TTL: a rated crosstable never changes, so the only
things that revive a dead section are new evidence (handled by invalidation)
or events that leave no trace in the store (a platform outage during the
walk, a seed found by an unharvested path, a member renaming). 30 days
bounds those and matches the investigation's recommendation (§6.5). Because
negatives can be written anonymously, they **deprioritise and never hide**: a
poisoned negative can delay a search, not stop one.

### 4.5 Termination and progress

- Ends on **evidence** (a target account at ≥ 0.85, the bar the baseline
  used), **frontier exhaustion**, or the **request budget**. No wall clock.
  The resolver's 6 h backstop and 90 s no-log stall watchdog remain as wedge
  guards; the engine emits a heartbeat every 25 s of silence, and the section
  search logs every level, backtrack and alignment.
- **Adaptive budget**: 2,500 Chess.com + Lichess requests to start; each level
  that made progress (a newly aligned section or a newly mapped member) earns
  +2,000, up to 15,000; a level that made none ends the search when the budget
  is spent. Depth is capped at level 4 (`maxLevel`). MUIR is budgeted
  separately by its own pacer.
- **Progress**: `ProgressSnapshot` gained `level`, `sectionsWalked` and
  `platformRequests`; the result carries `sectionSearch` with every counter
  the acceptance table uses.

### 4.6 Confidence tiers and conflicts

Built on the measured disagreement rates (strong 0.99%, weak ~3.5%, across 45
re-aligned sections; investigation §6.1):

| Evidence | Tier | Confidence | Shown as |
|---|---|---|---|
| Strong assignment (trusted section, ≥ 3 verified rounds, ≥ 2 corroborating opponents), re-run by the server | verdict | 0.99 | the answer |
| Two independent sections agreeing on a weak assignment | verdict | 0.97 | the answer |
| One weak assignment | lead | 0.93 (capped) | "likely — one more section would confirm" |
| Browser-asserted engine row (legacy) or a row unchecked for 90 days | lead | as stored | lead |
| Equal-strength collision on one handle | conflict | withheld | not shown |
| Name, rating, location only | — | < 0.85 | candidates, never a single answer |

Conflicts are resolved in `record_identity_edges()`, the same model as 3.1:
same handle claimed for two members → strong beats weak (the weak one is
superseded and points at the winner), equal strength → both withheld as
`conflict`; same member with two handles → strong+strong is a second account
(both kept), strong beats weak, weak+weak stays as two leads. A verdict whose
edge stops being active is retired in the same transaction. Locally tested
with a four-call script covering every branch. The "81 handle conflicts" in the
brief come from the previous session's snowball data, which I did not
re-derive; under these rules each of them is either withheld (equal strength)
or resolved toward the strong side, and none can surface as a verdict.

## Phase 5 — The measured bugs

### 5.1 No online footprint → explicit answer, immediately (`f6aaf7a`)

`discoverAccounts` checks the anchor's `hasOnline` (an OR/OQ/OB rating on the
US Chess record, which the member picker already has) **before any platform
request**. With none, it returns "no online-rated US Chess games, so there is
no online game record to align against", with `noOnlineFootprint: true`. The
school and name-search fallbacks are skipped too: in the baseline they
produced 0 of 12 resolutions and name-only leads between 0.04 and 0.62.
Measured cost now: see Acceptance (OTB-only cohort). A member who has online
ratings but only ICC/ChessKid sections gets the equivalent answer from the
section search at level 0, also without a platform request.

### 5.2 The 2020 cutoff (`b664d65`)

`fetchMemberOnlineSections` is called with no lower date bound
(`ONLINE_HISTORY_SINCE = ""`) by the graph build and by footprints. Additional
sections visible across the sample: reported in Acceptance (counted from the
footprints, which carry every section's date).

### 5.3 A stored tournament link ignored when the title names a platform (`cfc41a9`)

Root cause, confirmed in code: stage 0 fetched a discovery answer for every
researchable event but recorded it in `discoveredInfo` only for unknown-host
events (`uscfGraphEngine.ts:4421-4437` on `main`); `workEvent` applied only
`discoveredInfo`, and the later retry was skipped because the answer was
already in `discoverCache` (`:4240`). Fix: `workEvent` applies any answer in
the discovery cache. The traversal asks for title-named events in
`cacheOnly` mode, so a stored answer costs one database read and a miss costs
no web search.

**Measured in the first smoke run**: that player's section had a stored link
(from the P7 harvest). The section aligned **1.0 s after the engine started**
(36 of 36 players), and the match followed at 100 s of a 106 s run whose time
otherwise went to the issues fixed in `f846c29` and `18b49e7`. The
investigation's counterfactual for the same defect was 217 s, 778 calls, no
match.

### 5.4 Lichess pause → Retry-After-aware backoff

Landed inside the allocator commit (`8f5dd6d`). Measured: Lichess's 429 on
`/api/games/user` carries **no** `Retry-After` and a single overrun cleared
within 7 s. The flat 20 s / 60 s pause is replaced by: Retry-After when
present, else 6 s doubling per consecutive 429 on the same endpoint class
within two minutes, ±20% jitter, capped at 60 s; the pause applies to the
endpoint class that was refused, not to every Lichess request, and no longer
throttles Chess.com. Unit-tested (`test-allocator` scenario 6).

### 5.5 `quotaExhausted` reporting (`921c662`, `e198085`)

**Which branch carries the defect.** The mislabel the ADR describes —
`quotaExhausted: true` whenever grounding is unavailable, because
`groundingAllowed()` returns false for three reasons — is code that exists
only on the shelved branch. On `main`, with the cap at 0, `callAIWithSearch`
returns status 503 (not 429), so `quotaExhausted` stays false. Measured
against the deployed `main` code: `{"available":false,"backend":"none",
"quotaExhausted":false}` in 0.15–0.44 s.

The consequence the brief describes was live anyway, through a different
door: `edgeClient.ts:308` treats `available: false` as a request failure,
deletes the cache entry and returns null, so every member in every event
asked again. Fix: the edge distinguishes three states — searched with no
match (cached as a real miss), transient failure (retried), and **disabled**
(no backend enabled at all: `disabled: true`, returned with no AI call). The
client stops asking for 10 minutes after `disabled`. Measured after deploy:
`{"disabled":true,...}` in 0.19 s, and the smoke runs made **one**
`findUsername` call per search instead of one per member.

## Acceptance

_Pending._

## Decisions and assumptions

1. **The prompt arrived as pasted text with no other message.** I treated it as
   the instruction for this session.
2. **Line numbers in the brief belong to the shelved branch.** `ai.ts:256-277`,
   `identityStore.ts:184`, `store.ts:181` are on `search/searxng-pipeline`;
   on `main` the same code is at `ai.ts:218-239` and `identityStore.ts:225`,
   and `store.ts` does not exist. I worked from `main` and say so where it
   matters.
3. **Proxy kept configured although it is flaky.** The brief asks for the
   tunnel and the secret. After deployment the proxy answered 3 of 8 health
   checks and hung the other 5 until the 10 s bound. The direct Gemini key is
   also now answering 429 (quota). With the fail-fast and the 3 s AI grace in
   query mode, neither is on the search's critical path any more. Final state
   of the secret is in the production log.
4. **Execution model: client-side orchestration plus the database as the
   checkpoint**, not a job table. The edge function's hard ceiling is 150 s
   (measured, streaming does not extend it). See 1.4.
5. **No IP-rotation tricks.** The edge's egress rotates through AWS addresses
   per invocation. I did not design anything that relies on that to exceed a
   per-address limit (MUIR, Chess.com): each isolate paces itself as if its
   address were fixed.
6. **Platform for an unnamed online event** is learned (stored verdict, then
   series), not assumed. Unknown hosts count at half weight in ranking rather
   than zero; zero is reserved for ICC/ChessKid-only footprints, which is how
   I read "events on ICC or any other platform score zero".
7. **Bridge member as the engine's root** for deeper sections. The engine
   needs a target; using the member that links the section to its parent makes
   every deeper walk serve the backtrack.
8. **Section-mate seeds are signed-in only** (bulk read), preserving the
   `767bd5a` security decision; anonymous searches get the single-member
   short circuit. See 3.3.
9. **Negatives deprioritise, never hide**, because anonymous callers can write
   them.
10. **Level-0 ranking does not block on every footprint.** Direct opponents
    plus 30 are awaited; the rest stream in and are used as they arrive. This
    trades a little ordering accuracy for 48 s of latency (smoke runs).
11. **OTB-only members get no fallbacks** (5.1). The brief asks for an
    immediate explicit answer; the school/name paths produced 0 of 12 and
    name-only leads.
12. **Weights in 2.2 are reasoned from measured mechanics, not fitted.** There
    were not enough resolved targets to regress them.
13. **Two players' first runs are the smoke runs** (#0 and #1 in the sample),
    because those runs stored their sections and a re-run would have hit the
    store. #0's section had additionally been harvested by my own production
    test (P7) before its smoke run, so #0's first run had a stored tournament
    link a real first search would not have had.
14. **"Resolved"** keeps the baseline's bar (a tournament-proven account at
    ≥ 0.85) so the before/after rates are comparable, even though the new
    confidence model would call a weak single-section result a lead.

## Disagreements between the brief and the measurements

| Brief | Measured | Consequence |
|---|---|---|
| Chess.com ~300 requests / 10 s per address | Confirmed: first 429 after 301 (31/s), 302 (60/s), 392 (one edge address, 31/s). Block lifted in < 1 s today, not 10 s. | Bucket at 20/s, 60 burst; 3 s pause on a trip. |
| USCF portal lists each member's events "and online-rated events name their platform" | MUIR has no platform field; 46% of cached online sections name none in the title (43% ICC, 10% Chess.com). | Platform learned from stored verdicts and series (2.1). |
| MUIR (inherited: 3–5 req/s sustained) | **~100 requests per minute per address**: 429 on exactly request 101 at 3, 5 and 10/s; 201 clean at 1.6/s. | MUIR pacer cut from 20/s to 1.25/s per isolate; footprints read 2 pages. |
| Lichess "measure what Retry-After asks for" | It asks for nothing: no `Retry-After` on the 429. Recovery ≤ 7 s after one overrun. | Exponential backoff from 6 s, 60 s cap. |
| "The current 240 second stop" | Not in the product. Production uses a 6 h ceiling and a 90 s stall watchdog (`resolver.ts:625-626`); 240 s was the previous harness's soft stop. | Nothing to remove in the product; the new search has no clock. |
| Edge egress is either per-user or one shared pool | It is neither: a rotating pool of AWS addresses, a new one per invocation. `resolve-identity` also runs in us-east-1 despite `region = "us-east-2"`. | Edge limiters are per isolate. |
| Edge wall clock unknown | 150 s request idle limit; streaming does not extend it; an isolate died at 64 s. | Client orchestration (1.4). |
| `quotaExhausted` mislabel live? | Not on `main` (it is shelved-branch code); the "never cached, re-searched" consequence was live through `available:false`. | Fixed via `disabled` (5.5). |
| "Time to first aligned section, currently a 108 second median" | 108 s in the investigation is when work on the first *event* started. First *seeds* were found at 171–230 s and the six matches at 180–235 s; no first-alignment median was recorded. | Acceptance compares against the matched-time figures. |
| 100 Programmable Search queries a day | **Zero** today: no key is configured. | The budget exists and reads 0. |

## Errors I made this session

_Pending._

## What remains undetermined

_Pending._

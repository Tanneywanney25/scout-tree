# ADR 0001 — Self-hosted SearXNG for web discovery

- **Status:** Accepted as a shelved experiment. **Not merged to `main`.**
- **Date:** 2026-10-02
- **Branch:** `search/searxng-pipeline`

## Problem

Identity discovery needs the open web for two narrow steps: pinning which
platform hosted a USCF online event whose title names none, and acquiring the
first seed handle inside a crosstable section. Both were served by Gemini's
Grounding-with-Google-Search. That stopped working — the grounding quota was
exhausted and the free tier does not offer grounding on Gemini 3.x at all — so
every discovery call that needed the web failed.

The branch separates the two jobs grounding had conflated: self-hosted SearXNG
retrieves (no key, no per-query cost) and Gemini reasons over the results with
no search tool attached, spending only ordinary free-tier allowance. Grounding
survives as an emergency path behind a quota ledger.

## What was measured

Retrieval, when the engines answer, works: cold discovery **8.2 s median**
(n=3, `backend=searxng`, 3–5 candidates), repeat served from cache.

The decisive numbers are about the engines, not the code:

- All general engines suspend this address under load. brave and google
  (CAPTCHA) stay suspended for hours; duckduckgo and google cse recover.
- **CORRECTED 2026-10-02.** An earlier revision of this ADR said capacity was
  about 12 queries per five-hour window, i.e. one or two lookups. That was
  wrong, and it was the headline reason for shelving. The limit is a RATE, not
  a cumulative count: 16 consecutive distinct queries at **10 s spacing** all
  returned 24-30 results with no degradation whatsoever, where 96 queries at
  400 ms spacing collapsed after about 12. Sustainable throughput is therefore
  roughly **6 queries/minute**, so a discovery request (8 queries) costs about
  80 s of wall clock but is not rate-limited out of existence.
- Consequence for this decision: the capacity objection does not hold. The
  stagger trial that rejected "burst concurrency causes blocking" only tested
  0/200/500 ms and never probed a timescale 20x slower, so its conclusion was
  right for its range and wrong as a general claim. Blocking is rate-driven.

Two findings reframed the comparison:

- **An unreachable optional AI backend cost 25.6 s on every model-using call.**
  `AI_PROXY_BASE_URL` pointed at a dead tunnel; `callAI` tries the proxy first
  and `geminiFetch` retries both a 5xx and a thrown fetch across a 25 s budget
  (`_shared/ai.ts`). Clearing one secret took a trivial model call from
  **26,625 ms to 979 ms** (medians, n=3 each). This was the single largest
  latency item in the system and had nothing to do with retrieval.
- The earlier 8%-of-lookups baseline was measured while the live runs made
  1,143 `findUsername` and 197 `discoverEvent` calls "at an average of 25 s
  each, all empty", with first-event work starting at a median of 108 s.
  **A previous revision of this ADR concluded that clearing the proxy therefore
  hands ~100 s of useful work back to the deterministic engine. That was wrong.**
  The investigation had already run the counterfactual (section 2.5, "same, but
  with discovery failing instantly"): the match did NOT arrive within 180 s,
  because ~1,650 speculative guessed-handle requests then shared one queue with
  the 27 the proven trace needed. The mechanism is still in the code - a single
  `chesscomGate = semaphore(8)` with lanes chosen by endpoint, not by whether
  work is proven or speculative (`src/lib/identity/net.ts:106-107,130`), and no
  request prioritisation anywhere. The 25 s delay was accidentally throttling
  wasteful work. Also note the 8% figure is a re-weighted model, not a
  measurement: measured was 6/35 overall and 6/23 online-rated, with a 95%
  interval of 12-47%.

Against that, the deterministic layers measured far better: organizer research
resolved **16 of 16 sections, 184 of 186 players, in 25 requests** with no seed
and no web search; one aligned section snowballed to **788 identities at 2.2
requests each**. Handle guessing — what search is meant to replace — puts the
true handle among its guesses for **7.3%** of Chess.com players and accepts it
for **4.7%**.

## Proposals rejected

- **Replace model extraction with a regex harvest plus `api.chess.com`
  existence verification.** Rejected. Existence verification rejected **0 of 3**
  known false positives, because they are real accounts belonging to other
  people (`Chess-Network` → "Jerry", `jeffforever` → "Jens Hirneise"). The only
  discriminator, `name`, is populated on **57%** of ordinary accounts, and
  **51%** of handles carry no fragment of the player's name at all. Serial cost
  was never the objection (81 ms/call). Thin counter-signal (n=3, all the
  engines allowed): the correct handle appeared in **0/3** result URLs but in
  **2/3** snippet texts — i.e. in prose, which is the case the model handles and
  a URL regex does not. The harvest premise remains **untested, not disproven**.
- **Stagger queries to recover blocked engines.** Rejected. Staggering made
  failure rates worse (duckduckgo 88% → 100%, google 91% → 100%) and lost
  23–29% of results; 500 ms staggering also cost 41% more wall time. Blocking
  is cumulative and address-based, not burst-rate. Note for anyone revisiting
  the engine config: ~5–6 engines fire per general query (82 are enabled but
  only 10 are general-category and 4 of those are converters), so a ladder is
  ~40–48 outbound requests, not the 32 assumed.
- **Move the cache key from query to resolved identity.** Partly confirmed,
  then superseded. Extraction did dominate a cache hit, but because of the dead
  proxy, not extraction cost. And `resolved_handles` is *already* a permanent
  player-keyed store — `unique (uscf_id, platform)`, no TTL — whose problem is
  that **nothing reads it before discovery**: `fetchResolvedHandles()` has only
  a definition and a re-export, no caller. Building a second cache would add
  storage where the gap is wiring. Permanence is also wrong on its face:
  Chess.com allows a username change every 90 days.

## Decision

**Do not merge this branch as production retrieval.** Keep it on the shelf.

The reason is now narrower than when this ADR was first written. A production
dependency on a laptop, a Docker container, and a Cloudflare quick tunnel whose
hostname is discarded on every restart is not acceptable. Capacity is NOT the
reason - see the correction above - so if the hosting dependency is ever solved,
this pipeline is materially more viable than this ADR originally claimed. Five tunnel
hostnames died during development; two had to be re-registered by hand in a
single day. Note the actual failure mode, which is easy to get wrong: a
`cloudflared` process outlives the shell that started it and keeps serving, so
a tunnel does not die when its parent task ends. It dies when it loses edge
registration — after which it retry-loops forever and its hostname is gone for
good. Four such processes were found alive but serving nothing at the start of
this session.

Three things follow, and are not optional:

1. **The security fix on this branch does not belong to this decision.** Commit
   `40c3bb8` closes an unauthenticated bulk read of `resolved_handles`. It is
   already deployed to production but lives only on an unmerged branch. Extract
   it to `main` separately. See `scripts/test-resolved-handles-access.mjs`.
2. **Keep `AI_PROXY_BASE_URL` empty unless a reachable proxy exists**, and make
   an unreachable optional backend fail in one attempt rather than burning the
   retry budget. This is the largest measured win available and is independent
   of the branch.
3. **Fix two diagnostics before any revival.** `search_cache` identity rows are
   permanent with no sweeper (`_shared/search/store.ts`), reproducing the
   `resolved_handles` defect this branch criticises. And `googleSearch.ts`
   reports `quotaExhausted: true` whenever grounding is unavailable, but
   `groundingAllowed()` returns false for three different reasons — disabled by
   policy (`cap === 0`), ledger unreachable, or actually exhausted. With the cap
   deliberately at 0, every empty retrieval now blames the quota when the real
   cause is engine suspension. Observed 2026-10-02: tunnel up, shim up,
   container up, engines suspended, and the API said `quotaExhausted: true`.
4. **If any part of the pipeline is revived, revive `discoverEventOnWeb` only.**
   Host pinning is the gap with no deterministic substitute for organizers who
   run no Lichess team. `findUsernamesOnWeb` was 85% of the call volume and
   contributed nothing measurable; better seeds already exist, ranked, with
   `resolved_handles` rows among them.

## What would reopen this

- A zero-cost retrieval host that is not this laptop and not a single
  residential IP. Engine capacity, not code, is the binding constraint.
- The hosting dependency being solved. That is now the binding constraint, not
  engine capacity.
- Post-proxy-fix measurement showing host pinning, rather than seed
  acquisition, is the dominant remaining failure — which would justify item 3
  on its own.
- Evidence that organizer research does not generalise beyond Lichess-team
  organizers, leaving host pinning unservable deterministically.

## Consequences

Discovery keeps failing for the two narrow gaps until one of the above changes.
That is the status quo, not a regression: the grounded path it replaced is dead,
and the search path it added was already returning empty in production. The
deterministic engine is the competitor for the same hours, and with the proxy
fixed it gets back roughly 100 seconds of useful work per search.

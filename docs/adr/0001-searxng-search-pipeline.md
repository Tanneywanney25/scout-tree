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

- All general engines suspend this address under modest load. After ~5 hours
  idle, duckduckgo + google cse + wikipedia recovered (26 results); brave and
  google (CAPTCHA) did not.
- Capacity inside a recovery window is about **12 queries**. One discovery
  request costs 8. duckduckgo then escalated from `timeout` to `access denied`.
- So a single residential address supports roughly **one or two lookups per
  five-hour window**. Volume is not available at any price we are willing to pay.

Two findings reframed the comparison:

- **An unreachable optional AI backend cost 25.6 s on every model-using call.**
  `AI_PROXY_BASE_URL` pointed at a dead tunnel; `callAI` tries the proxy first
  and `geminiFetch` retries both a 5xx and a thrown fetch across a 25 s budget
  (`_shared/ai.ts`). Clearing one secret took a trivial model call from
  **26,625 ms to 979 ms** (medians, n=3 each). This was the single largest
  latency item in the system and had nothing to do with retrieval.
- The earlier 8%-of-lookups baseline was measured **under that handicap**: the
  live runs made 1,143 `findUsername` and 197 `discoverEvent` calls "at an
  average of 25 s each, all empty", and work on the first event started at a
  median of 108 s. The deterministic engine was being starved of its own 240 s
  budget by the search path's failure mode.

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

A production dependency on a laptop, a Docker container, and a Cloudflare quick
tunnel whose hostname is discarded on every restart is not acceptable, and the
engines cap throughput below one lookup per hour regardless. Five tunnel
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
- `engine-health.mjs` showing the ~12-queries-per-window ceiling has materially
  improved.
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

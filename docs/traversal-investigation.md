# Find Player traversal investigation

> **Note on identifiers.** The six sampled players are referred to as P1-P6. Their USCF member ids were removed before this document was committed: this repository is public, and recording which specific members were used as identity-resolution subjects works against the opt-out guarantee the same system is meant to honour. The ids were row labels only - no number in this document depends on them.

Investigation only. No application source was changed, nothing was committed. Code read at `main` `5be5071`; experiments run 2026-10-01, 02:10–05:15 UTC, against the production edge function and the live Chess.com, Lichess and US Chess APIs. Scratch scripts and raw results are outside the repo (see the appendix).

## The three findings that most change what to build next

**1. The archive 5xx problem does not reproduce. What is failing is seed discovery, and most of it is self-inflicted.**
About 3,400 Chess.com monthly-archive requests (serial and up to 96 in parallel, from Node and from a real browser tab) returned 200 without exception, and 37 live searches logged no archive failure. The actual limiter is a Cloudflare rule of roughly 300 requests per 10 seconds per IP that blocks every `api.chess.com` endpoint at once; a single search stays well under it. What the live pipeline spends its five minutes on is: discovery calls that take 25 seconds each to report an exhausted search quota (1,340 of them in the baseline), handle guessing (63% of all Chess.com requests were 404s; about 1,060 profile lookups per seed found), and Lichess 429s that its 20-second pause does not clear. Fixing those is days of work and is Phase 0 of the plan.

**2. The premise holds only for players with online-rated USCF games, and that is a third of the active population.**
68% of sampled active players have never played an online-rated game, so no game can align and no layer depth helps. Co-participants of an over-the-board section share an online-rated section 1.8% of the time. Inside the online-rated world the opposite is true: 74% of co-participants share a second online section, five event series account for 80% of all online sections, and 7% of players hold 80% of them. A literal level-order walk over all crosstables reaches hundreds of people at layer 0 and tens of thousands at layer 1, which is hours of API time per search at the measured limits.

**3. The lift is in keeping what each search proves, not in searching deeper.**
The hop the proposal describes already exists and is fast: once any section-mate's handle is known, the engine found the tournament and aligned the whole section in 3 to 16 seconds. It then throws away the 10 to 35 other identities it proved, never reads the table of handles it has stored, and ignores a stored tournament link for any event whose title names a platform. A level-order snowball from a single aligned section resolved 788 players in two hops with 1,761 Chess.com requests and no throttling. Build the persistent section-and-identity graph, feed it from a background worker, and a search for an online-rated player becomes a lookup. Expected resolution for that group goes from a measured 26% toward a modelled ceiling near 87%; for everyone else it stays where it is.

---

## Decisions and assumptions

Places where the brief was ambiguous, or wrong against the code or the data, and what I did instead.

1. **"Next.js on Vercel."** The app is a Vite React single-page app served statically by Vercel, plus one cron function. There is no server-side rendering and no Vercel code on the Find Player path. I evaluated it as that.
2. **"Chess.com monthly archive fetches are returning 5xx."** I could not reproduce one. I treated the task as "find out what is actually failing" and report that in section 3.
3. **"Order by number of online tournaments the person has played on Chess.com or Lichess."** That number is unknowable until the person is resolved. I used the count of online-rated USCF sections from the member's games feed, which is available beforehand and is what the platform count would be measuring anyway.
4. **"Layer 0 is every player who shares a USCF tournament with T."** I measured both the literal version (all crosstables) and the online-rated-only version. Only the second has edges the algorithm can use, so the lift estimates are for the second.
5. **"Co-presence in a verified tournament counts as an edge."** I read "verified" as "a tournament whose games align with a USCF crosstable". Co-presence in public arenas is excluded: the median tournament on sampled Chess.com histories has 113 players, a fifth have over 500, and Chess.com's API will not list more than 25 participants of a live tournament anyway.
6. **"Game alignment is dispositive and nothing overrides it."** True for alignments with at least three verified rounds and two corroborating opponents (no wrong assignment among 10,207 strong assignments made on incomplete data). Not true for weaker ones, which were wrong 3–21% of the time depending on how much data was missing. I kept the hierarchy and added a strength condition (section 6.1).
7. **"Accept the same handle on the other platform only if the rating correlates plausibly."** Tested and rejected: the gate accepts 33% of true pairs and 26% of mismatched pairs (section 5.8).
8. **"Unbounded, strictly level-order traversal."** Affordable to layer 0 live and to layer 1 only for small targets (section 3.6). I evaluated it as specified, then recommend running the same expansion once in the background instead of per search.
9. **Baseline method.** The live path runs in a browser. I ran the same engine bundle under Node against the same production edge function and the same platform APIs, one fresh process per player, with a 240-second soft stop (the engine's own limit is six hours). "Resolved" means a tournament-proven account at ≥0.85; name-search results capped at 0.62–0.70 are reported separately as leads. Correctness of resolved handles was not independently verified except for the two known players.
10. **Sample.** Activity-weighted, drawn from events rated in the last 15 months. It describes the players a user is likely to scout, not the whole membership file.
11. **Local `main` is one commit behind `origin/main`** (a README change). Nothing was pulled.

---

## Task 1 — What already exists

Everything below was read from code at local `main` (`5be5071`; `origin/main` is one README-only commit ahead). Where a comment or doc disagrees with the code, the code is what is reported. The production bundle at chess-scout.vercel.app was downloaded and contains this same engine (organizer research, whole-section alignment).

### 1.1 Pipeline, user input to verdict

| Step | Where | What actually happens |
|---|---|---|
| Pick the person | `src/pages/FindPlayer.tsx`, `src/components/findplayer/AnchorCard.tsx`, `UscfMemberPicker.tsx` → `resolveAnchor()` `resolver.ts:266` → `searchUscfMembers()` `edgeClient.ts:444` → edge mode `memberSearch` → `handleMemberSearch()` `anchor.ts:144` | One MUIR `/members?Fuzzy=` search, cached 12 h in `muir_cache`; in-memory limiter of 25 calls / 10 s per client IP per isolate (`anchor.ts:55-67`). |
| Preview | `fetchMemberPreview()` `edgeClient.ts:483` → `handleMemberPreview()` `anchor.ts:205` | Member record, recent events, and any `resolved_handles` rows for that USCF ID. The card shows cached handles, but the hunt still runs the full pipeline. |
| Start the hunt | `startDiscovery()` `huntStore.ts:238` → `discoverAccounts()` `resolver.ts:282` → `resolveIdentity()` `resolver.ts:190` → `resolveIdentityCore()` `resolver.ts:357` | Runs entirely **in the browser tab**. State lives in module-level variables of `huntStore.ts`; closing the tab ends the search. |
| Anchor phase | `PROVIDERS` in `providers/index.ts` (uscf, fide, google "ai-web", chessresults) — all four read one memoized edge call `fetchEdgeIdentity()` `edgeClient.ts:116` (`{query}`, 90 s client timeout, one retry) | Edge default branch `resolve-identity/index.ts:734-872`: `resolveMembers()` → `buildOnlineGraphForMember()` `uscf.ts:647` concurrently with an AI reasoning call. |
| Primary discovery | `getTournamentGraph()` → `runGraphTraversal()` wrapper `providers/uscfGraph.ts:50` → engine `runGraphTraversal()` `uscfGraphEngine.ts:1452` | See 1.2. |
| Fallback 1 | `findUsernameCandidates()` `edgeClient.ts:284` → edge `findUsername` → `findUsernamesOnWeb()` `googleSearch.ts:411` | Google index via Programmable Search if keyed, otherwise Gemini grounded search. Results verified with `verifyAccount()`; capped at 0.70 (`resolver.ts:113`). |
| Fallback 2 | `runSchoolResolver()` `providers/schoolResolver.ts:99` → `runSchoolResolution()` `schoolResolver.ts:931` | School roster → schoolmates' handles → friends/opponent overlap. Capped at 0.90. Skipped when `allowSocial` is false. |
| Fallback 3 | `NAME_FALLBACK_PROVIDERS` (`providers/lichess.ts`, `providers/chesscom.ts`) | Platform name search, capped at 0.62 (`resolver.ts:108`). |
| Verdict | clustering + `buildIdentity()` `resolver.ts:1049`, `scoreFromEvidence()` `confidence.ts:26` | Log-odds sum of evidence weights, logistic squash, clamped to 0.02–0.985. UI buckets: ≥0.75 high, ≥0.45 medium. Up to four identities returned. |
| Persist | `persistConfirmedHandles()` `huntStore.ts:186` → `storeResolvedHandle()` → edge `claimHandle` → `putResolvedHandle()` `identityStore.ts:200` | Only the **target's** accounts with confidence ≥0.75 and no "namesake" caveat are written. Every opponent the search mapped along the way is thrown away. |

### 1.2 The traversal engine (`src/lib/identity/uscfGraphEngine.ts`, 4,880 lines)

Input is a `TournamentGraph`: the target's **online-rated** USCF sections only, each with a full crosstable.

1. **Stage 0, depth 0 only** (`:4337-4420`). `researchOrganizers()` (`organizerDiscovery.ts:682`) derives an organizer key from event names, finds a Lichess team, streams its swiss/arena history, and matches each USCF section to a tournament by date, rounds, clock and player count. `trySectionAlign()` (`:3199`) then pulls the tournament's games once and maps every crosstable player to a handle by constraint propagation (`sectionAlign.ts`: `alignSectionBest`, `alignmentTrustworthy`). Unknown hosts go to the web/flyer search (`discover()` → edge `discoverEvent`, persisted in `event_platform_cache`).
2. **Event loop** (`:4530-4592`). Up to 12 passes over events, `EVENT_AGENTS = 4` at a time. `workEvent()` (`:3956`) per event: located links → `tryGoogleTarget()` (`:3751`) → seed scouts `resolveMemberOn()` (`:2117`: Google leads, then `guessHandles()` name guesses and Lichess autocomplete) → `traceFromSource()` (`:3385`) pulls the seed's games in the event window, discovers tournament links from them, aligns rounds (`alignRounds()` `:1208`), and reads the handle on the other side of each board → `tryCrownTarget()` (`:2949`) / `recordTarget()` (`:2495`). `tryRoster()` (`:3044`) name-matches a tournament roster and does elimination.
3. **Opponent pivot** (`:4594-4841`). Ring 1 = unresolved direct opponents; ring 2 = other section players, capped at 24 (`:4835`). For each, `hooks.expandMember` fetches that member's own online graph and `divePivot()` (`:4631`) runs a full sub-traversal on it, then traces back through the shared event.

**Actual maximum depth today: one pivot hop.** Three hard gates enforce it: `pivotPossible = depth === 0 && !!hooks.expandMember` (`:1494`); the sub-traversal is started with `depth: 1` and hooks that omit `expandMember` (`:4650-4651`); the pivot block itself requires `depth === 0` (`:4619`). So the walk is: target's sections → one opponent's own sections → back. It never expands an opponent's opponents.

Other limits that the comments do not advertise:

- The graph holds at most **16 sections** per member (`maxSections` default, `uscf.ts:655`; neither the main query nor `handleExpand` overrides it). The engine header says it works "every online-rated USCF event". In the sample below, 45% of players with online history have more than 16 online sections (median 11, p90 150).
- Only sections dated 2020-03-01 or later are read (`uscf.ts:672`). 4.7% of sampled online sections predate that.
- The engine does nothing for a member without an OR/OQ/OB rating: `buildOnlineGraphForMember()` returns `[]` when `!member.hasOnline` (`uscf.ts:651`). OTB crosstables are never fetched anywhere in the product.
- Ordering inside the pivot is "simplest first" (fewest shared traceable events, then smallest own graph, `:4815`, `:4778`), three dives at a time (`DEEP_AGENTS = 3`), first crown aborts everything. That is a best-first race, not level order.

### 1.3 USCF ingestion (`supabase/functions/resolve-identity/uscf.ts`)

MUIR JSON API at `ratings-api.uschess.org/api/v1`. `fetchMemberOnlineSections()` (`:492`) pages `/members/{id}/games` (100 rows, up to 30 pages) and keeps OR/OQ/OB rows; `fetchSectionMeta()` and `fetchSectionPlayers()` (`:556`, `:578`) pull one section record and one standings page (≤250 rows) per kept section, four at a time (`mapLimit(chosen, 4)` `:697`). Pacing is `muirThrottle()` (`:158`): 50 ms base gap, ×4 on a 429 up to 2 s, decaying 0.8× per success. `fetchJson()` retries three times and returns `null` on exhaustion, which reads downstream as "no data".

### 1.4 Platform clients

- **Network discipline** `src/lib/identity/net.ts`: `politeFetch()` (`:332`). Chess.com: `chesscomGate = semaphore(8)`; two paced lanes, light 120 ms and archive 300 ms (`:121`); a 429 pauses every lane for 2 s × attempt and doubles gaps for 60 s. Lichess: `lichessGate = semaphore(1)` plus a 120 ms slot, separate single-file lanes for exports and team streams; a 429 pauses the whole Lichess queue 20 s, or 60 s if it is the second within two minutes. Circuit breaker: six consecutive transport failures open it for 45 s.
- **Chess.com** endpoints used: `/pub/player/{u}`, `/stats`, `/clubs`, `/games/archives`, `/games/{yyyy}/{mm}` (`chesscomMonthGames()` `:778`, 4 s header timeout), `/pub/tournament/{slug}` and its rounds/groups (`fetchChesscomTournamentGames()` `:634`, capped at 40 GETs), plus the cookie-authenticated friends scrape in `school.ts:744`.
- **Lichess** endpoints: `/api/user/{u}`, `POST /api/users`, `/api/games/user/{u}?since&until` (`lichessWindowGames()` `:954`), `/api/swiss|tournament/{id}/results` and `/games`, `/api/team/search`, `/api/team/{id}/swiss|arena`, `/api/player/autocomplete`.
- `src/lib/chessApi.ts` is the opening-tree scouting client and is not on the Find Player path.

### 1.5 Caching layers

| Layer | Location | Lifetime | Notes |
|---|---|---|---|
| `SharedCaches` (profiles, window games, Chess.com months, Google leads, failure sets) | `cache.ts:94` `getSharedTraversalCaches()` | 1 h, per tab | In-memory only. |
| `identityCache` | `cache.ts:122` | 1 h, per tab | Target handles only. |
| Edge-call memos | `edgeClient.ts` (`cache` 15 min, `expandCache` 10 min, `discoverCache` 5 min, `usernameCache` session, `previewCache` 5 min) | per tab | |
| Engine module memos | `rosterCache` `:1048`, `tournamentGamesCache` `:627`, `clubsCache` `:336`; per-run `seedCache`, `rosterTried`, `sectionAligned` | per tab / per run | |
| Lichess team history | `organizerDiscovery.ts:304-317`, `localStorage` `scouttree:lichess-team:*` | persistent per browser | The only browser-persistent cache. |
| `expandMemo` | `resolve-identity/index.ts:440` | 15 min, per warm isolate, ≤200 entries | |
| `muir_cache` | Postgres via `identityStore.ts:50-86` | TTL on read: events/games lists 6 h, event/section/crosstable 30 d, member 6 h, search 12 h | Working in production (`muirCacheConfigured: true`). |
| `event_platform_cache` | Postgres, `identityStore.ts:108-160` | 1 year | USCF event → platform and tournament slugs/ids. |
| `resolved_handles` | Postgres | permanent | Target handles only; see 1.6. |
| `chess_archive_cache`, `chess_failure_cache`, `chesscom_account_weight` | Postgres; accessors `identityStore.ts:327-514` | n/a | Tables exist in production but **nothing in the production path reads or writes them**. The only caller is the Node CLI (`scripts/trace-entry.ts:252-266`). The browser cannot reach them (RLS, no policies) and no edge route exposes them. |
| Chess.com CDN | Cloudflare | `cache-control: public, max-age=5` | Measured; ETags are honored (section 3). |

### 1.6 Supabase schema (`supabase/migrations/`)

App tables: `profiles`, `scout_usage`, `anonymous_scout_usage`, `training_positions`, `saved_scouts`. Identity tables, all RLS-enabled with no policies (service role only): `chess_cookies`, `resolved_handles (uscf_id, platform, username, confidence, evidence jsonb, source, verified_at, superseded_by; unique (uscf_id, platform))`, `muir_cache (kind, key, payload jsonb, fetched_at)`, `handle_optouts`, `event_platform_cache (event_id pk, platform, info jsonb, source, fetched_at, expires_at)`, `chess_archive_cache`, `chess_failure_cache`, `chesscom_account_weight`. All eight were confirmed present in the live project through PostgREST.

There is no table for crosstables as rows, for player↔tournament edges, for intermediate (non-target) identity mappings, or for search/job state. `resolved_handles` allows one handle per platform per member, although the engine itself has seen players with two Lichess accounts.

One integrity gap that matters for any shared graph: `claimHandle` is callable by anyone holding the publishable key (`verify_jwt = false`, `anchor.ts:342`) and accepts a caller-supplied `confidence` and `source: "engine"`.

### 1.7 Edge functions and their real ceilings

| Function | Modes | Budget in code | Client timeout |
|---|---|---|---|
| `resolve-identity` (`verify_jwt = false`) | `health`, `memberSearch`, `memberPreview`, `fideSearch`, `resolvedHandles`, `claimHandle`, `optOut`, `expandMemberId`, `discoverEvent`, `findUsername`, `findUscfId`, `findSchool`, `schoolRoster`, `chesscomFriends`, default `query` | Graph build deadline `RESOLVE_BUDGET_MS` 55 s; expand `EXPAND_BUDGET_MS` 45 s (`index.ts:76-77`, confirmed by the live health response). No overall deadline on `discoverEvent`, `findUsername`, school modes; their bound is Gemini's 30 s attempt timeout plus a 25 s retry budget (`_shared/ai.ts:139-140`). | 90 s query/expand, 180 s `findUsername`, 12–60 s others (`edgeClient.ts`) |
| `explain-move`, `training-hint` | one AI call each | none | n/a |

The platform's own wall-clock limit is not in the repo and I could not measure it without deploying; Supabase documents 150 s (free) and 400 s (paid) per request. Measured in the baseline: `findUsername` calls averaged about 25 s each while Gemini grounded search was out of quota. The Vercel side is a static Vite SPA (not Next.js) plus one cron function, `api/refresh-chess-cookie.js`, scheduled daily in `vercel.json` (the `.env.example` comment says hourly).

### 1.8 Concurrency controls and pooling

- Engine fleets: `EVENT_AGENTS 4`, `SEED_AGENTS 6`, `TRACE_AGENTS 3`, `VERIFY_POOL 8`, `DEEP_AGENTS 3`, `EXPAND_AGENTS 12` (`:116-128`). The conductor (`conductor.ts`) retunes seed 2–12, trace 1–6, event 1–6 and the Chess.com gate on 429 pressure. It exists only in the browser path.
- Platform gates as in 1.4. Edge side: MUIR pacer, `mapLimit(…, 4)`, Gemini 500 ms spacing, CSE three at a time.
- There is no database connection pool because there are no database connections: `identityStore.ts` makes one HTTPS request to PostgREST per cache read and per cache write. A 16-section graph build is 32+ REST round trips on a warm cache. `putResolvedHandle()` is read-then-write with no transaction.

### 1.9 Where the traversal stops, and what level-order unbounded search would require

It stops at depth 1, on online-rated sections only, inside one browser tab, with every intermediate result discarded at the end. To run level order to arbitrary depth, these would have to change structurally:

1. **Frontier ownership.** Today each event owns a private frontier (`EventState.frontier`) and each pivot dive is a nested `runGraphTraversal` with its own closure state. Level order needs one global queue keyed by layer, one global visited set, and a rule that layer N+1 is not touched until layer N is drained. The depth gates at `:1494`, `:4619`, `:4650` are the smallest part of that.
2. **Graph source.** `expandMember` returns one member's 16 newest online sections through a 45 s edge call. Layer 1 of a typical target is hundreds to thousands of members (section 5). The graph has to be stored as rows and expanded server-side, not rebuilt per member per search.
3. **State location.** `mapped`, `handleClaims`, `workStates`, link trust ledgers are closure variables in the tab. An unbounded search outlives a tab and an edge invocation, so this state has to be persisted and resumable.
4. **Termination.** The engine aborts on the first high-confidence crown and treats "no progress in a pass" as done. Unbounded level order needs an explicit budget and a negative cache, or it will not terminate on unreachable targets.

---

## Task 2 — Baseline

### 2.1 Method

35 players from the Task 5 sample, stratified over six rating bands: 23 with an online USCF rating, 12 without. Each ran through `discoverAccounts()` (the function the Find Player page calls) in its own fresh process, against the production edge function and the live platform APIs, with a 240-second soft stop and every HTTP request counted. Two players with known answers ran first as a harness check; both came back correct and are not in the statistics. Limitations are listed in 2.6.

### 2.2 Results

| | All (35) | Online-rated (23) | OTB-only (12) |
|---|---|---|---|
| **Resolved** (tournament-proven account, ≥0.85) | **6 (17%)** | **6 (26%)** | 0 |
| Lead only (name search, ≤0.62) | 9 | 1 | 8 |
| No verdict | 20 | 16 | 4 |
| Hard failure (crash, timeout, edge unreachable) | 0 | 0 | 0 |
| Latency, median | 287 s | 286 s | 338 s |
| Latency, p95 | 339 s | 316 s | 339 s |
| API calls per search, median | 316 | 649 | 29 |
| API calls per search, p95 | 1,262 | 1,262 | 45 |

Resolved by band, online-rated players: under 800, 2 of 4; 800–1199, 1 of 4; 1200–1599, 1 of 4; 1600–1999, 1 of 4; 2000–2199, 0 of 4; 2200+, 1 of 3. Weighted by how common online history is in each band, that is roughly **8% of all active players** resolved within five minutes.

All six resolved accounts are on Chess.com. Five came from whole-section alignment and one from a pairing chain. Two of the six rest on a single verified round and are reported by the engine at 98.5%.

### 2.3 Where the time goes

For the six that resolved:

| Player | First seed found | Match | Total | Calls |
|---|---|---|---|---|
| P1 | 171 s | 180 s | 197 s | 1,039 |
| P2 | 188 s | 204 s | 288 s | 634 |
| P3 | 205 s | 221 s | 246 s | 649 |
| P4 | 213 s | 219 s | 261 s | 811 |
| P5 | 227 s | 229 s | 267 s | 1,262 |
| P6 | 230 s | 235 s | 311 s | 775 |

The step the proposal cares about, from a resolved neighbour to the target, took between 3 and 16 seconds. Everything before it was the hunt for a first neighbour. Each seed was a player whose handle is their name (`H1`, `H2`, `H3`).

Across all 37 runs:

- In the 22 sample searches that reached the traversal, work on the first event started at a median of **108 s** (maximum 203 s). Before that the engine was waiting on discovery calls that each take 25 s to fail. The edge function answered 1,143 `findUsername` and 197 `discoverEvent` calls, at an average of 25 s each, all empty.
- 13,465 Chess.com profile lookups, of which 8,977 (67%) were 404s from guessed handles. 404s were 63% of all Chess.com traffic.
- Thirteen seeds found among 2,480 section players: about **1,060 profile lookups per seed**.
- 44 monthly-archive requests. Every one returned 200.

### 2.4 Where the failures happen

| Outcome | Count | Detail |
|---|---|---|
| No online-rated history, fallbacks only | 12 OTB-only | Google index unavailable (25 s), school lookup unavailable (25 s), then platform name search. Eight ended with a name-only lead between 0.04 and 0.62; four with nothing. |
| Online history invisible to the engine | 1 | Five "US Chess Blitz on Chess.com" events from 2017–18, dropped by the 2020-03-01 cutoff. Went to fallbacks. |
| Stopped at 240 s while still hunting for a seed | 14 | No section player's handle had been found. For nine of these every event was "unknown host" and discovery could not place it. |
| Seed found too late | 2 | First seed at 217 s and 268 s. |
| Wrong verdict known | 0 | Not independently checked. |

No run failed because of a Chess.com error. Zero 429s, zero 5xx, zero "didn't return" log lines in 14,272 Chess.com requests.

Lichess was a different story: of 740 requests, 188 returned 429 and 290 failed at the connection or timed out. Only 19 of 365 profile lookups succeeded. See 2.6.

### 2.5 Three follow-up experiments on the same engine

**Give the engine one neighbour's handle** (the test-only `seedMappings` option, player P1). 71 requests instead of 1,039. Wall clock was 101 s, of which 66 s was a stalled Lichess team search, 25 s was the dead Google wait, and **6.6 s was the actual work**: pull the neighbour's games, find the tournament, align 36 of 36 players.

**Same, but with discovery failing instantly.** The match did not arrive within 180 s. With nothing holding the seed scouts back, about 1,650 Chess.com requests, two thirds of them guessed handles, shared one queue with the 27 requests the seed's trace needed; the trace took 100 s to get through. Speculative guessing starves proven work because both share one queue.

**Give the engine the tournament directly**, as a stored `event_platform_cache` row would. It was ignored: 217 s, 778 calls, no match. The engine fetches discovery answers for every event at stage 0 but only applies them to events whose host is unknown (`uscfGraphEngine.ts:4421-4437`), and the later retry is skipped because the answer is already cached (`:4225`). This event's title says "on Chess.com", so its exact tournament slug was never used.

### 2.6 Limitations of this baseline

- **Node, not a browser.** Same engine bundle, same edge function, same APIs. The browser differs in one way that matters: when Cloudflare blocks, a browser sees a network error, not a 429 (section 3.3).
- **240-second stop.** The engine is designed to run for hours. Section 7 models what a longer wait would add.
- **Lichess was refusing this IP for most of the run.** I had probed Lichess limits half an hour earlier, and the engine's own retries kept the block alive; single test requests were still refused more than ten minutes after the last baseline search, when further runs began. This slows the name-search fallback (the OTB-only latencies are inflated by it) and hurts any target whose events ran on Lichess. It does not affect the six Chess.com resolutions.
- **One contaminated attempt was discarded.** A profile-harvesting script of mine ran beside the first player and tripped Chess.com's limiter. That run was thrown away and repeated alone.
- **The last five online players ran alongside one other search** to save time. One of five resolved, against five of eighteen for the solo runs.
- **Thirty-five players.** The 95% interval on 26% is wide: roughly 12% to 47%.

**A longer wait does help.** Two players who were unresolved at 240 s were re-run alone with a 14-minute stop. Both resolved: one at 292 s (846 calls), one at 499 s (3,752 calls). In both cases the target's own handle turned out to be their name, which the engine by design never guesses for a target. So 26% is a five-minute figure, not the engine's limit.

---

## Task 3 — Rate limits and the 5xx problem

### 3.1 Headline

**The archive 5xx did not reproduce, anywhere, at any rate I could generate.** About 3,400 monthly-archive requests returned 200 with no exceptions: serial and up to 96 in parallel, cold and cached, 2 KB to 13 MB, from Node, from a real browser tab, with and without browser-style `Origin` headers, at two times 95 minutes apart. The 37 live searches in section 2 made 44 archive requests between them and logged no data holes.

What does exist is throttling, on three different services, plus a dead dependency. None of it is specific to archives.

| Service | Real limit (measured) | What the code does | Consequence seen in live runs |
|---|---|---|---|
| Chess.com | Cloudflare rule, about **300 requests per 10 s per IP**, all `api.chess.com` paths pooled | 8 in flight, about 12 requests/s at most | None for a single search. Not safe for several tabs, a shared office IP, or any server-side pool. |
| Lichess | Per-endpoint buckets. `/api/games/user`: about 8 in a burst, then roughly one every 2 s | One in flight with a 120 ms gap (about 8/s); 20 s pause on a 429 | 188 of 740 requests returned 429 and 290 more timed out or failed to connect. 19 of 365 profile lookups succeeded. |
| MUIR | About 3–5 requests/s sustained for one IP; 10/s locks out for 27 s | 50 ms base gap (20/s), ×4 on a 429 | Hidden by `muir_cache`; shared by every user through one egress. |
| Gemini grounded search | Out of quota today | Waits 25 s per call before reporting failure | Every search loses 25–130 s before real work starts. |

### 3.2 Chess.com in detail

| Test | Requests | Result |
|---|---|---|
| User-agent matrix | 22 | `curl`, `python-requests`, `Go-http-client` and an empty UA get **403** with a Cloudflare challenge. Node, Deno, okhttp, Chrome and a descriptive custom UA get 200. |
| 472 archive months, serial, unpaced, run twice (02:17 and 03:52 UTC) | 944 | All 200. Natural rate 2.9 requests/s. |
| Concurrency ladder 1 → 24, all cold | 540 | All 200. 36.6 requests/s at 24. |
| 32 → 96 concurrent | 480 | All 200. 68 requests/s at 96. |
| One account: 2 → 16 of its months at once; six of its endpoints at once; one URL 12 times at once | 210 | All 200. There is no per-account or per-URL limit. |
| 555 cold months, 8 in flight, 24.7 s | 555 | All 200 at 22.5 requests/s. |
| Browser-style `Origin`/`Referer`/`sec-fetch` headers, 8 → 32 concurrent | 240 | All 200. |
| Real browser tab, 8 / 24 / 48 concurrent | 334 | 333 × 200, one genuine 404. |
| 50 months of the heaviest accounts in the pool | 50 | All 200. |
| Steady 20 and 27 requests/s for 25 s | 1,175 | No 429. |
| Steady 34 requests/s | 328 | First 429 at 9.6 s. |
| Steady 45 requests/s | 345 | First 429 at 7.7 s. |
| Bursts of 300+ in about a second | several | 429 after 162–305 requests. |

Characterisation of the limiter:

- **Per IP, per time window, nothing else.** It tripped the same way on existing profiles, on not-found profiles and at different user agents, and at the same count.
- **It blocks everything.** At the moment of the 429, profile, stats, archive list, archive month and tournament endpoints all returned 429. It is not per-endpoint.
- **The response is a Cloudflare challenge page** (`cf-mitigated: challenge`, HTML body "Just a moment…"), with no `Retry-After` and no rate-limit headers on any response, before or after.
- **Recovery** took about 1 s when the rate was just over the line and 8–11 s after a hard burst.
- **Not time-of-day dependent** across the two samples I have. I could not test a full day.
- **Size affects latency, not success.** Time to first byte rises about 0.3 s per MB of JSON (r = 0.9): median 0.11 s under 50 KB, 0.45 s at 0.5–2 MB, 1.1 s at 2–10 MB, 2.6–3.5 s for the one 11.9 MB month. Repeats are served from the CDN in 0.2–0.4 s. The engine's header timeout for archives is 4 s (`uscfGraphEngine.ts:842`). Nothing crossed it from Node; the maximum in a browser tab was 3.7 s on a 9.5 MB month. A slower connection or a heavier month would cross it, the retry would then usually land on the CDN copy.
- **Compression**: responses arrive gzip- or brotli-encoded; Node and browsers decode transparently. No sign of a body-size limit.
- **Caching**: `cache-control: public, max-age=5` on everything, including months that closed years ago. ETags work: `If-None-Match` returned 304 in about 30 ms with an empty body on 30 of 30 months. `Last-Modified` carries the fetch time in a non-standard format and `If-Modified-Since` never produced a 304.
- **Roster truncation**: `/pub/tournament/{id}` returned exactly 25 players for 13 of 13 live tournaments that had more (up to 2,152 registered). Only a daily tournament returned its full list.

### 3.3 So what are users seeing?

The strings "archive shards failed" and "data hole" are not in the production bundle any more; the current wording is "Chess.com didn't return …". In 37 live searches that line was logged zero times. Ranked by evidence, the things that make a search end without a verdict today are:

1. **The search backend is out of quota and fails slowly** (measured, every run). `findUsername` and `discoverEvent` each took 25 s to return `quotaExhausted`. The health check passes because it tests a plain completion, not grounded search.
2. **Seed hunting by handle guessing** (measured). 63% of all Chess.com requests in the live runs were 404s. It took about 1,060 profile lookups to find each seed. The true handle is among the engine's guesses for 7.3% of Chess.com players and is accepted for 4.7%.
3. **Lichess throttling** (measured). Of 740 Lichess requests in the live runs, 188 were 429s and 290 timed out or failed to connect. The conductor then steps down the Chess.com gate as well, because `conductor.netEvent()` ignores which platform sent the 429. Part of the volume here is my own doing (section 2.6), but the engine's pacing for game exports is about sixteen times the measured refill rate on its own, and its 20-second pause was not enough to clear a block.
4. **A Cloudflare block looks like a network failure in a browser** (measured). In a real tab, 600 requests at 40 in flight gave 329 successes and then 271 `TypeError: Failed to fetch`. No 429 was ever visible to the page, because the challenge response carries no CORS header. Recovery took 8 s. `politeFetch()` counts those as transport failures; six in a row open its circuit breaker for 45 s, during which every Chess.com call fails instantly and every archive in flight becomes a hole. None of the 429 handling in `net.ts` runs. One search does not reach the limit by itself. Several tabs, or several users behind one address, would.
5. **A real upstream incident at some earlier date.** I cannot rule this out and cannot test it. The August probe in this repo also found no 5xx.

Things I checked and excluded: Vercel is not in the request path (the SPA calls the platforms directly); Supabase egress is only used for MUIR, AI and the cookie-authenticated friends scrape; edge calls took 1–3 s whenever their backends answered; gzip is handled; serial versus parallel month fetching makes no difference to Chess.com.

### 3.4 Lichess in detail

| Endpoint | Measurement |
|---|---|
| `/api/user/{name}` | 80 serial requests at 3.8/s: all 200. Two and four at once: fine. Eight at once: served, but queued to a 2.4 s median. Sixteen at once: 6 of 27 returned 429. A sustained test was not possible afterwards; by the end of the baseline this IP was refused on every request. |
| `/api/games/user/{name}?since&until` | From a quiet minute: 429 on the 18th request at 1/s, on the 10th at 2/s, on the 9th at 3/s. Recovered within 3 s. Three at once: one immediate 429, the other two served after 5.2 s. That fits a bucket of about 8 with a refill near 0.5/s. |
| `/api/swiss/{id}/games` | 24–26 games in 0.8 s; streams at about 30 games/s. |
| `/api/swiss/{id}/results` | 0.28 s median. |
| `/api/team/{id}/swiss` | Streams at 19.8 rows/s; a 1,700-tournament history took 89 s. |
| `POST /api/users` | 300 ids in one call, 0.27 s. |
| `/api/user/{name}/tournament/played` | Exists; arenas only. |

**Can Lichess carry more of the load? Not per player, yes per tournament.** Pulling one player's games is limited to about one request every two seconds, which is roughly 50 times less than Chess.com allows. Pulling a whole tournament is one request and maps a whole section. The design consequence is the same on both platforms: resolve sections, not people.

### 3.5 Mitigations, tested in scratch scripts

| Mitigation | Test | Result |
|---|---|---|
| Bounded rate (token bucket sized to the window) | 600 cold archive months, 12 in flight, at 25 and at 28 requests/s | 600 of 600, no 429, 24.6 s and 22.9 s |
| The engine's current discipline | 200 months, 8 in flight, 300 ms archive lane | 200 of 200, no 429, 60.2 s. Safe, and about seven times slower than it needs to be. |
| Naive fan-out, instant retry | 600 months, 48 in flight | 348 succeeded, 252 failed after three retries. 1,012 of 1,360 requests were 429s. |
| Exponential backoff with jitter, pausing all workers | Same fan-out | 600 of 600 in 20.2 s, at the cost of 161 rejected requests. In a browser each of those is an opaque network error, so backoff alone is the wrong tool; do not exceed the window in the first place. |
| Request coalescing | 200 logical requests for 40 URLs | 200 sent in 2.8 s without, 40 sent in 0.7 s with. The engine already does this per search (`SharedCaches.ccMonths`). |
| Conditional requests | 120 months re-requested with `If-None-Match` | 120 × 304, zero bytes, 4.7 s, against 78 MB and 8.9 s cold. `If-Modified-Since` does not work. |
| Persistent archive cache | Second pass over the same 120 months | Zero requests. The tables and accessors already exist and nothing in production uses them. Worth little to the engine as it stands, which made 44 archive requests in 37 searches; worth a lot to a background worker. |
| Partial-archive tolerance | Whole-section alignment with games removed (section 6.1) | Strong assignments stayed correct in every trial. Weak ones went wrong 3–21% of the time while the section still passed its trust check. So a hole should downgrade the verdict to "strong assignments only", not pass or fail the whole section. |

Recommended client discipline for Chess.com: one bucket for all endpoints at 20 requests/s per IP, trace and bracket requests ahead of speculative probes in the queue, ETag revalidation for the current month, closed months stored permanently, and no reliance on seeing a 429.

### 3.6 What the traversal can afford

Measured cost of one hop, from a resolved player to a newly aligned section: one archive month (shared by every section that player has in that month), 8.8 bracket requests on average, one MUIR crosstable. About 10 Chess.com requests and one MUIR request yield about 32 identities. Finding out which sections a player has costs one to six MUIR requests.

| | Chess.com requests | MUIR requests | Wall clock at safe rates (20/s Chess.com, 3/s MUIR) |
|---|---|---|---|
| One hop (one section) | ~10 | 1–7 | under 10 s |
| Search at layer 0, a co-participant or link already stored | 10–60 | 0–20 (cached crosstables) | 5–15 s |
| Search at layer 0, cold, as the engine does it today | 30–1,618 (median 649) | via edge | 200–330 s, 26% success within 240 s |
| Layer 1, exhaustive, live: every layer-0 member's other online sections (median 256 members, about 20 unseen sections each) | ~50,000 | ~6,000 | 40 min Chess.com, 35 min MUIR |
| Layer 1 for a hub-heavy target (1,192 members) | ~240,000 | ~27,000 | over 3 h |
| Layer 2 | The whole online-rated corpus: an estimated 20,000–30,000 sections since 2020 | ~130,000 to enumerate events | about a day, once |

**Hard ceiling.** For a live, per-search, level-order walk it is layer 1, and only for targets with small sections. MUIR binds first because its budget is shared by all users through one egress. Chess.com binds second at 30 requests/s per IP. "Unbounded" is therefore not a search depth; it is a one-off ingestion of a finite corpus, after which depth costs nothing.

---

## Task 4 — Gap analysis

### 4.1 Element by element

| Element of the proposal | In the repo today | Verdict |
|---|---|---|
| Layer 0 = everyone on T's crosstables | Online-rated sections only, at most 16 per member, 2020-03 onward (`uscf.ts:651-691`). OTB crosstables are never fetched. | Rework. The OTB part should stay out (section 5 shows it carries no usable edges). The cap and cutoff should go. |
| Resolve layer members first | `resolveMemberOn()` `uscfGraphEngine.ts:2117`: Google leads, then handle guessing, each verified against the event's games. | Reusable, but it is the bottleneck (about 1,060 profile lookups per seed found, section 2). |
| Order by online tournament count | Not present. The pivot does the opposite (`bySimplestPivot` `:4815`, smallest graph first `:4778`). Seed order inside an event is direct opponents, then name uniqueness. | Missing. The USCF games feed gives the count for free. |
| Order by name rarity | `nameUniqueness()` `:206`, used for seed order (`:4077`). | Reusable as-is. |
| Pull P's online tournament history | Only P's games inside the shared event's date window (`traceFromSource()` → `linksFromGames()` `:1088`). P's tournament list (`/pub/player/{u}/tournaments`, `/api/user/{u}/tournament/played`) is never called. | Partly exists. The window-games route is the better one; it yields the exact tournament and the date in one call. |
| Find accounts co-present with P | `fetchRoster()` `:1050` and the bracket walk `:634`. On Chess.com the roster call returns at most 25 players for live tournaments (measured on 13 of 13 live tournaments larger than 25), so the public-pool size check in `tryRoster()` `:3072-3074` can never fire for Chess.com, and elimination cannot complete for any section larger than 25. | Rework. Co-presence has to come from bracket games, which `fetchChesscomTournamentGames()` already fetches. |
| Test those accounts against T by game alignment | `sectionAlign.ts` (whole section), `alignRounds()` `:1208`, `tryCrownTarget()` `:2949`. | Reusable as-is. This is the strongest part of the codebase: one section resolved 36 of 37 players from 11 requests. |
| Expand to layer N+1 | One hop only (section 1.2). Dives are nested full traversals, three at a time. | Rework. |
| Strict level order | Not present. Order is per-event agents, per-event frontiers, then a best-first pivot race that stops at the first crown. | Missing. |
| Unbounded depth | Not present, and not affordable as a live per-search walk (section 3.6). | Replace with background ingestion. |
| Edges only from verified Chess.com / Lichess tournaments | `linkTrusted()` `:1916`, `validatedLinks`, `alignmentTrustworthy()`. ICC and ChessKid events are skipped. | Reusable. |
| Game alignment is dispositive | Structural methods get the full log-odds stack and reach the 0.985 clamp easily. `mapGate()` `:2069` lets country, state or a different displayed name veto a mapping from a *partial* alignment; a full alignment bypasses it. Location is ±0.6/−0.9 log-odds on the crown, never a veto. | Matches the stated hierarchy for full alignments. Needs a per-assignment strength term (section 6.1). |
| Same handle on the other platform | `candidatesForPlatform()` `:1782` re-tries Google leads on the other site. Not applied to resolved handles, no rating gate. | Missing, and section 5.8 shows the proposed rating gate does not work. |
| Persistent identity graph | `resolved_handles` is written for targets and **never read by the traversal** (`fetchResolvedHandles()` has no caller). `event_platform_cache` stores tournament slugs, but the engine ignores them for any event whose title already names a platform (verified by experiment, section 2.5). Seeds are a test-only option that the production wrapper strips (`providers/uscfGraph.ts:50`). | Missing in effect. |
| Negative caching | Per run only: `dudHandles`, `deadEndOpponents`, `junkLinks`, failed-month sets. `chess_failure_cache` exists but is unused in production. | Missing. |
| Seeding | None. | Missing. |
| Bidirectional search | None. | Missing. |
| Background execution, polling | None. Everything runs in the tab. | Missing. |

### 4.2 Reusable as-is

`sectionAlign.ts`; `organizerDiscovery.ts`; `alignRounds()` and `targetEdgeCandidates()`; the MUIR client and `muir_cache` in `uscf.ts`; the accessors in `identityStore.ts`; `verify.ts`; the semaphore and circuit-breaker shells in `net.ts`; the `chess_archive_cache` schema.

### 4.3 Needs rework

The control flow of `runGraphTraversal()` (one global frontier instead of per-event state and nested dives); seed acquisition order (stored identities first, guessing last); `recordTarget()` scoring for weak alignments; `tryRoster()`'s Chess.com roster assumption; where discovery answers are applied; `conductor.netEvent()`, which ignores its `platform` argument so a Lichess 429 throttles the Chess.com gate; pacing constants; the 16-section cap and 2020 cutoff; the `unique (uscf_id, platform)` constraint on `resolved_handles`.

### 4.4 Where the architecture fights the design

- **Edge function timeouts.** Graph expansion is one member per edge call with a 45 s budget and a 16-section cap. Layer 1 of a median online target is about 440 members. Every MUIR call from every user leaves through the same Supabase egress, and MUIR's sustained ceiling measured at roughly 3–5 requests per second for one IP.
- **No persistent graph.** A search that aligned a 37-player section kept one row. The next search for any of the other 36 players starts from zero and spends about three minutes guessing handles to rediscover the same tournament.
- **Synchronous, in-tab execution.** All traversal state is closure-local in the browser. There is no resume, no sharing between users, and no way to continue after the tab closes. The current cap on usefulness is the user's patience, about five minutes.
- **Unauthenticated writes.** `claimHandle` accepts any caller's assertion with any confidence. A shared graph built on that endpoint could be poisoned by one script.
- **Dependency failures are slow, not fast.** With Gemini grounded search out of quota, each discovery call takes 25 s to say so. A player with 16 unknown-host events waits about 130 s before any real work starts.

---

## Task 5 — Is the premise true?

Short answer: **not for the USCF graph as a whole, yes for the online-rated part of it.** The traversal cannot confirm anyone who has never played an online-rated USCF game, and that is about two thirds of active players. For players who have, the graph is dense, concentrated in a few event series, and connected through a small number of very active players.

### 5.1 The sample

900 members drawn at random from the crosstables of 198 sections of 120 events, themselves drawn at random from the 22,000 most recently rated events (July 2025 to September 2026). This is an activity-weighted sample: it over-represents people who play often, which is also who gets scouted. For the 291 members with an online rating, the full games feed was walked (up to 3,000 games each).

### 5.2 Who has any online-rated history

| Regular rating | Members | With OR/OQ/OB rating |
|---|---|---|
| Unrated | 32 | 0% |
| Under 800 | 232 | 12.1% |
| 800–1199 | 152 | 30.9% |
| 1200–1599 | 226 | 35.0% |
| 1600–1999 | 198 | 46.5% |
| 2000–2199 | 34 | 73.5% |
| 2200+ | 26 | 76.9% |
| **All** | **900** | **32.3%** |

Among the 818 members who entered the sample through an over-the-board section, 25.8% have online history. Game alignment needs an online game that corresponds to a USCF crosstable row. For the other 68%, no such game exists, so no layer depth can produce a confirmation. This is the ceiling on the whole approach.

### 5.3 How many online tournaments, and how heavy is the tail

Online-rated USCF sections per member, all 900: mean 16.4, **median 0**, p75 3, p90 31, p95 90, p99 330, max 840. Among the 291 who have any: median 11, p25 3, p10 1, p90 150. 6.9% of members hold 80% of all online-rated sections; 22 of the 291 hold half.

On the platform side, Chess.com's own tournament history for a mixed pool of 208 accounts (leaderboard, national masters, random US accounts) has median 0 finished tournaments, p75 4, p90 124, max 2,867. The tournaments on those lists are mostly public: median 113 players, 20% over 500.

### 5.4 Which events these are

14,754 online sections across the 291 members:

| Series | Share of sections | Members touching it |
|---|---|---|
| "US Chess Blitz/Rapid/Regular on Chess.com" (official weekly events) | 35.8% | 103 |
| "WNZ Rated" | 23.6% | 51 |
| "PCA Rapid Event" | 15.6% | 36 |
| DMV Chess (Lichess team) | 4.4% | 71 |
| "Grand Prix Rated" | 2.9% | 34 |
| ICC-hosted | 2.0% | 45 |
| Waltham | 1.5% | 24 |
| Everything else | 14.2% | 200 |

Volume by year in this sample: 1,060 sections in 2020, 749 in 2021, 503 in 2022, then 1,143, 1,431, 3,965 and 5,203 for 2023 through 2026 to date. Online-rated play is growing, not a pandemic relic. 26 of the 198 randomly sampled sections (13%) were online-rated. 53% of online members played an online-rated section in 2026; 20% have nothing after 2021; 26% have sections only outside the named series.

### 5.5 Edge density

| Pair type | Pairs | Share an online-rated USCF section |
|---|---|---|
| Co-participants of an **over-the-board** section | 4,545 | **1.83%** (83 pairs) |
| …of which both have online history | 502 | 16.5% |
| Co-participants of an **online** section | 365 | 93% share that one (feed truncation explains the rest); **74% also share another** |

Only 14 of 148 sampled OTB sections contained even one pair with an online edge. An OTB crosstable is, for this purpose, a list of people who mostly do not meet online in any verifiable way.

### 5.6 Branching factor

Twelve targets, two per rating band. Layer 0 is exact; layer 1 is estimated from 12 randomly chosen layer-0 members per target.

| | Median | Range |
|---|---|---|
| Sections played | 43 | 2–374 |
| Direct opponents | 120 | 8–690 |
| **Layer 0, all crosstables** | **441** | 39–3,421 |
| Layer 0, online sections only (six online targets) | 256 | 30–1,192 |
| Sections per layer-0 member (last 400 games) | 60 | 23–84 |
| Layer 1, all crosstables, upper bound before overlap | ~360,000 | 43,000–4.7 million |
| Layer 1, online only, upper bound | ~80,000 | 4,000–400,000 |

The layer-1 upper bounds exceed the active membership of the federation, so in practice layer 1 saturates at "most of the active player pool" and layer 2 is everyone. Each layer-0 member shares only one or two sections with the target; the rest of their history is new territory.

### 5.7 Does a hop actually work? A level-order snowball on real data

Start: one section ("US Chess Rapid on Chess.com", 2026-06-26) and its tournament. Each hop takes the players resolved in the previous hop, orders them by online footprint, expands the top 14, and for each tries five of their other online sections: fetch the player's archive month, read the tournament tag off games on the event date, walk the bracket, align the whole section.

| Hop | Frontier | Expanded | Sections tried | Tournament found | Section aligned | New players resolved | Chess.com calls | MUIR calls |
|---|---|---|---|---|---|---|---|---|
| 0 | 1 section | – | 1 | 1 | 1 | 36 of 37 | 11 | 1 |
| 1 | 36 | 14 | 70 | 63 | 54 | 477 | 815 | 189 |
| 2 | 477 | 14 | 70 | 70 | 54 | 275 | 935 | 1,895 (1,825 of them only to rank 477 members by footprint) |

Total: **788 USCF members resolved to Chess.com handles and 109 sections located, from 1,761 Chess.com requests (one 404, no 429, no 5xx)**. That is 2.2 Chess.com requests per identity. Aligned sections mapped 97% of their crosstable. The median frontier member had 65 online sections at hop 1 and 31 at hop 2, so the frontier was nowhere near exhausted; only 28 of 513 available players were expanded.

Success by series, section level, combining the snowball with a separate 60-section test across eras: official US Chess events 87% (94 of 108), WNZ 66% (29 of 44), Grand Prix 8 of 10, other organizers 38% (6 of 16). Bracket games were still retrievable for 2020 and 2021 events. Failures were almost all the wrong candidate tournament (the player also sat in a public arena that day) and were rejected by the alignment check, not accepted.

### 5.8 The cross-platform handle heuristic

184 ground-truth Lichess handles (from aligning 16 DMV Chess sections), each probed as the identical string on Chess.com:

- The string exists on Chess.com for 115 (63%). 67 fly a US flag, 47 a foreign one.
- 36 profiles show a real name. 20 match the USCF name; **16 are plainly a different person**.
- For the 27 pairs rated on both sites, Lichess minus Chess.com is +446 on average with a standard deviation of 465 (r = 0.62). A ±250 gate around the mean accepts 33% of true same-handle pairs and 26% of deliberately mismatched pairs. A ±500 gate accepts 70% and 49%.

A rating gate cannot tell a reused handle from a collision. The identical-handle probe is worth making as a lead, because it costs one request, but it must be confirmed the same way as anything else: by aligning that account's games against a crosstable.

### 5.9 Where it stops being viable

- **OTB-only targets: at layer 0.** There is nothing to align, and the edges out of layer 0 are 98% absent.
- **Online targets, live per-search walk: at layer 1.** Layer 0 is 30 to 1,200 people and affordable. Layer 1 is tens of thousands and costs hours at the measured rate limits (section 3.6).
- **Online targets, persistent graph: it does not stop.** The same expansion done once in the background covers the series that make up most of the corpus, and a search becomes a lookup.

---

## Task 6 — Open design questions

### 6.1 Confidence scoring and per-hop decay

**Recommendation: score the assignment, not the path. No per-hop decay for alignment-proven links; steep decay for anything else.**

Today every structural find stacks log-odds until it hits the 0.985 clamp (`recordTarget()`, `confidence.ts:26`). The baseline's first Chess.com crown was reported at 98.5% on one verified round. Two experiments say that is too generous for weak alignments and about right for strong ones.

*Complete data, 45 re-aligned sections, 4,885 pairs of assignments for the same member in different sections:*

| Pair | Agree | Disagree | Rate |
|---|---|---|---|
| Both strong (≥3 verified rounds and ≥2 corroborating opponents) | 2,504 | 25 | 0.99% |
| One strong, one weak | 1,438 | 56 | 3.75% |
| Both weak | 832 | 30 | 3.48% |

Eleven members had conflicting handles. For five of them both handles were backed by strong assignments, which is a real second account. For six the odd handle appeared only in weak assignments, which is a mis-assignment.

*Incomplete data, one 37-player section, 200 trials per row:*

| Missing | Passes `alignmentTrustworthy` | Wrong assignments, strong | Wrong assignments, weak |
|---|---|---|---|
| 5% of games | 98.5% | 0 of 3,608 | 6.1% |
| 10% of games | 82% | 0 of 2,393 | 14.5% |
| 20% of games | 18.5% | 0 of 450 | 20.9% |
| All of one player's games | 100% | 0 of 3,756 | 3.0%; the absent player was still given a handle in 2.6% of trials |

So "game alignment is dispositive" is safe for strong assignments and unsafe for weak ones. The model I would build:

- **Per assignment**: `strong` (≥3 verified rounds, ≥2 corroborating opponents, section passes the trust check) → 0.99. `weak` → 0.93 on complete data, lower when the tournament's game count is short of what the crosstable implies.
- **Combining**: two independent sections naming the same handle multiply the error terms. Two weak agreements are worth more than one strong one.
- **Per hop**: an alignment does not inherit uncertainty from how its tournament was found. If the route to the tournament was wrong, the alignment fails and nothing is recorded (that is what happened to every wrong candidate in the snowball). So the chain length does not enter the score. A chain that includes a non-alignment step (a name-matched seed, a Google lead, a same-handle probe) takes that step's own probability as a multiplier, and I would not let more than one such step into a confirmed verdict.
- **Thresholds**: show as confirmed at ≥0.97, which in practice means one strong assignment, two agreeing weak ones, or a federation-ID match. Show as "likely, one more event would confirm" from 0.85 to 0.97. Below 0.85 show candidates, not an answer. Refuse to name a single account when the best candidate rests only on name, rating and location, which is the entire OTB-only population.
- Location stays weak evidence and should lose its veto over partial alignments in `mapGate()`; a second section is the right tie-breaker there, not a flag.

### 6.2 Single answer or ranked list

**Both, by tier.** One answer with its chain when the confirmed threshold is met. Otherwise a short ranked list with the chain for each and an explicit statement of what would confirm it. Two things in the data argue against ever forcing a single answer: five of 236 multi-section members in the precision test had two strongly-proven accounts, and eight of the twelve sampled OTB-only players ended with name-search leads between 0.04 and 0.62 that are honestly "candidates".

### 6.3 A persistent identity graph

**Yes. It is the main recommendation of this report.** The evidence:

- A live search that resolved its target also proved 10 to 35 other identities and discarded them.
- With one stored co-participant handle the unchanged engine did the real work in 6.6 seconds and 58 Chess.com requests (versus 197 seconds and 976). 
- One section snowballed to 788 identities in two hops.
- `resolved_handles` exists but the traversal never reads it, and `event_platform_cache` is ignored for the events that make up a third of the corpus.

Schema sketch:

```sql
uscf_section        (event_id, section_no, name, start_date, end_date, rating_system, time_control,
                     rounds, n_players, fetched_at,                    primary key (event_id, section_no))
uscf_section_player (event_id, section_no, uscf_id, name, pre_rating, state, rounds jsonb,
                                                                       primary key (event_id, section_no, uscf_id))
online_tournament   (platform, tournament_id, name, starts_at, time_control, n_players, n_rounds,
                     n_games, fetched_at,                              primary key (platform, tournament_id))
section_link        (event_id, section_no, platform, tournament_id, source, assigned, n_players,
                     contradicted, status, verified_at,                primary key (event_id, section_no, platform, tournament_id))
identity_edge       (uscf_id, platform, handle, strength, rounds_verified, corroborating,
                     n_sections, first_event_date, last_event_date, evidence jsonb,
                                                                       primary key (uscf_id, platform, handle))
negative_cache      (kind, key, reason, expires_at,                    primary key (kind, key))
search_job          (id, uscf_id, status, layer, budget, result jsonb, created_at, updated_at)
```

`identity_edge` is many-to-many on purpose. `section_link.status` records rejected candidates as well as verified ones, which is most of the negative cache.

Expected density, from measured rates: each aligned section yields about 32 identities, 9 of them new at the snowball's stage of saturation. Five event series are 80% of online sections, and official US Chess events align 87% of the time, so a worker that follows hubs through those series reaches most of the online-rated population in days of background time, not months of organic searches. Organic use alone would add roughly one to sixteen links and ten to thirty-five identities per successful search of an online-rated player.

### 6.4 Seeding

**Seed with tournaments, not with people.** A bootstrap set of titled players exists and I measured it: 1,088 US-flagged titled Chess.com accounts publish a real name; 905 match exactly one USCF member with a plausible rating; 453 of those have online-rated history. (National masters were fetched completely; the international titles were sampled, so the true total is somewhat higher.) That is useful but smaller than what one aligned section gives after two hops (788 identities, every one of them an active online player by construction).

Better seeds, in order: (1) organizers that run a Lichess team, which the existing organizer research resolves with no seed at all (16 of 16 DMV sections, 184 of 186 players, 25 requests); (2) one resolved regular in each Chess.com series; (3) existing `resolved_handles` rows; (4) titled accounts. With any of these in place the average search depth for an online-rated target in a covered series is zero: the answer is already in the table.

### 6.5 Negative caching

| What | Key | TTL | Why |
|---|---|---|---|
| Member has no online-rated games | `uscf_id` | Until the member's games feed changes; recheck with the 6-hour events list | Stops the traversal from starting. Covers 68% of lookups. |
| Section's tournament candidates rejected by alignment | `section_link` rows with `status = rejected` | Permanent per candidate | Alignment against a fixed crosstable and a finished tournament never changes. |
| Section has no tournament-tagged games for any known participant | section | 30 days, cleared when a new participant is resolved | New identities bring new archives. |
| Handle does not exist (404) | platform + handle | 7 days | 63% of today's Chess.com requests are these. |
| Member tried by name and not found | `uscf_id` + method | 30 days | Prevents repeating 22 guesses per member per search. |
| Search backend unavailable or out of quota | global | 60 seconds to 10 minutes, shared in the database | Never cache this as "no result". The code already draws that distinction; it just does not share the cooldown across isolates. |
| ICC or ChessKid only | section | Permanent | No public game API. |

### 6.6 Bidirectional search

**Not as a live algorithm. Yes as a division of labour.** The measured branching (layer 0 in the hundreds, layer 1 in the tens of thousands) means the cost is in expanding nodes, not in path length, so meeting in the middle saves little per search. What does pay is making the "outward from the resolved pool" half a continuous background process, and reducing the "outward from T" half to: read T's sections, look them up, and if needed align one. That is bidirectional in effect, with only the cheap half on the request path.

### 6.7 Pivot ranking

The user's two terms are right but need a third in front and a proxy for the first.

```
priority(P) = 1000 · known(P)
            +  4.0 · linkedShared(P, T)
            +  2.0 · log2(1 + shared(P, T))
            +  1.0 · log2(1 + onlineSections(P))
            +  0.5 · rarity(P)
            −  0.5 · log2(1 + sectionsStillUnlocated(P))
```

- `known(P)`: P already has a stored identity. It costs nothing and is always first.
- `linkedShared`: number of T's sections P is in that already have a verified tournament link.
- `shared`: number of T's traceable sections P is in.
- `onlineSections(P)`: P's count of online-rated USCF sections. This stands in for "online tournament count", which cannot be known before P is resolved. It is log-scaled because the distribution is extreme (median 11, p99 507).
- `rarity(P)`: the existing `nameUniqueness()` in [0, 1].
- The last term discounts hubs whose own history is mostly unexplored when the goal is a quick answer rather than coverage. The background worker should drop it.

Justification for the weights. Footprint over rarity: the true handle is among the engine's guesses for only 7.3% of Chess.com players and 14.1% of Lichess players, and passes the real-name gate for 4.7% and 2.2%, so name-driven resolution is a low-yield path whatever the name; rarity only improves a channel that is currently down (the Google index). Footprint, by contrast, directly predicted yield: the 28 hubs expanded in the snowball produced 752 new identities. Shared sections over footprint: a hop is only useful to T if it lands in one of T's sections. The current engine ranks in the opposite direction ("simplest first") because, without persistence, a big graph is expensive to dive; with persistence that reason disappears. The weights themselves are a judgment, not a fit; I did not have enough resolved targets to regress them.

### 6.8 Execution model

**Queued background work for expansion; lookup plus one bounded job for a search; polling for status.**

- An edge function is the wrong home for a traversal: 45 to 55 second budgets in code, a 150 to 400 second platform ceiling, and no state between invocations. It is a fine home for one slice of a queue.
- The browser is the wrong home for a shared graph: state dies with the tab, and its writes cannot be trusted.
- Rate limits decide the rest. Chess.com allows about 300 requests per 10 seconds per IP, which is ample for one worker (the whole snowball used 1,761) but is a shared budget once many users' work leaves through one egress. MUIR sustained about 3 requests per second and is already shared by every user through the edge. So the worker must own a single global limiter, and user-triggered cold work should keep running in the user's browser, where it spreads across IPs, with its findings re-verified server-side before they are stored.

Concretely: `search_job` row on submit; immediate answer if the graph has one; otherwise the job is queued at layer 0 only, the client polls or subscribes, and the tab's own engine runs in parallel as it does today. The worker handles everything beyond layer 0 on its own schedule.

---

## Task 7 — Expected lift

### 7.1 What bounds everything

- 32% of active players have online-rated history. The other 68% cannot be confirmed by game alignment at any depth.
- Of those with history, 96% have at least one section after 2020 that is not on ICC or ChessKid.
- Measured chance that a section aligns once any participant's handle is known: 87% for official US Chess events, 66% for WNZ, about 38% for small local organizers on Chess.com, 16 of 16 for a Lichess-team organizer.
- An aligned section maps 97% of its crosstable.

Applying those per-section rates to the actual section lists of the 291 sampled online players, and assuming sections succeed or fail independently, **87% of online-rated players have at least one section that would align**. Halving every per-section rate still gives 77%. That is the ceiling for any version of this algorithm: about **28% of all active players**.

### 7.2 Estimates

| Scenario | Resolved, online-rated players | Resolved, all active players | Latency | Platform calls per search | Basis |
|---|---|---|---|---|---|
| **Today** (measured, 240 s stop) | 26% (6 of 23) | ~8% | 287 s median | 649 median, 1,262 p95 | Section 2 |
| Proposal, layer 0, stateless, 240 s | ~26% | ~8% | same | same | It is the same mechanism: resolve a section-mate by name, then hop. The proposal's ordering does not change what name-guessing can find. |
| Proposal, layer 0, stateless, unlimited time | ~75% (model) | ~24% | 10–40 min | 5,000–20,000 | Two re-runs with a 14-minute stop both resolved (292 s and 499 s; 846 and 3,752 calls). Model: every section player is guessed (22 handles each). The true handle is accepted for 4.7% of players, so a 33-player section has a 79% chance of containing a seed and a 9-player section 32%. |
| Proposal, layer 1, stateless | ~85% (model, near the ceiling) | ~27% | 40 min to 3+ h | 50,000–240,000 | Neighbours' other sections supply seeds for small sections. Cost from section 3.6. |
| Proposal, layer 2 and beyond, stateless | ~87% | ~28% | about a day | the whole corpus | No further gain; the walk has reached everything. |
| **Persistent graph, opportunistic** (Phases 0–2, no background worker) | 26% rising with use | 8% rising | 5–15 s when any section-mate is stored, otherwise as today | 10–60 when warm | Each resolved search stores 10–35 identities and 1–16 links. |
| **Persistent graph, official US Chess series ingested** | ~36% from lookup alone, plus today's cold path for the rest | ~12%+ | under 1 s for covered players | 0–3 | 107 of 291 online players touch that series. |
| **Persistent graph, five largest series ingested** | ~64% | ~21% | under 1 s for covered players | 0–3 | Adds WNZ, PCA, Grand Prix and one Lichess team. The Lichess team's share is inflated by this sample. |
| **Persistent graph, mature** | ~87% | ~28% | under 1 s | 0–3 | Same ceiling as unbounded traversal, without the per-search cost. |

Rows marked "model" are calculations from measured rates, not measurements.

### 7.3 The simulation on real data

Section 5.7 is the simulation of the proposed walk on the real graph: one section in, two level-order hops, 28 players expanded, 788 players resolved, 109 sections located, 1,761 Chess.com requests. It took 36 minutes of wall clock, most of it waiting on MUIR to rank the frontier; the Chess.com part is about 10 minutes at 3 requests per second and would be about 90 seconds at 20. Cross-section consistency of the resulting identities: strong assignments disagreed in 1.0% of pairs, including five genuine second accounts among 236 multi-section members; weak ones in 3.5%.

### 7.4 Assumptions, labelled

1. The 26% baseline has a wide interval (about 12% to 47%) and was measured with the Google index down. With a working index the cold path would do better; I could not measure by how much.
2. Per-section alignment rates come from sections reached through hub players in 2020–2026, mostly official US Chess events. The 38% figure for other organizers is from 16 sections.
3. Section independence overstates success for players whose sections are all from one failing organizer and understates it for players in mixed series.
4. "Unlimited time" assumes the user waits. Nobody will wait 40 minutes, which is the argument for doing that work before they ask.
5. Lift for the 68% without online history is zero in every row. Their only routes are the existing fallbacks.
6. Precision is assumed to follow the strong/weak split measured in section 6.1. No resolved handle from the 35-player baseline was verified against an outside source.

---

## Task 8 — Build plan

Plan only. Phases are ordered so that each one is useful on its own and the next one depends on it. Effort is for one engineer who knows this codebase; treat the numbers as rough.

### Phase 0 — Remove the self-inflicted failures (3–5 days)

Nothing here is new architecture. Each item is a measured cause of a slow or failed search today.

| Change | Files | Evidence |
|---|---|---|
| Make discovery fail fast when the search backend is out of quota: persist the cooldown (one row in Postgres, checked before calling Gemini) and return immediately. Restore a working key, or configure Programmable Search, which the code already prefers. | `supabase/functions/_shared/ai.ts`, `resolve-identity/googleSearch.ts`, `resolve-identity/index.ts` | Every `findUsername` and `discoverEvent` call takes 25 s to fail. A 16-event player waits ~130 s before work starts. |
| Apply discovery answers (including `event_platform_cache` hits) to every event, not only unknown-host events. | `src/lib/identity/uscfGraphEngine.ts` around `:4421-4437`, `:3999`, `:4225` | A supplied tournament slug for a title-tagged event was ignored: 217 s, 778 calls, no match (section 2.5). |
| Replace the Chess.com lanes with one token bucket at 20 req/s across all endpoints; replace the Lichess 120 ms gap with per-endpoint buckets (user-games export: burst 6, refill 0.45/s); shorten the Lichess 429 pause; make `conductor.netEvent()` platform-aware. | `src/lib/identity/net.ts`, `src/lib/identity/conductor.ts` | Section 3. |
| Route the Lichess name-search provider through `politeFetch`. | `src/lib/identity/providers/lichess.ts:49` | Raw `fetch` bypasses the gate. |
| Remove the 2020-03-01 cutoff; replace the fixed 16-section cap with a relevance order (sections with a stored link first, then by date). | `supabase/functions/resolve-identity/uscf.ts:655,672` | One sampled player's only online history (2017–18) was invisible; 44% of online players are truncated. |
| Before seed scouting, look up stored handles for every section player and inject them as seeds. | `src/lib/identity/providers/uscfGraph.ts:50`, `providers/edgeClient.ts:526`, engine seed injection `:4509` | `fetchResolvedHandles()` has no caller today. |
| Cap handle guessing per member and stop it once any section player is mapped. | `uscfGraphEngine.ts:2354-2391` | 63% of Chess.com requests are 404s; about 1,060 lookups per seed. In one test the guess queue delayed a known seed's trace by 100 s. |
| Raise the archive header timeout from 4 s, or scale it with the account's archive size. | `uscfGraphEngine.ts:738,842` | Time to first byte reached 3.7 s on a 9.5 MB month in a browser tab. |

Unlocks: searches that currently hit a five-minute wall finish or fail honestly in about a minute. Depends on: nothing.

### Phase 1 — Persist what every search already proves (1–2 weeks)

- **Schema** (one migration): `uscf_section`, `uscf_section_player`, `online_tournament`, `section_link`, `identity_edge` as sketched in section 6.3. Drop the `unique (uscf_id, platform)` assumption; a member can have several handles.
- **Write path**: a new edge mode, `recordAlignment {eventId, section, platform, tournamentId}`. The server fetches the crosstable (from `muir_cache`) and the tournament's games itself, runs `sectionAlign`, and stores only assignments that pass the strict rule (≥3 verified rounds and ≥2 corroborating opponents). The browser never supplies a handle. This closes the `claimHandle` hole for the new tables.
- **Read path**: `lookupSections {sections[]}` returns stored links and identities. The engine consults it at stage 0, before organizer research.
- **Files**: new `supabase/migrations/…_identity_graph.sql`; `supabase/functions/_shared/identityStore.ts`; a new `supabase/functions/resolve-identity/graphStore.ts`; `resolve-identity/index.ts`; `src/lib/identity/sectionAlign.ts` moved or copied under `supabase/functions/_shared/` (it is already dependency-free apart from `politeFetch`); `providers/edgeClient.ts`; `uscfGraphEngine.ts` stage 0.

Unlocks: each resolved search adds one to sixteen section links and ten to thirty-five identities, and any later search that touches one of those sections becomes a lookup. Depends on: Phase 0 for the link-application fix.

### Phase 2 — Use resolved players to locate tournaments (about 1 week)

When any player in one of T's sections has a stored handle, fetch that player's archive month for the event date, read the tournament tag off their games, walk the bracket, align the section. This is what `traceFromSource()` does after a seed is found; the change is to do it first, from stored identities, and to run it for the resolved player's other sections as well. Add Lichess parity through the existing organizer research plus `/api/games/user` tournament tags.

Files: `uscfGraphEngine.ts` (`workEvent` ordering, `traceFromSource`), `graphStore.ts`. Unlocks: the 7-second path measured in section 2.5 becomes the default path. Depends on: Phase 1.

### Phase 3 — Background snowball and a job model (2–3 weeks)

- `search_job` and `expansion_queue` tables; a worker that drains the queue in level order, hubs first (section 6.7 ranking), under one shared rate limiter whose state lives in Postgres.
- Where it runs: a scheduled edge function in 50-second slices is enough to start (`pg_cron` plus `pg_net`, state in tables, no long-lived process). If throughput matters, a single small always-on Node worker is simpler than tuning slices. Either way it must be a single egress identity, because the Chess.com limit is per IP.
- Request path: Find Player creates a job, reads whatever the graph already has, and polls. The in-tab engine stays as the cold-path executor for now, because it spreads Chess.com load across user IPs and already works.

Files: new migration; new `supabase/functions/graph-worker/`; `src/lib/identity/huntStore.ts` and `src/pages/FindPlayer.tsx` for polling. Unlocks: coverage grows without user searches; depth stops being a per-search cost. Depends on: Phases 1–2.

### Phase 4 — Ingest the online-rated USCF corpus (1 week of work, 1–2 days of runtime)

Walk `/rated-events` back to 2020 (about 130,000 events), keep sections rated OR/OQ/OB, store their crosstables. At a safe 2.5 requests per second that is roughly a day of MUIR time, then about 60 events per day incrementally. Files: `graph-worker`, `uscf.ts`. Unlocks: layer expansion on the USCF side becomes a SQL join, and the footprint ranking needs no per-member feed fetches (the snowball spent 1,825 MUIR calls ranking 477 members). Depends on: Phase 3.

### Phase 5 — Confidence model and evidence-chain UI (about 1 week)

Per-assignment strength in `recordTarget()`; thresholds from section 6.1; ranked candidates with the chain shown when nothing is confirmed; several handles per person. Files: `uscfGraphEngine.ts:2495-2927`, `confidence.ts`, `resolver.ts:1049`, `src/components/findplayer/IdentityResults.tsx`, `EvidenceLedger.tsx`, `ConfidenceStatement.tsx`. Depends on: Phase 1 for the strength fields.

### Phase 6 — Decide what to do about players with no online-rated games (open)

About two thirds of active players have none. No traversal confirms them. The options are the existing Google-index and school paths, a seed set of self-identifying profiles, and a claim flow. This is a product decision more than an engineering one and is listed so it is not mistaken for something Phases 1–5 solve.

---

## Appendix — method notes and artifacts

**Where the raw data is.** Scripts and results are in the session scratch directory, not in the repo:
`C:\Users\Code4\AppData\Local\Temp\claude\C--Users-Code4-Projects-scout-report-pro\0af60dab-a205-486b-ba9a-69c077910e26\scratchpad\`. It is a temp directory; copy it somewhere durable if you want to keep it. The files that matter:

| File | Contents |
|---|---|
| `baseline/*.json`, `baseline_rows.json` | One file per baseline player: verdict, timings, every log line, every HTTP call by class and status |
| `sample.json`, `m1_online.json`, `m2_layers.json` | The 900-member sample, the 291 online histories, the 12 layer measurements |
| `snowball.json`, `era.json`, `prec.log` | The level-order snowball, the by-era alignment test, the cross-section precision test |
| `S_lichess.json`, `x1_crossplatform.json`, `g1.json` | Lichess ground truth, same-handle probe, guess-reachability |
| `titled_profiles.json`, `titled_matched.json` | Titled-account seed set |
| `cc_*.json`, `cc.mjs`, `cc2.mjs`, `cc404*.mjs`, `cc_window.mjs`, `cc_mitig.mjs` | Chess.com probes and the mitigation bake-off |
| `li*.mjs`, `muir_rate*.mjs` | Lichess and MUIR probes |
| `baseline-entry.ts`, `seeded-entry.ts`, `snowball-entry.ts`, `holes-entry.ts`, `prec-entry.ts` | Harnesses that import the app's own modules read-only and are bundled with the repo's esbuild |

**Load placed on third parties.** Roughly 45,000 requests to Chess.com over three and a half hours (several thousand of them deliberately over the limit to find it, plus one accidental flood in which about 4,900 were rejected), about 10,000 to MUIR, about 1,100 to Lichess, and about 1,650 calls to the production edge function. Chess.com recovered within seconds each time. Lichess was still refusing this IP when the work ended.

**Things I did not get to or could not test.**

- Edge function platform ceiling (needs a deploy).
- Time-of-day behaviour beyond a three-hour window.
- Lichess `/api/user` limits under clean conditions, and the engine-pacing-versus-token-bucket comparison for Lichess exports: the IP was blocked by then.
- Whether traffic to `www.chess.com` in another tab counts toward the same Cloudflare window.
- The resolution rate with a working Google index.
- Precision of the six baseline verdicts against an outside source.
- Per-section alignment success for organizers outside the big series beyond 16 sections.

**Smaller defects noticed along the way**, not central to the report:

- `clubEventTie()` credited "Chess.com iOS Club" as tied to an event because both contain "com" (+0.9 log-odds on a crown).
- `providers/lichess.ts:49` calls `fetch` directly, bypassing the Lichess gate.
- `resolve-identity` health reports the AI backend as healthy while grounded search is out of quota; it tests a plain completion.
- `.env.example` says the cookie cron is hourly; `vercel.json` schedules it daily.
- The engine header says there are no request caps; `fetchChesscomTournamentGames()` caps at 40 and the graph at 16 sections.

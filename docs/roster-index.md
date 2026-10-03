# Roster index: enumerable platform data instead of open-web search

Session 2026-10-03 01:12 UTC onward (evening of 2026-10-02, US Eastern). Branch: `traversal/section-bfs`.
Every number below states the tag or commit that produced it.

Sampled players are referred to by row number only; no member id, name or
handle of a subject appears in this file (the repository is public).

## Summary

- **The gate is positive** (Phase 1). Chess.com truncates only the summary
  roster (25); the per-round bracket is complete in 28 of 28 tested
  tournaments at 1 + R requests, and Lichess swiss exports are complete in 18
  of 18 at 2. One request lists a member's whole Chess.com tournament history,
  one lists a Lichess team's swiss: tournaments are enumerable without any web
  search.
- **The index works** (Phase 2). Rosters and per-round result vectors for the
  five series (no games, no PGN) in `roster_tournament`; a section's crosstable
  is aligned against every stored tournament of its day. Blind, it
  reproduced **45 of 46** engine-verified sections with **0 of 1,284** handles
  disagreeing, and on the larger index resolved **880** cached sections the
  engine never had (15,145 identities; against identities proven elsewhere,
  8,400 agree, 175 disagree, almost all strong-vs-strong second accounts). A
  blind join needs ≥ 90% coverage; three small-section false positives at
  67–71% showed why.
- **Resolution order** is now index join → stored handles → section walk →
  guessing (Phase 2.4), with a search-wide speculative request budget (4.1),
  a per-class Lichess breaker built from measurement (4.3) and platform
  inference that places 57% of formerly unknown-host footprint sections in production (Phase 5).
- **Measured on frozen code** (`rindex-p6`, held-out players, Phase 6):
  cold online-rated **35 / 46 = 76% (95% CI 62–86%)**, median **48 s**, index
  answers in **0.8 s**; speculative share of requests **22%** (was 70%);
  Chess.com 404 share **15%** (was 44%); warm **63 / 63** in 0.7 s; OTB-only
  answered in ~1 ms with no request.
- **The crawler** (Phase 3) runs serially at ~1 request/s per platform with no
  Chess.com rate-limit event, survived a real laptop sleep without losing or
  duplicating work, and is deployable as Supabase Edge slices on `pg_cron`
  (staged, not switched on). Backfill this session: **5,332 rosters** in ~3.8
  hours (all 2,715 DMV swiss since 2020; Chess.com series since Dec 2025);
  the rest of the known catalogue is ~41,000 requests (~12 h), and keeping up
  costs ~250 requests a day (Phase 3.4–3.5).
- **SearXNG stays shelved** (7.1). **Hosting**: Supabase Edge + `pg_cron`,
  card-free and already in use (7.2). **Handoff** (Phase 8): Groq,
  Cloudflare and OpenRouter keys (all card-free on the live signup page) and
  one SQL statement to start the crawler.
- **Also found**: a long-standing hang where a stalled Lichess stream ignored
  the search's abort (fixed, `98b4cea`); `muir_cache`, not the index, is what
  will hit the 500 MB cap (153 MB, ~0.5 MB per search, never pruned).

## Phase 0: Housekeeping and freeze

Run 2026-10-03 01:12–01:25 UTC.

| Item | Result | Evidence |
|---|---|---|
| 0.1 Push | `git push -u origin traversal/section-bfs` created the remote branch. Confirmed **from the remote**: `git ls-remote origin traversal/section-bfs` = `2a001df5b1ee…` = local HEAD; GitHub compare `main...traversal/section-bfs` = `ahead_by: 29, status: ahead`. | — |
| 0.2 `AI_PROXY_BASE_URL` | Before: set (updated 2026-10-02 19:45), proxy alive, health `backend: proxy:google/gemini-3.5-flash` in 1.2–2.2 s (n=3). Unset at 01:15:48 UTC. After: `aiBackends.proxy: false`, `backend: gemini-direct`, **0.66 / 0.71 / 0.76 s** for the first three calls — then **6.2 s**, then **429 "exceeded your current quota" at 25.3 s**. Spaced 12 s apart a minute later: **3 of 3 were 429 at 25.3–25.4 s.** | See below |
| 0.3 Grounding cap | `GEMINI_GROUNDING_DAILY_CAP` digest `5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9`; `printf 0 \| sha256sum` gives the same digest. **The value is "0"**, confirmed by value at 01:15. | — |
| 0.4 Tag | `rindex-p0` → `2a001df` (pushed; `git ls-remote --tags origin rindex-p0` returns it). Every later number names the tag or commit it ran on. | — |
| 0.5 Deployed function | `resolve-identity` **v105**, deployed 2026-10-02 21:11:13 UTC. The only `supabase/functions` change on the branch after that is `cc8a00d`, a one-line comment in `harvest.ts`. **Deployed code = branch HEAD, modulo a comment.** `explain-move`/`training-hint` v62. | `supabase functions list`; `git diff 18b49e7 HEAD --stat -- supabase/functions` |
| 0.5 Docker / SearXNG | Docker running; one container `searxng` (`searxng/searxng:latest`), up 25 h, answering on `127.0.0.1:8080` (200 in 1.65 s). Left running. | `docker ps -a` |
| 0.5 `SEARXNG_URL`, `SEARXNG_TOKEN` | Still set in production (updated 2026-10-02 09:47 / 06:18). The only cloudflared process alive at session start pointed at FreeLLMAPI (`127.0.0.1:31415`), not SearXNG, so the URL names a dead tunnel. Nothing on this branch reads either secret (`grep -rn SEARXNG supabase/functions src` is empty). **Stale and inert; not changed.** | — |
| 0.5 Orphaned cloudflared | One: pid 44944, started 2026-10-02 15:44 local by the previous session, still serving `jury-macro-…trycloudflare.com` → FreeLLMAPI (401 in 0.5 s). With the secret unset it served nothing that production references, so I **stopped it** (`Stop-Process 44944`); zero cloudflared processes afterwards. FreeLLMAPI itself (3 processes) left running. | — |

**Disagreement with the brief (0.2).** The brief says gemini-direct "answers in
under a second". It did for three calls. The direct key then hit its free-tier
quota and **every call after that costs 25.3 s** because the direct path
keeps its retry budget for a 429 (`_shared/ai.ts`; the fail-fast added last
session applies to the optional proxy only). The proxy, alive tonight,
answered 3 of 3 in 1.2–2.2 s. I followed the instruction (laptop dependency
removed) and recorded the cost: AI is off the search's critical path (query
mode waits at most 3 s for it), so the 25 s lands on `discoverEvent`,
`aiCheck`, `explain-move` and `training-hint`. Reverse with
`supabase secrets set AI_PROXY_BASE_URL=<tunnel origin>` once a tunnel exists.

## Phase 1: The gate — roster enumeration

Run 2026-10-03 01:25–01:50 UTC, from this laptop, serial, User-Agent
`ScoutTree-research/1.0 (… contact <owner address>)`, ≥ 250 ms between
requests. 370 + 129 platform requests, **zero 429s**. Scripts in the session
scratchpad (`p1/roster.mjs`, `p1/ptlist.mjs`, `pw/tpage2.mjs`).

**Sample.** Every section in production with a *verified* `section_link` (the
tournament is known and was proven by alignment): **46 sections — 28 Chess.com
(official US Chess blitz/rapid ×17, PCA ×7, Westford/AOCC ×3, New Britain ×1;
2020-03 to 2026-09) and 18 Lichess swiss (DMV, 2020-09 to 2026-09).**

### 1.1 Results

| | Chess.com (28 tournaments) | Lichess swiss (18) |
|---|---|---|
| Summary endpoint roster | `/pub/tournament/{id}` `players[]` = **exactly 25 in 16 of 16** tournaments whose crosstable has > 25 players (registered up to 72). Complete only when ≤ 25. | `/api/swiss/{id}/results` (NDJSON): **complete in 18 of 18** |
| Per-round / per-group roster | `/{id}/{round}` and `/{id}/{round}/{group}`: union of group `players[]` = union of game participants in **28 of 28**; both ≥ the crosstable's players-with-a-played-game in **28 of 28**. Every swiss round had exactly one group. | `/api/swiss/{id}/games` participants ≥ crosstable in **18 of 18** |
| Requests per full roster | 1 + 2R as walked (round, then its group): **7–15, median 11** (R = 3…7). Group URLs are `/{id}/{r}/1`, so **1 + R** is enough (6 for a 5-round event). | **2** (results + games; info optional) |
| Wall time per roster (serial, 250 ms floor) | median 2.9 s | median 1.5 s |
| Per-game records | 1,828 games: **1,828** carry `end_time`, both colours (white/black objects) and both results. Round = the URL it came from. | 845 games: **845** carry `createdAt`, colours, status/winner. Round inferred from start-time clusters (the existing `inferRounds`). |

So a section's **result vector** — per player, per round: colour, result,
opponent — is retrievable at section granularity on both platforms.

### 1.2 Interface vs endpoint

Chess.com's tournament page (Playwright, headless Chromium, logged out) shows
25 players on page 1 and a "Page 2" control; `?players=2` showed the rest
(34 further distinct member links on the 46-registered example). **The roster
is visible in the interface and also complete in the public bracket
endpoints**, so the crawler never needs the interface for rosters. The page
also names the hosting club, **"USChess - Members Only" (club id 34556)**; the
club's tournament listing (`/callback/clubs/live/…/34556`) answers **401**
logged out, and `/club/uschess-members-only/tournaments` is a "Missing Page".
A club-level tournament list is therefore **login-only**.

**Tournament discovery without the club list** (the crawler's other
prerequisite, measured because the gate is useless without it):

- **Chess.com:** `/pub/player/{handle}/tournaments` returns a member's **whole**
  history in one request — 961, 1,942 and 1,954 finished tournaments for three
  hubs, 761–1,006 of them `us-chess-*`, ids from 2018 to the new 31-million id
  range. Independent completeness check: for 40 members holding a stored
  handle proven in ≥ 2 sections, **89 of 89** linked tournaments appear in the
  member's own list (median list 329, max 2,783 entries; no truncation seen).
- **Lichess:** `/api/team/dmv-chess-tournaments/swiss?max=5000` streamed
  **2,720 swiss** (2020–2026, 40,851 player entries) in one request (136 s);
  **18 of 18** linked swiss are in it. The same team has 11 arenas.

### 1.3 Completeness against stored identities

All 1,288 handles the store holds for these 46 sections are in the enumerated
rosters (**1,288 / 1,288**; 46 / 46 sections). This check is partly circular —
those handles were proven by aligning the same brackets, through the harvest's
40-GET walk — so the independent evidence is the two counts above: the
platform roster is never smaller than the USCF crosstable (46 / 46), and a
member's own tournament list names every tournament the alignment put them in
(89 / 89).

### 1.4 Verdict

**Full enumeration works on both platforms through public endpoints.**
Chess.com truncates only the summary `players[]` (25); the bracket is complete,
at 1 + R requests per section. Lichess swiss are complete at 2 requests.
Conditions: (a) the tournament must be known — Chess.com through any
participant's tournament list (one request, whole history), Lichess through
the organizer team's listing (one request); (b) Chess.com arenas and Lichess
arenas have no round structure and were not tested for roster completeness
(no USCF section in the store is linked to an arena; the DMV team has 11
arenas against 2,720 swiss). Phases 2 and 3 proceed.

## Phase 2: The index

### 2.1 Schema and the arithmetic (computed before the backfill)

`supabase/migrations/20261003000000_roster_index.sql` (applied 01:36 UTC):

- **`roster_tournament`** — one row per platform tournament of a target series:
  platform, tournament id, series, status (`pending`/`done`/`failed`/`skipped`),
  date, rounds, size, `handles text[]` (lowercased, index = player position)
  and `vectors text`: per player, per round, one token
  `<opponentIndex><w|b><w|l|d>` (e.g. `3ww,7bl,,1bd`). **No game records, no
  PGN** — a game exists only as the two tokens of its players. GIN index on
  `handles` for handle → tournaments; partial indexes for the crawl queue and
  for date lookups.
- **`crawl_source`** — discovery sources (a Chess.com member's tournament
  list, a Lichess team) with `last_polled_at` and a priority.

Arithmetic, with the catalogue the discovery probe had already listed
(`p1/stems.mjs`: 120 members' tournament lists, 25,848 distinct tournaments):

| Series | Tournaments listed | Mean players | Player entries |
|---|---|---|---|
| Official US Chess on Chess.com (`*-us-chess-*`, `us-chess-*-u*`, `…-open`) | 3,305 | 40 | 132,200 |
| WNZ / Waltham | 1,879 | 9 | 16,911 |
| PCA | 759 | 24 | 18,216 |
| Grand Prix Rated | 170 | 8 | 1,360 |
| DMV (Lichess team, 2020–2026) | 2,720 | 15 | 40,851 |
| **Total** | **8,833** | | **≈ 210,000** |

At ~40 bytes per player entry in the row (handle ≈ 12 B, ~5 tokens ≈ 20 B,
separators) plus ~30 B of GIN key, and ~300 B of row overhead per tournament,
that is **≈ 18 MB**. The database was **112 MB of the 500 MB cap** at the start
(`pg_database_size`, Phase 0), so even a 5× error leaves > 200 MB of headroom.
Nothing had to be cut.

Measured after 621 tournaments were crawled (02:00 UTC): official US Chess rows
average **1,416 B** for 32.9 players (43 B per entry in-row), WNZ 459 B for
8.9, Lichess DMV 602 B for 13.3; the whole table was 2.8 MB for 621 done +
7,576 pending rows. That is ~190 B per player entry including the GIN index
and the pending-row overhead — the estimate holds within 2×; final size is in
Phase 3.

### 2.2 Alignment by result vector

`supabase/functions/_shared/rosterIndexCore.ts` (`aeef370`, pure, no I/O):
`rosterGames()` rebuilds one row per game from the stored tokens and
`joinSection()` runs the **existing** whole-section alignment
(`alignSectionBest` + `alignmentTrustworthy`) against every candidate. Candidate
window: start date ± 14 h (USCF dates are US-local, platform times UTC), round
count within ±1, platform roster ≥ 80% of the crosstable's played players. Two
trusted candidates with no clear winner (< max(2, 10% of players) apart) are
reported **ambiguous**, never picked between.

Edge mode `indexJoin` (`supabase/functions/resolve-identity/rosterIndex.ts`,
`34f68c6`, member mode `e56eda3`): for named sections, or for a member's own
sections (footprint, newest first, up to 12, stopping at a strong assignment or
two agreeing weak ones). On one trusted match it records the alignment exactly
as the harvest does (shared `recordVerifiedAlignment`): every member's
`identity_edge`, a `section_link` with `source = 'index'`, the event's platform
and series. Only the named member's handle is returned (same single-member
disclosure as `storedIdentity`). Rate limit 30/min per caller.

Live checks after deploy: a PCA section resolved **10/10 in 0.53 s** with one
candidate (v107); a member resolved **strong, 5 rounds, in 0.75 s** from two of
their sections (v108).

### 2.3 Against what the engine already resolved

Blind run (`p2/join-eval.ts`, nothing written): every production section with a
**verified** `section_link`, joined against the index as if the tournament
were unknown.

| | Result |
|---|---|
| Sections | 46 (28 Chess.com, 18 Lichess); all 46 tournaments are in the index |
| Index picks the engine's tournament | **45 / 46** |
| Index picks a different tournament | **0** |
| Ambiguous | 0 |
| No candidate | 1 |
| Handles: index vs stored | **1,284 agree, 0 disagree** (of 1,288 stored; the 4 left are the one miss) |

**The one miss, investigated:** a 4-player Westford AOCC round robin
(2023-06-23). US Chess records **9 rounds**; Chess.com's bracket has **3
rounds** with three games per player in each. The candidate filter (rounds
± 1) excluded it, and even unfiltered the stored vector keeps one token per
player per platform round, so it could not align. Every sampled tournament of
the five target series is a swiss with exactly one game per player per round
(6 of 6 checked: WNZ ×3, Grand Prix ×3), so this is a format limit of
multi-game rounds, outside the target series. Not fixed.

**Sections the engine never resolved**, with an independent cross-check:
each index answer's members who hold an identity proven in a *different*
section. Three runs, the last on the larger index:

| | 02:05 UTC, 860 rosters, before the trust bar | 02:10, 860 rosters, with the bar (`25a161a`) | **14:30, 3,898 rosters**, with the bar |
|---|---|---|---|
| Cached online sections tried (not already linked) | 2,756 | 2,756 | 3,281 |
| **Resolved by the index** | 119 | 150 | **880** (DMV 571, PCA 171, official US Chess 62, WNZ 62, Grand Prix 14) |
| Identities those carry | 2,121 | 2,759 | **15,145** |
| Cross-checked identities: agree / disagree | 738 / 10 | 948 / 9 | **8,400 / 175 (2.0%)** |
| Ambiguous (two trusted candidates) | 3 | 0 | 3 |
| No candidate in the window | 1,941 | 1,906 | 1,329 |

The 14:30 linked set also includes the 229 links Phase 6 created (151 by
index joins, 78 by harvests). Of the **226 with their tournament in the index:
223 same tournament, 0 handle disagreements in 4,715**, 2 no candidate, and
**1 different tournament** — investigated: a 7-player "Grand Prix Rated #24"
section (3 rounds, 2026-05-27) that a Phase 6 *harvest* had linked to "Grand
Prix Rated #21" (4 rounds, starting 2026-05-25) on 5 of 7 players, which
`alignmentTrustworthy` accepts (≥ 50%). The index found a tournament inside the
section's own date window explaining 7 of 7. The harvest link is the likely
error, which says the harvest wants the same coverage bar as the index.

**The 175 disagreements** (78 distinct member/handle pairs, each counted once
per section it appears in): 151 are strong on both sides (≥ 3 verified rounds
and ≥ 2 corroborating opponents in fully aligned sections), 41 of those with
visibly related handles; 149 of the 175 are in the DMV scholastic series on
Lichess, where children commonly hold two accounts. The investigation measured
two strong accounts for 5 of 236 multi-section members (~2%); this is the same
rate. 20 have a weak assignment on the index side, which the store's conflict
rules resolve toward the strong one.

**One evaluation error, disclosed:** the 14:2x first pass paged the index
with an unordered offset and read duplicate rows, which showed up as 182
"ambiguous" sections (both top candidates were the same tournament). Paging
ordered and deduplicated, it is 3. The 02:0x runs read fewer than 1,000
rosters (one page) but paged the 2,800-row section list the same unordered
way, so their section counts are approximate; the 14:30 column is the
reliable one. Production's candidate read is one ordered, filtered query
(`getRosterCandidates`) and was not affected.

### 2.4 Wired in ahead of everything else

`e56eda3`. Order for a search:

1. **No-footprint gate** (free, decided from the US Chess record) — unchanged.
2. **Index join** (`indexJoin {memberId}`) and the **stored-identity read**
   run side by side; a strong index assignment (or one agreed by two
   sections) is returned as a verdict (`fromIndex`). A single weak one is a
   lead and the search continues.
3. **Stored verdicts** (`fromStore`).
4. **Section walk** (`sectionBfs`): level-0 sections are joined against the
   index first and the engine walks only the ones the index did not align;
   every deeper section is joined for its bridge before it is walked. Stored
   handles are the engine's seeds.
5. **Guessing**, last, inside the engine, under the search-wide speculative
   request budget (Phase 4.1).

Counters: `result.indexJoin` (member mode) and `sectionSearch.index`
(per-section joins: tried, resolved, not-covered, bridges resolved).

## Phase 3: The crawler

`scripts/roster-crawler.mjs` (CLI) over `scripts/roster-crawl-core.mjs` (the
crawler, runtime-neutral), `bb6f524` → `4878633`.

### 3.1 Scope

Five series and nothing else. Chess.com slugs are admitted only if they match
the official US Chess events (`-us-chess-…`, `us-chess-…-u1450`, `…-open`),
WNZ / Waltham (`…-wnz-rated-…`, `…-waltham-rated-…`), PCA (`pca-…`) or Grand
Prix Rated (`…-grand-prix-rated-…`); Lichess: the DMV team's rated, finished
swiss. The 25,848 distinct tournaments in 120 members' lists were 80% other
things (hourly public blitz, bullet, Titled Tuesday…) and are never fetched.
Plus the 46 tournaments already linked to a section, crawled first as
validation targets.

### 3.2 Pacing

One request at a time per platform, target **1 request/s each**, with a
descriptive User-Agent carrying a contact URL (the project's issues page; see
Decisions). A 429 or a Cloudflare challenge halves the rate and pauses
(Chess.com 10 s doubling to 5 min; Lichess 60 s doubling to 10 min, Lichess's
own "wait a minute"); each clean minute adds 0.1/s back. Measured over the
backfill: Chess.com **0.99 requests/s sustained, 0 rate-limit events**;
Lichess 0.73–0.77/s effective (each roster is two requests and the exports are
larger), **1 rate-limit event** (02:18:44, during my own Lichess experiments of
4.3), recovered by the schedule.

### 3.3 Resumable by construction

All state is in Postgres: a tournament is `pending` until its **whole** roster
is in hand and is written in one PATCH; `done` rows are never selected again;
discovery progress is `crawl_source.last_polled_at`. A process killed, slept
or cut off mid-tournament leaves that tournament `pending` and it is fetched
again. Evidence: the crawler was stopped and restarted twice mid-run (01:56:47
for the Phase 5 change; 02:45:37 for the Phase 6 freeze) with no lost or
duplicated work: of 738 Chess.com rosters, 707 cost exactly 1 + rounds and 31
cost less (fewer rounds played than scheduled); all 1,514 Lichess rosters cost
2 (3 for the 18 validation targets, which also read the tournament's info). No
row shows a second fetch. **An actual sleep happened** (unplanned): the laptop slept from about 05:55
to 14:22 UTC during the third crawl run. On wake, the two in-flight requests
failed as transport errors, the run's 2.5-hour bound had passed, and it exited
normally; both tournaments that were mid-fetch were still `pending` with
`attempts = 0` and no partial data, and the lease (last renewed 05:55) had
expired on its own. The release call at wake did not land; harmless, because
the lease is time-bounded. A lease (`crawl_lease`, `4878633`) keeps a
laptop run and the edge slices (7.2) from ever crawling at once.

### 3.5 Backfill run this session (real numbers)

Four bounded runs from this laptop, **~3.8 hours of crawling** in total
(01:42–01:56, 01:56–02:45, 05:11–05:55 cut short by the sleep, 14:24–16:24),
paused for the Phase 6 freeze. State at 16:24 UTC:

| Series | Rosters crawled | Pending (catalogued) | Dates covered (crawled, newest first) | Player entries | Requests per roster |
|---|---|---|---|---|---|
| Official US Chess (Chess.com) | 401 | 3,762 | 2025-12-15 → 2026-10-01 | 10,710 | 6.46 |
| WNZ / Waltham (Chess.com) | 1,303 | 958 | 2025-12-14 → 2026-10-03 | 11,342 | 4.76 |
| PCA (Chess.com) | 678 | 2,470 | 2025-12-11 → 2026-09-28 | 12,538 | 4.89 |
| Grand Prix Rated (Chess.com) | 207 | **0** | 2026-01-01 → 2026-10-02 | 1,345 | 4.08 |
| DMV (Lichess) | **2,697** | **0** | **2020-09-02 → 2026-10-01 (complete)** | 40,460 | 2.00 |
| Validation targets | 46 | 0 | 2020-03 → 2026-09 | 1,301 | 6.14 / 3.00 |
| **Total** | **5,332** | **7,190** | | **77,696** | |

Requests: ~13,650 to Chess.com (rosters 13,125 plus 528 member-list polls)
with **0 rate-limit events in any run**; 5,448 to Lichess with 4 rate-limit
events (one during my own Lichess experiments, three while diagnostic searches
ran from the same address), each recovered by the schedule. Nothing failed or was skipped. The table is
**7.5 MB** for 5,332 crawled + 7,190 pending rows (the database: 189 MB, of
which `muir_cache` is 153 MB — see Production changes).

### 3.4 Projection

- **Rest of the backfill.** The known catalogue still pending is 7,190
  Chess.com tournaments ≈ 3,762 × 6.46 + 2,470 × 4.89 + 958 × 4.76 ≈ **41,000
  requests**, plus polling the 2,139 discovery sources not yet read (one
  request each). At the measured 0.99/s: **≈ 12 hours** of serial Chess.com
  time. The catalogue is not closed: PCA grew from 938 to 3,148 known events
  once PCA regulars' own lists were polled (sources are re-ranked by how many
  crawled rosters they sit in, so each series' regulars surface quickly). The
  edge slices (7.2) crawl at the same 1 request/s for ~110 s of every 2
  minutes, so the backlog takes about the same ~13 hours there.
- **Steady state.** New tournaments per day, from the crawled windows: WNZ
  4.4, PCA 2.3, official US Chess 1.4, DMV 1.2, Grand Prix 0.8 — **~10 a
  day**, ≈ **47 roster requests a day**, plus a daily re-poll of the ~200
  highest-ranked members (≈ 200 requests) and one Lichess team listing: **≈ 250
  requests a day, about 4 minutes of crawling.**

## Phase 4: Kill the guessing

### 4.1 A search-wide speculative request budget

`b6b2c2b`, fixed in `4558483`. The previous caps counted guessed *members*
(8 at level 0, 3 per deeper section, 24 per search) and each guessed member
costs 20–30 profile probes, so they compounded. The allocator now counts
speculative requests actually **sent** in one search and sheds the rest before
they are sent (default 250 per search; `sectionBfs` resets it at the start of
every search). Proven work is never charged.

The first version checked the budget only when a request was enqueued. Live,
on the re-run of acceptance player #6, it sent **333 speculative requests
against a budget of 250**, because requests queued before the budget ran out
were granted later without a check. The fix re-checks at grant time.
`test-allocator` scenario 10, queued case: **10 sent / 30 shed** with the fix,
**40 sent / 0 shed** on the previous code.

Speculative share of platform requests, live (the two players that wedged
last session, walk forced, index disabled — the worst case for guessing):

| Run | Code | Proven | Speculative | Speculative share |
|---|---|---|---|---|
| #6 | `rindex-p0`+4.1 (pre-fix) | 310 | 333 | 51.8% |
| #22 | same | 4,255 | 306 | 6.7% |
| last session's acceptance, all online players | `a709727` era | 3,982 | 9,311 | **70.0%** |

The share across a representative sample is in Phase 6.

### 4.2 Round-robin frontier

`b851275` (last session) admits at most `sectionsPerBridge` (4) sections from
one bridge per level, taking one section per bridge per round. New counters
(`sectionSearch.levels`, `eb55a11`) measure it rather than assert it:

| Run | Level | Sections admitted | Distinct bridges | Most from one bridge | Held back |
|---|---|---|---|---|---|
| #6 | 1 | 8 | 3 | 4 | 0 |
| #6 | 2 | 60 | 56 | 2 | 155 |
| #6 | 3 / 4 | 60 / 60 | 60 / 60 | 1 / 1 | 780 / 959 |
| #22 | 1 / 2 / 3 | 60 / 60 / 60 | 60 / 60 / 60 | 1 / 1 / 1 | 152 / 1,730 / 700 |

**The fix holds.** The smoke data it was written against had 60 of 60 level-1
sections from one member; no level here takes more than 4 from one bridge, and
every level past the first is spread one section per bridge.

### 4.3 The Lichess breaker, live

**Measured schedule first** (`p4/li429.mjs`, `p4/li429b.mjs`, 01:58–02:13 UTC,
this laptop, 62 requests):

| Probe | Result |
|---|---|
| `/api/games/user`, 2/s from rest | 429 on the **10th** request. **No `Retry-After`.** |
| Recovery after each of 4 back-to-back trips (probes at 1, 2, 4… s) | **1.4, 1.3, 3.4, 1.3 s** — no escalation |
| 40 requests at 4/s ignoring 429s (27 refused) | games recovered in **1.5 s** |
| `/api/user/{name}` during and after | **429 for every name from the first probe (01:58) until at least 02:30 — over 31 minutes**, while `/api/users/status`, autocomplete and the crawler's swiss exports (≈1/s throughout) answered 200 |

So Lichess limits **per endpoint class**, and the games bucket refills in
~2 s (≈ 0.5 token/s, consistent with last session's fit). The profile
endpoint's block is of a different kind: it was **still on at 14:59 UTC, 13
hours later, after 8.5 hours in which this address sent nothing at all** (the
laptop slept), while the same request from another network (Firecrawl,
14:59) returned **200**. It is a long, address-specific penalty on
`/api/user/{name}`, not a rate bucket. Whether this session or last session's
acceptance run (46 + 34 profile 429s on two players) earned it is not
determinable from here.

**Breaker changed to match** (`7fbb67b`): it now trips **per class** (four
429s on one class in 2 minutes) instead of dropping every Lichess request,
because a `/api/user` penalty was also stopping proven tournament exports. A
429 within 2 minutes of a cool-off ending re-trips at **twice** the cool-off:
**90 s, 180 s, 360 s … capped at 15 minutes**. Backoff for an isolated 429 is
unchanged (6 s doubling to 60 s): the measured refill is ~2 s, so 6 s is
3× margin.

**Stall reproduced and ended.** Last session's two wedged searches (#6, #22)
were re-run with the store and index switched off (walk forced) **while this
address's `/api/user` was in its penalty** — the stall condition, occurring
naturally:

| Player | Last session | This session, `f771786` breaker | This session, per-class breaker (`4878633`) |
|---|---|---|---|
| #6 | stopped by the 25-min guard after ~20 min without progress; 46 Lichess 429s | **169 s**, ended on evidence; 4 Lichess rate-limit events, 580 Lichess requests failed fast; longest silence **15.1 s** | 8 s (not comparable: the first re-run had stored its section's tournament link, so the engine aligned it from the store) |
| #22 | stopped by the guard after 13+ min without progress; 34 Lichess 429s | **811 s**, ended on its own (frontier exhausted, level 3, 14 sections aligned, not resolved); 17 events, 1,224 failed fast; longest silence **49.3 s** | **757 s**, ended on its own (frontier, level 2, 15 aligned, not resolved); 12 events, 825 failed fast; **39 Lichess tournament exports still answered** while `/api/user` was saturated; longest silence **40.2 s**; speculative budget **250 used, 184 denied** (exact) |

The breaker ends the stall: neither search waited on Lichess; every run
finished without the guard. #22 is not resolved by any run, last session's
included: it is a resolution failure, no longer a wedge.

## Phase 5: Platform resolution for unnamed sections

### The premise, re-measured

The cache has grown since the brief's numbers were taken (the acceptance run
cached thousands of footprints), and one of those numbers was misread:

| | Measured 2026-10-03 |
|---|---|
| Online sections in `muir_cache` (section meta, `isOnline`) | **2,802**: title names nothing 2,294 (81.9%), ICC 330, Chess.com 171, ChessKid 6, Lichess 1 |
| Distinct sections across the 2,663 cached footprints (what ranking actually reads; ICC/ChessKid already dropped) | **13,535**: Chess.com 5,267, Lichess 599, **unknown 7,669 (56.7%)** |
| **Are the unnamed ones ICC?** | **No.** "43%" in the brief is ICC's share of *all* online sections (330 of 761 then), not of the unnamed ones. Every section whose organiser is an ICC host (affiliate `ICC CHESSCLUB.COM`, 148; Continental Chess Association, 166) names ICC in its title: **314 of 314**. Of the 451 unnamed sections whose event record (with affiliate) is cached, **0** belong to an ICC-hosting affiliate. |

The event record carries the organiser (`affiliate`, e.g. `CHESSCOM LLC`,
`DMV CHESS CLUB`, `Waltham Chess Club`), but the games feed that footprints
read does not, and only 451 of the 2,294 unnamed sections have their event
record cached. An affiliate rule would cost one MUIR request per event at
search time; I did not build it (see Decisions).

### 5.1 What was built (`2366c59`)

`series_platform` gains a `source`; footprints classify each section in this
order (`supabase/functions/resolve-identity/footprint.ts`):

1. **stored** — `event_platform_cache` for this event (alignment, harvest, or
   now an index join);
2. **series (alignment)** — a series an aligned section proved;
3. **title** — "… on Chess.com", "… ICC";
4. **index** — a crawled tournament's *name* has this series key (the crawler
   writes it for every roster it stores);
5. **listing** — a Chess.com tournament *slug* with this series key appeared in
   a member's public tournament list (the crawler writes every distinctive key
   it sees while discovering, not only the five series);
6. **prefix** — an organiser prefix learned from series whose platform is
   known: `dmvchess.com …` → Lichess (leave-one-key-out on 593 known sections:
   **593 right, 0 wrong**; stricter rule than the first draft, which learned
   generic words like "first" and "action");
7. otherwise **unknown**.

Only an alignment-proved series outranks the title, so a titled "ON ICC" event
can never be relabelled by a look-alike Chess.com name. Footprint payloads are
versioned (`v: 2`) so the 3-day footprint cache is recomputed rather than
served stale.

### 5.2 How much of the unknown it resolves

Replayed offline over the 7,669 unknown footprint sections, with the series
keys the crawler had learned by 02:00 UTC (a partial index):

| Layer | Sections resolved |
|---|---|
| series (alignment, 17 keys) | 975 |
| index (crawled names) | 1,608 |
| listing (members' tournament lists) | 927 |
| prefix (`dmvchess.com`) | 998 |
| **Resolved** | **4,508 of 7,669 (58.8%)** → 3,326 Chess.com, 1,182 Lichess |
| **Still unknown** | **3,161 (41.2%)**, i.e. 23.4% of all footprint sections (was 56.7%) |

Re-run at 14:40 UTC with production's own tables after Phase 6 (4,636
`series_platform` rows, 304 stored event platforms) and the production
classifier's order: **4,402 of 7,669 placed (57.4%)** — stored 174, aligned
series 3,372, listing 386, prefix 470 — leaving **3,267 unknown (24.1% of all
footprint sections)**. Most alignment-learned keys now come from Phase 6's
index joins and harvests, which recorded their series.

The largest remaining keys are organisers outside the five series (e.g. one
"play n stay" series, 539 sections; 64Squares "SFS" events; Seneca, PNWCC).

**How an unknown-platform section is ranked: unchanged, at half weight**, and
as "either platform" inside its own section. Reason: the measurement says an
unknown section is almost never ICC (0 of 451 with a known organiser), so it
should not score zero; but it is also, by construction, outside every crawled
series and every listing seen so far, so it needs a seed walk rather than an
index join, and is worth less than a section on a known platform.

## Phase 6: The measurement that was lost

### 6.1 The pivot-rank metric, fixed and proven first

`5459748` (last session) read the rank before the mapping, which cured "every
value is 1", but it still counted every **already-known** member (rank 1000)
as ranked above the scouted pivot, so the position grew with the store. Fixed
in `d3b908a`: position = 1 + still-unknown, eligible members ranked above the
pivot when it resolved. Proven on a scripted known case
(`scripts/test-pivotrank.mjs`, the engine injected so no network): four
scenarios pass; the same scenario reads **4** on the previous metric and **3**
on the fixed one (K stored, C third among the unknown).

### 6.2–6.3 Sample and conditions

- **Held-out sample**: 60 online-rated + 15 OTB-only members drawn with a fixed
  seed from the investigation's 900-member activity-weighted sample, after
  removing last session's 35 and everyone with a stored identity (Decisions
  15). None was in the store when the sample was drawn.
- **Frozen**: tag **`rindex-p6`** (`fbd1a41`); client bundle built once from
  it at 02:46; `resolve-identity` v110 = its edge code; roster index frozen
  (crawler stopped 02:45:37; at freeze: 738 Chess.com rosters covering
  2026-07-06 → 10-03 plus the 28 validation targets, 1,514 Lichess DMV
  rosters covering 2022-09 → 2026-10). **No code edit during the run.**
- Run 02:46:05 → 05:11:03 UTC, one fresh process per search, strictly
  serial, a 25-minute runaway guard in the harness (a clock, see Errors), every
  HTTP request counted. Then every online player whose first search resolved
  was searched again (warm).
- **Disclosed conditions.** (a) Lichess's `/api/user/{name}` was in its long
  penalty for this address from before the run (Phase 4.3); the run drew 83
  Lichess rate-limit events, all handled by the breaker. (b) The store grows
  during the run: 14 of the 75 first searches found their player already
  stored by an earlier player's search (mostly an index join that aligned a
  shared section). Those 14 are in the warm column, not the cold one.
- **One bug, recorded, run finished anyway:** player #44's process did not end
  when the harness's 25-minute guard aborted it, and was killed by the runner
  at 27 minutes with no output. It is counted as a failure at 1,620 s.
  Diagnosis below.

### 6.4–6.5 Results, cold and warm never merged

Cold = no stored identity for the player when their first search started.

| Metric | **Cold**, online-rated (n = 46) | **Warm**, online-rated (n = 63: 14 first searches found stored + 49 repeats) | OTB-only (n = 15, all cold) |
|---|---|---|---|
| Resolved (tournament-proven, ≥ 0.85) | **35 / 46 = 76.1%** (Wilson 95% CI **62–86%**) | **63 / 63 = 100%** (94–100%) | 0 / 15 (nothing to align, by design) |
| … of which verdict-grade (≥ 0.97) | 31 (67.4%); 4 are single weak sections (0.93, leads) | — | — |
| How the cold ones resolved | index join of the player's own section **8**; index join inside the walk **3**; walk alignment / crown **24** | index **26**, store **25**, walk 12 | — |
| Latency, median / p95 | **48.5 s / 900 s** (resolved only: 36.8 s / 166.7 s; index-answered: **0.79 s**) | **0.70 s / 37.4 s** | **≈ 1 ms** / 2 ms, 0 requests |
| Platform requests per search, median: proven / speculative | **54 / 200** | 0 / 0 | 0 / 0 |
| Speculative share of all platform requests | **22.3%** aggregate (per walk, median 59%; **22 of 37 walks spent ≥ 240 of the 250 budget**) | (few requests) | — |
| 404 share of Chess.com requests | **14.8%** (of 29,673 requests) | (few requests) | — |
| Identities stored per aligned section | **21.4** (285 sections aligned) | 21.4 (56) | — |
| Time to first aligned section, median | **41.8 s** (n = 38) | 0.58 s | — |
| Rank of first resolved (scouted) pivot | 5, 22, 3, 11, 4, 13, 14 — median **11**, **n = 7** | 3, 11, 18, 8 (n = 4) | — |
| Traversal depth reached (searches that walked) | level 0: 13, 1: 15, 2: 3, 3: 2, 4: 4 | 0: 9, 1: 3 | — |
| Index joins: tried / resolved / not covered | 893 / **199 (22%)** / 290 (32%: no crawled tournament in that date window) | 263 / 46 / 42 | — |
| Searches whose answer came from the index | **11 / 46** (24%; 31% of the resolved) | 27 / 63 | — |
| Bridges resolved by the index (deeper sections, no walk) | 180 | 12 | — |
| Runs stopped by a guard | 2 (#45 at 25 min, ended cleanly; #44 killed, see below) | 0 | 0 |
| Longest silence in any run | 43.7 s | 15.7 s | — |

**Against the earlier numbers** (different samples and conditions, so
reported, not concluded from): the investigation's baseline resolved **6 / 23
(26%, CI 12–47%)** online-rated players in 5 minutes; last session's
contaminated run reported 21 / 23. Speculative share: **70.0% → 22.3%**.
Chess.com 404 share: **63.5% → 43.9% → 14.8%**. Per search, median: 649
platform calls (baseline) → 80 proven + 518 speculative (last session) →
**54 proven + 200 speculative** (cold; a walk alone: 343 in total, median). OTB-only: 338 s → 0.34 s → ~1 ms.

**Why the 11 cold failures failed** (from each run's own record): 1 has only
ICC/ChessKid sections (nothing alignable; answered in 49 s); 2 have a single
online section that never aligned and an empty frontier (61–62 s); **7
aligned 15–35 sections each without the target's own handle ever appearing**
(frontier exhausted ×3, request budget ×3, guard ×1) — the target's own
sections are the ones nothing aligns; 1 is the #44 hang.

**Does portal ranking do real work?** Not determinable from this run: only 7
of 46 cold searches resolved their first pivot by scouting (the rest were
answered by the index, a stored link or an alignment seeded by stored
handles), and their ranks (median 11) are not comparable to a random order
without each section's count of eligible members, which the run did not
record. The metric is now correct; the sample that exercises it is too small.

### 6.6 Confidence and sample size

Cold online-rated resolution is **76.1%, 95% CI 62–86%** (n = 46; verdict-grade
67.4%, CI 53–79%). The change this report claims is from the investigation's
**26%**: detecting 26% → 76% at two-sided α = 0.05 with 80% power needs **15
per arm**, which both samples exceed — but the two arms were not run under the
same conditions (different players, a 240 s stop, a dead discovery backend
then; the index and a Lichess penalty now), so the comparison is indicative.
Telling 76% from last session's reported 91% would need **~95 per arm**; a
±10-point interval on 76% needs **~70** cold online-rated players.

### #44: what hung

Reproduced after the run with the same bundle and a diagnostic copy of the
harness that writes its events as they happen and, 60 s after an unheeded
abort, dumps what the process is still waiting on (`acc6/diag-entry.ts`):

- The 25-minute abort fired at 1,500 s; the search had not returned at
  1,560 s (exit by the dump). **Same failure.**
- The last HTTP request of any kind left at **728 s**. For the next 13
  minutes there was none, while **four engine instances** kept emitting
  heartbeats, each "working" a Lichess-hosted event with no seeds and nothing
  queued — waiting, not computing (CPU stayed flat in the live #45 check).
- Open resources at the dump: one TCP socket, stdout's pipe, timers. The
  request just before the silence was the Lichess team-history stream (headers
  at 724 s).

So: the team-history NDJSON stream stopped sending mid-body; `reader.read()`
never settled; the single-file stream lane stayed held; every section worker
that needed the organiser's history queued behind it; and nothing in that
chain listens to the search's abort (`politeFetch`'s timeout and abort end at
the headers). Fix `98b4cea`: every response body read now rejects on abort and
after 30 s without a byte (`guardBody`, `test-allocator` scenario 11).

Re-run of #44 on the fixed code (14:33–14:58 UTC, awake): the 25-minute abort
**ended the search at 1,500 s with its output written** (exit 0, no hang dump;
terminated "stopped", level 2, 8 sections aligned, not resolved; longest
silence 44.6 s). An earlier fixed-code attempt straddled the laptop's sleep
and is not evidence either way. Whether a stream stalled during the awake
re-run is not recorded (an idle rejection is not logged as an event); what is
shown is that the search now honours the abort. #44 is still unresolved: a
resolution failure, no longer a hang.

## Phase 7: Retrieval and hosting, decided

### 7.1 SearXNG: stays shelved

**Decision: do not revive it.** The ADR's corrected objection was the laptop
dependency, not capacity, and nothing this session removes that dependency at
zero dollars: Hugging Face now requires a paid plan to create a Docker Space
("Gradio and Docker Spaces run on compute and require a paid plan to create",
read live 2026-10-03), Render's free web services sleep after 15 idle minutes,
Fly.io has no free tier for new organisations, and Koyeb's single free
instance is a web service that "can't be used as a Worker Service". Meanwhile
the reason to want retrieval has shrunk:

- The index joins whole sections of the five series with no seed and no web
  query (Phase 2.3: 45 of 46 engine-verified sections reproduced blind, 150
  more the engine never resolved).
- Host pinning, the one gap the ADR said had no deterministic substitute,
  now has three: the index's own crawled names, the public tournament
  listings the crawler reads anyway, and a learned organiser prefix. Together
  they placed 57–59% of the footprint sections that had no platform (Phase 5.2).
- What is left unknown (23.4% of footprint sections) is small organisers
  outside the five series. For those, a web search would find a flyer at best;
  the listing layer grows on its own as the crawler polls more members, at no
  query cost.

What would reopen it: a Phase 6-style failure analysis showing that unresolved
online-rated players fail *specifically* on unknown-host sections that no
listing reaches, at a share that justifies a hosted search box — and a
card-free always-on host for a container, which does not exist today.

### 7.2 Hosting the crawler

Read live with Playwright on 2026-10-03 (`pw/hosts.mjs`, `pw/grab.mjs`): each
host's pricing or limits page, and the signup form's visible fields. No
account was created and nothing was submitted.

| Host | Card-free today? | What the free tier allows | Fits a resumable crawler writing to Supabase? |
|---|---|---|---|
| **Supabase Edge Functions + `pg_cron`** (this project) | **Yes** (already in use) | 500,000 invocations/month; **150 s** wall clock, **2 s CPU** per request, async I/O not counted; the docs show invoking a function every minute from `pg_cron` + `pg_net` + Vault. `pg_cron` 1.6.4 and `pg_net` 0.20.3 are available (not yet installed) on this project. | **Yes.** Crawl in ≤ 120 s slices; progress already lives in the tables. |
| **GitHub Actions** (public repo `scout-tree`) | **Yes** (already in use) | "Public repositories: Minutes remain free"; jobs up to 6 h; cron schedules run from the default branch only | Yes: the Node script runs unchanged with `--hours 5.5`. |
| Cloudflare Workers (Free) | Yes (signup form: email + password, or Google/Apple/GitHub; no card field) | 100,000 requests/day; **10 ms CPU** per invocation, cron included; cron wall 15 min | Marginal: 10 ms CPU per run is tight for parsing brackets. |
| Deno Deploy (Free) | Not verified beyond the pricing page ($0 plan) | 1M requests/month, 20 GiB egress, 10 h active CPU/month (I/O wait not billed), `Deno.cron` | Yes in principle; a new account and a port. |
| Koyeb | Unclear | One free web-service instance (512 MB, 0.1 vCPU), "can't be used as a Worker Service" | No. |
| Render | Free web services only | Spin down after 15 min idle; background workers and cron jobs are paid | No. |
| Railway | **No** (30-day trial with $5, then $1/month of usage) | — | Out (trial). |
| Fly.io | **No** ("New organizations don't have a free tier"; trial of 2 h or 7 days) | — | Out. |
| Hugging Face Spaces | Static only | Docker/Gradio Spaces need a paid plan to create | Out. |
| Oracle Cloud Free Tier | **No** (card required at signup, per its FAQ) | — | Out. |
| Google Cloud | **No** (free trial; card) | — | Out. |
| Northflank | Sandbox advertises free services/cron; its FAQ asks "Am I charged when I enter my credit card?" | — | Out (card entered). |

**Recommendation: Supabase Edge Functions on a `pg_cron` schedule.** It needs
no new account and no new secret, it runs next to the tables it writes, and
its egress is already measured against all three APIs (an edge address took
392 Chess.com requests before a 429 and MUIR's 100-per-minute rule held per
address; the crawler sends 1 per second). Resumability is free: every slice
reads `pending` rows and writes a tournament only when it is whole, exactly as
the laptop crawler does, and a lease row keeps two slices from overlapping. Its
limits fit the measured workload: a slice of ~100 requests parses ~100 JSON
bodies, far inside 2 s of CPU; one slice a minute is ~43,000 invocations a
month of the 500,000. GitHub Actions is the fallback (zero port: the same
script, `--hours 5.5` every six hours), held back only because schedules run
from `main` and this branch is not merged.

What is not built: the Deno port of the crawler loop into an edge function and
the `pg_cron` job. The laptop crawler (`scripts/roster-crawler.mjs`) is the
running implementation today.

## Phase 8: Human handoff

### 8.1–8.2 Candidates, checked against the live pages (2026-10-03)

| Candidate | What the live page asked for | Kept? | Measured bottleneck it removes |
|---|---|---|---|
| **Groq** (console.groq.com) | Sign-in with Google, GitHub, SSO or e-mail; no card field. The rate-limits page has a "Free Plan Limits" table. Models include `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`. | **Yes** | Production AI: gemini-direct went to 429 after three calls and then costs **25 s per call** (Phase 0). Groq's API is OpenAI-compatible, so it plugs into the existing `AI_PROXY_*` path with no code change and no laptop. |
| **Cloudflare** (dash.cloudflare.com/sign-up) | E-mail + password, or Google/Apple/GitHub; no card field. Workers AI: 10,000 Neurons/day free; Workers Free: 100,000 requests/day. | **Yes** (second AI provider for the FreeLLMAPI pool; also a fallback crawler host) | Same as Groq, as a second pool member. |
| **OpenRouter** (openrouter.ai/sign-up) | First/last name (optional), e-mail, password, terms checkbox; no card field. | **Yes** (pool member; free models only) | Same. Its limits page could not be read (the docs URL redirected elsewhere), so the free daily allowance is unverified. |
| Supabase `pg_cron` for the crawler (7.2) | No signup: same project. | **Yes** (a switch, not a signup) | The crawler lives on this laptop. |
| Cerebras | "Add a valid payment method to receive a one-time $5 promotional credit." | **No** (payment method) | — |
| GitHub Models | "GitHub Models has been retired." | **No** | — |
| Mistral | The console redirected to a login form; the free API tier's requirements could not be read without an account. | **No** (unverified) | — |
| Fly.io, Railway, Render workers, Oracle, Google Cloud, HF Docker Spaces | See 7.2 | **No** | — |

### 8.3 The open browser

A visible Chromium (Playwright, persistent profile in the session scratchpad
`pw/handoff-profile`, launcher pid 56812, opened 16:25 UTC) was left running
with one tab per checklist step:

1. `https://console.groq.com/login`
2. `https://dash.cloudflare.com/sign-up`
3. `https://openrouter.ai/sign-up`
4. `https://supabase.com/dashboard/project/xqyszdjczchlgyisvtvo/sql/new`
   (asks for the Supabase sign-in first)

Nothing was typed, filled in or submitted on any page. Closing the window ends
the process. If it is gone (a reboot), the same four URLs are in the
checklist.

### 8.4 Checklist (followable on its own)

1. **Groq key → production AI** (removes the 25 s gemini-direct 429 cost).
   - Tab 1: `https://console.groq.com/login` → sign in (Google, GitHub or
     e-mail; no card is asked for) → **API Keys** → **Create API Key** → copy
     the `gsk_…` value.
   - Pick a chat model id that the **Free Plan Limits** table on
     `https://console.groq.com/docs/rate-limits` lists (the models page,
     `https://console.groq.com/docs/models`, shows which are chat models).
   - Run, from the repo:
     ```
     supabase secrets set AI_PROXY_BASE_URL=https://api.groq.com/openai AI_PROXY_API_KEY=<gsk_…> AI_PROXY_MODEL=<model id>
     ```
     (`_shared/ai.ts` appends `/v1/chat/completions`, which is Groq's path.)
   - Verify: `curl -s -X POST https://xqyszdjczchlgyisvtvo.supabase.co/functions/v1/resolve-identity -H "apikey: <publishable key>" -H "Authorization: Bearer <publishable key>" -H "Content-Type: application/json" -d '{"health":true,"aiCheck":true}'`
     must show `"backend":"proxy:<model>"`.
   - Undo: `supabase secrets unset AI_PROXY_BASE_URL` (falls back to
     gemini-direct). Note this replaces the FreeLLMAPI key held in
     `AI_PROXY_API_KEY`.
2. **Cloudflare account → Workers AI token** (second provider).
   - Tab 2: `https://dash.cloudflare.com/sign-up` → sign up (e-mail +
     password or Google/Apple/GitHub; no card) → **AI → Workers AI** → **Use
     REST API** → create a token with *Workers AI: Read* (and *Edit*) → copy
     the token and the **Account ID**.
   - Where it goes: the FreeLLMAPI desktop app on this laptop, in its
     provider settings (Cloudflare Workers AI: account id + token). Production can
     hold only one `AI_PROXY_*` backend; use Cloudflare there only instead of
     Groq, as `AI_PROXY_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai`.
3. **OpenRouter key** (third pool member, free models).
   - Tab 3: `https://openrouter.ai/sign-up` → e-mail + password → **Keys** →
     **Create Key** → copy `sk-or-…`.
   - Where it goes: the FreeLLMAPI app's provider settings (OpenRouter). Use
     only `:free` model ids unless credits are deliberately added.
4. **Turn on the crawler in production** (takes it off this laptop).
   - Tab 4: `https://supabase.com/dashboard/project/xqyszdjczchlgyisvtvo/sql/new`
     (sign in to Supabase).
   - Paste `supabase/sql/roster-crawl-schedule.sql` from this branch, replace
     `<SERVICE_ROLE_KEY>` with the service-role key (Project Settings → API
     Keys), run it.
   - Check after 5 minutes: `select * from cron.job_run_details order by start_time desc limit 3;`
     and `select status, count(*) from roster_tournament group by 1;`
     (`done` should grow by a few dozen per slice: ~110 Chess.com and ~80 Lichess requests per 110 s slice).
   - Undo: `select cron.unschedule('roster-crawl');`. A laptop crawler and the
     schedule never run together (`crawl_lease`).

## Production changes

Project `xqyszdjczchlgyisvtvo` (secrets, functions, database) and the GitHub
remote. Times UTC, 2026-10-03.

| # | When | Change | Reverse with |
|---|---|---|---|
| R1 | 01:13 | `git push -u origin traversal/section-bfs` (29 commits that existed only locally); later pushes of this branch and tags `rindex-p0` (01:19), `rindex-p6` (02:46). Not merged, no pull request. | `git push origin --delete traversal/section-bfs rindex-p0 rindex-p6` |
| R2 | 01:15:48 | **Secret `AI_PROXY_BASE_URL` unset** (was the laptop's quick tunnel). `AI_PROXY_API_KEY` and `AI_PROXY_SEARCH_MODEL` left as they were. | `supabase secrets set AI_PROXY_BASE_URL=<reachable proxy origin>` |
| R3 | 01:16 | Stopped the orphaned `cloudflared` (pid 44944) on this laptop. Not production, but it was the tunnel R2 pointed at. | `cloudflared tunnel --url http://127.0.0.1:31415` |
| R4 | 01:36 | `db push` `20261003000000_roster_index.sql`: tables `roster_tournament`, `crawl_source` (+ indexes, RLS on, no policies). | `drop table public.roster_tournament, public.crawl_source;` |
| R5 | 01:38 | `db push` `20261003000100_roster_index_fns.sql`: function `refresh_crawl_source_priority(text)`. | `drop function public.refresh_crawl_source_priority(text);` |
| R6 | 01:38–02:45 | Crawler writes (three runs from this laptop): `roster_tournament` rows (status, rosters, vectors), `crawl_source` rows; 46 validation rows inserted by hand (`series = 'linked'`). | `truncate public.roster_tournament, public.crawl_source;` |
| R7 | 01:44, 01:48, 01:57, 02:11 | Deployed `resolve-identity` **v107** (indexJoin), **v108** (member mode), **v109** (footprint v2 / platform inference), **v110** (index trust bar) from this branch. All earlier modes keep their request and response shapes. | `gh workflow run deploy-supabase-functions.yml --ref main` (or deploy from tag `rindex-p0`, = v105 modulo a comment) |
| R8 | 01:44–01:48 | Two live index joins (smoke tests): 2 `section_link` rows `source = 'index'` and their `identity_edge` rows. | `delete from section_link where source = 'index';` (edges: by `sections` containing those events) |
| R9 | 01:56 | `db push` `20261003000200_series_platform_source.sql`: column `series_platform.source`; one row `prefix:dmvchess.com → lichess` inserted by hand; the crawler then added `index`/`listing` rows (3,784 rows in the table at 02:45). | `delete from series_platform where source <> 'alignment'; alter table series_platform drop column source;` |
| R10 | 02:12–02:45 | Four searches for Phase 4.3 (players #6, #22 twice) through production: their harvests added identities (`identity_edge` 979 → 1,384 by 02:45, together with R8). Re-run alignments of public games. | `delete from identity_edge where first_seen between '2026-10-03 01:40' and '2026-10-03 02:46';` |
| R11 | 02:31 | `db push` `20261003000300_crawl_lease.sql`: table `crawl_lease`, functions `take_crawl_lease`, `release_crawl_lease`. | drop the table and both functions |
| R12 | 02:32 | Deployed a **new** function `roster-crawl` v1 (service-role only; 401 otherwise). **No schedule**: `supabase/sql/roster-crawl-schedule.sql` is staged, not run. | `supabase functions delete roster-crawl` |
| R13 | — | `explain-move` / `training-hint` list as v63 (v62 at session start) with **unchanged** bundle hash and `updated_at` (2026-10-02 23:22). Not deployed by me; recorded because the number moved. | — |

| R14 | 02:46–05:11 | **The Phase 6 run**: 124 searches through production. Writes: **2,153** `identity_edge` rows, **151** `section_link` rows from index joins and **78** from harvests, the mirrored `resolved_handles` verdicts, footprints and crosstables in `muir_cache`. All are re-run alignments of public games. | `delete … where first_seen / checked_at between '2026-10-03 02:46' and '2026-10-03 05:12'` per table |
| R15 | 05:12–05:38, 05:4x–14:2x, 14:24– | Three diagnostic searches for #44 (same writes as any search). | as R14, by time window |
| R16 | 05:11–05:55, 14:24–16:24 | Crawl runs 3 and 4 (`roster_tournament`, `crawl_source`, `series_platform` rows; `crawl_lease` taken and released). | as R6 / R9 |

Database size: **112 MB** at the start, **187 MB** at 14:25. The roster index is
**5.8 MB** of that (3,745 crawled rosters); `muir_cache` is **153 MB** (about
83 MB at the start), grown by this session's ~140 searches at roughly 0.5 MB
each. At that rate the 500 MB free-tier cap is a few hundred searches away
unless `muir_cache` is pruned; nothing deletes its rows today (TTLs are applied
on read).

**Credentials.** Before the first code commit, and on every later commit, the
staged diff was scanned for `sb_secret_…`, JWTs, `AIza…`, `sk-…` and e-mail
addresses: no hits except the literal word "sb_secret_" in a comment. The
service-role key used by the laptop crawler and the evaluation scripts was
fetched with `supabase projects api-keys` into the session scratchpad
(`crawler.env`, outside the repository) and is in no committed file. The
publishable key in `src/integrations/supabase/client.ts` and the deploy
workflow is public by design.

## Errors made this session

1. **The owner's e-mail address went out in a request header.** The Phase 1
   probes (`p1/roster.mjs`, `ptourn.mjs`, `ptlist.mjs`, `stems.mjs`, ~650
   requests to Chess.com and Lichess) and the first Lichess probes carried it
   in the User-Agent as the "contact address" the brief asked for. That
   address should not leave the session without an explicit instruction to
   send it; from the crawler on, the contact is the repository's issues URL
   (configurable).
2. **The speculative budget overshot on its first version** (333 sent against
   250, live, player #6): queued requests were granted without a re-check.
   Fixed (`4558483`) before the frozen run.
3. **The first breaker dropped every Lichess request**, so a `/api/user`
   penalty also stopped proven tournament exports. Found by measuring
   (Phase 4.3), changed to per class (`7fbb67b`).
4. **Blind index joins shipped without their own trust bar** for 27 minutes
   (v107–v109, 01:44–02:11). The evaluation found three false positives at
   67–71% coverage; production made only my two smoke joins in that window,
   both at 100% coverage.
5. **I probably caused the Lichess `/api/user` penalty** that then overlapped
   the Phase 6 run: my first `/api/user` request (01:58) came seconds after I
   deliberately tripped the games endpoint, with the crawler's exports running
   since 01:42, and was already refused; I then kept probing it while
   measuring. Its exact cause is not determinable, but this session is the
   likeliest source, and it contaminates the Lichess side of Phase 6.
6. **A hang in the frozen run** (#44): a response body could stall past the
   search's abort. The bug is older than this session (the stream reader is
   unchanged since before it), but this session's harness is what exposed it;
   fixed after the run (`98b4cea`).
7. **The second #6 re-run in 4.3 was not comparable**: the first re-run had
   stored its section's tournament link, so the engine aligned it from the
   store in 8 s. I should have used a player not yet re-run.
8. **Harness clock.** The 25-minute runaway guard is a clock; the product has
   none, but the harness needed one. It fired once (#45, cleanly) and failed
   once (#44).
9. **Smaller ones**: a regex edit through a Python heredoc wrote backspace
   characters into the crawler's `seriesKey` (caught by a test print before
   the crawler restarted with it); one evaluation run read a partial table
   page (33 of 46 linked rosters), rerun; a scripted test's expectations were
   wrong on first write (the code was right); the first pivot-rank metric
   proof needed its scenarios recomputed; several heredoc commands failed on
   quoting and were redone with files.

## Undetermined, and what would settle it

| Question | Why it is open | What would settle it |
|---|---|---|
| Whether the cold resolution rate (76%, CI 62–86%) holds | n = 46; Lichess was in a penalty during the run; the index covered only Jul–Oct 2026 on Chess.com at the freeze | ~70 never-searched online-rated players run after the backfill completes, with a clean Lichess state (no experiments that day), cold only |
| How much of the remaining failure is index coverage | 290 of 893 index joins in the cold column found **no crawled tournament in the window** (the Chess.com backfill had reached back to 2026-07-06) | Re-run the same 46 cold players against a completed backfill (they are now warm for the store, so with `skipStore` and the index on) and count index answers |
| Whether portal pivot ranking beats a random order | Only 7 cold searches resolved their first pivot by scouting; eligible-member counts per section were not recorded | Record each section's eligible count with the rank; ~100 scouted resolutions |
| What earns Lichess's address-level `/api/user/{name}` penalty, and how long it lasts | On from 01:58 until at least 14:59 (13 h, 8.5 h of them with no traffic); 200 from another network | Probe once a day from this address until it clears; from a fresh address, find the profile-lookup volume that triggers it. Meanwhile, a heavy user's own address can lose Lichess profile lookups for hours, which the per-class breaker now contains |
| Whether every hang of this kind is gone | #44 reproduced the hang on the old code and honoured the abort on the fixed code; idle rejections are not logged, so a stall-then-recover is invisible | Log `guardBody` idle rejections as engine events and run the held-out sample again |
| Total catalogue size per series | Discovery yield fell from ~600 to ~16 new tournaments per member poll, but 1,267 of 1,417 sources were still unpolled | Poll every source once (≈ 1,400 requests, 25 minutes) and see whether the catalogue still grows |
| Whether the edge crawler behaves like the laptop one | Deployed, not scheduled; never run in production | Run `supabase/sql/roster-crawl-schedule.sql` (Phase 8, step 4) and read `cron.job_run_details` after an hour |
| Whether the index generalises beyond the five series | The 150 extra sections the index resolved are all in the crawled series | Add one more organiser's series to `chesscomSeries()` and measure its join rate |
| Precision of index answers against an outside source | Cross-checks are against other alignments (948 agree, 9 disagree, all 9 strong-vs-strong) | Self-identified accounts (a profile naming the USCF id) for a sample of index answers |

## Decisions and Assumptions

1. **The instruction.** The user's message asked me to push the existing
   commits first, sign up for nothing that needs a card (or at all, for this
   prompt), and use Playwright only if free; it carried the brief as pasted
   text. I followed the brief within those limits. Playwright 1.63
   (Apache-2.0) and its Chromium were installed into the session scratchpad,
   not the repository. No account was created anywhere.
2. **Which code the "Phase 0 tag" measurement runs.** `rindex-p0` marks the
   state the session started from. Running Phase 6 on it would measure none of
   this session's work and could not report an index-join hit rate, which the
   brief asks for. So Phase 6 ran on frozen code tagged **`rindex-p6`**
   (`fbd1a41`), with the bundle built once from that commit, `resolve-identity`
   v110 equal to its edge code, and the index frozen (crawler stopped) for the
   whole run. Both tags are on the remote.
3. **Proxy unset despite the measurement.** The brief said to unset
   `AI_PROXY_BASE_URL`; the measurement showed gemini-direct then costs 25 s
   per call once its quota is hit. I followed the brief (the laptop dependency
   was the stated reason) and recorded the cost (Phase 0). AI is not on the
   search's critical path.
4. **The orphaned tunnel** was stopped once nothing in production pointed at
   it (R3). The SearXNG container was left running, untouched.
5. **Contact in the User-Agent.** The crawler sends the project's issues URL
   (`CRAWLER_CONTACT` overrides it). The owner's e-mail address went out in the
   User-Agent of the Phase 1 probes; see Errors.
6. **Result vectors, not games.** The index stores one token per player per
   round (opponent index, colour, result); a game exists only as the two
   tokens of its players. That is the brief's "result vector … with opponent
   references", and it is exactly what the alignment needs.
7. **Disclosure parity.** `indexJoin` writes every member's identity to the
   store but returns only the named member's handle, like `storedIdentity` and
   `recordAlignment`; the bulk read stays signed-in only (`seedEdges`).
8. **Resolution order.** The brief puts the index join before stored handles.
   Both are single edge calls, so they run side by side and the index answer
   takes precedence; the free no-footprint gate stays in front of both (it is
   a gate, not a resolution method).
9. **A stricter trust bar for blind joins** (≥ 90% coverage, or ≥ 75% with a
   single candidate and ≥ 10 players) than for the harvest, because a blind
   join tries every tournament of the day (Phase 2.3).
10. **No affiliate (organiser) layer at search time.** The event record names
    the organiser, but reading it costs one MUIR request per event and MUIR
    allows ~100 a minute per address. The organiser prefix rule captures the
    largest case (DMV) from data already in hand.
11. **Unknown-platform sections keep half weight** in pivot ranking (Phase 5.2).
12. **The edge crawler is deployed but not scheduled.** A `pg_cron` job is a
    standing process that keeps hitting three third-party APIs from production
    indefinitely; starting it is left as a checklist item (Phase 8), with the
    SQL staged.
13. **Crawl paused for the measurement.** The index must not grow during
    Phase 6 (the last session's store grew during its run); the crawler was
    stopped at 02:45:37 and resumed afterwards.
14. **Cold vs warm.** Cold = the player has no stored identity when their first
    search starts (so none of their sections has been aligned by anyone). Warm
    = the store already holds them: a first search that found them stored, or
    the repeat search after a resolved first one. The roster index is part of
    the system under test in both columns, not "the store".
15. **The held-out sample**: the investigation's activity-weighted 900-member
    sample, minus last session's 35 and minus anyone already in the store
    (820 left: 223 online-rated, 597 OTB-only); 60 online-rated and 15
    OTB-only drawn with a fixed seed (`acc6/heldout.json`, scratchpad).
16. **Reproducing the stall** used a harness switch (`skipStore,noIndex`: the
    index join answered "no candidate") so the walk ran; the product code was
    not changed for it.
17. **Scope edge.** "Official US Chess" includes `us-chess-*-open` events that
    may not be USCF-rated; the join decides, and the cost is a few thousand
    rows.
18. **Hosting**: Supabase Edge + `pg_cron` over GitHub Actions (7.2), because
    GitHub schedules run from `main` only and this branch is not merged.

## Mass pre-resolution and target discovery (2026-10-03, 22:00 UTC session)

Short results; numbers are as of 22:16 UTC and the unattended loop keeps adding.

**What runs.** `scripts/pre-resolve.mjs` joins USCF online sections against the
roster index in bulk and writes exactly what the edge `indexJoin` writes
(`record_identity_edges`, then a `section_link` with `source = 'index'`).
Progress is one row per section in `preresolve_section` (migration
`20261003000400`), so a later run continues: a resolved section is never
processed again, and an unresolved one is retried only when a roster inside its
date window was crawled after it was last tried. Trust bar: the strict form of
`indexTrusted` (>= 90% of the crosstable, no 75% clause), and no blind join for
sections with fewer than 3 players who played. The index join calls no model;
its limits are the database and, for sections whose crosstable is not cached,
MUIR (about 75 requests a minute from one address, ~2.6 requests a section).

| | |
|---|---|
| Candidates before starting | 3,588 cached online sections (3,434 with a cached crosstable); 307 already linked, **3,127 to try**; index 5,609 rosters |
| Cached pass (22:04, 72 s, no MUIR request) | 3,127 processed, **1,079 resolved**, 19,912 member alignments written (16,812 strong) |
| Second cached pass (30 failed writes retried, earlier index links given a progress row, new rosters) | 221 processed, 205 resolved, 4,024 alignments |
| Not resolved, by reason | no roster in the window 1,211; candidates but none trusted 495; **below the 90% floor 126**; ICC / ChessKid title 180; ambiguous 4; under 3 players 2 |
| Disagreements with stored identities | 9 equal-strength conflicts, 41 weaker edges superseded |
| Resolved rows under 90% coverage | **0 of 1,376** (minimum 90.2%) |
| Store, before → 22:16 | `identity_edge` 3,691 → **7,518** (7,443 active, 6,829 strong, 23 in conflict, 52 superseded); verified `section_link` 307 → **1,642** |
| Enumerated from MUIR (`scripts/enumerate-online-sections.mjs`) | `/affiliates/{id}/events` lists an organiser's events newest first (no online or date filter; `isOnline` is only on the section). 11,424 sections in `preresolve_section` at 22:16, 7,912 still queued: the five series' affiliates back to 2025-01 (DMV to 2020, 3,790 of those with the online flag unknown, which the batch reads itself) |
| Unattended loop (`scripts/pre-resolve-run.sh`, started 22:07) | works the queue at MUIR pace (about 30 sections a minute) and re-reads the index every pass; first 226 queued sections: 205 resolved. Log `logs/pre-resolve.log` |

"Alignments written" counts one row per member per section; a member seen in
ten sections is one `identity_edge`, which is why 24,000 alignments became
3,800 new edges. The five crawled series are now mostly the same people again
(100 more WNZ sections added 16 edges); new people will come from the newly
queued series and teams. The table can grow `muir_cache` (153 MB of the 500 MB
cap today) by one crosstable per joined section, an estimated 50 to 80 MB for
the present queue. The first cached pass wrote the link before the identities and
30 identity writes failed under 8 concurrent calls; the order is now identities
first, with retries, and the second pass repaired all 30.

**Model capacity (Item 0).** OpenRouter (`nvidia/nemotron-3-super-120b-a12b:free`)
and Cloudflare Workers AI (`@cf/openai/gpt-oss-120b`) both answer;
`scripts/llm-rotate.mjs` rotates round-robin with a per-provider pause on 429.
Measured for 45 s at 8 concurrent: 115 + 113 = **228 completions a minute, about
90,000 tokens a minute**, no 429. Groq's key exists only as a Supabase secret, so
it was not measured from the laptop. Nothing in the pre-resolution uses a model,
so worker count was sized from MUIR instead. Production `AI_PROXY_*` secrets
were not changed.

**Crawl targets queued (Item 2).** Two discovery waves, each target accepted
only on a tournament whose name and date matched a USCF online section within a
day, or on the organiser's own statement that its events there are USCF rated.

| Platform | Queued | What |
|---|---|---|
| Chess.com | **1,211 tournaments** (1,121 + 90), pending in `roster_tournament` | New series `sfs` (64Squares) 351, `evangel` 512, `aocc` (Westford) 201, `seneca` 54, `morning` 24, `ktchess` 6, `transcon` 3, `supersat` 2, `pnwcc` 12 (10 since skipped); Waltham variants under `wnz` 46 (Under-1201/1400 rated, First Thursday, First Friday, Goldfarb). `chesscomSeries()` extended to match. The running crawler reads the queue from the database and has already fetched 99 of them. |
| Lichess | **659 swisses**, 13 new teams in `crawl_source` | chess-klub-uscf-tournaments, sam-schenk-uscf-online-chess-tournaments, uscf-rated-tournament-club, uscf-chess, presidential-pawn-storm, the-golden-pawn, westfield-chess-club, livingston-scholastic-chess-club, seattle-chess-school-uscf, chess4everyonecom, online-tr-tournaments, start-right-chess, chess-for-all-online-team. `lichessLane` now reads teams from `crawl_source` and keeps Lichess-casual swisses for them. |

Estimated additional USCF sections: about 2,000 on Chess.com (upper bound: every
cached section whose name falls in an accepted series) and 400 to 500 on
Lichess (not checked against MUIR). The running crawler's Lichess lane exited at
start ("nothing pending"), so the 659 Lichess rows wait for the next crawler run:
`node scripts/roster-crawler.mjs --platform lichess` once the lease is free.

Not traceable or not settled: HERMOVENEXT / Impact Coaching Network (653
sections) is played on the organiser's own login-gated server; PLAY N STAY
(Chess NYC, 659 sections) names no platform, its members' identities are mostly
Lichess, and no team swiss list matches it. One member's Lichess games in that
period are all casual direct challenges (`source: friend`), which would put the
series out of reach of tournament rosters; one member is not proof. Great
Lakes Chess League, ISCA, Marshall and True Chess have Lichess teams with no
matching swisses. Mechanics' and Marshall Sunday Beginner were not reached.

**Production changes.** Migration `20261003000400_preresolve_section.sql`
applied (`drop table public.preresolve_section;`). Rows written by the batch:
`delete from section_link where source = 'index' and checked_at >= '2026-10-03 22:04';`
and the `identity_edge` rows whose `sections` name those events. Queued targets:
`delete from roster_tournament where status = 'pending' and series in ('sfs','evangel','aocc','morning','seneca','transcon','ktchess','supersat','pnwcc');`
and `delete from crawl_source where platform = 'lichess' and kind = 'team' and key <> 'dmv-chess-tournaments';`
with their pending `roster_tournament` rows. No secret was set and no function
was deployed.

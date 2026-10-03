# Roster index: enumerable platform data instead of open-web search

Session date: 2026-10-02. Branch: `traversal/section-bfs`.
Every number below states the tag or commit that produced it.

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

Sections the engine never resolved, and an independent cross-check of index
answers against identities proven in *other* sections: see the update below
(run once the backfill has coverage).

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

_pending_

## Phase 4: Kill the guessing

_pending_

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

The largest remaining keys are organisers outside the five series (e.g. one
"play n stay" series, 539 sections; 64Squares "SFS" events; Seneca, PNWCC).

**How an unknown-platform section is ranked: unchanged, at half weight**, and
as "either platform" inside its own section. Reason: the measurement says an
unknown section is almost never ICC (0 of 451 with a known organiser), so it
should not score zero; but it is also, by construction, outside every crawled
series and every listing seen so far, so it needs a seed walk rather than an
index join, and is worth less than a section on a known platform.

## Phase 6: The measurement that was lost

_pending_

## Phase 7: Retrieval and hosting, decided

_pending_

## Phase 8: Human handoff

_pending_

## Production changes

_pending_

## Errors made this session

_pending_

## Undetermined, and what would settle it

_pending_

## Decisions and Assumptions

_pending_

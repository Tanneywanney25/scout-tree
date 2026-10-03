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

_pending_

## Phase 3: The crawler

_pending_

## Phase 4: Kill the guessing

_pending_

## Phase 5: Platform resolution for unnamed sections

_pending_

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

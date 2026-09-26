# ScoutTree — System Architecture & User Experience

> A complete, end‑to‑end map of how ScoutTree works: the frontend UI, the identity
> resolution engine, the scouting pipeline, the edge functions, the AI integration,
> the data model, and the user journey — plus an honest accounting of friction
> points and where the experience could improve.
>
> **Audience:** a developer (or another Claude session) who needs to understand the
> system's design, its trade‑offs, and its rough edges without re‑reading the whole
> codebase.
>
> **Scope note:** this documents *what exists today*, not what it could become
> (except the clearly‑labeled "Proposed improvements" section). Where the code is
> subtle, the doc quotes the actual guard/threshold so it stays truthful.

---

## Table of contents

1. [TL;DR](#1-tldr)
2. [High‑level system overview](#2-high-level-system-overview)
3. [Deployment architecture](#3-deployment-architecture)
4. [Tech stack & repository layout](#4-tech-stack--repository-layout)
5. [Data model](#5-data-model)
6. [The Identity Resolution Engine (Find Player backend)](#6-the-identity-resolution-engine-find-player-backend)
7. [The Scouting Pipeline (username → report)](#7-the-scouting-pipeline-username--report)
8. [AI integration](#8-ai-integration)
9. [Training & spaced repetition](#9-training--spaced-repetition)
10. [End‑to‑end data flow](#10-end-to-end-data-flow)
11. [Screen & component map](#11-screen--component-map)
12. [The user journey, step by step](#12-the-user-journey-step-by-step)
13. [Friction points](#13-friction-points)
14. [Proposed improvements](#14-proposed-improvements)
15. [Trade‑offs & limitations](#15-trade-offs--limitations)
16. [Appendix: file index](#16-appendix-file-index)

---

## 1. TL;DR

ScoutTree is a **chess opponent‑scouting web app** with four features:

| Feature | Route | What it does |
| --- | --- | --- |
| **Find Player** | `/find-player` | Discover a player's Lichess/Chess.com handle from a name + optional clues, using US Chess/FIDE data, tournament crosstables, and school social graphs. |
| **Scout Report** | `/scout` → `/report/:id` | Fetch a player's games and build an opening tree, opponent profile, pawn‑structure/endgame stats, engine weaknesses, and a tailored game plan. |
| **Training Drills** | `/training` | Spaced‑repetition (SM‑2) drills built from mistakes found in scouted games. |
| **Saved Scouts** | `/scouts` | Save and revisit scout report summaries. |

The intellectually heaviest part by far is the **Identity Resolution Engine**
(`src/lib/identity/`). It is *tournament‑first*: it refuses to name‑search a
platform (which finds homonyms too easily) and instead traces the target through
the actual online‑rated US Chess events they played, aligning crosstable results
against real online games until a username falls out. When that fails it walks the
player's **school social graph**. Only as an absolute last resort does it fall back
to name search — and it caps and flags those results as possible namesakes.

Everything is **probabilistic and explainable**: every clue is `Evidence` with a
signed log‑odds `weight`, combined via a logistic function into a 0–1 confidence
the UI can justify piece by piece.

The app **degrades gracefully**: with no edge function and no AI key, Find Player
still works from the direct Lichess/Chess.com providers; the scout pipeline needs
no server at all beyond Supabase auth/usage tracking.

---

## 2. High‑level system overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              BROWSER (Vite + React SPA)                        │
│                                                                                │
│  Pages: Landing · FindPlayer · Scout · Report · Training · MyScouts · …        │
│                                                                                │
│  ┌────────────────────────┐   ┌───────────────────────────────────────────┐   │
│  │  Identity Engine        │   │  Scouting Pipeline                        │   │
│  │  src/lib/identity/*      │   │  chessApi · chessAnalysis · treePool      │   │
│  │  • resolver (phases)     │   │  • fetch games (budgeted, streaming)      │   │
│  │  • uscfGraphEngine       │   │  • opening tree (Web Worker pool)         │   │
│  │  • schoolResolver        │   │  • advancedAnalysis (profile/structure/   │   │
│  │  • conductor (autopilot) │   │     endgame/weakness)                     │   │
│  │  • net (gates/pacers)    │   │  • Stockfish (bundled Web Worker)         │   │
│  │  • confidence (log-odds) │   │  • gamePlan                               │   │
│  └───────────┬────────────┘   └───────────────────────────────────────────┘   │
│              │ direct, CORS-friendly              ▲ direct, CORS-friendly       │
└──────────────┼─────────────────────────────────────┼───────────────────────────┘
               │                                     │
   ┌───────────▼───────────┐        ┌────────────────┴───────────────┐
   │  Lichess public API    │        │  Chess.com public API           │
   │  (autocomplete, games, │        │  (profiles, monthly archives,   │
   │   swiss/arena rosters) │        │   tournament rosters, clubs)    │
   └────────────────────────┘        └─────────────────────────────────┘

               │ CORS-blocked / needs a key / needs HTML scraping
               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                    SUPABASE (Postgres + Auth + Edge Functions)                  │
│                                                                                │
│  Auth (email + Google OAuth, instant signup)                                   │
│  Postgres: profiles · scout_usage · anonymous_scout_usage ·                    │
│            training_positions · saved_scouts · chess_cookies                   │
│                                                                                │
│  Edge Functions (Deno):                                                        │
│   • resolve-identity  → USCF (MUIR) member lookup + tournament graph build,    │
│                          AI reasoning, Google-index username search, event     │
│                          flyer discovery, school lookup + roster + friends     │
│   • explain-move      → natural-language move explanations                     │
│   • training-hint     → natural-language drill hints                           │
└──────────────────────────────────────────────────────────────────────────────┘
               │                                     │
   ┌───────────▼───────────┐       ┌─────────────────▼─────────────────┐
   │ US Chess MUIR JSON API │       │ AI backends (via _shared/ai.ts):  │
   │ ratings-api.uschess.org│       │  proxy → Gemini → Anthropic,      │
   │ (no CORS, server-only) │       │  Google Programmable Search (CSE) │
   └────────────────────────┘       └───────────────────────────────────┘

               ▼ (Vercel-hosted, scheduled)
   ┌───────────────────────────────────────────┐
   │ Vercel: static SPA + /api/refresh-chess-   │
   │ cookie cron (keeps a chess.com session     │
   │ alive for the authenticated friends fetch) │
   └───────────────────────────────────────────┘
```

**Two guiding architectural principles show up everywhere:**

1. **Do CORS‑friendly work in the browser; push everything else to the edge.**
   Lichess and Chess.com have permissive public APIs, so the client hits them
   directly (and in parallel). The US Chess MUIR API sends no CORS headers, AI
   needs a key, and Google/friends need a server — those live in the
   `resolve-identity` edge function.

2. **Never let parallelism become a request storm.** Every platform call funnels
   through `src/lib/identity/net.ts`, which imposes a global Chess.com concurrency
   gate, a Lichess pacer, polite 429 retry/backoff, and a per‑platform outage
   circuit breaker.

---

## 3. Deployment architecture

```
Developer / GitHub
      │
      ├── Vercel  ──────────────► static SPA (Vite build, dist/)
      │                          rewrites: /api/* → serverless, /* → index.html
      │                          cron: /api/refresh-chess-cookie (daily, 0 0 * * *)
      │
      └── Supabase (project xqyszdjczchlgyisvtvo)
                ├── Postgres + RLS (migrations/ auto-applied via GitHub integration)
                ├── Auth (email, no confirmation; Google OAuth)
                └── Edge Functions: resolve-identity, explain-move, training-hint
                       (verify_jwt = false — all three are public)
```

- **Frontend** is a pure client‑side SPA. `vercel.json` rewrites all non‑`/api`
  routes to `index.html` (client routing via `react-router-dom`).
- **Supabase client** ships with hardcoded fallback URL + publishable key
  (`src/integrations/supabase/client.ts`), so the app works even if the
  `VITE_SUPABASE_*` env vars are unset. These are publishable values, safe to
  expose.
- **Edge functions** are optional. If `resolve-identity` isn't deployed, Find
  Player degrades to direct Lichess/Chess.com discovery. If no AI key is set,
  `explain-move`/`training-hint` return graceful "unavailable" messages.
- **The chess‑cookie cron** (`api/refresh-chess-cookie.js`, Vercel scheduled
  function) keeps a chess.com session cookie alive in the `chess_cookies` table so
  the school resolver's *authenticated friends‑list* fetch keeps working without a
  human re‑pasting the cookie. Chess.com's login is Cloudflare‑Turnstile‑protected,
  so the reliable path is **keep‑alive** (seed once from a real browser session,
  extend before expiry) — the project never solves the bot‑check itself.

**Auth configuration** (`supabase/config.toml`) is tuned for zero‑friction signup:
email confirmations are **off** (instant accounts), Google OAuth is enabled, JWT
expiry 1 h with refresh‑token rotation.

---

## 4. Tech stack & repository layout

**Frontend:** Vite + React 18 + TypeScript, Tailwind CSS + shadcn/ui (Radix
primitives), `@tanstack/react-query`, `react-router-dom`, `sonner` (toasts),
`recharts`, `chess.js` (rules), `chessboardjsx` (boards), Stockfish (bundled Web
Worker in `public/`), `comlink` (worker RPC).

**Backend:** Supabase (Postgres + Auth + Deno edge functions). Vercel for hosting
+ cron.

**Data sources:** US Chess MUIR API, FIDE (via AI/edge), Chess.com public API,
Lichess public API, NWSRS / state associations (school data), Google Programmable
Search, Gemini/Anthropic (AI + web search).

### Repository layout (the parts that matter)

```
src/
  pages/            Landing, FindPlayer, Scout, Report, Training, MyScouts,
                    Auth, AuthCallback, Onboarding, Settings, NotFound
  components/
    findplayer/     PlayerSearchForm, SearchExperience, IdentityResults,
                    ConfidenceBadge, SearchLogDialog
    (report)        InteractiveOpeningTree, OpponentProfile, StructureWeaknesses,
                    EndgameProfile, WeaknessDashboard, GamePlanCard,
                    ScoutIdentityHeader, DeepAnalysisTab, TrainingDashboard, …
    ui/             shadcn/ui primitives
  lib/
    identity/       THE IDENTITY ENGINE (see §6)
      resolver.ts           phase orchestrator
      conductor.ts          proactive-intelligence autopilot
      uscfGraphEngine.ts    tournament-graph traversal (3.7k lines)
      schoolResolver.ts     school social-graph fallback
      confidence.ts         log-odds scoring & name/rating similarity
      net.ts                gates, pacers, 429 retry, circuit breaker
      verify.ts             live profile verification
      handoff.ts            Find Player → Scout handoff contract
      cache.ts              session-wide fetch + identity caches
      types.ts / graphTypes.ts / schoolTypes.ts
      providers/            uscf, fide, chesscom, lichess, google, chessresults,
                            uscfGraph, edgeClient, schoolResolver (browser hooks)
    chessApi.ts             game fetching (budgeted, streaming)
    chessAnalysis.ts        opening-tree types / serialization
    analysis/               treePool, treeWorker, treeCore (worker tree build)
    advancedAnalysis.ts     orchestrates profile/structure/endgame/weakness
    engineAnalysis.ts       Stockfish wrapper
    opponentProfiling.ts, structureStats.ts, endgameStats.ts,
    weaknessDetection.ts, gamePlan.ts, trainingGeneration.ts, savedScouts.ts, …
  hooks/            useAuth, useProfile, use-mobile, use-toast
  integrations/supabase/  client, generated types

supabase/
  functions/
    resolve-identity/  index, uscf, googleSearch, school, schoolAdapters
    explain-move/      index
    training-hint/     index
    _shared/           ai.ts, chessCookie.ts
  migrations/          init_schema.sql, chess_cookies_cache.sql

api/                   Vercel serverless: refresh-chess-cookie (cron), refresh
scripts/               Node CLI harnesses (trace-username, test-conductor, …)
```

---

## 5. Data model

### 5.1 Postgres (with row‑level security)

`supabase/migrations/20260628000000_init_schema.sql` creates five tables (plus
`chess_cookies` in a later migration). RLS restricts every user to their own rows;
a trigger auto‑creates a `profiles` row on signup.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `profiles` | One row per auth user | `lichess_username`, `chesscom_username`, `rating`, `preferred_platform`, `goals[]`, `onboarded` |
| `scout_usage` | Scouts run by logged‑in users | `user_id`, `username`, `platform`, unique `(user_id, username, platform)` |
| `anonymous_scout_usage` | 1 free scout per browser fingerprint | `fingerprint` (unique) |
| `training_positions` | Spaced‑repetition drill library | `fen`, `move_to_find`(+`_uci`), `weakness_category`, `difficulty`, `eval_loss`, SM‑2 fields (`easiness_factor`, `next_review`, `mastery_level`, `times_attempted/correct`) |
| `saved_scouts` | Saved report summaries | `opponent_username`, `platform`, `player_color`, `total_games`, `summary jsonb` |
| `chess_cookies` | Service‑role‑locked chess.com session cache | (used by the friends fetch + cron) |

### 5.2 Key TypeScript structures (identity engine)

The engine's vocabulary lives in `src/lib/identity/types.ts`:

- **`PlayerQuery`** — everything the user knows. Only `name` is required; the rest
  (rating, federation, country, state, club, school, ageOrGrade, `uscfId`,
  `fideId`, `usernameHint`, tournament context, `additionalDetails`) are optional
  clues.
- **`Evidence`** — the atomic unit of belief:
  `{ kind, weight, label, source }`. `weight` is a **signed log‑odds** contribution
  (~0.4 weak · ~1.0 moderate · ~2.0 strong · ~4.0 near‑decisive like an exact ID).
  `label` is shown verbatim in the UI.
- **`DiscoveredAccount`** — a candidate online presence: platform, username,
  ratings, `fideId`, `gamesFound`, `lastActive`, `verified`, `confidence`, and its
  own `evidence[]`.
- **`ResolvedIdentity`** — a real person + their accounts, overall `confidence`,
  identity‑level `evidence`, plain‑English `reasoning`, and `sources[]`.
- **`Provider`** — every data source implements `{ name, label, enabled(query),
  run(ctx) → ProviderResult }`.
- **`ResolutionResult`** — what the page renders: `identities[]`,
  `providerStatus[]`, `elapsedMs`, `phaseTimings`, `partialOpponents`.
- **`SearchEvent`** — one narrated step for the live "detective" UI:
  `{ id, message, provider?, status: running|done|info, timestamp }`.

The **tournament graph** shapes (`graphTypes.ts`, mirrored server‑side): a
`TournamentGraph` has a `rootUscfId`/`rootName` and `onlineEvents[]`; each
`GraphEvent` carries its full section roster (`GraphPlayer[]`), and each player
carries their round‑by‑round `GraphGame[]` (round, color, outcome, opponent USCF
id). This is the mesh the client traverses.

The **scout handoff** (`handoff.ts`): a serialisable `ScoutHandoff` written to
`sessionStorage` under `findPlayerHandoff`, carrying the chosen platform/username
(+ optional second account), the color, and a `ScoutIdentity` summary embedded into
the report header.

---

## 6. The Identity Resolution Engine (Find Player backend)

This is the heart of the app. Its job: turn *"a name plus a few optional hints"*
into one or more **resolved identities**, each carrying the online accounts we
believe belong to that person, with a transparent confidence score.

### 6.1 Design philosophy: tournament‑first, never name‑search

Online usernames rarely match real names, and searching a platform by name finds
the wrong homonym far too easily (*"the 200‑rated John Smith is not the 2000‑rated
one you're scouting"*). So the engine **never name‑searches the target**. It works
in strict trust tiers, and name search is the extreme last resort — capped and
explicitly flagged as a possible namesake.

### 6.2 The phase pipeline (`resolver.ts`)

`resolveIdentity(query, { signal, onEvent })` runs these phases. It wraps the core
in a **conductor** (§6.6) and attaches a net observer, restoring both in a
`finally` even on abort/error. Each phase is timed (`phaseTimings`) and narrated
via `onEvent`.

```
                          resolveIdentity(query)
                                   │
   ┌───────────────────────────────┼──────────────────────────────────────────┐
   │ 0. HINT PREFETCH (overlap)     │  If the user typed a username hint, start │
   │    verifyAccount() for each    │  its Lichess/Chess.com profile fetches    │
   │    hinted handle NOW, in       │  concurrently with the anchor+graph edge  │
   │    parallel with phase 1.      │  call (disjoint resources → free overlap).│
   └───────────────────────────────┘                                           │
                                   ▼                                            │
   1. ANCHOR PHASE  ── run PROVIDERS concurrently (uscf, fide, google/ai,        │
      "who is this   chessresults). All four are thin wrappers over ONE memoized │
      person?"       resolve-identity edge call. Establishes IDs, state,         │
                     ratings, online-rated history. Also verifies a user-        │
                     supplied username hint here (that's their knowledge).       │
                                   ▼                                            │
   1b. HINT PROBE ── score the prefetched hinted handles. If a hinted handle    │
      matches the target's FIDE id, or its profile name is ≥0.92 similar →      │
      hintStrong = true, and the tournament trace is SKIPPED (we already have   │
      the account).                                                             │
                                   ▼                                            │
   2. PRIMARY DISCOVERY ── the TOURNAMENT-GRAPH TRAVERSAL (§6.3). Fetch the      │
      target's USCF tournament graph via the edge; if they have traceable       │
      online events, work every one to exhaustion until a username falls out.   │
      Guarded only against WEDGING (90s stall watchdog + a 6h "effectively       │
      unbounded" hard ceiling), never against slowness.                        │
                                   ▼                                            │
   3. FALLBACKS (only if traversal + hint found nothing), in strict order:       │
      3a. GOOGLE INDEX  ── site:-restricted searches tying the real name to     │
          indexed profile pages; verified live, capped at 0.70 confidence.      │
      3a½. SCHOOL SOCIAL GRAPH (§6.4) ── trace the player through their          │
          school's cohort; capped at 0.90 (0.985 with a federation-ID anchor).  │
      3b. PLATFORM NAME SEARCH ── Lichess/Chess.com by name. Absolute last       │
          resort, capped at 0.62, demoted with a "could be a namesake" note.    │
                                   ▼                                            │
   4. CLUSTER ── group anchor fragments + discovered accounts into identities   │
      (match by ID digits or name similarity ≥0.72; attach accounts to the      │
      best cluster at ≥0.62).                                                    │
                                   ▼                                            │
   5. SCORE & RANK ── score each cluster in log-odds space, keep the top 4.     │
```

**Key confidence caps** (from `resolver.ts`):
`NAME_FALLBACK_MAX_CONFIDENCE = 0.62`, `GOOGLE_FALLBACK_MAX_CONFIDENCE = 0.70`.
The traversal and school routes can go higher because they're anchored to real
games / social graphs.

**Partial‑progress honesty:** if the traversal mapped some of the target's
*opponents* to handles but never confirmed the *target's own* account, the result
carries `partialOpponents = N`, and the UI shows a prominent warning that any handle
shown is a *same‑name guess*, not a tournament‑confirmed match. (This is dropped if a
later fallback produced a genuinely verified account.)

### 6.3 The tournament‑graph traversal (`uscfGraphEngine.ts`, ~3,770 lines)

This is the primary discovery engine. Given the target's USCF online events (each
with a full crosstable), it works every event until a username falls out. There are
**no request‑count caps and no meaningful time budget** — it runs until exhausted or
the user aborts; politeness pacing is the only rate control.

**Stage 0 — research every event's host BEFORE any name work** (top level only;
`organizerDiscovery.ts` + `sectionAlign.ts`, added 2026‑09):

- The edge's title regex only treats a *standalone* "chess.com" as a platform hint —
  an organizer domain such as "DMVCHESS.COM" is the organizer, not the host (those
  events run on Lichess). The engine also sanitizes stale hints on ingest.
- **Organizer research:** read the organizer off the event names (domain, leading
  phrase, or a prefix shared by ≥2 events) → `GET /api/team/search` → stream the
  team's swiss and arena history newest‑first (`/api/team/{id}/swiss|arena`, ~20
  rows/s, stopped at the target's oldest event, cached in `localStorage`) → match
  each USCF section to the exact tournament by **date (US‑tz tolerant), rounds,
  clock, roster size and section/name tokens**. Matching is incremental: the newest
  events are handed over while the older history is still downloading.
- **Whole‑section alignment:** a located tournament's full game list (one
  `/api/swiss/{id}/games` export, or the Chess.com bracket tagged per round) is
  aligned to the crosstable by constraint propagation over round‑by‑round results —
  every player of the section, target included, maps in one pass with no name ever
  searched. The same alignment validates a games‑derived link, so a single seed
  found by any route unlocks its whole section.
- Then the flyer/web search runs only for events still unknown, an organizer proven
  on one platform lends that platform to its sibling events, and events are ranked by
  resolvability: located tournament → Chess.com → Lichess → unknown → ICC/ChessKid.

For each online‑rated event, in order:

1. **Pin the host platform** — from stage 0, else from a web/flyer search (the
   `discoverPlatform` hook → edge AI/Google looks up the TLA / club announcement /
   exact tournament slug), or by trying both platforms. A late web answer that
   places the event elsewhere *replaces* the platform list and re‑runs the seed hunt.
1b. **Whole‑section alignment** of any located tournament (see stage 0).
2. **Roster shortcut (elimination)** — most USCF online events ran as a Chess.com
   tournament or Lichess swiss/arena whose public API returns the **exact
   participant handles**. Match them to the crosstable by real name; if every player
   *but the target* is claimed, the leftover handle **is** the target.
3. **Google‑index the target** — the `findUsernames` hook runs a site‑restricted
   query ladder tying the name to indexed handles. A candidate only counts once it
   provably has games inside the event's date window (round‑sequence alignment,
   membership in the linked tournament, or games against confirmed section players).
   A lead with no in‑window games is the *wrong* username — keep searching.
4. **Seed hunt** — resolve *any* section player's account (direct opponents first,
   then the whole roster) the same Google‑first, date‑verified way. Seeds are never
   the answer; they're entry points.
5. **Pairing‑chain BFS** — from each seed, pull their games in the event's date
   window (Chess.com monthly archives / Lichess since‑until export), scope them to
   the event (tournament/swiss linkage, else rated + expected time control), and
   **align them 1:1 against that player's crosstable rounds** by matching the
   win/loss/draw sequence (and colors, and already‑known handles). Every aligned game
   maps one more crosstable player to their handle — *player 22 reveals player 10,
   who reveals player 15…* — until a chain reaches the target. No name is needed at
   any hop: **the pairing itself is the proof.**
6. **Deep recursion (depth 1)** — if every event fails, recurse into direct
   opponents' *own* online histories (via the `expandMember` edge hook) to pin their
   handles first, then re‑trace the shared event.

A **FIDE ID** linked on a candidate profile is checked against the target's
USCF‑registered FIDE ID: a match is near‑decisive (`weight 4.0`), a hard mismatch
rejects (`weight -3.0`).

**The alignment algorithm** (`alignRounds`) is a dynamic program that finds the best
ordered subsequence match between crosstable rounds and time‑sorted archive games,
tolerating spare games (warm‑ups, casual games) and missing rounds (byes, forfeits,
second‑account games). It refuses to align a big mixed game pool unless it's
"well‑anchored" (≥ half the rounds already pinned to known handles) — a guard added
after a rated bullet game once stole a round a player actually spent against the
target.

**Speed comes from concurrent agents, never from skipping work:**

- **Event agents** (4) work several events at once.
- **Seed scouts** (6) resolve several section players in parallel.
- **Pairing tracers** (3) drain the frontier concurrently — a fresh mapping is
  traced the moment it lands.
- **Deep agents** (3) expand several opponents at once.
- Expensive fetches (profile verifies, game archives, Google searches, Chess.com
  monthly archives) are **memoized once in `SharedCaches` and shared** all the way
  down into deep‑phase sub‑traversals — nothing is fetched twice.

**Data‑hole vs. verdict discipline:** a failed fetch ("the shard hiccuped") must
never read as "played nothing." Chess.com months and Lichess windows that fail are
recorded in `ccFailedMonths` / `lichessFailedWindows` (keyed to failure time), fast‑
fail during a cooldown, and are never cached as empty — because a lost month of games
can break a pairing chain and reject a player's *real* account as a namesake.

The **agent‑fleet sizes are LIVE tunables** when a conductor is attached (§6.6).

> **Memory note (project‑specific):** the engine skips schoolmates whose *entire*
> online footprint is on no‑public‑API platforms (ICC / ChessKid) —
> `hasTraceableOnlineHistory()` / `NO_PUBLIC_API_PLATFORMS` — because those are dead
> ends for username discovery and not worth the opponent‑pivot minutes for a single
> social anchor (commit 29651f0).

### 6.4 The school social‑graph resolver (`schoolResolver.ts`)

The fallback for a player with **zero online USCF tournament history**. It
reconstructs the target's account from their **school's social graph**:

1. **School** — resolve the target's school via server‑backed hooks (NWSRS / state
   associations / registration platforms / LinkedIn / web). Only schools whose state
   matches the target's are trusted.
2. **Cohort** — pull the school roster and resolve schoolmates to online handles the
   *same way the main engine does*: roster name + state → USCF member ID (public
   ratings search) → the full tournament‑graph traversal on that ID. Every mate earns
   a full, unbounded trace; the only shortcut is the engine‑confirmed identity cache.
   Google‑index search is the fallback for mates the USCF route can't resolve.
3. **Social graph** — for each resolved schoolmate, gather connections from three
   public/member‑public signals:
   - **Friends** — chess.com's friends list (member‑public, fetched server‑side with
     a session cookie). The strongest signal when available.
   - **Game overlap** — frequent opponents in public game archives (always‑on,
     keyless default). ≥3 games vs a handle = a "connection."
   - **Clubs/teams** — small chess.com clubs / lichess teams shared with the cohort.
4. **Identify** — the account connected to **multiple** schoolmates (or dominating
   one schoolmate's play) is the lead. Verify it, then confirm with rating proximity,
   US/state location, cross‑platform handle consistency, and — decisively — a
   **federation‑ID cross‑check**.

**Confidence bar** (`scoreCandidate`): a federation‑ID anchor → up to 0.985; a
purely‑social tie to **2+** schoolmates → capped at `SCHOOL_SOCIAL_MAX_CONFIDENCE =
0.90`; a tie to a *single* schoolmate (even heavy, even with a matching rating) →
capped at 0.72 (kept below the UI "high" band). This mirrors the manual method:
identify by *multiple* mutual connections, not a lone tie.

**Concurrency:** `USCF_MATE_POOL = 2` unbounded traces in flight (a rate‑limit
governor, not a count cap — it drains the *entire* roster), `CRAWL_POOL = 6`,
`CANDIDATE_VERIFY_POOL = 8`. No time budget by default — the abort signal is the only
external stop.

> **Memory note (verification gotcha):** because a warm MUIR cache + a wedged mate
> trace make single full live runs unreliable, confirm the crawl via targeted
> harnesses rather than one end‑to‑end run (`trace-school-live-verification.md`).

### 6.5 Confidence model (`confidence.ts`)

Confidence is computed in **log‑odds space**: start from a prior (default `-1.4` ≈
20% before any evidence), add every `Evidence.weight`, then squash with a logistic
function, clamped to `[0.02, 0.985]` (so even an exact‑ID match never reads as a
literal 100%).

```
confidence = sigmoid( prior + Σ evidence.weight )
```

Supporting helpers:

- **`nameSimilarity`** — order‑robust token‑set overlap + whole‑string Sørensen–Dice
  bigram similarity. **`nameMatchWeight`** maps it to signed weight (≥0.92 → +2.4;
  ≤0.30 → −1.8), so a random look‑alike username can't masquerade as the person.
- **`ratingMatchWeight`** / **`onlineRatingMatchWeight`** — deliberately lenient on
  large gaps (USCF OTB ratings sit several hundred points above online ratings for
  the same person), but a >1000‑pt gap becomes real counter‑evidence (a 242‑rated
  namesake once scored 62% on name alone; this cancels it).
- **`graphDiscoveryWeight`** — the strongest signal short of an ID match: a date‑
  matched game against a confirmed opponent (base 2.0, +0.6 per corroborating
  opponent).

**UI buckets:** `high ≥ 0.75`, `medium ≥ 0.45`, `low` otherwise (colour‑coded).

### 6.6 The conductor — proactive intelligence (`conductor.ts`)

The engines already emit rich real‑time signals (429s, gate occupancy, queue depths,
per‑trace activity, mid‑phase candidates). The **conductor** turns those signals into
autonomous, strategy‑level decisions *while a search runs*, on a once‑per‑second
tick. It's dependency‑free (no imports) so it runs in the browser, the Node CLI, and
tests alike; with no conductor attached the engines behave exactly as before.

| Policy | Trigger | Action |
| --- | --- | --- |
| **Rate governor** | ≥3 × 429 in 15s | Step the Chess.com gate and seed‑fleet **down** (fewer wasted retries). A clean 30s window steps them back up. |
| **Throughput booster** | Free gate slots + queued work | Raise seed/trace/event agent limits (bounded) so queued work drains. |
| **Stall detector** | A trace silent past `max(90s floor, 3× EMA of typical trace duration)` **and** quiet > 45s | Stand the trace down cooperatively (it keeps everything it already found). |
| **Early exit** | A federation‑ID‑**anchored** candidate at **≥90%** | The whole phase is won; remaining traces stand down and the answer ships now. |
| **Progress heartbeat** | A phase has agents working but no decision logged for 12s | Narrate "still working — N of M schoolmates resolved, Ns elapsed" so a quiet stretch never reads as a hang. |

Its **accuracy contract**: every policy can only *preserve or improve* the result —
the governor changes only *how fast* requests go out; the booster only adds
parallelism behind the same polite gates; the stall detector only stands down
genuinely‑wedged traces; the early exit fires only on the one evidence class the
engine itself treats as decisive.

### 6.7 Network discipline (`net.ts`)

Every platform call in the identity stack funnels through here:

- **Chess.com** — a global concurrency **gate** (`semaphore`, default 12 in‑flight).
  Any number of logical agents can queue; only N HTTP requests fly. The limit is
  **live** (the conductor lowers/raises it).
- **Lichess** — a global **pacer** (`lichessSlot`, ~250 ms spacing) because Lichess
  rate‑limits per IP.
- **`politeFetch`** — per‑attempt timeout, 429 backoff‑retry (429 means "slow down,"
  never "doesn't exist"), and a **per‑platform circuit breaker**: after 6 consecutive
  transport failures the circuit opens and calls fast‑fail for 45s (then one half‑open
  probe tests recovery). This turned a 12‑minute run during a Lichess outage back into
  ~30 seconds. A **net observer** slot reports every 429/ok/fail to the conductor.

### 6.8 The `resolve-identity` edge function

The server half of the engine (`supabase/functions/resolve-identity/`). It always
returns HTTP 200 with a structured body, and handles several modes on one endpoint:

| Mode (request body) | Purpose |
| --- | --- |
| `{ query }` (default) | Resolve USCF member(s) + build the tournament graph + run an AI reasoning pass (graph build and AI run **concurrently**). Big graphs are gzipped. |
| `{ expandMemberId }` | Build just the graph for one member (deep‑phase recursion). Memoized 15 min. |
| `{ discoverEvent }` | Web/flyer search: which platform hosted this USCF event (+ exact slug/swiss id). |
| `{ findUsername }` | Google‑index search for a person's handles (the query ladder). |
| `{ findUscfId }` | Name + state → USCF member ID (the school resolver's bridge). |
| `{ findSchool }` / `{ schoolRoster }` / `{ chesscomFriends }` | School lookup, roster fetch, authenticated friends fetch. |

- **`uscf.ts`** talks to the **MUIR JSON API** (`ratings-api.uschess.org`) — US Chess
  retired the old HTML MSA pages in mid‑2026. It searches members (fuzzy name +
  state), reads real ratings (including the Online systems OR/OQ/OB), and walks a
  member's event history → sections → standings to build the crosstable graph. A
  member `hasOnline` when any online rating is non‑null — those are the traversable
  players. Everything is defensive (any failure → empty, never throws). Requests are
  **adaptively paced** (light base gap that backs off hard on a 429).
- **`googleSearch.ts`** runs the site‑restricted query ladder against either the
  **Google Programmable Search JSON API** (preferred — the literal index) or **AI with
  live web search**. Results are *leads* the client must verify against real games.
- **`school.ts` / `schoolAdapters.ts`** resolve schools and rosters from NWSRS / state
  associations / the web, and fetch chess.com friends server‑side.

The **client edge wrapper** (`providers/edgeClient.ts`) memoizes one edge call per
query so all four anchor providers share a single round‑trip, applies generous
client‑side timeouts (480s for the main call — the graph build can legitimately run
minutes on an active player), retries once, and **never caches a failure as "no
data."**

---

## 7. The Scouting Pipeline (username → report)

Once an identity is confirmed (or a username typed directly on `/scout`), the scout
pipeline fetches games and analyses them. This half needs no edge function — it hits
Lichess/Chess.com directly.

### 7.1 Handoff (`handoff.ts`)

Confirming an identity on `/find-player` builds a `ScoutHandoff` (primary account +
optional second account on the other platform + color + a `ScoutIdentity` summary),
writes it to `sessionStorage`, and navigates to `/scout`, which **auto‑prefills and
auto‑runs**. The resolved identity is carried into the report header. Only accounts
on *fetchable* platforms (Lichess/Chess.com) can seed a report.

### 7.2 Game fetching (`chessApi.ts`) + budget

`Scout.tsx` drives the fetch. A shared **fetch budget** (`createFetchBudget` — a
raw‑game cap + wall‑clock deadline) bounds the whole scout to ~90s no matter how
active the player is. Games stream in via a progress callback; a second account's
games are **normalized** so the scouted player's name matches the primary username,
then merged into one report. A failed *secondary* account doesn't sink the report; a
failed primary is fatal.

### 7.3 Opening tree (Web Worker pool)

PGN parsing and tree building run **off the main thread** across CPU cores via a
`TreePool` (`src/lib/analysis/`), in amortized chunks of 48 games. Partial trees are
merged into the canonical Map tree (`mergeSerializedIntoNode`), which re‑renders a
**live preview** as games arrive. When fetching completes, `finalizeAnalysis`
computes the weakest/strongest lines once. Abort‑safe: a stopped analysis still
finalizes and shows a partial report.

### 7.4 Advanced analysis (`advancedAnalysis.ts`)

Runs at the **Report page level** (not inside a tab) so it keeps going while the user
browses, and isn't cancelled by switching tabs. Two phases over up to 300 collected
games:

- **Phase 1 (fast, always, 0–20%)** — opponent profile, pawn structures, endgames,
  in chunks with yields so the progress ring fills gradually.
- **Phase 2 (slow, optional, 20–100%)** — **Stockfish** weakness analysis over as
  many games as fit within `timeCapMs` (default 150s). Fully guarded: if the engine
  can't load it's skipped and phase‑1 results stand. Partial results stream via
  `onPartial`.

The Report page (`Report.tsx`) surfaces this in tabs: **Opening Tree**,
**Advanced** (Game Plan + Opponent Profile / Pawn Structures / Endgames / Weaknesses
sub‑tabs), **Deep Analysis** (single‑game engine review). Each tab is wrapped in an
`ErrorBoundary` so one crash can't take down the whole report. The report is passed
between pages via `sessionStorage` (`scoutAnalysis`), which is progressively trimmed
if it exceeds the ~5MB quota.

### 7.5 Game plan (`gamePlan.ts`)

Synthesizes the opening tree + profile + structure/endgame reports (+ the user's own
rating, when signed in) into a concrete, prioritized plan (`GamePlanCard`): what to
play, which lines to steer toward, which weaknesses to target.

---

## 8. AI integration

All AI runs through **`supabase/functions/_shared/ai.ts`**, a provider‑agnostic
helper with a strict backend order and heavy rate‑limit discipline.

**Backends, tried in order** (all optional; callers catch errors and fall back to
non‑AI text):

1. **AI proxy** — an OpenAI‑compatible unified router (e.g. FreeLLMAPI) that pools
   many free‑tier providers behind one key. Gemini `google_search` grounding passes
   through it, but a grounded reply is trusted **only** when the proxy reports it was
   routed via the Google platform (otherwise the reply is ungrounded — the "namesake
   bug" — and is rejected).
2. **Google Gemini direct** (`GEMINI_API_KEY`, default `gemini-2.5-flash`).
3. **Anthropic Messages API** (`ANTHROPIC_API_KEY`, default
   `claude-haiku-4-5-20251001`).

Plus **Google Programmable Search (CSE)** as a separate, preferred discovery backend
(the literal index, no AI in the loop).

**Rate‑limit discipline** (shared by every Gemini/proxy call in the process): a
concurrency gate (3), inter‑call spacing, bounded exponential backoff honoring
`Retry-After`, and a process‑wide **cooldown** once the quota is proven exhausted so
the other 39 calls in a burst fail fast (and it's logged once) instead of each
re‑hitting the wall.

Two consumer functions:

- **`explain-move`** — takes a FEN + the played move + best move + eval diff +
  classification (inaccuracy/mistake/blunder) + phase, describes the board from the
  FEN, and asks the model for a 2–3 sentence coaching explanation. Returns graceful
  fallbacks on 429 / no key.
- **`training-hint`** — natural‑language hints for the current drill.

`callAIWithSearch` enables the provider's live web‑search tool (Gemini grounding /
Anthropic `web_search`) — used by the identity engine to look up tournament flyers,
TLAs, and announcements. AI in the identity engine is **fallback‑only** — its
suggested handles are verified in the fallback phase, never trusted blind.

---

## 9. Training & spaced repetition

`trainingGeneration.ts` turns engine‑found mistakes into `training_positions`:

- **Extraction** — keep only significant, legal mistakes (min eval loss scaled to the
  user's rating: 250cp under 1200, down to 60cp above 2400), diversified across games
  (round‑robin, ≥6‑move gap within a game, hardest first) so drills aren't consecutive
  plies from one game.
- **Difficulty** — 1–5 from eval loss. Each drill stores a spoiler‑free `game_context`
  prompt and a post‑attempt `explanation`.
- **SM‑2 spaced repetition** — `calculateNextReview(quality, easinessFactor,
  consecutiveCorrect)`: quality < 3 resets to 1 day; then 1 → 6 → `interval × EF`
  days, capped at 365. `quality` is derived from attempts needed + whether a hint was
  used. Mastery (0–5 stars) tracks success rate × attempts.
- **Persistence** — deduped by FEN per user; `TrainingDashboard` shows stats (total,
  due today, mastery distribution, weakness breakdown) and drives review sessions.
  Training is **sign‑in‑gated**.

---

## 10. End‑to‑end data flow

**Find Player → Scout → Report (the full happy path):**

```
User types "Jane Smith, WA, ~1600" on /find-player
        │
        ▼
resolveIdentity(query)  ──emits SearchEvents──►  SearchExperience (live UI)
        │
        ├─ anchor phase ──► resolve-identity edge ──► MUIR member + tournament graph
        │                                          └─► AI reasoning candidates
        │
        ├─ traversal ──► Chess.com/Lichess (rosters, archives) ──► pairing chains
        │                (+ discoverEvent / findUsername edge hooks)
        │
        └─ (fallbacks: Google index → school graph → name search, if needed)
        │
        ▼
ResolutionResult { identities[], providerStatus[], phaseTimings, partialOpponents }
        │
        ▼
IdentityResults UI  ──user picks accounts, clicks "Generate Scout Report"──►
        │
        ▼
buildHandoff() → sessionStorage["findPlayerHandoff"] → navigate("/scout")
        │
        ▼
Scout auto-runs: fetch games (budgeted, streaming) ──► TreePool workers ──►
        opening tree (live preview) ──► finalizeAnalysis ──► sessionStorage
        │
        ▼
navigate("/report/:username")
        │
        ▼
Report: ScoutIdentityHeader + Opening Tree + Advanced (Stockfish weakness pass) +
        Deep Analysis + Game Plan  ──(optional)──► Save Scout / generate Training
```

**Where state lives:**

| State | Where | Lifetime |
| --- | --- | --- |
| Search progress / events | React state in `FindPlayer` (bounded tail) + a `useRef` full log | during the search |
| Resolution result | `FindPlayer` state | until reset / navigate |
| Identity → Scout handoff | `sessionStorage["findPlayerHandoff"]` | 10 min (age‑checked) |
| Report analysis payload | `sessionStorage["scoutAnalysis"]` | one‑shot (cleared on read) |
| Pending scout params (auth interrupt) | `sessionStorage["pendingScoutParams"]` | 10 min |
| Auth session | Supabase (`useAuth`) | JWT 1h + refresh |
| Saved scouts / training / profile | Postgres (RLS) | persistent |
| Session‑wide fetch/identity caches | module‑level Maps in `cache.ts` / engine | page session |

---

## 11. Screen & component map

### 11.1 Routes (`App.tsx`)

```
/                 Landing        (Hero + PlatformLogos; marketing)
/find-player      FindPlayer     ★ the identity discovery experience
/scout            Scout          username entry + game fetch + live opening-tree preview
/report/:id       Report         the full scout report (tabs)
/demo             Report         demo report
/opening-tree     OpeningTree    standalone opening explorer
/training         Training       spaced-repetition dashboard (sign-in gated)
/scouts           MyScouts       saved scout summaries (sign-in gated)
/auth             Auth           email + Google sign-in/up
/auth/callback    AuthCallback   OAuth return
/onboarding       Onboarding     first-run profile setup
/settings         Settings       profile / linked accounts
*                 NotFound
```

Global providers wrap everything: `QueryClientProvider`, `TooltipProvider`, two
toasters, `BrowserRouter`, `AuthProvider`. Navigation is via a sticky `Header` (Home
· Find Player · Scout · — signed‑in: My Scouts · Training · Settings — · Sign
in/out).

### 11.2 Find Player components (the real ones)

> The brief mentioned components like `SearchPhaseStrip`, `ConfirmPanel`,
> `NoMatchDiagnosis`, `DiscoveryTabs`. Those names **do not exist** in the codebase;
> the actual components are listed below. Documenting what exists:

| Component | Role |
| --- | --- |
| **`PlayerSearchForm`** | The input form. One prominent required **name** field; everything else is behind a collapsible "Add anything else you know" (rating, federation, country/state, club, school, age/grade, USCF/FIDE id — shown conditionally by federation, username hint, tournament context, free‑text details). Shows a count of filled optional fields. |
| **`SearchExperience`** | The full‑screen "AI detective" overlay during a search: an animated scanner ring with orbiting source nodes (US Chess, FIDE, Lichess, Chess.com, Web+AI, Opponent trace) that light up as providers run/finish; an eased time‑based progress bar; a phase label; a live reasoning feed (last 8 events); a dedicated "resolving schoolmates… N of M" readout for the long, quiet school phase; and a "View full log" button. |
| **`SearchLogDialog`** | The unabridged, live‑refreshing search log (every event, not just the tail). |
| **`IdentityResults`** | The results view. Renders `IdentityCard`s (selectable when multiple matches), each with the identity header, the `partialOpponents` warning banner when applicable, a plain‑English reasoning line, identifier chips, an "Why we believe this" evidence chip cloud (green +/red −), and the discovered‑accounts grid. `EmptyState` handles no‑match. |
| **`IdentityCard` / `AccountCard`** | Per‑identity and per‑account. Accounts default‑selected at ≥45% confidence, show rating/games/last‑seen, an "Open profile" link, a green **ShieldCheck** ("identity confirmed through tournament games") vs an **"unconfirmed"** namesake caveat, and a "Generate Scout Report" button. |
| **`ConfidenceBadge`** | The colour‑coded confidence pill (`72% · Possible match`) with an optional bar, driven by `confidenceLevel`/`confidencePercent`. |

### 11.3 Report components

`ScoutIdentityHeader` (identity confidence/evidence/accounts, when arriving from Find
Player), `InteractiveOpeningTree` (+ `OpeningTreeViewer`, `OpeningLineBoard`),
`OpponentProfile`, `StructureWeaknesses`, `EndgameProfile`, `WeaknessDashboard`,
`GamePlanCard`, `DeepAnalysisTab`, `CircularProgress`. Report‑level state (advanced
analysis) lives in `Report.tsx`; the analysis payload arrives via `sessionStorage`.

### 11.4 State management summary

- **No global store** (no Redux/Zustand). State is local `useState`/`useRef` per
  page, plus React Query (configured but lightly used), plus `AuthProvider`/
  `useProfile` context for auth/profile.
- **Cross‑page handoff** is `sessionStorage` (deliberately — it survives the
  navigation but not a new tab, and is age‑guarded).
- **Engine caches** are module‑level singletons in `cache.ts` and the engine files,
  shared across the main search and every school‑mate sub‑trace within a session.

---

## 12. The user journey, step by step

### 12.1 Landing & entry points

The user lands on `/` (Hero + platform logos). Entry points into real work: **Find
Player** (discover a handle) and **Scout** (you already know the handle). Signed‑in
users also see My Scouts, Training, Settings. Signup is instant (no email
confirmation) via email or Google.

### 12.2 Find Player — the full flow

**1. Landing on the page.** A confident headline ("Find anyone. Scout everyone."),
three value props, and a single card with one big field: *"Who are you trying to
scout?"* — "Just a name is enough." Everything else is optional and collapsed.

**2. Entering information.** The user types a name and optionally expands "Add
anything else you know." A username hint field explicitly invites *"I think it starts
with chess…"*; tournament context reveals round/section/board/color sub‑fields when a
tournament name is entered; a free‑text box says *"Everything here becomes evidence."*

**3. Waiting (the detective).** On submit, the full‑screen `SearchExperience` takes
over (with a 1.2s minimum display floor so it never just flashes). The user sees:
- source nodes lighting up as US Chess / FIDE / Lichess / Chess.com / Web+AI /
  Opponent‑trace providers run and finish,
- a phase label ("Investigating" → "Tracing tournament opponents" → "Tracing
  schoolmates" → "Match found — assembling the profile"),
- a live reasoning feed narrating real steps ("Tracing the player's USCF online
  events…", "⏱ Tournament graph fetch: 3.2s", "Traced 1 online account through the
  player's own tournaments."),
- an explicit "Resolving schoolmates… N of M resolved" readout during the school
  phase (which is long and quiet),
- and a progress bar driven mostly by elapsed time (eased, never jumping to 100%,
  because the traversal length is unbounded).

The user can open the **full search log** at any time.

**4. Results.** `IdentityResults` shows one or more identity cards, ranked by
confidence:
- a headline ("We found your opponent" / "We found N possible matches"),
- each card's name, title/federation/state/rating, a **confidence pill**, a
  plain‑English reasoning sentence, identifier chips (USCF/FIDE IDs), an
  evidence chip cloud (each clue as +/−), and the **discovered accounts** as
  selectable cards (with a green shield for tournament‑confirmed accounts, an
  "unconfirmed" caveat for namesake leads, and rating/games/last‑seen stats).
- The `partialOpponents` banner warns when only opponents (not the target) were
  confirmed.

**5. Confirming & generating.** The user ticks the account(s) they want (defaults are
pre‑selected at ≥45% confidence), clicks **Generate Scout Report**, and is handed off
to the scout pipeline, which auto‑runs.

**6. Failure states.** `EmptyState` ("No confident match for '…'") suggests adding
detail (rating, state, federation, tournament name, username hint) and offers "Refine
search" or **"Enter a username manually"** (→ `/scout`).

### 12.3 Generating a scout report

`/scout` (reached via handoff or directly): the user confirms username/platform,
their own color, optional advanced filters (time controls, variant, rated/casual,
date range, opponent rating range, opponent name), and optionally a **second account
on the other platform**. Games stream in with a live opening‑tree preview and a game
counter; the user can **Stop** at any time (a partial report is still produced).
Anonymous users get **1 free scout** (browser‑fingerprint‑tracked) before an
auth wall; signed‑in users are unlimited. "View Full Report" navigates to
`/report/:username`.

The report opens on the **Opening Tree** tab; **Advanced** kicks off the fast
client‑side profile/structure/endgame pass then the Stockfish weakness pass (with a
big progress ring, then a slim live banner — browsing other tabs won't cancel it);
**Deep Analysis** offers single‑game engine review. Signed‑in users can **Save
scout** or **Download JSON**.

### 12.4 Training & saved scouts

Training (`/training`, sign‑in gated) is the SM‑2 drill dashboard built from
mistakes. My Scouts (`/scouts`) lists saved report summaries. Settings/Onboarding
manage the profile (linked usernames, rating, goals).

### 12.5 When something goes wrong

- **Edge function down / no AI key** → Find Player degrades to direct
  Lichess/Chess.com discovery; a console warning explains why USCF/FIDE/AI are off.
- **Platform outage** → the circuit breaker fast‑fails instead of hanging.
- **Rate limits** → polite backoff + the conductor's governor; the user sees
  continued progress, not a freeze.
- **Report too large for sessionStorage** → the game list is progressively trimmed
  (with a toast) so the report still loads.
- **Analysis stopped mid‑fetch** → whatever was collected is finalized into a partial
  report.
- **Engine won't load** → the weakness tab explains it and the rest of the report
  stands.

---

## 13. Friction points

An honest accounting of where the current UX creates drag. (Several of these are
*perception* problems the engine has already partly solved under the hood.)

### 13.1 Leaving the app / opaque required knowledge

- **The USCF‑ID friction is smaller than it looks — but the UI doesn't say so.** The
  form has an optional "Do you know their USCF ID?" field (shown only when federation
  = USCF). A user who *doesn't* know it may assume they need to go look it up on
  `ratings.uschess.org`. In reality the edge function already does a **name + state
  MUIR search server‑side**, so the ID is rarely necessary. The friction is that the
  UI never reassures the user of this, so some will still leave the app to hunt for an
  ID they don't need. **FIDE ID** is genuinely un‑searched (there's no name→FIDE‑ID
  lookup), so that field is a real "go look it up elsewhere" ask.
- **No inline confirmation of *who* MUIR matched.** Because the member lookup happens
  invisibly inside the anchor phase, the user can't see or correct the USCF record the
  engine locked onto before the (multi‑minute) traversal runs on it.

### 13.2 Opacity during long waits

- **The traversal is unbounded and can run for minutes.** The `SearchExperience`
  does a lot to fight the "is it frozen?" feeling (ambient lines, eased progress,
  live feed, conductor heartbeat, schoolmate counter) — but the **progress bar is
  time‑based, not work‑based**, so it can't tell the user "3 of 5 events left." There
  is no ETA and no way to know how much longer a search might take.
- **No incremental results.** Anchor identities (the USCF member, ratings, state) are
  known within the first few seconds, but the user sees *nothing* until the entire
  pipeline finishes — including a potentially long, ultimately empty traversal.
- **The school phase is the longest and quietest.** Even with the "N of M
  schoolmates" readout, resolving a whole roster (each via a full tournament trace)
  can take a very long time with no cancel‑and‑keep‑partial option beyond aborting the
  whole search.

### 13.3 Confusion / interpretation

- **What does "72% · Possible match" mean?** The confidence pill is honest but
  abstract. The evidence chips explain the *inputs*, but a user can't easily tell
  whether 72% means "almost certainly them" or "a coin‑flip better than a namesake."
  The three‑band colour coding helps, but the number invites false precision.
- **Shield vs. "unconfirmed" is subtle.** The distinction between a
  tournament‑confirmed account (green shield) and a same‑name lead ("unconfirmed"
  caveat) is meaningful and correct — but it's a small visual cue that's easy to miss,
  and the `partialOpponents` warning, while prominent, is wordy.
- **Evidence weights aren't shown.** Chips show direction (+/−) but not magnitude, so
  a user can't see that "FIDE ID matches exactly" (weight 4.0) vastly outweighs "State
  matches" (weight 1.0).

### 13.4 Dead ends

- **No‑match offers a refinement, but no guided next step.** `EmptyState` suggests
  categories of detail to add, but doesn't tell the user *which* additional clue would
  most help *this* query, nor does it show what it already tried and ruled out.
- **`/scout` has a hard CORS caveat** ("Chess.com (may hit CORS)") that a user can't
  act on other than switching platforms.
- **The one‑free‑scout wall** interrupts anonymous users mid‑flow (after they've
  entered everything), which is a classic conversion‑vs‑friction tension.

### 13.5 Cross‑cutting

- **sessionStorage handoff is fragile by design.** Opening the report in a new tab,
  or waiting > 10 min, loses the handoff/analysis. Reports aren't persisted (only
  *summaries* are saveable), so a generated report can't be re‑opened later by URL.
- **`console.log` timing instrumentation** is left in `Scout.tsx` (dev noise).

---

## 14. Proposed improvements

Scoped to the current architecture — each is achievable without a rewrite.

### 14.1 Make the "you don't need the USCF ID" reality visible

The engine *already* resolves by name + state via MUIR. Surface that:

- Replace the passive "Do you know their USCF ID?" with an active **"Search US Chess
  by name"** affordance that, on name + (optional) state, does an **instant anchor
  preview** (the anchor phase already returns members in seconds) and shows the
  matched member(s) *before* committing to the full traversal — "Is this the Jane
  Smith you mean? WA, ~1587 USCF, has online history." This removes the temptation to
  leave the app, and lets the user correct a wrong homonym up front.
- For FIDE, add a name→FIDE‑ID lookup (or reuse the AI pass) so that field stops being
  a "go look it up elsewhere" ask.

### 14.2 Progressive disclosure of results (biggest UX win)

The engine is already phased and emits `phaseTimings` + per‑phase events. Render
results **incrementally**:

1. Show the **anchor identity** (member, ratings, state, IDs) as soon as the anchor
   phase completes — a card that says "Found the person; now hunting their online
   accounts…"
2. Stream discovered accounts into that card as the traversal confirms them.
3. Let the user **accept an anchor‑only identity and jump to `/scout` to type the
   handle manually** without waiting for a traversal that may come up empty.

This directly attacks the "long opaque wait with nothing to show" friction, and
"suggest likely candidates before running the full engine."

### 14.3 Work‑based progress + ETA

The traversal knows how many events/seeds/frontier items remain and tracks an EMA of
trace durations (in the conductor). Expose a coarse **"event 2 of 5" / "roster: 14 of
40 schoolmates"** progress and a rough ETA from the EMA, replacing (or augmenting) the
purely time‑based bar. The conductor's heartbeat already computes most of this.

### 14.4 Explain the confidence number in plain language

- Add a one‑line interpretation next to the pill ("Very likely this person" /
  "Plausible, but could be a namesake — verify the account").
- Show evidence **magnitude** (bar length or a small weight badge), so the decisive
  clues visually dominate.
- Add a short "How we're sure" tooltip explaining tournament‑confirmed (shield) vs.
  name‑lead (unconfirmed).

### 14.5 Turn dead ends into guided next steps

- On no‑match, show **what was tried and ruled out** (providerStatus already carries
  this) and recommend the *single most valuable* missing clue for this query (e.g.
  "Adding a state would let us search US Chess directly").
- Offer a "search a nearby tournament" path when a tournament name was given but not
  matched.

### 14.6 Directly integrate `ratings.uschess.org` more deeply

Today the edge function hits the MUIR *API* (`ratings-api.uschess.org`) — the modern
JSON backend of the ratings site — for member search and crosstables. Opportunities:

- **A dedicated "USCF member picker"** in the form: type a name, get live MUIR
  matches (id, state, rating, online‑history flag) to pick from — anchoring the whole
  search to the *right* person deterministically and eliminating homonym risk.
- **Show the member's event history** (already fetched to build the graph) as a
  browsable list, so the user can point the engine at the specific event they care
  about.
- **Cache MUIR member/crosstable data** in Postgres (crosstables of old events never
  change) to cut repeat‑search latency dramatically.

### 14.7 Make the report more interactive/visual & persist it

- Persist full reports (not just summaries) so `/report/:id` is shareable/re‑openable
  instead of dying with `sessionStorage`.
- Add board‑overlay heatmaps for pawn structures/weaknesses, and clickable evidence
  chips that jump to the game that produced them.

### 14.8 Smooth the conversion wall & clean up

- Move the free‑scout check *before* the user fills the whole form (or allow the first
  scout to complete, then prompt to save it), reducing mid‑flow interruption.
- Remove the `console.log` timing instrumentation from `Scout.tsx`.

---

## 15. Trade‑offs & limitations

- **Accuracy over speed, deliberately.** The traversal has no time budget and can run
  minutes. This is a conscious choice (*"finding the username matters more than
  wall‑clock"*) that trades latency for correctness — and it's the root of the biggest
  UX friction. The conductor and progressive‑disclosure ideas mitigate the *perception*
  without compromising the *result*.
- **Client‑heavy compute.** Opening‑tree building, Stockfish, and the entire identity
  traversal run in the browser. This keeps server costs near zero and sidesteps CORS,
  but ties heavy work to the user's device and tab staying open.
- **sessionStorage as the inter‑page bus.** Simple and quota‑guarded, but fragile
  (new tab / 10‑min expiry / 5MB cap) and un‑shareable.
- **Free‑tier AI + Google quotas.** The whole AI/discovery layer is built around
  *"quota exhausted ≠ no result"* semantics and graceful degradation, because it runs
  on pooled free tiers. Under load, discovery quietly falls back to weaker signals.
- **US‑centric.** The strongest discovery paths (MUIR tournament graphs, NWSRS school
  rosters, state matching) are US Chess–specific. A non‑US player with no online USCF
  history and no indexed handle degrades straight to name search.
- **The friends signal depends on a fragile cookie.** Chess.com's Turnstile‑protected
  login means the authenticated friends list rides on a manually‑seeded, cron‑extended
  session cookie; when it lapses, the school crawl silently loses its strongest signal
  (falling back to public game overlap + clubs).
- **Untraceable platforms are genuine dead ends.** ICC/ChessKid publish no public
  game/tournament API, so a player whose entire footprint is there can't be traced —
  correctly surfaced as a `partialOpponents` warning rather than a false match.
- **No test/observability layer in‑app.** Verification relies on the `scripts/` CLI
  harnesses (trace‑username, test‑conductor, trace‑school, …); there's no in‑product
  telemetry on resolution success rates.

---

## 16. Appendix: file index

**Identity engine (`src/lib/identity/`):** `resolver.ts` (phase orchestrator),
`conductor.ts` (autopilot), `uscfGraphEngine.ts` (traversal, ~3.7k lines),
`schoolResolver.ts` (social‑graph fallback), `confidence.ts` (log‑odds + similarity),
`net.ts` (gates/pacers/breaker), `verify.ts` (live profile verify), `handoff.ts`,
`cache.ts`, `types.ts`, `graphTypes.ts`, `schoolTypes.ts`, `index.ts` (public barrel).
Providers: `providers/{uscf,fide,chesscom,lichess,google,chessresults,uscfGraph,
edgeClient,schoolResolver,index}.ts`.

**Scout pipeline (`src/lib/`):** `chessApi.ts` (fetch + budget), `chessAnalysis.ts`
(tree types), `analysis/{treePool,treeWorker,treeCore}.ts`, `advancedAnalysis.ts`,
`engineAnalysis.ts` (Stockfish), `opponentProfiling.ts`, `structureStats.ts`,
`endgameStats.ts`, `weaknessDetection.ts`, `gamePlan.ts`, `trainingGeneration.ts`,
`savedScouts.ts`, `fingerprint.ts`.

**Pages (`src/pages/`):** `Landing, FindPlayer, Scout, Report, OpeningTree, Training,
MyScouts, Auth, AuthCallback, Onboarding, Settings, NotFound`.

**Find Player UI (`src/components/findplayer/`):** `PlayerSearchForm,
SearchExperience, IdentityResults, ConfidenceBadge, SearchLogDialog`.

**Edge functions (`supabase/functions/`):** `resolve-identity/{index,uscf,
googleSearch,school,schoolAdapters}.ts`, `explain-move/index.ts`,
`training-hint/index.ts`, `_shared/{ai,chessCookie}.ts`.

**Infra:** `supabase/migrations/*.sql`, `supabase/config.toml`, `vercel.json`,
`api/refresh-chess-cookie.js` (cron), `scripts/*` (CLI harnesses).

---

*Generated from a full read of the ScoutTree codebase. Where a threshold or guard is
quoted, it reflects the code as read; treat any specific number as a pointer to verify
against the source, since these are tuned frequently.*

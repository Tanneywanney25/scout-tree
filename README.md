# ScoutTree

AI-powered chess opponent scouting. Enter a Lichess or Chess.com username and get
an opening tree, opponent profile, weakness/structure/endgame analysis, a tailored
game plan, and spaced-repetition training drills.

## Tech stack

- Vite + React + TypeScript
- Tailwind CSS + shadcn/ui
- Supabase (auth + Postgres)
- Stockfish (bundled in `public/stockfish.js`, runs in a Web Worker)
- Lichess & Chess.com public APIs (no key required)

## Local development

```sh
npm install
npm run dev
```

### Environment variables

Create a `.env` (see `.env.example`). These are frontend, publishable values
(safe to expose):

| Variable | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | `https://xqyszdjczchlgyisvtvo.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_BH3AoBttItAuh4mpSvgFTw_oKmPpKBU` |
| `VITE_SUPABASE_PROJECT_ID` | `xqyszdjczchlgyisvtvo` |

When deploying (e.g. Vercel), set the same variables in the host's environment.
The Supabase client also has these as built-in fallbacks, so the app works even
if the env vars aren't set.

## Database

The full schema lives in `supabase/migrations/` as a single initial migration.
Apply it to your Supabase project either by connecting the repo to Supabase
(GitHub integration auto-applies migrations) or manually:

```sh
supabase link --project-ref xqyszdjczchlgyisvtvo
supabase db push
```

Or paste `supabase/migrations/20260628000000_init_schema.sql` into the Supabase
SQL editor. It creates `profiles`, `scout_usage`, `anonymous_scout_usage`,
`training_positions`, and `saved_scouts`, with row-level security so each user
can only access their own rows, plus a trigger that creates a profile row on
signup.

## Optional: AI explanations

The `explain-move` and `training-hint` edge functions add natural-language move
explanations and training hints. They are optional — the app works without them.
To enable, deploy the functions and set an `ANTHROPIC_API_KEY` secret (optionally
`AI_MODEL`) in your Supabase project:

```sh
supabase functions deploy explain-move
supabase functions deploy training-hint
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

## Find Player — AI opponent discovery

`/find-player` lets you scout an opponent without knowing any username. You give
whatever you know (a name, plus optional rating, federation, state, tournament,
USCF/FIDE ID, a username hint, free-text details) and the **Identity Resolution
Engine** (`src/lib/identity/`) discovers the person and their online accounts,
scoring every clue as evidence toward a transparent confidence number.

Username discovery is **tournament-first** — searching a platform by name finds
the wrong homonym far too easily, so it is the extreme last resort, never the
method. The resolver works in strict phases:

1. **Anchors** — US Chess / FIDE / AI reasoning establish *who* the person is
   (IDs, state, ratings, online-rated history). A username the user explicitly
   supplied is verified here too.
2. **Tournament-graph traversal** (`src/lib/identity/uscfGraphEngine.ts`) — the
   primary discovery. Every online-rated USCF event the player appeared in is
   worked to exhaustion, in order: pin the host platform (event name, or a
   web/flyer search for the TLA/announcement via the edge function); pull the
   hosting Chess.com tournament / Lichess swiss or arena **participant roster**
   and match it to the crosstable (if every player but the target is claimed,
   the leftover handle *is* the target); resolve *any* section player as a seed
   (direct opponents first, then the whole roster); then run a **pairing-chain
   BFS** — a seed's games from the event's date window are aligned 1:1 against
   their crosstable rounds by result sequence, so each aligned game maps one
   more crosstable player to their handle (player 22 reveals player 10, who
   reveals player 16…) until a chain reaches the target. If all events fail, it
   recurses into direct opponents' own online histories to pin *their* handles
   first. A FIDE ID linked on a candidate profile is checked against the USCF
   record's — a match is near-decisive, a contradiction rejects.
3. **Name fallback (last resort)** — only when the traversal finds nothing do
   the Lichess/Chess.com name searches and AI username suggestions run, and
   their results are confidence-capped and explicitly flagged as possible
   namesakes.

Try the traversal from a terminal (no edge function needed — Node isn't
CORS-bound):

```sh
node scripts/trace-username.mjs --name "First Last" [--state XX] [--budget 150]
node scripts/trace-username.mjs --id 12345678 --list   # inspect the graph only
```

Each data source is a `Provider`:

- **Lichess** and **Chess.com** resolve directly in the browser against their
  public, key-less APIs (autocomplete + profile verification, real ratings and
  last-seen) — last-resort tier only.
- **US Chess**, **FIDE**, **web/AI reasoning** and **tournament/chess-results**
  run server-side in the optional `resolve-identity` edge function, which does a
  best-effort USCF lookup, builds the online tournament graph, answers
  `discoverEvent` flyer searches (AI with live web search), and runs an AI
  reasoning pass whose suggested handles are only verified in the fallback
  phase.

The engine **degrades gracefully**: with no edge function or AI key, Find Player
still works from the direct Lichess/Chess.com providers. Deploy the function and
set an AI key to unlock the AI detective. The shared AI helper supports **Google
Gemini** (preferred when `GEMINI_API_KEY` is set, default model
`gemini-2.5-flash`) or Anthropic (`ANTHROPIC_API_KEY`):

```sh
supabase functions deploy resolve-identity
# Gemini (recommended):
supabase secrets set GEMINI_API_KEY=...        # optional: GEMINI_MODEL=gemini-2.5-flash
# …or Anthropic instead:
# supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

`explain-move` and `training-hint` use the same helper, so the same key powers
every AI feature.

Confirming an identity hands off into the existing scout pipeline and generates a
report whose header shows the identity confidence, evidence sources and verified
accounts.

## Build

```sh
npm run build
```

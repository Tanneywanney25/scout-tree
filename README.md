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

Each data source is a `Provider`:

- **Lichess** and **Chess.com** resolve directly in the browser against their
  public, key-less APIs (autocomplete + profile verification, real ratings and
  last-seen).
- **US Chess**, **FIDE**, **web/AI reasoning** and **tournament/chess-results**
  run server-side in the optional `resolve-identity` edge function, which does a
  best-effort USCF lookup plus an AI reasoning pass that proposes the usernames
  most worth verifying. The browser then verifies those handles against the real
  Lichess/Chess.com APIs before trusting them.

The engine **degrades gracefully**: with no edge function or `ANTHROPIC_API_KEY`,
Find Player still works from the direct Lichess/Chess.com providers. Deploy the
function (same `ANTHROPIC_API_KEY` secret as above) to unlock the AI detective:

```sh
supabase functions deploy resolve-identity
```

Confirming an identity hands off into the existing scout pipeline and generates a
report whose header shows the identity confidence, evidence sources and verified
accounts.

## Build

```sh
npm run build
```

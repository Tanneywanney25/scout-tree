-- ============================================================================
-- Roster index: the complete rosters and result vectors of the online
-- tournaments that host USCF-rated sections, crawled from public platform
-- endpoints (docs/roster-index.md).
--
-- Why. A USCF section's crosstable and its hosting tournament are two copies of
-- one pairing graph. Measured 2026-10-03 (Phase 1): every Chess.com bracket and
-- every Lichess swiss export lists the full roster with per-round colour, result
-- and opponent, so a section can be matched against STORED vectors with no seed
-- handle and no guessed handle at all.
--
--   roster_tournament — one row per platform tournament of a target series.
--                       Pending until crawled; then the roster (handles[]) and
--                       each player's result vector (vectors). NO game records
--                       and NO PGN: one token per player per round.
--   crawl_source      — where tournaments are discovered: a Chess.com member's
--                       tournament list (one request returns their whole
--                       history) or a Lichess team's swiss list. Progress lives
--                       here and in roster_tournament.status, never on disk, so
--                       a crawler can die anywhere and resume.
--
-- Size (computed before any backfill; Phase 2.1 of the report): ~8,700
-- tournaments and ~210,000 player entries for the five target series, about
-- 70 bytes per entry with its GIN key and ~300 bytes per tournament row —
-- roughly 20 MB against the 500 MB free-tier cap (112 MB used on 2026-10-03).
--
-- SECURITY: RLS on, no policies — service role only, like every identity table.
-- Idempotent.
-- ============================================================================

create table if not exists public.roster_tournament (
  platform text not null check (platform in ('chesscom', 'lichess')),
  tid text not null,                      -- Chess.com slug / Lichess swiss id
  series text not null,                   -- crawl series: uschess, wnz, pca, grandprix, dmv, linked
  status text not null default 'pending'
    check (status in ('pending', 'done', 'failed', 'skipped')),
  priority smallint not null default 0,   -- higher first (validation targets)
  id_num bigint,                          -- recency order: Chess.com id suffix, Lichess start epoch
  name text,
  starts_at timestamptz,
  n_rounds smallint,
  n_players smallint,
  time_control text,
  -- Lowercased handles; a player's position is their index everywhere below.
  handles text[],
  -- One entry per player (space-separated, same order as handles), one token
  -- per round (comma-separated): <opponentIndex><w|b><w|l|d>, empty when the
  -- player had no game that round. Example: "3ww,7bl,,1bd".
  vectors text,
  requests smallint,
  attempts smallint not null default 0,
  last_error text,
  discovered_at timestamptz not null default now(),
  fetched_at timestamptz,
  primary key (platform, tid)
);
create index if not exists roster_tournament_queue_idx
  on public.roster_tournament (platform, priority desc, id_num desc) where status = 'pending';
create index if not exists roster_tournament_date_idx
  on public.roster_tournament (starts_at) where status = 'done';
create index if not exists roster_tournament_handles_idx
  on public.roster_tournament using gin (handles);
alter table public.roster_tournament enable row level security;

create table if not exists public.crawl_source (
  platform text not null check (platform in ('chesscom', 'lichess')),
  kind text not null check (kind in ('player', 'team')),
  key text not null,                      -- lowercased handle, or Lichess team id
  priority real not null default 0,       -- series tournaments this source sat in
  last_polled_at timestamptz,
  last_found integer,                     -- series tournaments its list held
  added_at timestamptz not null default now(),
  primary key (platform, kind, key)
);
create index if not exists crawl_source_next_idx
  on public.crawl_source (platform, last_polled_at nulls first, priority desc);
alter table public.crawl_source enable row level security;

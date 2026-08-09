-- ============================================================================
-- Cached Chess.com account "weight" estimate (pairing-symmetry routing).
--
-- Every crosstable round has two players, and either side's archive contains
-- the same game. When the engine has a CHOICE of which known handle's archive
-- to pull to resolve a round, it should pull the LIGHTER one: a smaller archive
-- is faster to download, and heavy accounts are the ones most likely to hit a
-- response-size failure. "Weight" is a cheap proxy for archive heaviness —
-- estimated from the length of the account's /games/archives list (months of
-- history) and/or total games from /stats — computed once per username and
-- cached here so it is not recomputed on every future search.
--
-- SECURITY / access: same posture as the other cache tables — service-role only,
-- RLS enabled with no policies. The estimate is derived from public data and is
-- non-authoritative (only reorders fetches), but it is written server-side to
-- keep the write path uniform and un-poisonable.
--
-- TTL: a member's weight drifts slowly as they play; 30 days is plenty and
-- lets a stale row age out. Reads filter on expires_at.
--
-- Idempotent: safe to run on an empty database and to re-run.
-- ============================================================================

create table if not exists public.chesscom_account_weight (
  username text primary key,
  -- Higher = heavier archive. Currently: number of months in the archives list
  -- (its length), optionally refined by /stats total games when available.
  weight integer not null,
  -- How the estimate was derived: 'archives_len' | 'stats_total'.
  source text not null default 'archives_len',
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);

create index if not exists chesscom_account_weight_expires_idx
  on public.chesscom_account_weight (expires_at);

alter table public.chesscom_account_weight enable row level security;
-- No policies on purpose: service-role only (see header).

-- ============================================================================
-- Persistent event → platform cache (traversal speed).
--
-- Pinning which platform hosted a USCF online event (chess.com / lichess /
-- chesskid / icc) costs a full grounded AI web-search — 2-4s per unknown event,
-- and discovery-grade money. The answer to "where was this 2020 tournament
-- hosted" is IMMUTABLE, and the same event is shared by everyone who played it,
-- so it is the ideal thing to cache once and reuse across every future search.
--
-- Keyed by the USCF event id (stable). Stores not just the platform string but
-- the whole discovery payload (`info`) — the exact Chess.com tournament slug /
-- Lichess swiss+arena ids whose public APIs hand the engine the full roster —
-- so a cache hit reproduces the roster shortcut, not merely the platform hint.
--
-- SECURITY / access: same posture as muir_cache — written ONLY by the
-- resolve-identity edge function with the service role (bypasses RLS). RLS is
-- enabled with no policies, so anon/authenticated keys can neither read nor
-- write; the browser sees this data only through discoverEvent responses.
--
-- TTL: one year (events are immutable, but a bounded expiry lets a rare bad
-- early answer age out and lets the store be pruned). Reads filter on
-- expires_at, so an expired row is a miss and the discovery re-runs.
--
-- Idempotent: safe to run on an empty database and to re-run.
-- ============================================================================

create table if not exists public.event_platform_cache (
  -- The USCF event id (MUIR), stable and unique per online section.
  event_id text primary key,
  -- Resolved host platform: 'chesscom' | 'lichess' | 'chesskid' | 'icc' | 'unknown'.
  platform text not null,
  -- Full DiscoveredEventInfo (platform + chesscomSlugs + lichessSwissIds +
  -- lichessArenaIds + confidence + note), so a hit reproduces the roster
  -- shortcut's golden handle sets, not just the platform label.
  info jsonb,
  -- Where the answer came from: 'web_search' (the AI/flyer discovery) | 'manual'.
  source text,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '1 year')
);

create index if not exists event_platform_cache_expires_idx on public.event_platform_cache (expires_at);

alter table public.event_platform_cache enable row level security;
-- No policies on purpose: service-role only (see header).

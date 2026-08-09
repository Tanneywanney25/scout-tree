-- ============================================================================
-- Persistent Chess.com archive + failure cache (traversal speed / politeness).
--
-- A closed month's game archive is IMMUTABLE (Chess.com refreshes these at most
-- once/24h, and a month that has ended never changes except for a username
-- change or a fair-play account closure). Re-fetching it on every search is the
-- dominant avoidable cost behind the multi-minute traversals. So cache it once,
-- keyed by (username, year, month, endpoint_variant), and serve repeats from
-- Postgres instead of re-hammering the pub API.
--
-- SECURITY / access: SAME posture as muir_cache / event_platform_cache — written
-- and read ONLY by the resolve-identity edge function with the service role
-- (bypasses RLS). RLS is enabled with NO policies, so the browser's anon key can
-- neither read nor write. This is deliberate: a browser-writable cache the
-- identity engine TRUSTS would be a data-poisoning vector (fake games -> wrong
-- person) and a DoS vector (fake failures -> skip real months). All Chess.com
-- fetches are therefore routed through the edge function (service role), never
-- cached directly from the browser.
--
-- TTL rules (enforced on READ via expires_at; a NULL expires_at never expires):
--   * Closed month (older than ~35 days): IMMUTABLE. expires_at = NULL. Never
--     expires — the single biggest speed win.
--   * Current month: 6h TTL, revalidated with If-None-Match / If-Modified-Since
--     (etag / last_modified). A 304 just extends the row's expiry.
--   * STRUCTURAL_FAIL (500 on a heavy account): 7 day TTL — it will not fix
--     itself, but a bounded expiry lets a genuinely-changed account recover.
--   * Transient failure (502/503/504/524): 15 minute TTL.
--   * 410 Gone: permanent, expires_at = NULL, never requested again.
-- (The differentiated failure TTLs live in chess_failure_cache; a successful
--  archive lives in chess_archive_cache.)
--
-- Idempotent: safe to run on an empty database and to re-run.
-- ============================================================================

create table if not exists public.chess_archive_cache (
  username text not null,
  year smallint not null,
  month smallint not null,
  -- Which serializer produced `payload`: 'json' (the monthly JSON archive) is
  -- the default; 'pgn' etc. reserved for the endpoint ladder.
  endpoint_variant text not null default 'json',
  -- The parsed/normalized archive payload (the games array or a compact form).
  payload jsonb not null,
  -- Revalidation handles for the current month (RFC 7232).
  etag text,
  last_modified text,
  byte_size integer,
  fetched_at timestamptz not null default now(),
  -- NULL = never expires (a closed, immutable month). A non-null value is the
  -- revalidation deadline for the current month; an expired row reads as a miss.
  expires_at timestamptz,
  primary key (username, year, month, endpoint_variant)
);

create index if not exists chess_archive_cache_expires_idx
  on public.chess_archive_cache (expires_at);

alter table public.chess_archive_cache enable row level security;
-- No policies on purpose: service-role only (see header).

create table if not exists public.chess_failure_cache (
  username text not null,
  year smallint not null,
  month smallint not null,
  endpoint_variant text not null default 'json',
  -- 'structural' (500) | 'transient' (502/503/504/524) | 'gone' (410).
  status_class text not null,
  failed_at timestamptz not null default now(),
  -- Structural: +7d. Transient: +15m. Gone: NULL (permanent). An expired
  -- failure row reads as a miss, so the month is re-attempted after the window.
  expires_at timestamptz,
  primary key (username, year, month, endpoint_variant)
);

create index if not exists chess_failure_cache_expires_idx
  on public.chess_failure_cache (expires_at);

alter table public.chess_failure_cache enable row level security;
-- No policies on purpose: service-role only (see header).

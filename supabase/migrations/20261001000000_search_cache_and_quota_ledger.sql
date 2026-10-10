-- ============================================================================
-- Free-search support tables: retrieval cache + model-quota ledger.
--
-- WHY: Gemini's Grounding-with-Google-Search quota is exhausted and this project
-- is on the free tier, where 3.x grounding is not offered at all. Discovery was
-- therefore failing outright. The fix splits the two jobs that grounding had
-- conflated: SearXNG (self-hosted, unmetered) does RETRIEVAL, and Gemini does
-- REASONING with no search tool attached, consuming only ordinary free-tier
-- request allowance. These two tables make that split safe to run repeatedly:
--
--   * search_cache  — never pay for the same retrieval twice.
--   * quota_ledger  — a hard, countable stop so the emergency grounding path
--                     can NEVER quietly drain the quota again.
--
-- SECURITY / access: SAME posture as muir_cache / chess_archive_cache — written
-- and read ONLY by the edge functions with the service role (bypasses RLS). RLS
-- is enabled with NO policies, so the browser's anon key can neither read nor
-- write. Deliberate: a browser-writable retrieval cache that the identity
-- engine TRUSTS would be a data-poisoning vector (fabricated search hits ->
-- wrong person), and a browser-writable ledger would let anyone either burn the
-- grounding budget or forge headroom to drain it.
--
-- TTL rules (enforced on READ via expires_at; NULL expires_at = never expires):
--   * kind='web'      — 30 day TTL. Ordinary open-web queries drift as pages
--                       are added and reindexed.
--   * kind='identity' — PERMANENT (expires_at = NULL). A resolved USCF-member ->
--                       platform-handle mapping does not change; re-deriving it
--                       is pure waste.
--
-- Idempotent: safe to run on an empty database and to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. search_cache — retrieval results keyed by the normalized query
-- ---------------------------------------------------------------------------
create table if not exists public.search_cache (
  -- sha256 of the normalized query (lowercased, collapsed whitespace), so the
  -- key is stable across callers that format the same intent differently.
  key        text primary key,
  -- The normalized query itself, kept for debugging and cache-audit queries.
  query      text not null,
  -- The merged, de-duplicated hit list: [{title, url, content, engine}, ...].
  hits       jsonb not null,
  -- 'web' (30d) or 'identity' (permanent). Drives expires_at on write.
  kind       text not null default 'web',
  -- NULL means never expires. Readers MUST filter on this, not on created_at.
  expires_at timestamptz,
  -- Lets us report a real cache hit rate instead of guessing at it.
  hit_count  integer not null default 0,
  created_at timestamptz not null default now(),
  constraint search_cache_kind_check check (kind in ('web', 'identity'))
);

create index if not exists search_cache_created_at_idx
  on public.search_cache (created_at desc);
-- Sweeping expired rows should not scan the permanent (identity) ones.
create index if not exists search_cache_expires_at_idx
  on public.search_cache (expires_at)
  where expires_at is not null;

alter table public.search_cache enable row level security;

-- ---------------------------------------------------------------------------
-- 2. quota_ledger — per-provider, per-day call counter
-- ---------------------------------------------------------------------------
create table if not exists public.quota_ledger (
  -- 'gemini_grounding' (the scarce one) or 'gemini_generate' (ordinary free
  -- tier). Free-form so a new backend can be metered without a migration.
  provider   text not null,
  -- UTC day. Google's free-tier counters reset daily, so the ledger does too.
  day        date not null,
  used       integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (provider, day)
);

alter table public.quota_ledger enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Atomic increment
--
-- The traversal fans out concurrently, so read-then-write from the function
-- would race and undercount — precisely the failure that lets a "capped"
-- budget overrun. One statement, and it RETURNS the post-increment total so the
-- caller can decide whether it has just crossed the cap.
-- ---------------------------------------------------------------------------
create or replace function public.increment_quota(
  p_provider text,
  p_amount   integer default 1,
  p_day      date default (now() at time zone 'utc')::date
) returns integer
language sql
security definer
set search_path = public
as $$
  insert into public.quota_ledger (provider, day, used, updated_at)
  values (p_provider, p_day, greatest(p_amount, 0), now())
  on conflict (provider, day) do update
    set used = public.quota_ledger.used + greatest(p_amount, 0),
        updated_at = now()
  returning used;
$$;

revoke all on function public.increment_quota(text, integer, date) from public;
revoke all on function public.increment_quota(text, integer, date) from anon;

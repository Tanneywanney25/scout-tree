-- ============================================================================
-- UX redesign (anchor → discovery split) — persistence layer.
--
-- Three tables from the redesign doc §6.4:
--
--   resolved_handles — "the moat": every confirmed USCF-member → online-handle
--     resolution the engine (or a user correction) produces. Serves instant
--     cache-first answers and compounds across searches.
--   muir_cache       — server-side cache of MUIR API payloads (member records,
--     events, crosstables). Old crosstables are immutable, so cached entries
--     serve repeat traffic instead of re-hitting an API US Chess has said is
--     unsupported and will be rate-limited. Latency + cost + diplomacy.
--   handle_optouts   — privacy: players (or their parents) can ask not to be
--     resolvable. Checked at anchor-preview time; an opted-out member's
--     discovery path is refused.
--
-- SECURITY: all three are written ONLY by the resolve-identity edge function
-- with the service role (which bypasses RLS). RLS is enabled with no policies,
-- same posture as chess_cookies: anon/authenticated keys can neither read nor
-- write. The browser sees this data only through edge-function responses.
--
-- Idempotent: safe to run on an empty database and to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- resolved_handles
-- ---------------------------------------------------------------------------
create table if not exists public.resolved_handles (
  id bigint generated always as identity primary key,
  uscf_id text not null,
  platform text not null,               -- 'lichess' | 'chesscom' | 'chesskid' | 'icc' | 'other'
  username text not null,
  confidence double precision not null default 0,
  -- The evidence array behind the resolution, verbatim (kind/weight/label/source).
  evidence jsonb,
  -- Where this row came from: 'engine' (a completed hunt), 'user-correction'
  -- ("wrong account? tell us"), 'claim' (the player claiming their own handle).
  source text not null default 'engine',
  verified_at timestamptz not null default now(),
  -- When a later, better resolution replaces this one, point at it instead of
  -- deleting — the history is part of the audit trail.
  superseded_by bigint references public.resolved_handles(id),
  unique (uscf_id, platform)
);

create index if not exists resolved_handles_uscf_idx on public.resolved_handles (uscf_id);

alter table public.resolved_handles enable row level security;
-- No policies on purpose: service-role only (see header).

-- ---------------------------------------------------------------------------
-- muir_cache
-- ---------------------------------------------------------------------------
create table if not exists public.muir_cache (
  -- What kind of MUIR payload this is: 'member' | 'member-search' | 'events' |
  -- 'event' | 'section' | 'crosstable'.
  kind text not null,
  -- Cache key within the kind (member id, normalised search query, event id…).
  key text not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (kind, key)
);

create index if not exists muir_cache_fetched_idx on public.muir_cache (fetched_at);

alter table public.muir_cache enable row level security;
-- No policies on purpose: service-role only.

-- ---------------------------------------------------------------------------
-- handle_optouts
-- ---------------------------------------------------------------------------
create table if not exists public.handle_optouts (
  id bigint generated always as identity primary key,
  -- At least one of uscf_id / (platform, username) identifies who opted out.
  uscf_id text,
  platform text,
  username text,
  -- Free-text contact/justification captured with the request (never shown).
  note text,
  requested_at timestamptz not null default now(),
  -- Set true once a human confirms the requester is (or represents) the player.
  verified boolean not null default false
);

create index if not exists handle_optouts_uscf_idx on public.handle_optouts (uscf_id);
create index if not exists handle_optouts_handle_idx on public.handle_optouts (platform, username);

alter table public.handle_optouts enable row level security;
-- No policies on purpose: writes arrive only via the edge function's optOut
-- mode (service role), reads only via memberPreview.

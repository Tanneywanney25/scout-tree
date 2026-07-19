-- ============================================================================
-- chess_cookies — server-side cache for the authenticated Chess.com session
-- cookie the identity resolver uses to fetch member-public friends lists.
--
-- A scheduled refresher (api/refresh-chess-cookie on Vercel) keeps a valid
-- session alive and writes the formatted Cookie string here; the resolve-identity
-- edge function reads it (school.ts) instead of a manually-set CHESSCOM_COOKIE
-- env var that expires and breaks.
--
-- SECURITY: the cookie is a live session secret. RLS is enabled with NO policies
-- so neither the anon nor the authenticated key can ever read or write it — only
-- the service role (which BYPASSES RLS) touches this table, and the service role
-- key never reaches the browser.
--
-- Idempotent: safe to run on an empty database and to re-run.
-- ============================================================================

create table if not exists public.chess_cookies (
  -- Which cached cookie this is. Single logical entry today ("chesscom"), but a
  -- key lets us hold more than one service account later without a schema change.
  key text primary key,
  -- The formatted Cookie header value, e.g. "PHPSESSID=...; __cf_bm=...; ...".
  cookie text not null,
  -- How the value was last obtained ("keepalive" | "login" | "seed"), for logs.
  source text,
  updated_at timestamptz not null default now()
);

alter table public.chess_cookies enable row level security;

-- Intentionally NO policies: RLS with an empty policy set denies anon and
-- authenticated entirely. The service role bypasses RLS, so the Vercel refresher
-- (writer) and the edge function (reader) still work with the service key.
-- Drop any legacy permissive policies if a prior run created them.
drop policy if exists "Anyone can view chess cookies" on public.chess_cookies;
drop policy if exists "Anyone can insert chess cookies" on public.chess_cookies;

drop trigger if exists update_chess_cookies_updated_at on public.chess_cookies;
create trigger update_chess_cookies_updated_at
  before update on public.chess_cookies
  for each row execute function public.update_updated_at_column();

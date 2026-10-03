-- ============================================================================
-- One crawler at a time (docs/roster-index.md, Phase 3/7.2).
--
-- The roster crawler can run on a laptop (scripts/roster-crawler.mjs) or as
-- Supabase Edge slices (supabase/functions/roster-crawl). Two at once would
-- double the request rate from shared addresses and fetch the same pending
-- tournaments twice, so both take this lease first: a slice takes it for its
-- wall clock, the laptop renews it every few minutes. An expired lease is free.
-- Service role only. Idempotent.
-- ============================================================================

create table if not exists public.crawl_lease (
  id text primary key,
  holder text,
  until timestamptz not null default 'epoch'
);
insert into public.crawl_lease (id) values ('roster') on conflict (id) do nothing;
alter table public.crawl_lease enable row level security;

create or replace function public.take_crawl_lease(p_holder text, p_ttl_seconds integer)
returns boolean
language sql
security definer
set search_path = public
as $$
  with t as (
    update public.crawl_lease
       set holder = p_holder, until = now() + make_interval(secs => p_ttl_seconds)
     where id = 'roster' and (until < now() or holder = p_holder)
    returning 1
  )
  select exists (select 1 from t);
$$;

create or replace function public.release_crawl_lease(p_holder text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.crawl_lease set until = now() where id = 'roster' and holder = p_holder;
$$;

revoke all on function public.take_crawl_lease(text, integer) from public, anon, authenticated;
revoke all on function public.release_crawl_lease(text) from public, anon, authenticated;

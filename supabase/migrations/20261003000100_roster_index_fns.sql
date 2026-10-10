-- ============================================================================
-- Roster index helpers (service role only).
--
-- refresh_crawl_source_priority(): a Chess.com member's tournament list is the
-- crawler's discovery channel (one request returns their whole history), so
-- the members who sat in the most crawled series tournaments are polled first.
-- Adds every crawled roster handle as a source and sets its priority to that
-- count. Cheap enough to run every few hundred tournaments.
-- ============================================================================

create or replace function public.refresh_crawl_source_priority(p_platform text default 'chesscom')
returns integer
language sql
security definer
set search_path = public
as $$
  with counts as (
    select h as key, count(*)::real as n
    from public.roster_tournament t, unnest(t.handles) as h
    where t.platform = p_platform and t.status = 'done'
    group by h
  ), up as (
    insert into public.crawl_source (platform, kind, key, priority)
    select p_platform, 'player', c.key, c.n from counts c
    on conflict (platform, kind, key) do update set priority = excluded.priority
    returning 1
  )
  select count(*)::integer from up;
$$;
revoke all on function public.refresh_crawl_source_priority(text) from public, anon, authenticated;

-- ============================================================================
-- muir_cache retention (docs/roster-index.md, "muir_cache retention").
--
-- Nothing deleted rows from muir_cache: 180 MB on 2026-10-04 against the 500 MB
-- free-tier cap, growing ~0.5 MB per search. Measured that day (muir_cache_stats):
--
--   games        71 MB  12,452 rows   member game-feed pages; readers ignore a
--                                     row older than 6 h (EVENTS_LIST_TTL_MS)
--   crosstable   66 MB   7,047 rows   immutable; readers ignore a row older
--                                     than 30 d (EVENT_CACHE_TTL_MS)
--   footprint     6 MB   6,618 rows   readers ignore after 3 d
--   section / event / events / member / member-search: 10 MB together
--
-- All of it is re-fetchable from the US Chess ratings API. The rule: a row is
-- deleted once it is older than the TTL its reader applies, so the sweeper never
-- removes anything a reader would have served. The short-lived feed kinds
-- (games, events; 6 h read TTL) are kept 24 h, which leaves a day of margin and
-- still removes 93% of their bytes; footprints 3 d; everything else 30 d.
--
-- Hourly through pg_cron when the extension is available; the function is also
-- callable by hand: select public.sweep_muir_cache();
-- Service role only. Idempotent.
-- ============================================================================

create or replace function public.sweep_muir_cache()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v jsonb;
begin
  with d as (
    delete from muir_cache c
    where c.fetched_at < now() - case
            when c.kind in ('games', 'events') then interval '24 hours'
            when c.kind = 'footprint' then interval '3 days'
            else interval '30 days'
          end
    returning c.kind
  )
  select coalesce(jsonb_object_agg(t.kind, t.n), '{}'::jsonb) into v
  from (select kind, count(*) as n from d group by kind) t;
  return v;
end;
$fn$;
revoke all on function public.sweep_muir_cache() from public, anon, authenticated;

do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('sweep-muir-cache', '23 * * * *', 'select public.sweep_muir_cache()');
exception when others then
  raise notice 'pg_cron not available, sweep_muir_cache() is not scheduled: %', sqlerrm;
end
$$;

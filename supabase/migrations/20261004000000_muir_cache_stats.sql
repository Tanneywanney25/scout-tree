-- ============================================================================
-- muir_cache_stats(): what the MUIR cache holds, by kind (docs/roster-index.md,
-- "muir_cache retention"). Read-only; service role only. Idempotent.
-- ============================================================================

create or replace function public.muir_cache_stats()
returns table (
  kind text,
  n bigint,
  bytes bigint,
  oldest timestamptz,
  newest timestamptz,
  older_6h bigint,
  older_3d bigint,
  older_7d bigint,
  older_30d bigint,
  bytes_older_6h bigint,
  bytes_older_3d bigint,
  bytes_older_7d bigint,
  bytes_older_30d bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select c.kind,
         count(*),
         coalesce(sum(pg_column_size(c.payload)), 0)::bigint,
         min(c.fetched_at),
         max(c.fetched_at),
         count(*) filter (where c.fetched_at < now() - interval '6 hours'),
         count(*) filter (where c.fetched_at < now() - interval '3 days'),
         count(*) filter (where c.fetched_at < now() - interval '7 days'),
         count(*) filter (where c.fetched_at < now() - interval '30 days'),
         coalesce(sum(pg_column_size(c.payload)) filter (where c.fetched_at < now() - interval '6 hours'), 0)::bigint,
         coalesce(sum(pg_column_size(c.payload)) filter (where c.fetched_at < now() - interval '3 days'), 0)::bigint,
         coalesce(sum(pg_column_size(c.payload)) filter (where c.fetched_at < now() - interval '7 days'), 0)::bigint,
         coalesce(sum(pg_column_size(c.payload)) filter (where c.fetched_at < now() - interval '30 days'), 0)::bigint
  from public.muir_cache c
  group by c.kind
  order by 3 desc;
$$;
revoke all on function public.muir_cache_stats() from public, anon, authenticated;

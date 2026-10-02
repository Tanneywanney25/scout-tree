-- ============================================================================
-- Identity graph: keep what every aligned section proves.
--
-- A whole-section alignment maps 10–35 crosstable players to their handles at
-- once (measured, docs/traversal-investigation.md §6.3). Until now only the
-- searched-for member was written (resolved_handles); everyone else was
-- thrown away. These tables keep all of it, with the evidence strength, and
-- record dead ends so they are not re-walked.
--
--   identity_edge    — every member → handle assignment an alignment proved,
--                      many-to-many (a member can have two real accounts), with
--                      its tier and the sections behind it. Written ONLY by the
--                      edge function after it re-runs the alignment itself; a
--                      browser never supplies a handle here.
--   section_link     — section ↔ hosting tournament verdicts, verified AND
--                      rejected (a rejected candidate never needs re-testing:
--                      the crosstable and a finished tournament are fixed).
--   section_negative — sections walked to exhaustion without a resolution,
--                      with their member list so a newly stored handle for any
--                      member clears the negative.
--   series_platform  — which platform an event SERIES runs on, learned from
--                      aligned sections. MUIR carries no platform field and
--                      46% of cached online sections name none in the title.
--
-- resolved_handles gains a status so stale or contradicted rows can be retired
-- (superseded_by was declared and never written). A retired row ALSO gets
-- superseded_by = its own id, so readers that only know the old contract
-- (`superseded_by is null`) hide it too.
--
-- SECURITY: RLS on, no policies — service role only, like every identity table.
-- Idempotent.
-- ============================================================================

create table if not exists public.identity_edge (
  id bigint generated always as identity primary key,
  uscf_id text not null,
  platform text not null,
  handle text not null,                         -- lowercased
  -- 'strong': >=3 verified rounds and >=2 corroborating opponents in a section
  -- that passed alignmentTrustworthy. 'weak': anything less. Measured
  -- cross-section disagreement: strong 0.99%, weak ~3.5%.
  tier text not null check (tier in ('strong', 'weak')),
  rounds_verified integer not null default 0,
  corroborating integer not null default 0,
  n_sections integer not null default 1,
  -- [{eventId, section, platform, tournament, tier, rounds, corroborating, at}]
  sections jsonb not null default '[]'::jsonb,
  status text not null default 'active'
    check (status in ('active', 'superseded', 'conflict', 'gone')),
  superseded_by bigint references public.identity_edge(id),
  status_reason text,
  source text not null default 'alignment',
  first_seen timestamptz not null default now(),
  last_verified timestamptz not null default now(),
  unique (uscf_id, platform, handle)
);
create index if not exists identity_edge_uscf_idx on public.identity_edge (uscf_id);
create index if not exists identity_edge_handle_idx on public.identity_edge (platform, handle);
alter table public.identity_edge enable row level security;

create table if not exists public.section_link (
  event_id text not null,
  section_no integer not null,
  platform text not null,
  tournament_id text not null,
  status text not null check (status in ('verified', 'rejected')),
  assigned integer,
  n_players integer,
  contradicted integer,
  inconsistent_edges integer,
  source text,
  checked_at timestamptz not null default now(),
  primary key (event_id, section_no, platform, tournament_id)
);
alter table public.section_link enable row level security;

create table if not exists public.section_negative (
  event_id text not null,
  section_no integer not null,
  members text[] not null default '{}',
  reason text,
  requests integer,
  walked_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (event_id, section_no)
);
create index if not exists section_negative_members_gin on public.section_negative using gin (members);
alter table public.section_negative enable row level security;

create table if not exists public.series_platform (
  series_key text primary key,
  platform text not null,
  n_events integer not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.series_platform enable row level security;

alter table public.resolved_handles add column if not exists status text not null default 'active';
alter table public.resolved_handles add column if not exists status_reason text;
alter table public.resolved_handles add column if not exists revalidated_at timestamptz;
alter table public.resolved_handles add column if not exists tier text;
do $$ begin
  alter table public.resolved_handles
    add constraint resolved_handles_status_check check (status in ('active', 'superseded', 'conflict', 'gone'));
exception when duplicate_object then null; end $$;

-- Clear every negative that lists a member, in one statement (called when a
-- handle for that member is stored, so a dead end that member could now open
-- is walked again).
create or replace function public.clear_section_negatives(p_members text[])
returns integer
language sql
security definer
set search_path = public
as $$
  with d as (delete from public.section_negative where members && p_members returning 1)
  select count(*)::integer from d;
$$;
revoke all on function public.clear_section_negatives(text[]) from public;
revoke all on function public.clear_section_negatives(text[]) from anon;
revoke all on function public.clear_section_negatives(text[]) from authenticated;

-- search_cache sweeper. kind='identity' rows were written with expires_at NULL
-- and nothing removed them; that branch's identity rows are a copy of what
-- resolved_handles / identity_edge already keep with real provenance.
-- Deletes expired web rows and identity rows older than p_identity_days.
create or replace function public.sweep_search_cache(p_identity_days integer default 90)
returns integer
language sql
security definer
set search_path = public
as $$
  with d as (
    delete from public.search_cache
    where (expires_at is not null and expires_at < now())
       or (kind = 'identity' and created_at < now() - make_interval(days => p_identity_days))
    returning 1
  )
  select count(*)::integer from d;
$$;
revoke all on function public.sweep_search_cache(integer) from public;
revoke all on function public.sweep_search_cache(integer) from anon;
revoke all on function public.sweep_search_cache(integer) from authenticated;

-- ---------------------------------------------------------------------------
-- record_identity_edges: merge one aligned section's assignments into the
-- graph, apply the conflict rules, mirror verdicts into resolved_handles, and
-- clear negatives the new identities could open. One transaction, so two
-- concurrent harvests of overlapping sections cannot interleave half-writes.
--
-- p_rows: [{uscf_id, platform, handle, tier, rounds, corroborating,
--           section: {eventId, section, platform, tournament, tier, rounds, corroborating, at}}]
--
-- Conflict rules (measured basis: strong-strong cross-section disagreement
-- 0.99%; five of eleven conflicting members were genuine second accounts, all
-- strong-strong; the other six were weak mis-assignments):
--   same handle, different member:  strong beats weak (weak superseded);
--                                   equal strength -> both 'conflict' (withheld)
--   same member, different handle:  strong vs strong -> both kept (second account);
--                                   strong beats weak (weak superseded);
--                                   weak vs weak -> both kept as leads
-- Opted-out members (by id or by handle) are never written.
-- ---------------------------------------------------------------------------
create or replace function public.record_identity_edges(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r jsonb;
  v_id bigint;
  v_tier text;
  v_written integer := 0;
  v_skipped_optout integer := 0;
  v_superseded integer := 0;
  v_conflicts integer := 0;
  v_mirrored integer := 0;
  v_members text[] := '{}';
  v_touched text[] := '{}';
  o record;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    if exists (
      select 1 from handle_optouts h
      where h.uscf_id = r->>'uscf_id'
         or (h.platform = r->>'platform' and lower(h.username) = lower(r->>'handle'))
    ) then
      v_skipped_optout := v_skipped_optout + 1;
      continue;
    end if;

    insert into identity_edge as e (uscf_id, platform, handle, tier, rounds_verified, corroborating, n_sections, sections, source)
    values (r->>'uscf_id', r->>'platform', lower(r->>'handle'), r->>'tier',
            coalesce((r->>'rounds')::int, 0), coalesce((r->>'corroborating')::int, 0), 1,
            jsonb_build_array(r->'section'), 'alignment')
    on conflict (uscf_id, platform, handle) do update set
      tier = case when e.tier = 'strong' or excluded.tier = 'strong' then 'strong' else 'weak' end,
      rounds_verified = greatest(e.rounds_verified, excluded.rounds_verified),
      corroborating = greatest(e.corroborating, excluded.corroborating),
      n_sections = e.n_sections + case when exists (
          select 1 from jsonb_array_elements(e.sections) s
          where s->>'eventId' = r->'section'->>'eventId' and s->>'section' = r->'section'->>'section'
        ) then 0 else 1 end,
      sections = case when exists (
          select 1 from jsonb_array_elements(e.sections) s
          where s->>'eventId' = r->'section'->>'eventId' and s->>'section' = r->'section'->>'section'
        ) then e.sections else e.sections || jsonb_build_array(r->'section') end,
      last_verified = now()
    returning id, tier into v_id, v_tier;
    v_written := v_written + 1;
    v_members := array_append(v_members, r->>'uscf_id');
    v_touched := array_append(v_touched, r->>'uscf_id');

    -- Same handle claimed for a different member.
    for o in
      select id, tier, uscf_id from identity_edge
      where platform = r->>'platform' and handle = lower(r->>'handle')
        and uscf_id <> r->>'uscf_id' and status = 'active'
    loop
      v_touched := array_append(v_touched, o.uscf_id);
      if v_tier = 'strong' and o.tier = 'weak' then
        update identity_edge set status = 'superseded', superseded_by = v_id,
          status_reason = 'handle proven strong for another member' where id = o.id;
        v_superseded := v_superseded + 1;
      elsif v_tier = 'weak' and o.tier = 'strong' then
        update identity_edge set status = 'superseded', superseded_by = o.id,
          status_reason = 'handle proven strong for another member' where id = v_id;
        v_superseded := v_superseded + 1;
      else
        update identity_edge set status = 'conflict',
          status_reason = 'same handle assigned to two members at equal strength'
          where id in (o.id, v_id);
        v_conflicts := v_conflicts + 1;
      end if;
    end loop;

    -- Same member, a different handle on the same platform.
    for o in
      select id, tier from identity_edge
      where uscf_id = r->>'uscf_id' and platform = r->>'platform'
        and handle <> lower(r->>'handle') and status = 'active'
    loop
      if v_tier = 'strong' and o.tier = 'weak' then
        update identity_edge set status = 'superseded', superseded_by = v_id,
          status_reason = 'member proven strong on another handle' where id = o.id;
        v_superseded := v_superseded + 1;
      elsif v_tier = 'weak' and o.tier = 'strong' then
        update identity_edge set status = 'superseded', superseded_by = o.id,
          status_reason = 'member proven strong on another handle' where id = v_id;
        v_superseded := v_superseded + 1;
      end if;
      -- strong+strong: a genuine second account, both stay. weak+weak: both leads.
    end loop;
  end loop;

  -- Retire alignment verdicts whose edge stopped being active in this call
  -- (superseded_by = own id keeps old-contract readers from showing them).
  update resolved_handles h
     set status = e.status, status_reason = e.status_reason, superseded_by = h.id
    from identity_edge e
   where h.uscf_id = any(v_touched) and h.source = 'alignment' and h.status = 'active'
     and e.uscf_id = h.uscf_id and e.platform = h.platform and e.handle = lower(h.username)
     and e.status <> 'active';

  -- Mirror verdicts into resolved_handles: a strong active edge, or a weak one
  -- that two independent sections agree on. One verdict row per (member,
  -- platform); a user correction or claim is never overwritten.
  for o in
    select distinct on (e.uscf_id, e.platform)
      e.uscf_id, e.platform, e.handle, e.tier, e.n_sections, e.rounds_verified, e.corroborating
    from identity_edge e
    where e.uscf_id = any(v_touched) and e.status = 'active'
      and (e.tier = 'strong' or e.n_sections >= 2)
    order by e.uscf_id, e.platform, (e.tier = 'strong') desc, e.n_sections desc, e.last_verified desc
  loop
    insert into resolved_handles as h (uscf_id, platform, username, confidence, evidence, source, verified_at, status, tier, revalidated_at)
    values (o.uscf_id, o.platform, o.handle,
            case when o.tier = 'strong' then 0.99 else 0.97 end,
            jsonb_build_array(jsonb_build_object(
              'kind', 'section-alignment',
              'weight', 4.0,
              'label', format('Whole-section alignment: %s verified round(s), %s corroborating opponent(s), %s section(s)',
                              o.rounds_verified, o.corroborating, o.n_sections),
              'source', 'alignment')),
            'alignment', now(), 'active', o.tier, now())
    on conflict (uscf_id, platform) do update set
      username = excluded.username,
      confidence = excluded.confidence,
      evidence = excluded.evidence,
      source = excluded.source,
      verified_at = now(),
      status = 'active',
      status_reason = case when h.username <> excluded.username
                           then format('replaced %s (source %s) with an alignment verdict', h.username, h.source)
                           else null end,
      superseded_by = null,
      tier = excluded.tier,
      revalidated_at = now()
    where h.source not in ('user-correction', 'claim');
    v_mirrored := v_mirrored + 1;
  end loop;

  if array_length(v_members, 1) > 0 then
    perform clear_section_negatives(v_members);
  end if;

  return jsonb_build_object(
    'written', v_written, 'skippedOptOut', v_skipped_optout,
    'superseded', v_superseded, 'conflicts', v_conflicts, 'verdictsMirrored', v_mirrored);
end;
$fn$;
revoke all on function public.record_identity_edges(jsonb) from public;
revoke all on function public.record_identity_edges(jsonb) from anon;
revoke all on function public.record_identity_edges(jsonb) from authenticated;

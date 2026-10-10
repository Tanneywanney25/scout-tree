-- ============================================================================
-- Pre-resolution progress (docs/roster-index.md, "Mass pre-resolution").
--
-- scripts/pre-resolve.mjs joins USCF online sections against the roster index
-- in bulk, ahead of any search. One row per section it has looked at, so a
-- later run continues instead of restarting:
--
--   resolved      — written (section_link source 'index' + identity_edge);
--                   never processed again.
--   queued        — a candidate nobody has tried yet (enumerators insert these
--                   with ignore-duplicates, so they never overwrite a verdict).
--   no-candidate / none / below-floor / ambiguous
--                 — tried and not resolved. Retried only when a roster inside
--                   [win_from, win_to] was crawled after checked_at.
--   untraceable / no-crosstable — not retried.
--
-- SECURITY: RLS on, no policies — service role only. Idempotent.
-- ============================================================================

create table if not exists public.preresolve_section (
  event_id text not null,
  section_no integer not null,
  verdict text not null default 'queued',
  platform text,
  tournament_id text,
  played integer,
  assigned integer,
  candidates integer,
  written integer,
  conflicts integer,
  win_from timestamptz,
  win_to timestamptz,
  source text,
  checked_at timestamptz not null default now(),
  primary key (event_id, section_no)
);
create index if not exists preresolve_section_verdict_idx on public.preresolve_section (verdict);
alter table public.preresolve_section enable row level security;

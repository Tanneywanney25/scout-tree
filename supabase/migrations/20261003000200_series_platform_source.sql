-- ============================================================================
-- Platform inference for sections whose title names no platform
-- (docs/roster-index.md, Phase 5).
--
-- series_platform gains a source, so readers can rank the evidence:
--   alignment — a section of this series aligned (existing rows)
--   index     — a crawled tournament of this name sits in the roster index
--   listing   — a tournament of this name appears in a Chess.com member's
--               public tournament list (no roster crawled)
--   prefix    — an organizer prefix ("prefix:dmvchess.com") learned from
--               series whose platform is known
-- Footprints trust alignment/index rows ahead of the title, and listing/prefix
-- rows only after it (a titled "ON ICC" event must never be re-labelled by a
-- look-alike Chess.com name).
-- Idempotent.
-- ============================================================================

alter table public.series_platform add column if not exists source text not null default 'alignment';

-- ============================================================================
-- STAGED, NOT APPLIED. Turns on the roster crawler in production as Edge
-- slices: one invocation of `roster-crawl` every 2 minutes (each runs ~110 s
-- and holds the crawl lease, so slices never overlap and a laptop crawler
-- yields). Docs: docs/roster-index.md, Phase 7.2 / Phase 8.
--
-- Run it in the SQL editor (or `supabase db query --linked -f ...`) after
-- replacing <SERVICE_ROLE_KEY>. Undo: select cron.unschedule('roster-crawl');
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://xqyszdjczchlgyisvtvo.supabase.co', 'roster_crawl_url');
select vault.create_secret('<SERVICE_ROLE_KEY>', 'roster_crawl_key');

select cron.schedule(
  'roster-crawl',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'roster_crawl_url') || '/functions/v1/roster-crawl',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'roster_crawl_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

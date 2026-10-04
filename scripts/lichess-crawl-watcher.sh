#!/usr/bin/env bash
# Start the roster crawler's Lichess lane as soon as the crawl lease is free
# (docs/roster-index.md). One crawler at a time is the rule, so this never takes
# the lease from a running crawler: it polls crawl_lease every two minutes and
# only launches once the holder has released it or let it expire. The crawler
# itself takes the lease atomically; if it loses a race it exits and the watcher
# keeps polling. The service key is fetched from the Supabase CLI at start and
# lives only in this process's environment.
#
#   bash scripts/lichess-crawl-watcher.sh [give-up-after-hours=30] [crawl-hours=8]
cd "$(dirname "$0")/.." || exit 1
GIVE_UP="${1:-30}"
CRAWL_HOURS="${2:-8}"
REF=$(cat supabase/.temp/project-ref)
KEY=$(supabase projects api-keys --project-ref "$REF" -o json 2>/dev/null | jq -r '.[]|select(.name=="service_role").api_key')
[ -n "$KEY" ] || { echo "no service key (supabase CLI not logged in?)" >&2; exit 2; }
export SUPABASE_URL="https://$REF.supabase.co" SUPABASE_SERVICE_ROLE_KEY="$KEY"
# The User-Agent names the repository's issue tracker, never a personal address.
export CRAWLER_CONTACT="https://github.com/Tanneywanney25/scout-tree/issues"
mkdir -p logs
LOG=logs/lichess-crawl.log
log() { echo "$(date -u +%FT%TZ) [watcher] $*" >> "$LOG"; }
get() { curl -s -m 30 -H "apikey: $KEY" -H "Authorization: Bearer $KEY" "$SUPABASE_URL/rest/v1/$1"; }
pending() { get "roster_tournament?platform=eq.lichess&status=eq.pending&select=tid&limit=1" | jq 'length' 2>/dev/null; }

log "start; waiting for the crawl lease"
END=$(( $(date +%s) + GIVE_UP * 3600 ))
while [ "$(date +%s)" -lt "$END" ]; do
  FREE=$(get "crawl_lease?id=eq.roster&until=lt.$(date -u +%FT%TZ)&select=id" | jq 'length' 2>/dev/null)
  if [ "$FREE" = "1" ]; then
    log "lease free; starting the Lichess lane"
    T0=$(date +%s)
    node scripts/roster-crawler.mjs --platform lichess --hours "$CRAWL_HOURS" >> "$LOG" 2>&1
    log "crawler exited after $(( $(date +%s) - T0 ))s"
    # Done when nothing is left; otherwise it lost the lease race or ran out of hours.
    [ "$(pending)" = "0" ] && break
  fi
  sleep 120
done
log "done"

#!/usr/bin/env bash
# Keep the mass pre-resolution going unattended (docs/roster-index.md):
# repeat scripts/pre-resolve.mjs so newly crawled rosters and newly queued
# sections are picked up while the roster crawler is still filling the index.
# Every pass skips whatever is already resolved, so a pass with nothing new
# costs a few seconds. The service key is fetched from the Supabase CLI at
# start and lives only in this process's environment.
#
#   bash scripts/pre-resolve-run.sh [hours=12] [pre-resolve.mjs args…]
cd "$(dirname "$0")/.." || exit 1
HOURS="${1:-12}"
shift || true
REF=$(cat supabase/.temp/project-ref)
KEY=$(supabase projects api-keys --project-ref "$REF" -o json 2>/dev/null | jq -r '.[]|select(.name=="service_role").api_key')
[ -n "$KEY" ] || { echo "no service key (supabase CLI not logged in?)" >&2; exit 2; }
export SUPABASE_URL="https://$REF.supabase.co" SUPABASE_SERVICE_ROLE_KEY="$KEY"
mkdir -p logs
END=$(( $(date +%s) + HOURS * 3600 ))
while [ "$(date +%s)" -lt "$END" ]; do
  echo "===== pass $(date -u +%FT%TZ) =====" >> logs/pre-resolve.log
  node scripts/pre-resolve.mjs --source both --minutes 55 "$@" >> logs/pre-resolve.log 2>&1
  sleep 600
done
echo "===== done $(date -u +%FT%TZ) =====" >> logs/pre-resolve.log

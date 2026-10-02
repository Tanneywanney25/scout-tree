#!/usr/bin/env bash
# Bring up the whole free search stack and publish its public URL.
#
#   SearXNG (container, :8080)  <-  token shim (:8081)  <-  cloudflare tunnel
#
# A quick tunnel gets a NEW random hostname every restart, so the deployed edge
# functions would break on every restart if the URL were set by hand. This
# script scrapes the new hostname out of cloudflared's output and pushes it to
# Supabase secrets automatically.
#
# Usage:  bash scripts/start-search.sh
# Stop:   bash scripts/start-search.sh --stop
#
# Reads .env.local for SEARXNG_TOKEN (required) and SUPABASE_ACCESS_TOKEN /
# SUPABASE_PROJECT_REF (optional — without them the URL is printed for you to
# paste into the Supabase dashboard instead).
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"
RUN_DIR="$ROOT/.searxng-run"
mkdir -p "$RUN_DIR"

PROJECT_REF="${SUPABASE_PROJECT_REF:-xqyszdjczchlgyisvtvo}"

# --- locate tools (winget/manual installs are not always on PATH) -----------
find_tool() {
  local name="$1"; shift
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return 0; fi
  for p in "$@"; do [ -x "$p" ] && { echo "$p"; return 0; }; done
  return 1
}
DOCKER=$(find_tool docker "/c/Program Files/Docker/Docker/resources/bin/docker.exe") || { echo "FATAL: docker not found"; exit 1; }
CLOUDFLARED=$(find_tool cloudflared "/c/Program Files (x86)/cloudflared/cloudflared.exe" "/c/Program Files/cloudflared/cloudflared.exe") || { echo "FATAL: cloudflared not found"; exit 1; }
SUPABASE=$(find_tool supabase "$HOME/.local/bin/supabase.exe" "/c/Users/$USER/.local/bin/supabase.exe" || true)

# shellcheck disable=SC1091
[ -f .env.local ] && set -a && . ./.env.local && set +a

stop_all() {
  echo "stopping tunnel + shim…"
  [ -f "$RUN_DIR/tunnel.pid" ] && kill "$(cat "$RUN_DIR/tunnel.pid")" 2>/dev/null
  [ -f "$RUN_DIR/proxy.pid" ]  && kill "$(cat "$RUN_DIR/proxy.pid")"  2>/dev/null
  rm -f "$RUN_DIR/tunnel.pid" "$RUN_DIR/proxy.pid"
  "$DOCKER" stop searxng >/dev/null 2>&1 && echo "searxng container stopped"
  echo "done."
}
[ "${1:-}" = "--stop" ] && { stop_all; exit 0; }

if [ -z "${SEARXNG_TOKEN:-}" ]; then
  echo "FATAL: SEARXNG_TOKEN missing. Add it to .env.local (openssl rand -hex 32)."
  exit 1
fi

# --- 1. SearXNG container ---------------------------------------------------
echo "==> SearXNG container"
if "$DOCKER" ps -a --format '{{.Names}}' | grep -qx searxng; then
  "$DOCKER" start searxng >/dev/null 2>&1
  echo "    started existing container"
else
  [ -z "${SEARXNG_SECRET:-}" ] && SEARXNG_SECRET=$(openssl rand -hex 32)
  MSYS_NO_PATHCONV=1 "$DOCKER" run -d --name searxng -p 8080:8080 \
    -v searxng-config:/etc/searxng \
    -e SEARXNG_SECRET="$SEARXNG_SECRET" \
    --restart unless-stopped \
    searxng/searxng:latest >/dev/null || { echo "FATAL: container failed to start"; exit 1; }
  echo "    created new container"
  echo "    NOTE: a fresh volume has JSON output disabled — re-apply settings.yml"
fi
for _ in $(seq 1 60); do
  [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ 2>/dev/null)" = "200" ] && break
done
if [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8080/search?q=test&format=json' 2>/dev/null)" != "200" ]; then
  echo "FATAL: SearXNG is up but format=json is not 200 — add 'json' to search.formats in"
  echo "       the settings.yml inside the searxng-config volume, then restart the container."
  exit 1
fi
echo "    json API OK"

# --- 2. token shim ---------------------------------------------------------
echo "==> token shim :8081"
if [ -f "$RUN_DIR/proxy.pid" ] && kill -0 "$(cat "$RUN_DIR/proxy.pid")" 2>/dev/null; then
  echo "    already running (pid $(cat "$RUN_DIR/proxy.pid"))"
else
  SEARXNG_TOKEN="$SEARXNG_TOKEN" node tools/searxng-proxy/server.mjs > "$RUN_DIR/proxy.log" 2>&1 &
  echo $! > "$RUN_DIR/proxy.pid"
  sleep 1
  echo "    started (pid $(cat "$RUN_DIR/proxy.pid"))"
fi

# --- 3. cloudflare quick tunnel -------------------------------------------
echo "==> cloudflare tunnel -> :8081"
: > "$RUN_DIR/tunnel.log"
"$CLOUDFLARED" tunnel --url http://127.0.0.1:8081 --no-autoupdate > "$RUN_DIR/tunnel.log" 2>&1 &
echo $! > "$RUN_DIR/tunnel.pid"

TUNNEL_URL=""
for _ in $(seq 1 90); do
  TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$RUN_DIR/tunnel.log" 2>/dev/null | head -1)
  [ -n "$TUNNEL_URL" ] && break
  sleep 1
done
[ -z "$TUNNEL_URL" ] && { echo "FATAL: no tunnel URL after 90s. See $RUN_DIR/tunnel.log"; exit 1; }
echo "    $TUNNEL_URL"

# verify the tunnel actually reaches the shim through auth
for _ in $(seq 1 20); do
  code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H "X-ScoutTree-Token: $SEARXNG_TOKEN" "$TUNNEL_URL/search?q=test&format=json" 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "    authed probe: HTTP ${code:-000}"
[ "$code" = "200" ] || echo "    WARNING: tunnel not serving 200 yet; it may still be propagating"

# --- 4. publish the URL ----------------------------------------------------
# Keep .env.local in step so local runs and the committed record agree.
if grep -q '^SEARXNG_URL=' .env.local 2>/dev/null; then
  sed -i.bak "s|^SEARXNG_URL=.*|SEARXNG_URL=$TUNNEL_URL|" .env.local && rm -f .env.local.bak
else
  echo "SEARXNG_URL=$TUNNEL_URL" >> .env.local
fi
echo "==> .env.local updated"

if [ -n "${SUPABASE:-}" ] && [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "==> pushing to Supabase secrets"
  SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" "$SUPABASE" secrets set \
    SEARXNG_URL="$TUNNEL_URL" SEARXNG_TOKEN="$SEARXNG_TOKEN" \
    --project-ref "$PROJECT_REF" && echo "    done"
else
  echo "==> Supabase CLI or SUPABASE_ACCESS_TOKEN unavailable — set these by hand:"
  echo "    SEARXNG_URL=$TUNNEL_URL"
  echo "    SEARXNG_TOKEN=<the value in .env.local>"
  echo "    (Dashboard -> Project Settings -> Edge Functions -> Secrets)"
fi

cat <<EOF

ready.
  searxng   http://127.0.0.1:8080
  shim      http://127.0.0.1:8081   (needs X-ScoutTree-Token)
  public    $TUNNEL_URL

Leave this terminal OPEN — closing it kills the tunnel and the deployed
functions lose their retrieval backend (they fall back to cache, then empty).
Stop cleanly with: bash scripts/start-search.sh --stop
EOF

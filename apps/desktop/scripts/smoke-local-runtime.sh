#!/usr/bin/env bash
# Isolated source-image smoke for the desktop provisioning contract.  It uses
# unique labelled containers, an ephemeral host port, and a private mktemp root;
# cleanup refuses resources that do not carry this run's ownership label.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

SOURCE_REVISION="${1:-$(git rev-parse HEAD)}"
EXPECTED_COMPATIBILITY="${2:-2026-06-27}"
if [[ ! "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "A full lowercase Git source revision is required" >&2
  exit 1
fi
APP_IMAGE="propr-desktop-local/app:$SOURCE_REVISION"
STACK="propr-desktop-runtime-smoke-$$-$RANDOM"
LABEL="dev.propr.desktop-runtime-smoke"
NETWORK="$STACK-network"
REDIS_CONTAINER="$STACK-redis"
API_CONTAINER="$STACK-api"
SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/propr-desktop-runtime-smoke.XXXXXX")"

owned_container() {
  [[ "$(docker container inspect --format "{{ index .Config.Labels \"$LABEL\" }}" "$1" 2>/dev/null || true)" == "$STACK" ]]
}

cleanup() {
  for container in "$API_CONTAINER" "$REDIS_CONTAINER"; do
    if docker container inspect "$container" >/dev/null 2>&1; then
      if owned_container "$container"; then docker rm -f "$container" >/dev/null; fi
    fi
  done
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then
    owner="$(docker network inspect --format "{{ index .Labels \"$LABEL\" }}" "$NETWORK")"
    if [[ "$owner" == "$STACK" ]]; then docker network rm "$NETWORK" >/dev/null; fi
  fi
  if [[ "$SMOKE_ROOT" == "${TMPDIR:-/tmp}"/propr-desktop-runtime-smoke.* ]]; then
    rm -rf -- "$SMOKE_ROOT"
  fi
}
trap cleanup EXIT

docker image inspect "$APP_IMAGE" >/dev/null
mkdir -p "$SMOKE_ROOT/data" "$SMOKE_ROOT/logs"
# publicInstanceIdentity deliberately rejects group/world-accessible data roots.
# Establish the required authority independently of the caller's umask.
chmod 700 "$SMOKE_ROOT/data" "$SMOKE_ROOT/logs"
openssl genrsa -out "$SMOKE_ROOT/data/gh-app.pem" 2048 2>/dev/null
chmod 600 "$SMOKE_ROOT/data/gh-app.pem"
cat > "$SMOKE_ROOT/runtime.env" <<EOF
NODE_ENV=production
LOG_LEVEL=warn
DB_FILENAME=/usr/src/app/data/propr.sqlite
REDIS_HOST=$REDIS_CONTAINER
REDIS_PORT=6379
GH_APP_ID=0
GH_INSTALLATION_ID=0
GH_PRIVATE_KEY_PATH=/usr/src/app/data/gh-app.pem
GH_AUTH_MODE=app
GITHUB_EVENT_INTAKE_MODE=polling
PROPR_CONTAINERIZED=1
PROPR_ADMIN_USERS=desktop-runtime-smoke
API_PUBLIC_URL=http://127.0.0.1
FRONTEND_URL=http://127.0.0.1
GH_OAUTH_CALLBACK_URL=http://127.0.0.1/api/auth/github/callback
SESSION_SECRET=desktop-runtime-smoke-session-secret-000000000000
GH_OAUTH_CLIENT_ID=desktop-runtime-smoke
GH_OAUTH_CLIENT_SECRET=desktop-runtime-smoke
EOF

docker network create --label "$LABEL=$STACK" "$NETWORK" >/dev/null
docker run -d --name "$REDIS_CONTAINER" --label "$LABEL=$STACK" --network "$NETWORK" redis:7-alpine >/dev/null
docker run -d --name "$API_CONTAINER" --label "$LABEL=$STACK" --network "$NETWORK" \
  -p 127.0.0.1::4000 --env-file "$SMOKE_ROOT/runtime.env" \
  -v "$SMOKE_ROOT/data:/usr/src/app/data" -v "$SMOKE_ROOT/logs:/usr/src/app/logs" \
  "$APP_IMAGE" node dist/packages/api/server.js >/dev/null

API_PORT="$(docker port "$API_CONTAINER" 4000/tcp | sed -n 's/.*://p' | tail -1)"
[[ "$API_PORT" =~ ^[0-9]+$ ]] || { echo "Could not resolve isolated API port" >&2; exit 1; }
DISCOVERY="$SMOKE_ROOT/discovery.json"
for _ in $(seq 1 45); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$API_PORT/api/desktop/discovery" > "$DISCOVERY"; then break; fi
  sleep 1
done
[[ -s "$DISCOVERY" ]] || { docker logs --tail 100 "$API_CONTAINER"; exit 1; }

node - "$DISCOVERY" "$EXPECTED_COMPATIBILITY" <<'NODE'
const fs = require('node:fs');
const [path, expected] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(path, 'utf8'));
const auth = value.desktopAuthentication;
if (value.schemaVersion !== 1 || value.product !== 'ProPR'
  || value.apiCompatibility !== expected || value.uiCompatibility !== expected
  || !/^[0-9a-f-]{36}$/.test(value.publicInstanceIdentity || '')
  || auth?.protocolVersion !== 2 || auth.browserPairing !== true
  || auth.instanceBearerTokens !== true || auth.socketIoBearerAuthentication !== true) {
  throw new Error('Source-built backend does not expose the complete desktop contract');
}
NODE

echo "Desktop runtime smoke passed for $APP_IMAGE on isolated port $API_PORT"

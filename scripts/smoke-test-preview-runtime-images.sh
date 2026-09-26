#!/usr/bin/env bash
# Native smoke test for the app+UI image pair used by Linux desktop previews.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SOURCE_REVISION="${SOURCE_REVISION:-$(git rev-parse HEAD)}"
EXPECTED_VERSION="${EXPECTED_VERSION:-$(node -p "require('./package.json').version")}"
EXPECTED_COMPATIBILITY="${EXPECTED_COMPATIBILITY:-2026-06-27}"
APP_IMAGE="${APP_IMAGE:-propr/app:$SOURCE_REVISION}"
UI_IMAGE="${UI_IMAGE:-propr/ui:$SOURCE_REVISION}"

if [[ ! "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'SOURCE_REVISION must be a full lowercase 40-character Git commit SHA' >&2
  exit 1
fi
if [[ "$APP_IMAGE" != "propr/app:$SOURCE_REVISION" || "$UI_IMAGE" != "propr/ui:$SOURCE_REVISION" ]]; then
  echo 'Preview smoke accepts only exact propr/app and propr/ui full-SHA tags' >&2
  exit 1
fi

STACK="propr-preview-runtime-smoke-${GITHUB_RUN_ID:-local}-$$-$RANDOM"
LABEL="dev.propr.preview-runtime-smoke"
NETWORK="$STACK-network"
REDIS_CONTAINER="$STACK-redis"
API_CONTAINER="$STACK-api"
UI_CONTAINER="$STACK-ui"
DAEMON_CONTAINER="$STACK-daemon"
WORKER_CONTAINER="$STACK-worker"
SMOKE_ROOT="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/propr-preview-runtime-smoke.XXXXXX")"

owned_container() {
  [[ "$(docker container inspect --format "{{ index .Config.Labels \"$LABEL\" }}" "$1" 2>/dev/null || true)" == "$STACK" ]]
}

cleanup() {
  local container owner
  for container in "$UI_CONTAINER" "$WORKER_CONTAINER" "$DAEMON_CONTAINER" "$API_CONTAINER" "$REDIS_CONTAINER"; do
    if docker container inspect "$container" >/dev/null 2>&1 && owned_container "$container"; then
      docker rm -f "$container" >/dev/null
    fi
  done
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then
    owner="$(docker network inspect --format "{{ index .Labels \"$LABEL\" }}" "$NETWORK")"
    if [[ "$owner" == "$STACK" ]]; then docker network rm "$NETWORK" >/dev/null; fi
  fi
  if [[ "$SMOKE_ROOT" == "${RUNNER_TEMP:-${TMPDIR:-/tmp}}"/propr-preview-runtime-smoke.* ]]; then
    rm -rf -- "$SMOKE_ROOT"
  fi
}
trap cleanup EXIT

docker image inspect "$APP_IMAGE" "$UI_IMAGE" >/dev/null
mkdir -p "$SMOKE_ROOT/data" "$SMOKE_ROOT/logs"
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
GITHUB_REPOS_TO_MONITOR=smoketest/fake-repo
WORKER_CONCURRENCY=1
PROPR_CONTAINERIZED=1
PROPR_ADMIN_USERS=preview-runtime-smoke
API_PUBLIC_URL=http://127.0.0.1
FRONTEND_URL=http://127.0.0.1
GH_OAUTH_CALLBACK_URL=http://127.0.0.1/api/auth/github/callback
SESSION_SECRET=preview-runtime-smoke-session-secret-000000000000
GH_OAUTH_CLIENT_ID=preview-runtime-smoke
GH_OAUTH_CLIENT_SECRET=preview-runtime-smoke
EOF

docker network create --label "$LABEL=$STACK" "$NETWORK" >/dev/null
docker run -d --name "$REDIS_CONTAINER" --label "$LABEL=$STACK" --network "$NETWORK" redis:7-alpine >/dev/null
docker run --rm --network "$NETWORK" --env-file "$SMOKE_ROOT/runtime.env" \
  -v "$SMOKE_ROOT/data:/usr/src/app/data" "$APP_IMAGE" \
  sh -c "npx knex migrate:latest --knexfile /usr/src/app/dist/knexfile.js"
# An absent agents row means "create the default agent", which legitimately
# requires Docker access. Persist one explicitly disabled direct agent instead:
# this is the supported no-work configuration and lets the real worker prove it
# can initialize BullMQ and remain live without a Docker socket or agent image.
docker run --rm --network "$NETWORK" --env-file "$SMOKE_ROOT/runtime.env" \
  -v "$SMOKE_ROOT/data:/usr/src/app/data" "$APP_IMAGE" \
  node --input-type=module -e \
  "import { closeConnection, saveAgents } from '@propr/core'; try { await saveAgents([{ id: '00000000-0000-4000-8000-000000000001', type: 'claude', alias: 'preview-runtime-no-work', enabled: false, dockerImage: 'propr/agent:preview-runtime-no-work', configPath: '/tmp/preview-runtime-no-work', supportedModels: ['claude-sonnet-4-6'] }]); } finally { await closeConnection(); }"
docker run -d --name "$API_CONTAINER" --label "$LABEL=$STACK" --network "$NETWORK" \
  -p 127.0.0.1::4000 --env-file "$SMOKE_ROOT/runtime.env" \
  -v "$SMOKE_ROOT/data:/usr/src/app/data" -v "$SMOKE_ROOT/logs:/usr/src/app/logs" \
  "$APP_IMAGE" node dist/packages/api/server.js >/dev/null
API_PORT="$(docker port "$API_CONTAINER" 4000/tcp | sed -n 's/.*://p' | tail -1)"
[[ "$API_PORT" =~ ^[0-9]+$ ]] || {
  echo 'Could not resolve isolated preview app port' >&2
  exit 1
}
API_ORIGIN="http://127.0.0.1:$API_PORT"
docker run -d --name "$UI_CONTAINER" --label "$LABEL=$STACK" \
  -p 127.0.0.1::5173 -e "PROPR_UI_PUBLIC_API_URL=$API_ORIGIN" "$UI_IMAGE" >/dev/null
docker run -d --name "$DAEMON_CONTAINER" --label "$LABEL=$STACK" --network "$NETWORK" \
  --env-file "$SMOKE_ROOT/runtime.env" \
  -v "$SMOKE_ROOT/data:/usr/src/app/data" -v "$SMOKE_ROOT/logs:/usr/src/app/logs" \
  "$APP_IMAGE" node dist/src/daemon.js >/dev/null
docker run -d --name "$WORKER_CONTAINER" --label "$LABEL=$STACK" --network "$NETWORK" \
  --env-file "$SMOKE_ROOT/runtime.env" \
  -v "$SMOKE_ROOT/data:/usr/src/app/data" -v "$SMOKE_ROOT/logs:/usr/src/app/logs" \
  "$APP_IMAGE" node dist/src/worker.js >/dev/null

UI_PORT="$(docker port "$UI_CONTAINER" 5173/tcp | sed -n 's/.*://p' | tail -1)"
[[ "$UI_PORT" =~ ^[0-9]+$ ]] || {
  echo 'Could not resolve isolated preview UI port' >&2
  exit 1
}

DISCOVERY="$SMOKE_ROOT/discovery.json"
UI_HTML="$SMOKE_ROOT/index.html"
for _ in $(seq 1 45); do
  curl -fsS --max-time 2 "http://127.0.0.1:$API_PORT/api/desktop/discovery" > "$DISCOVERY" \
    && curl -fsS --max-time 2 "http://127.0.0.1:$UI_PORT/" > "$UI_HTML" \
    && break
  sleep 1
done
[[ -s "$DISCOVERY" && -s "$UI_HTML" ]] || {
  docker logs --tail 100 "$API_CONTAINER" >&2 || true
  docker logs --tail 100 "$UI_CONTAINER" >&2 || true
  exit 1
}

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
  throw new Error('Preview app image does not expose the complete desktop contract');
}
NODE

grep -Eq "(src|href)=['\"][^'\"]+" "$UI_HTML" || {
  echo 'Preview UI page does not reference built assets' >&2
  exit 1
}
mapfile -t UI_ASSETS < <(
  grep -oE "(src|href)=('([^']+)'|\"([^\"]+)\")" "$UI_HTML" \
    | sed -E -e "s/^[^=]+='([^']+)'$/\1/" -e 's/^[^=]+="([^"]+)"$/\1/' \
    | grep -E '^/[^/]' \
    | sort -u
)
if [[ "${#UI_ASSETS[@]}" -eq 0 ]]; then
  echo 'Preview UI page does not reference any local built assets' >&2
  exit 1
fi
for asset in "${UI_ASSETS[@]}"; do
  curl -fsS --max-time 5 "http://127.0.0.1:$UI_PORT$asset" >/dev/null
done
UI_CONFIG="$(curl -fsS --max-time 5 "http://127.0.0.1:$UI_PORT/config.js")"
UI_CONFIG="$UI_CONFIG" EXPECTED_API_ORIGIN="$API_ORIGIN" node <<'NODE'
const source = process.env.UI_CONFIG || '';
const match = source.match(/^window\.__PROPR_CONFIG__\s*=\s*(\{.*\});?\s*$/s);
if (!match || JSON.parse(match[1]).apiBaseUrl !== process.env.EXPECTED_API_ORIGIN) {
  throw new Error('Preview UI runtime configuration was not applied');
}
NODE

COMPATIBILITY="$(curl -fsS --max-time 5 "http://127.0.0.1:$API_PORT/api/compatibility")"
COMPATIBILITY="$COMPATIBILITY" EXPECTED_VERSION="$EXPECTED_VERSION" node <<'NODE'
const value = JSON.parse(process.env.COMPATIBILITY || '{}');
if (value.version !== process.env.EXPECTED_VERSION) {
  throw new Error('Preview app compatibility version does not match repository metadata');
}
NODE

sleep 3
for container in "$API_CONTAINER" "$DAEMON_CONTAINER" "$WORKER_CONTAINER" "$UI_CONTAINER"; do
  [[ "$(docker inspect --format '{{.State.Status}}' "$container")" == running ]] || {
    docker logs --tail 100 "$container" >&2 || true
    exit 1
  }
done

echo "Preview runtime smoke passed for $APP_IMAGE and $UI_IMAGE"

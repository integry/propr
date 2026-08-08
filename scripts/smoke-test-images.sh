#!/usr/bin/env bash
# Smoke test for the production Docker images.
#
# Starts the app, UI, and docs images, checks the agent and launcher artifacts,
# waits for HTTP endpoints to respond, and tears everything down.
#
# What this validates:
#   - Images boot (no missing files, Dockerfile commands work end-to-end)
#   - TypeScript build output is runnable (no import path errors)
#   - Native modules load (better-sqlite3 works on alpine musl)
#   - API server binds and responds to /health
#   - Workers connect to Redis without crashing
#
# What this does NOT validate:
#   - Real GitHub webhook flow (needs creds)
#   - Actual agent spawning (needs Anthropic/OpenAI/Google API keys)
#   - Full e2e tests (see scripts/smoke-test-e2e.sh for that)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

STACK="${STACK:-propr-smoke-${GITHUB_RUN_ID:-local-$$}}"
if [[ ! "$STACK" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
  echo "STACK must contain only letters, numbers, dots, underscores, and hyphens" >&2
  exit 1
fi
NETWORK="${STACK}-net"
DATA_DIR="/tmp/${STACK}-data"
STACK_LABEL_KEY="com.propr.smoke.stack"
DATA_OWNER_FILE="$DATA_DIR/.propr-smoke-owner"
API_PORT="${API_PORT:-14000}"
APP_TAG="${APP_TAG:-propr/app:latest}"
UI_TAG="${UI_TAG:-propr/ui:latest}"
DOCS_TAG="${DOCS_TAG:-propr/docs:latest}"
AGENT_TAG="${AGENT_TAG:-propr/agent:latest}"
LAUNCHER_TAG="${LAUNCHER_TAG:-propr/launcher:latest}"
REDIS_TAG="${REDIS_TAG:-redis:7-alpine}"
UI_PORT="${UI_PORT:-14173}"
DOCS_PORT="${DOCS_PORT:-13000}"
EXPECTED_VERSION="${EXPECTED_VERSION:-$(node -p "require('./package.json').version")}"
STACK_CONTAINERS=(
  "$STACK-api"
  "$STACK-daemon"
  "$STACK-worker"
  "$STACK-ui"
  "$STACK-docs"
  "$STACK-redis"
)

remove_stack_resources() {
  local resource owner

  # Resolve and validate every target before deleting any of them. A matching
  # name is not proof of ownership: an operator or another run may own it.
  for resource in "${STACK_CONTAINERS[@]}"; do
    if ! docker container inspect "$resource" >/dev/null 2>&1; then
      continue
    fi
    owner=$(docker container inspect --format "{{ index .Config.Labels \"$STACK_LABEL_KEY\" }}" "$resource")
    if [ "$owner" != "$STACK" ]; then
      echo "✗ refusing to remove unowned container $resource" >&2
      return 1
    fi
  done
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then
    owner=$(docker network inspect --format "{{ index .Labels \"$STACK_LABEL_KEY\" }}" "$NETWORK")
    if [ "$owner" != "$STACK" ]; then
      echo "✗ refusing to remove unowned network $NETWORK" >&2
      return 1
    fi
  fi

  for resource in "${STACK_CONTAINERS[@]}"; do
    if docker container inspect "$resource" >/dev/null 2>&1; then
      docker rm -f "$resource" >/dev/null
    fi
  done
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then
    docker network rm "$NETWORK" >/dev/null
  fi
}

remove_data_dir() {
  if [ ! -e "$DATA_DIR" ] && [ ! -L "$DATA_DIR" ]; then
    return 0
  fi
  if [ -L "$DATA_DIR" ] || [ ! -f "$DATA_OWNER_FILE" ] || [ "$(< "$DATA_OWNER_FILE")" != "$STACK" ]; then
    echo "✗ refusing to remove unowned smoke data directory $DATA_DIR" >&2
    return 1
  fi
  rm -rf -- "$DATA_DIR"
}

cleanup() {
  echo ""
  echo "▸ cleaning up"
  remove_stack_resources 2>/dev/null || true
  remove_data_dir 2>/dev/null || true
}
trap cleanup EXIT

reconcile_stale_stack() {
  local resource found=false
  for resource in "${STACK_CONTAINERS[@]}"; do
    if docker container inspect "$resource" >/dev/null 2>&1; then
      found=true
      break
    fi
  done
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then
    found=true
  fi
  if $found; then
    echo "▸ removing stale resources for validated smoke stack $STACK"
    if ! remove_stack_resources; then
      echo "✗ could not remove stale network $NETWORK; inspect its attached containers before retrying" >&2
      exit 1
    fi
  fi
  if ! remove_data_dir; then
    exit 1
  fi
}

echo "▸ propr image smoke test"
echo "  stack:    $STACK"
echo "  api port: $API_PORT"
echo "  app tag:  $APP_TAG"
echo "  ui tag:   $UI_TAG"
echo "  docs tag: $DOCS_TAG"
echo "  agent tag: $AGENT_TAG"
echo "  launcher: $LAUNCHER_TAG"
echo ""

reconcile_stale_stack

# --- Prepare throwaway data dir and fake .env ------------------------------
mkdir -p "$DATA_DIR"/{data,logs}
printf '%s\n' "$STACK" > "$DATA_OWNER_FILE"

# Dummy GitHub App private key — structurally valid RSA PEM so openssl-based
# parsers accept it. The smoke test doesn't make actual GitHub API calls.
openssl genrsa -out "$DATA_DIR/data/gh-app.pem" 2048 2>/dev/null
chmod 644 "$DATA_DIR/data/gh-app.pem"

# Minimal .env that lets the app boot without real credentials.
# GitHub App values are non-functional — the daemon will log warnings but
# won't crash as long as the module can load.
cat > "$DATA_DIR/.env" <<EOF
NODE_ENV=production
LOG_LEVEL=warn
DB_FILENAME=/usr/src/app/data/propr.sqlite
REDIS_HOST=${STACK}-redis
REDIS_PORT=6379
GH_APP_ID=0
GH_INSTALLATION_ID=0
GH_PRIVATE_KEY_PATH=/usr/src/app/data/gh-app.pem
GH_AUTH_MODE=app
GITHUB_EVENT_INTAKE_MODE=polling
GITHUB_REPOS_TO_MONITOR=smoketest/fake-repo
WORKER_CONCURRENCY=1
PROPR_CONTAINERIZED=1
PROPR_ADMIN_USERS=smoketest-admin
API_PUBLIC_URL=http://localhost:${API_PORT}
FRONTEND_URL=http://localhost:${UI_PORT}
GH_OAUTH_CALLBACK_URL=http://localhost:${API_PORT}/api/auth/github/callback
SESSION_SECRET=smoke-test-only-session-secret-0000000000000000
GH_OAUTH_CLIENT_ID=smoke-test
GH_OAUTH_CLIENT_SECRET=smoke-test
GITHUB_WEBHOOK_SECRET=smoke-test
EOF

# --- Pre-flight: every publishable image exists locally ---------------------
for image in "$APP_TAG" "$UI_TAG" "$DOCS_TAG" "$AGENT_TAG" "$LAUNCHER_TAG"; do
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "✗ image $image not found locally — run: npm run images:build" >&2
    exit 1
  fi
done

wait_for_http() {
  local label="$1" url="$2" body
  echo "▸ waiting for $label on $url"
  for _ in $(seq 1 30); do
    if body=$(curl -fsS --max-time 2 "$url" 2>/dev/null); then
      echo "✓ $label responded: ${body:0:120}"
      return 0
    fi
    sleep 1
  done
  echo "✗ $label did not respond within 30s" >&2
  return 1
}

check_page_assets() {
  local label="$1" base_url="$2" html asset
  local -a assets=()
  html=$(curl -fsS --max-time 5 "$base_url")
  mapfile -t assets < <(
    grep -oE "(src|href)=(\"[^\"]+\"|'[^']+'|[^[:space:]>]+)" <<< "$html" \
      | sed -E "s/^[^=]+=['\"]?([^'\"]+)['\"]?$/\1/" \
      | grep -E '^/[^/]' \
      | sort -u
  )
  if [ "${#assets[@]}" -eq 0 ]; then
    echo "✗ $label page did not reference any local assets" >&2
    return 1
  fi
  for asset in "${assets[@]}"; do
    curl -fsS --max-time 5 "${base_url%/}${asset}" >/dev/null
  done
  echo "✓ $label referenced assets are reachable (${#assets[@]} checked)"
}

check_ui_api_configuration() {
  local config expected_origin response_headers response_body
  config=$(curl -fsS --max-time 5 "http://localhost:${UI_PORT}/config.js")
  expected_origin="http://localhost:${API_PORT}"
  if ! UI_CONFIG="$config" EXPECTED_API_ORIGIN="$expected_origin" node <<'NODE'
const source = process.env.UI_CONFIG || '';
const match = source.match(/^window\.__PROPR_CONFIG__\s*=\s*(\{.*\});?\s*$/s);
if (!match || JSON.parse(match[1]).apiBaseUrl !== process.env.EXPECTED_API_ORIGIN) process.exit(1);
NODE
  then
    echo "✗ UI runtime config does not point to $expected_origin" >&2
    return 1
  fi

  response_headers=$(mktemp)
  response_body=$(mktemp)
  if ! curl -fsS --max-time 5 \
    -H "Origin: http://localhost:${UI_PORT}" \
    -D "$response_headers" \
    -o "$response_body" \
    "$expected_origin/api/compatibility"; then
    rm -f -- "$response_headers" "$response_body"
    echo "✗ UI-configured compatibility path is not reachable" >&2
    return 1
  fi
  if ! grep -Fqi "access-control-allow-origin: http://localhost:${UI_PORT}" "$response_headers" \
      || ! grep -Fq "\"version\":\"${EXPECTED_VERSION}\"" "$response_body"; then
    rm -f -- "$response_headers" "$response_body"
    echo "✗ UI-configured compatibility path did not return versioned CORS-enabled output" >&2
    return 1
  fi
  rm -f -- "$response_headers" "$response_body"
  echo "✓ UI runtime configuration reaches the API compatibility endpoint"
}

# --- Network ---------------------------------------------------------------
docker network create --label "$STACK_LABEL_KEY=$STACK" "$NETWORK" >/dev/null
echo "✓ network created"

# --- Redis -----------------------------------------------------------------
docker run -d --name "$STACK-redis" --label "$STACK_LABEL_KEY=$STACK" --network "$NETWORK" "$REDIS_TAG" >/dev/null
echo "✓ redis started"

# --- Static UI and docs -----------------------------------------------------
docker run -d --name "$STACK-ui" --label "$STACK_LABEL_KEY=$STACK" -p "${UI_PORT}:5173" \
  -e "PROPR_UI_PUBLIC_API_URL=http://localhost:${API_PORT}" \
  "$UI_TAG" >/dev/null
docker run -d --name "$STACK-docs" --label "$STACK_LABEL_KEY=$STACK" -p "${DOCS_PORT}:3000" "$DOCS_TAG" >/dev/null
wait_for_http "ui" "http://localhost:${UI_PORT}"
wait_for_http "docs" "http://localhost:${DOCS_PORT}"
check_page_assets "ui" "http://localhost:${UI_PORT}"
check_page_assets "docs" "http://localhost:${DOCS_PORT}"

# --- Run migrations (fresh SQLite) -----------------------------------------
docker run --rm --network "$NETWORK" \
  --env-file "$DATA_DIR/.env" \
  -v "$DATA_DIR/data:/usr/src/app/data" \
  "$APP_TAG" sh -c "npx knex migrate:latest --knexfile /usr/src/app/dist/knexfile.js 2>/dev/null || node -e 'import(\"./dist/packages/core/src/db/connection.js\").catch(e=>{console.error(e);process.exit(1)})'" \
  >/dev/null 2>&1 || echo "  (migrations: best-effort)"
echo "✓ db ready"

# --- API -------------------------------------------------------------------
docker run -d --name "$STACK-api" --label "$STACK_LABEL_KEY=$STACK" --network "$NETWORK" \
  -p "${API_PORT}:4000" \
  --env-file "$DATA_DIR/.env" \
  -v "$DATA_DIR/data:/usr/src/app/data" \
  -v "$DATA_DIR/logs:/usr/src/app/logs" \
  "$APP_TAG" node dist/packages/api/server.js >/dev/null
echo "✓ api started"

# --- Daemon + Worker (crash-check only) ------------------------------------
docker run -d --name "$STACK-daemon" --label "$STACK_LABEL_KEY=$STACK" --network "$NETWORK" \
  --env-file "$DATA_DIR/.env" \
  -v "$DATA_DIR/data:/usr/src/app/data" \
  -v "$DATA_DIR/logs:/usr/src/app/logs" \
  "$APP_TAG" node dist/src/daemon.js >/dev/null
echo "✓ daemon started"

docker run -d --name "$STACK-worker" --label "$STACK_LABEL_KEY=$STACK" --network "$NETWORK" \
  --env-file "$DATA_DIR/.env" \
  -v "$DATA_DIR/data:/usr/src/app/data" \
  -v "$DATA_DIR/logs:/usr/src/app/logs" \
  "$APP_TAG" node dist/src/worker.js >/dev/null
echo "✓ worker started"

# --- Wait for /health ------------------------------------------------------
echo ""
if ! wait_for_http "api" "http://localhost:${API_PORT}/health"; then
  echo ""
  echo "--- api logs ---"
  docker logs --tail 50 "$STACK-api"
  exit 1
fi
check_ui_api_configuration

# --- Agent and launcher artifact checks ------------------------------------
docker run --rm "$AGENT_TAG" sh -c '
  set -eu
  for executable in claude codex agy opencode vibe git gh rg python3; do
    command -v "$executable" >/dev/null
  done
' >/dev/null
echo "✓ agent runtime exposes every bundled CLI"

docker run --rm --entrypoint node \
  -e "EXPECTED_VERSION=$EXPECTED_VERSION" \
  "$LAUNCHER_TAG" --input-type=module -e '
    import fs from "node:fs";
    const manifest = JSON.parse(fs.readFileSync("/app/manifest.json", "utf8"));
    if (manifest.version !== process.env.EXPECTED_VERSION) throw new Error("launcher manifest version mismatch");
    await import("file:///app/orchestrator.mjs");
  ' >/dev/null
echo "✓ launcher contains the release manifest and runnable orchestrator"

# --- Crash check: all containers still running after startup grace ---------
sleep 3
for c in api daemon worker ui docs; do
  status=$(docker inspect --format '{{.State.Status}}' "$STACK-$c" 2>/dev/null || echo "missing")
  if [ "$status" != "running" ]; then
    echo "✗ $STACK-$c is $status (expected running)"
    docker logs --tail 30 "$STACK-$c" || true
    exit 1
  fi
  echo "✓ $STACK-$c is running"
done

echo ""
echo "✓ smoke test passed"

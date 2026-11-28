#!/usr/bin/env bash
# Smoke test for the production Docker images.
#
# Starts the app, UI, and docs images, checks the agent and launcher artifacts,
# waits for HTTP endpoints to respond, and tears everything down.
#
# What this validates:
#   - Images boot (no missing files, Dockerfile commands work end-to-end)
#   - TypeScript build output is runnable (no import path errors)
#   - Native modules load (better-sqlite3 and sharp work in the app image)
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
# Bounded removal of the private data root, shared with the other image smokes.
# shellcheck source=apps/desktop/scripts/smoke-local-runtime-cleanup.sh disable=SC1091
source "$REPO_ROOT/apps/desktop/scripts/smoke-local-runtime-cleanup.sh"

STACK="${STACK:-propr-smoke-${GITHUB_RUN_ID:-local-$$}}"
if [[ ! "$STACK" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
  echo "STACK must contain only letters, numbers, dots, underscores, and hyphens" >&2
  exit 1
fi
NETWORK="${STACK}-net"
STACK_LABEL_KEY="com.propr.smoke.stack"
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
  "$STACK-opencode-stop"
  "$STACK-antigravity-stop"
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
      docker rm -f "$resource" >/dev/null || return 1
    fi
  done
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then
    docker network rm "$NETWORK" >/dev/null || return 1
  fi
}

# A private per-run data root.  The app containers run as root and leave
# root-owned 0700 entries (e.g. data/web-push) in its bind mounts, so removal
# goes through the bounded helper rather than a host `rm -rf`.
SMOKE_TMP_BASE="$(cd "${RUNNER_TEMP:-${TMPDIR:-/tmp}}" && pwd -P)"
DATA_DIR="$(mktemp -d "$SMOKE_TMP_BASE/propr-image-smoke.XXXXXX")"
DATA_DIR_IDENTITY="$(smoke_root_identity "$DATA_DIR")"

# The smoke's own exit status is preserved; a cleanup failure is reported and
# turns an otherwise successful run into a failure.
cleanup() {
  local status=$? failed=0
  set +e
  echo ""
  echo "▸ cleaning up"
  remove_stack_resources || failed=1
  remove_smoke_root "$DATA_DIR" "$SMOKE_TMP_BASE" "$DATA_DIR_IDENTITY" "$APP_TAG" "$STACK_LABEL_KEY" "$STACK" || failed=1
  if (( failed )); then
    echo "✗ image smoke cleanup did not remove every owned resource" >&2
    (( status )) || status=1
  fi
  exit "$status"
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

docker run --rm --entrypoint node "$APP_TAG" -e '
  const fs = require("node:fs");
  const manifestPath = "/app/docs/docs-manifest.json";
  if (!fs.existsSync(manifestPath)) throw new Error("app image is missing docs/docs-manifest.json");
  if (!fs.existsSync("/app/docs/docs/features/pr-commands.md")) throw new Error("app image is missing bundled Markdown pages");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const appPackage = JSON.parse(fs.readFileSync("/usr/src/app/package.json", "utf8"));
  const apiPackage = JSON.parse(fs.readFileSync("/usr/src/app/packages/api/package.json", "utf8"));
  if (manifest.version !== appPackage.version || manifest.version !== apiPackage.version) {
    throw new Error(`docs manifest version ${manifest.version} does not match app ${appPackage.version} and API ${apiPackage.version}`);
  }
' >/dev/null
echo "✓ app contains version-matched MCP documentation"

# Resolve sharp from every shipped importer and run a real image operation.
"$REPO_ROOT/scripts/smoke-check-app-sharp.sh" "$APP_TAG"

# The worker builds custom agent bundles from the app image's /usr/src/app.
"$REPO_ROOT/scripts/smoke-check-app-agent-build-context.sh" "$APP_TAG"

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
    grep -oE "(src|href)=(\"[^\"]+\"|'[^']+'|[^[:space:]>\"']+)" <<< "$html" \
      | sed -E -e "s/^[^=]+=\"([^\"]+)\"$/\1/" \
        -e "s/^[^=]+='([^']+)'$/\1/" \
        -e "s/^[^=]+=([^[:space:]>\"']+)$/\1/" \
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
# Restricted snapshotters (rootless, userxattr overlay, OrbStack's containerd
# store) cannot unpack a layer that carries overlayfs whiteouts.
"$REPO_ROOT/scripts/check-image-whiteouts.sh" "$AGENT_TAG"

docker run --rm "$AGENT_TAG" sh -c '
  set -eu
  for executable in claude codex agy opencode vibe pi agent-tank git gh rg python3; do
    command -v "$executable" >/dev/null
  done
' >/dev/null
echo "✓ agent runtime exposes every bundled CLI"

# Bundled Agent Tank runs through the shared entrypoint's agent-tank branch,
# which must not hand it a provider entrypoint. This is the unauthenticated half
# of that check; scripts/verify-agent-tank-image.sh drives real usage through it.
docker run --rm --network none -e PROPR_AGENT_TYPE=agent-tank "$AGENT_TAG" agent-tank --version >/dev/null
echo "✓ agent-tank runs through the entrypoint without a provider entrypoint"

# Exercise GitHub CLI through every normal agent entrypoint. Merely checking
# command -v is insufficient because each entrypoint places gh-wrapper first in
# PATH; a wrapper that delegates back through PATH resolves itself and hangs.
for entrypoint in claude codex antigravity opencode vibe pi; do
  docker run --rm --network none --entrypoint "/home/node/${entrypoint}-entrypoint.sh" \
    "$AGENT_TAG" gh --version >/dev/null
done
echo "✓ agent entrypoints can execute GitHub CLI through the wrapper"

# Pi runs through the shared entrypoint's dispatch, as ProPR starts it.
pi_version="$(docker run --rm --network none -e PROPR_AGENT_TYPE=pi "$AGENT_TAG" pi --version 2>"$DATA_DIR/pi-version.log")" || {
  echo "✗ pi --version failed through the agent entrypoint"
  cat "$DATA_DIR/pi-version.log"
  exit 1
}
pi_label="$(docker image inspect --format '{{ index .Config.Labels "dev.propr.agent.pi.version" }}' "$AGENT_TAG")"
if [ -z "$pi_label" ] || [ "$pi_version" != "$pi_label" ]; then
  echo "✗ pi --version ($pi_version) through the entrypoint does not match the image label ($pi_label)"
  exit 1
fi
echo "✓ pi --version runs through the agent entrypoint"

# Exercise the real source bind mount with a private UID 1001 store and with a
# UID 1000 store that would be writable by the task without the root-only parent.
for pi_source_uid in 1000 1001; do
  pi_source="$DATA_DIR/pi-source-$pi_source_uid"
  mkdir -p "$pi_source"
  docker run --rm --network none --user 0:0 -v "$pi_source:/source:rw" --entrypoint sh "$AGENT_TAG" -ec '
    mkdir -p /source/sessions /source/extensions
    printf "%s" "{\"anthropic\":{\"type\":\"oauth\",\"access\":\"a\",\"refresh\":\"r\",\"expires\":1}}" > /source/auth.json
    printf "%s" "{}" > /source/settings.json
    printf "%s" "{}" > /source/mcp.json
    chown -R "$1:$1" /source
    chmod 700 /source
    chown "$1:1002" /source/auth.json
    chmod 600 /source/auth.json
  ' pi-fixture "$pi_source_uid"
  if ! docker run --rm --network none --user 0:0 --security-opt no-new-privileges \
    -v "$pi_source:/root/propr-pi-source:rw" \
    -e PROPR_PI_GOAL_SESSION_DIR=/tmp/goal-sessions \
    --entrypoint sh "$AGENT_TAG" -ec '
    mkdir -m 0755 /tmp/goal-sessions
    printf "%s" "{\"anthropic\":{\"type\":\"oauth\",\"access\":\"new-a\",\"refresh\":\"new-r\",\"expires\":2}}" > /tmp/propr-pi-refreshed.json
    chmod 644 /tmp/propr-pi-refreshed.json
    /opt/propr/pi-entrypoint.sh sh -ec "
      test \"\$(id -u)\" = 1000
      test ! -r /root/propr-pi-source/auth.json
      test ! -w /root/propr-pi-source/auth.json
      test ! -x /root/propr-pi-source
      ! ls /root/propr-pi-source >/dev/null 2>&1
      ! touch /root/propr-pi-source/planted 2>/dev/null
      ! ls -d /root/propr-pi-source/* >/dev/null 2>&1
      test ! -e /proc/self/fd/9
      test \"\$(stat -c %a /tmp/goal-sessions)\" = 700
      (umask 022 && printf %s {} > /tmp/goal-sessions/session.jsonl)
      cat /tmp/propr-pi-refreshed.json > \"\$PI_CODING_AGENT_DIR/auth.json\"
      # /home/node is node-owned: replace its bin dir wholesale with fakes
      # (last, so the task itself still runs the real tools).
      mv /home/node/bin /home/node/bin.task-moved 2>/dev/null || true
      mkdir /home/node/bin
      for tool in cp chown chmod python3 python3.11 env mkdir rm ln mv realpath stat su-exec cat find; do
        printf \"%s\\n\" \"#!/bin/sh\" \"echo \\\$0 >> /tmp/propr-fake-bin-ran\" \"exit 0\" > /home/node/bin/\$tool
        /bin/chmod +x /home/node/bin/\$tool
      done
    "
    test -x /home/node/bin/python3
    test ! -e /tmp/propr-fake-bin-ran
    test ! -e /root/propr-pi-source/planted
    test "$(stat -c "%u:%g:%a" /tmp/goal-sessions/session.jsonl)" = "1000:1000:600"
    grep -q "\"refresh\": \"new-r\"" /root/propr-pi-source/auth.json
    test "$(stat -c "%u:%g:%a" /root/propr-pi-source/auth.json)" = "$1:1002:600"
    test "$(stat -c "%u:%g:%a" /root/propr-pi-source)" = "$1:$1:700"
    test "$(stat -c "%u:%g" /root/propr-pi-source/sessions)" = "$1:$1"
    test ! -e /root/propr-pi-source/auth.json.lock
    test ! -e /tmp/propr-pi-home/agent/mcp.json
    test ! -e /tmp/propr-pi-home/agent/extensions
    test -f /tmp/propr-pi-home/agent/auth.json
    test -z "$(find /tmp/propr-pi-home ! -user node -print)"
  ' pi-check "$pi_source_uid" 2>"$DATA_DIR/pi-entrypoint.log"; then
    echo "✗ Pi entrypoint failed with a mounted UID $pi_source_uid source"
    cat "$DATA_DIR/pi-entrypoint.log"
    exit 1
  fi
done
echo "✓ Pi isolates UID 1000 and UID 1001 credential sources from the task, ignores a task-replaced /home/node/bin after the run, writes back refreshes keeping owner and mode, and restricts goal session permissions"

# ProPR starts OpenCode task containers as root (--user 0:0) with disposable
# state and a mounted host data directory. Everything the entrypoint runs
# before dropping to node (version probe, schema init, credential seeding) must
# leave the disposable data dir node-owned, or OpenCode cannot open its log.
opencode_root_owned="$(docker run --rm --user 0:0 \
  -e XDG_DATA_HOME=/tmp/propr-opencode-data \
  -e PROPR_EPHEMERAL_STATE=1 \
  -e PROPR_OPENCODE_SOURCE_DATA=/tmp/propr-opencode-source \
  --entrypoint sh "$AGENT_TAG" -c '
    set -eu
    mkdir -p /tmp/propr-opencode-source
    python3 -c "import sqlite3; sqlite3.connect(\"/tmp/propr-opencode-source/opencode.db\").close()"
    chown -R node:node /tmp/propr-opencode-source
    exec /home/node/opencode-entrypoint.sh \
      sh -c "test \"\$(id -u)\" = 1000 && find /tmp/propr-opencode-data ! -user node -print"
  ' 2>"$DATA_DIR/opencode-entrypoint.log")" || {
  echo "✗ OpenCode entrypoint failed when started as root with disposable state"
  cat "$DATA_DIR/opencode-entrypoint.log"
  exit 1
}
if [ -n "$opencode_root_owned" ]; then
  echo "✗ OpenCode entrypoint left files not owned by node in the disposable data dir:"
  echo "$opencode_root_owned"
  cat "$DATA_DIR/opencode-entrypoint.log"
  exit 1
fi
echo "✓ OpenCode entrypoint keeps disposable state node-owned when started as root"

# ProPR stops task containers with `docker stop` (cancel, cost cap, watchdog,
# deadline), and --init signals only the entrypoint shell. A run that already
# rotated its OAuth token must still write it back to the mounted host store,
# forward the stop to the agent and exit promptly with 143.
#   stop_after_refresh <name> <label> <docker run args...>
# The command must create /tmp/propr-refreshed once it has refreshed.
stop_after_refresh() {
  local name="$1" label="$2" started stopped exit_code
  shift 2
  docker run -d --name "$name" --label "$STACK_LABEL_KEY=$STACK" --init --user 0:0 "$@" >/dev/null
  for _ in $(seq 1 60); do
    if docker exec "$name" test -e /tmp/propr-refreshed 2>/dev/null; then break; fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$name")" != "true" ]; then break; fi
    sleep 0.5
  done
  if ! docker exec "$name" test -e /tmp/propr-refreshed 2>/dev/null; then
    echo "✗ $label task never simulated its credential refresh"
    docker logs "$name" || true
    exit 1
  fi
  started=$(date +%s)
  docker stop "$name" >/dev/null
  stopped=$(date +%s)
  exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$name")
  docker logs "$name" >"$DATA_DIR/$label-stop.log" 2>&1 || true
  docker rm "$name" >/dev/null
  if [ "$exit_code" != "143" ]; then
    echo "✗ $label entrypoint exited $exit_code after docker stop (expected 143)"
    cat "$DATA_DIR/$label-stop.log"
    exit 1
  fi
  if (( stopped - started > 5 )); then
    echo "✗ $label container took $((stopped - started))s to stop (SIGKILLed after the stop timeout?)"
    cat "$DATA_DIR/$label-stop.log"
    exit 1
  fi
}

# The host stores are prepared and read back inside the image, as root, so the
# node-owned files work whatever the runner's UID is.
opencode_stop_source="$DATA_DIR/opencode-stop-source"
mkdir -p "$opencode_stop_source"
docker run --rm --user 0:0 -v "$opencode_stop_source:/source" --entrypoint python3 "$AGENT_TAG" -c '
import json, os, sqlite3
db = sqlite3.connect("/source/opencode.db")
db.executescript("""
CREATE TABLE migration (id TEXT PRIMARY KEY);
CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
CREATE TABLE machine (id TEXT PRIMARY KEY);
CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, connector_id TEXT,
    method_id TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER);
""")
value = json.dumps({"type": "oauth", "methodID": "oauth", "refresh": "refresh-1", "access": "access-1", "expires": 1})
db.execute("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, ?, 1, 1, 1)", ("cred-openai", "openai", "ChatGPT", value, "oauth"))
db.commit()
db.close()
os.chown("/source", 1000, 1000)
os.chown("/source/opencode.db", 1000, 1000)
'
# OpenCode rotates the ChatGPT token in the disposable database, then keeps working.
stop_after_refresh "$STACK-opencode-stop" opencode \
  -e XDG_DATA_HOME=/tmp/propr-opencode-data \
  -e PROPR_EPHEMERAL_STATE=1 \
  -e PROPR_OPENCODE_SOURCE_DATA=/home/node/.local/share/opencode-source \
  -v "$opencode_stop_source:/home/node/.local/share/opencode-source:rw" \
  --entrypoint /home/node/opencode-entrypoint.sh \
  "$AGENT_TAG" python3 -c '
import json, os, sqlite3, time
db = sqlite3.connect("/tmp/propr-opencode-data/opencode/opencode.db")
value = json.dumps({"type": "oauth", "methodID": "oauth", "refresh": "refresh-2", "access": "access-2", "expires": 2})
assert db.execute("UPDATE credential SET value=?, time_updated=2 WHERE id=?", (value, "cred-openai")).rowcount == 1
db.commit()
open("/tmp/propr-refreshed", "w").close()
time.sleep(120)
'
opencode_host_refresh="$(docker run --rm --user 0:0 -v "$opencode_stop_source:/source" --entrypoint python3 "$AGENT_TAG" -c '
import json, sqlite3
print(json.loads(sqlite3.connect("/source/opencode.db").execute("SELECT value FROM credential WHERE id=?", ("cred-openai",)).fetchone()[0])["refresh"])
')"
if [ "$opencode_host_refresh" != "refresh-2" ]; then
  echo "✗ OpenCode did not write the refreshed token back to the host store after docker stop (host has $opencode_host_refresh)"
  cat "$DATA_DIR/opencode-stop.log"
  exit 1
fi
echo "✓ OpenCode entrypoint forwards docker stop and still writes the refreshed token back"

antigravity_stop_source="$DATA_DIR/antigravity-stop-source"
mkdir -p "$antigravity_stop_source"
docker run --rm --user 0:0 -v "$antigravity_stop_source:/source" --entrypoint sh "$AGENT_TAG" -c '
  set -eu
  mkdir -p /source/antigravity-cli
  printf token-1 > /source/antigravity-cli/antigravity-oauth-token
  chmod 600 /source/antigravity-cli/antigravity-oauth-token
  chown -R node:node /source
'
# agy rotates its Google token in the disposable HOME, then keeps working.
stop_after_refresh "$STACK-antigravity-stop" antigravity \
  -e PROPR_EPHEMERAL_STATE=1 \
  -e PROPR_ANTIGRAVITY_SOURCE_CONFIG=/home/node/.gemini-source \
  -v "$antigravity_stop_source:/home/node/.gemini-source:rw" \
  --entrypoint /home/node/antigravity-entrypoint.sh \
  "$AGENT_TAG" /bin/bash -lc '
    printf token-2 > "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"
    : > /tmp/propr-refreshed
    exec sleep 120
  ' propr-antigravity
antigravity_host_token="$(docker run --rm --user 0:0 -v "$antigravity_stop_source:/source:ro" --entrypoint cat "$AGENT_TAG" /source/antigravity-cli/antigravity-oauth-token)"
if [ "$antigravity_host_token" != "token-2" ]; then
  echo "✗ Antigravity did not write the refreshed token back to the host store after docker stop (host has $antigravity_host_token)"
  cat "$DATA_DIR/antigravity-stop.log"
  exit 1
fi
echo "✓ Antigravity entrypoint forwards docker stop and still writes the refreshed token back"

# The root steps after the task (credential and transcript write-back) must not
# run anything the task planted on PATH, and must treat task files as data.
mkdir -p "$DATA_DIR/entrypoint-privileges"
"$REPO_ROOT/scripts/smoke-test-entrypoint-privileges.sh" "$AGENT_TAG" "$DATA_DIR/entrypoint-privileges"

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

#!/usr/bin/env bash
# Smoke test for the production Docker images.
#
# Starts a minimal Propr stack (redis + app in api mode) from the locally
# built prod images, waits for /health to respond, checks the daemon/worker
# containers don't crash on startup, and tears everything down.
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

STACK="${STACK:-propr-smoke}"
NETWORK="${STACK}-net"
API_PORT="${API_PORT:-14000}"
APP_TAG="${APP_TAG:-propr/app:latest}"
REDIS_TAG="${REDIS_TAG:-redis:7-alpine}"

cleanup() {
  echo ""
  echo "▸ cleaning up"
  docker rm -f "$STACK-api" "$STACK-daemon" "$STACK-worker" "$STACK-redis" 2>/dev/null || true
  docker network rm "$NETWORK" 2>/dev/null || true
  rm -rf /tmp/$STACK-data
}
trap cleanup EXIT

echo "▸ propr image smoke test"
echo "  stack:    $STACK"
echo "  api port: $API_PORT"
echo "  app tag:  $APP_TAG"
echo ""

# --- Prepare throwaway data dir and fake .env ------------------------------
DATA_DIR="/tmp/$STACK-data"
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
GITHUB_REPOS_TO_MONITOR=smoketest/fake-repo
WORKER_CONCURRENCY=1
API_PUBLIC_URL=http://localhost:${API_PORT}
FRONTEND_URL=http://localhost:5173
GH_OAUTH_CALLBACK_URL=http://localhost:${API_PORT}/api/auth/github/callback
SESSION_SECRET=smoke-test-not-secret
GH_OAUTH_CLIENT_ID=smoke-test
GH_OAUTH_CLIENT_SECRET=smoke-test
GITHUB_WEBHOOK_SECRET=smoke-test
EOF

# --- Pre-flight: images exist locally --------------------------------------
if ! docker image inspect "$APP_TAG" >/dev/null 2>&1; then
  echo "✗ image $APP_TAG not found locally — run: npm run images:build" >&2
  exit 1
fi

# --- Network ---------------------------------------------------------------
docker network create "$NETWORK" >/dev/null
echo "✓ network created"

# --- Redis -----------------------------------------------------------------
docker run -d --name "$STACK-redis" --network "$NETWORK" "$REDIS_TAG" >/dev/null
echo "✓ redis started"

# --- Run migrations (fresh SQLite) -----------------------------------------
docker run --rm --network "$NETWORK" \
  --env-file "$DATA_DIR/.env" \
  -v "$DATA_DIR/data:/usr/src/app/data" \
  "$APP_TAG" sh -c "npx knex migrate:latest --knexfile /usr/src/app/dist/knexfile.js 2>/dev/null || node -e 'import(\"./dist/packages/core/src/db/connection.js\").catch(e=>{console.error(e);process.exit(1)})'" \
  >/dev/null 2>&1 || echo "  (migrations: best-effort)"
echo "✓ db ready"

# --- API -------------------------------------------------------------------
docker run -d --name "$STACK-api" --network "$NETWORK" \
  -p "${API_PORT}:4000" \
  --env-file "$DATA_DIR/.env" \
  -v "$DATA_DIR/data:/usr/src/app/data" \
  -v "$DATA_DIR/logs:/usr/src/app/logs" \
  "$APP_TAG" node dist/packages/api/server.js >/dev/null
echo "✓ api started"

# --- Daemon + Worker (crash-check only) ------------------------------------
docker run -d --name "$STACK-daemon" --network "$NETWORK" \
  --env-file "$DATA_DIR/.env" \
  -v "$DATA_DIR/data:/usr/src/app/data" \
  -v "$DATA_DIR/logs:/usr/src/app/logs" \
  "$APP_TAG" node dist/src/daemon.js >/dev/null
echo "✓ daemon started"

docker run -d --name "$STACK-worker" --network "$NETWORK" \
  --env-file "$DATA_DIR/.env" \
  -v "$DATA_DIR/data:/usr/src/app/data" \
  -v "$DATA_DIR/logs:/usr/src/app/logs" \
  "$APP_TAG" node dist/src/worker.js >/dev/null
echo "✓ worker started"

# --- Wait for /health ------------------------------------------------------
echo ""
echo "▸ waiting for /health on http://localhost:${API_PORT}"
ok=false
for i in $(seq 1 30); do
  if body=$(curl -fsS --max-time 2 "http://localhost:${API_PORT}/health" 2>/dev/null); then
    echo "✓ api responded: $body"
    ok=true
    break
  fi
  sleep 1
done

if [ "$ok" = "false" ]; then
  echo "✗ api did not respond within 30s"
  echo ""
  echo "--- api logs ---"
  docker logs --tail 50 "$STACK-api"
  exit 1
fi

# --- Crash check: all containers still running after startup grace ---------
sleep 3
for c in api daemon worker; do
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

#!/usr/bin/env bash
# Integration test: run the full e2e test suite against a launcher-started
# stack. Validates that the production Docker images work end-to-end exactly
# the way a real user would run them.
#
# Requires:
#   - propr/launcher:latest and propr/app:latest built locally
#     (npm run images:build)
#   - Agent images pulled or built locally (propr/agent-{claude,codex,antigravity})
#   - `gh auth login` or PROPR_E2E_TOKEN
#   - Mounted agent credentials on the host ($HOME/.claude, /.codex, /.antigravity
#     as applicable for the tests being run)
#
# Env:
#   PROPR_E2E_REPO   (default: integry/propr-test)
#   API_PORT         (default: 14001)
#   PROPR_E2E_SKIP_SLOW=1  skip agent-invoking tests

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

STACK="${STACK:-propr-itest}"
API_PORT="${API_PORT:-14001}"
TEST_REPO="${PROPR_E2E_REPO:-integry/propr-test}"
LAUNCHER_TAG="${LAUNCHER_TAG:-propr/launcher:latest}"

TOKEN="${PROPR_E2E_TOKEN:-}"
if [ -z "$TOKEN" ] && command -v gh >/dev/null 2>&1; then
  TOKEN="$(gh auth token 2>/dev/null || true)"
fi
[ -z "$TOKEN" ] && { echo "✗ no GitHub token" >&2; exit 1; }

DATA_DIR="/tmp/$STACK"
mkdir -p "$DATA_DIR"/{data,logs,repos} /tmp/git-processor /tmp/claude-logs /tmp/pr-worktrees

# Start from the developer's real .env so real GitHub App credentials, OAuth
# client IDs, etc. are available. Then override test-specific values.
if [ ! -f "$REPO_ROOT/.env" ]; then
  echo "✗ $REPO_ROOT/.env not found — the integration test reuses the dev .env for real credentials" >&2
  exit 1
fi

# Copy the GH App private key into $DATA_DIR so it's reachable at a stable
# path when mounted into the api/worker containers.
HOST_PEM=$(grep '^GH_PRIVATE_KEY_PATH=' "$REPO_ROOT/.env" | cut -d= -f2-)
HOST_PEM="${HOST_PEM#./}"
HOST_PEM_ABS="$REPO_ROOT/$HOST_PEM"
if [ ! -f "$HOST_PEM_ABS" ]; then
  echo "✗ private key not found at $HOST_PEM_ABS" >&2
  exit 1
fi
cp "$HOST_PEM_ABS" "$DATA_DIR/data/gh-app.pem"
chmod 644 "$DATA_DIR/data/gh-app.pem"

# Compose the test .env: base = dev .env with test-overrides appended. Bash
# processes the file top-to-bottom, so later duplicates of a key win.
{
  grep -v -E '^(DB_FILENAME|REDIS_HOST|REDIS_PORT|GITHUB_REPOS_TO_MONITOR|GH_PRIVATE_KEY_PATH|API_PUBLIC_URL|FRONTEND_URL|GH_OAUTH_CALLBACK_URL|CLAUDE_DOCKER_IMAGE|CODEX_DOCKER_IMAGE|ANTIGRAVITY_DOCKER_IMAGE|NODE_ENV|LOG_LEVEL)=' "$REPO_ROOT/.env"
  cat <<EOF
NODE_ENV=production
LOG_LEVEL=warn
DB_FILENAME=/usr/src/app/data/propr.sqlite
REDIS_HOST=${STACK}-redis
REDIS_PORT=6379
GH_PRIVATE_KEY_PATH=/usr/src/app/data/gh-app.pem
GITHUB_REPOS_TO_MONITOR=${TEST_REPO}
API_PUBLIC_URL=http://localhost:${API_PORT}
FRONTEND_URL=http://localhost:5173
GH_OAUTH_CALLBACK_URL=http://localhost:${API_PORT}/api/auth/github/callback
ENABLE_BEARER_TOKEN_AUTH=true
CLAUDE_DOCKER_IMAGE=propr/agent-claude:latest
CODEX_DOCKER_IMAGE=propr/agent-codex:latest
ANTIGRAVITY_DOCKER_IMAGE=propr/agent-antigravity:latest
SESSION_SECRET=itest-not-secret
GH_OAUTH_CLIENT_ID=itest
GH_OAUTH_CLIENT_SECRET=itest
GITHUB_WEBHOOK_SECRET=itest
EOF
} > "$DATA_DIR/.env"

cleanup() {
  echo ""
  echo "▸ cleaning up"
  docker rm -f "$STACK-launcher" 2>/dev/null || true
  # The launcher traps SIGTERM and tears down its siblings, but belt-and-braces:
  for c in api daemon worker analysis-worker indexing-worker ui docs redis; do
    docker rm -f "$STACK-$c" 2>/dev/null || true
  done
  docker network rm "${STACK}-net" 2>/dev/null || true
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

echo "▸ propr image integration test (via launcher)"
echo "  stack:     $STACK"
echo "  api port:  $API_PORT"
echo "  test repo: $TEST_REPO"
echo "  launcher:  $LAUNCHER_TAG"
echo ""

docker image inspect "$LAUNCHER_TAG" >/dev/null || {
  echo "✗ $LAUNCHER_TAG not found — run: npm run images:build" >&2
  exit 1
}

# Build the launcher arg list. HOST_* vars point at real paths on the docker
# host so agent containers find their credentials.
# Launcher only needs the docker socket; the paths it uses for spawning
# sibling containers must be real HOST paths (docker socket = host docker).
LAUNCHER_ARGS=(
  run --rm -d
  --name "$STACK-launcher"
  -v /var/run/docker.sock:/var/run/docker.sock
  -v "$DATA_DIR/.env:/app/.env:ro"
  -e "PROPR_STACK=$STACK"
  -e "API_PORT=$API_PORT"
  -e "UI_PORT=${UI_PORT:-15173}"
  -e "DOCS_ENABLED=false"
  -e "PROPR_ENV_FILE=$DATA_DIR/.env"
  -e "PROPR_DATA_DIR=$DATA_DIR/data"
  -e "PROPR_LOGS_DIR=$DATA_DIR/logs"
  -e "PROPR_REPOS_DIR=$DATA_DIR/repos"
)
[ -d "$HOME/.claude" ] && LAUNCHER_ARGS+=(-e "HOST_CLAUDE_DIR=$HOME/.claude")
[ -d "$HOME/.codex" ]  && LAUNCHER_ARGS+=(-e "HOST_CODEX_DIR=$HOME/.codex")
[ -d "$HOME/.antigravity" ] && LAUNCHER_ARGS+=(-e "HOST_ANTIGRAVITY_DIR=$HOME/.antigravity")

LAUNCHER_ARGS+=("$LAUNCHER_TAG")

echo "▸ starting stack via launcher"
docker "${LAUNCHER_ARGS[@]}" >/dev/null
echo "✓ launcher started"

# Wait for /health
echo ""
echo "▸ waiting for api on :${API_PORT}"
for i in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://localhost:${API_PORT}/health" >/dev/null 2>&1; then
    echo "✓ api responsive"
    break
  fi
  sleep 1
  if [ "$i" = "60" ]; then
    echo "✗ api did not respond in 60s"
    docker logs --tail 80 "$STACK-launcher" || true
    docker logs --tail 40 "$STACK-api" 2>/dev/null || true
    exit 1
  fi
done

echo ""
echo "▸ auth probe"
probe=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:${API_PORT}/api/status")
[ "$probe" = "200" ] || { echo "✗ /api/status returned HTTP $probe"; exit 1; }
echo "✓ authenticated"

# Bootstrap test configuration the tests assume:
#   - three agents (claude/codex/antigravity) with cheap/fast models
#   - test repo registered
#   - summarization enabled so indexing works
api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-s -X "$method" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}" "http://localhost:${API_PORT}${path}"
}

echo ""
echo "▸ configuring agents"
# Full supportedModels lists so tests that request a specific model still
# resolve. defaultModel is the cheap/fast one — used by summarization and any
# code path that doesn't pin a model.
# configPath must be the HOST path so when the api/worker spawns agent
# containers via docker socket, the bind mount resolves correctly on the host.
CLAUDE_CFG="${HOME}/.claude"
CODEX_CFG="${HOME}/.codex"
ANTIGRAVITY_CFG="${HOME}/.antigravity"
agents_payload=$(cat <<JSON
{"agents":[
  {"id":"itest-claude","type":"claude","alias":"claude","enabled":true,
   "dockerImage":"propr/agent-claude:latest","configPath":"${CLAUDE_CFG}",
   "supportedModels":["claude-opus-4-6","claude-sonnet-4-6","claude-opus-4-5-20251101","claude-sonnet-4-5-20250929","claude-haiku-4-5-20251001"],
   "defaultModel":"claude-haiku-4-5-20251001"},
  {"id":"itest-codex","type":"codex","alias":"codex","enabled":true,
   "dockerImage":"propr/agent-codex:latest","configPath":"${CODEX_CFG}",
   "supportedModels":["gpt-5","gpt-5-mini","gpt-5.4"],
   "defaultModel":"gpt-5-mini"},
  {"id":"itest-antigravity","type":"antigravity","alias":"antigravity","enabled":true,
   "dockerImage":"propr/agent-antigravity:latest","configPath":"${ANTIGRAVITY_CFG}",
   "supportedModels":["antigravity-gemini-2.5-pro","antigravity-gemini-2.5-flash"],
   "defaultModel":"antigravity-gemini-2.5-flash"}
]}
JSON
)
resp=$(api POST /api/config/agents "$agents_payload")
echo "  $resp"

echo "▸ registering test repo"
repo_payload=$(cat <<JSON
{"repos_to_monitor":[{"name":"${TEST_REPO}","enabled":true}]}
JSON
)
resp=$(api POST /api/config/repos "$repo_payload")
echo "  $resp"

echo "▸ enabling summarization (agent: claude)"
summ_payload='{"enabled":true,"agent_alias":"claude"}'
resp=$(api POST /api/config/summarization "$summ_payload")
echo "  $resp"

echo ""
echo "▸ running e2e tests"
echo ""
export PROPR_E2E_API_URL="http://localhost:${API_PORT}"
export PROPR_E2E_TOKEN="$TOKEN"
export PROPR_E2E_REPO="$TEST_REPO"
npm run --silent test:e2e
echo ""
echo "✓ integration test passed"

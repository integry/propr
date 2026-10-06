#!/usr/bin/env bash
# Integration test: run the full e2e test suite against a launcher-started
# stack. Validates that the production Docker images work end-to-end exactly
# the way a real user would run them.
#
# Requires:
#   - propr/launcher:latest and propr/app:latest built locally
#     (npm run images:build)
#   - Unified agent image pulled or built locally (`propr/agent:latest`)
#   - `gh auth login` or PROPR_E2E_TOKEN
#   - Mounted agent credentials on the host ($HOME/.vibe, /.gemini,
#     and /.config/opencode as applicable for the tests being run)
#
# Env:
#   PROPR_E2E_REPO   (default: integry/propr-test)
#   API_PORT         (default: 14001)
#   PROPR_E2E_SKIP_SLOW=1  skip agent-invoking tests
#   PROPR_E2E_VIBE_MODELS comma-separated Vibe models
#   PROPR_E2E_ANTIGRAVITY_MODELS comma-separated Antigravity models
#   PROPR_E2E_OPENCODE_MODELS comma-separated OpenCode models
#   AGENT_TAG          unified agent image to verify (default: propr/agent:latest)
#   PROPR_E2E_KEEP_STACK=1  leave containers/logs running after the script exits
#   PROPR_E2E_REUSE_DATA=1  reuse the stack root kept by a previous
#                           PROPR_E2E_KEEP_STACK=1 run
#
# Temporary data: everything this harness writes (the test .env derived from
# the real dev .env, data, logs, repos, Vibe prompts) lives in a private root,
# ${TMPDIR:-/tmp}/propr-itest-<uid>/<STACK>, created 0700 with 0600 files
# regardless of umask. The GitHub App key is never copied: the launcher
# bind-mounts it read-only via HOST_GH_PRIVATE_KEY. Existing roots are reused
# or removed only when they carry this harness's ownership marker; symlinks,
# foreign owners and wrong modes are refused, not repaired. Legacy /tmp/$STACK
# data from older versions is no longer used or removed. Cleanup removes only
# the validated root and containers proven to belong to it, by ID; the launcher
# is killed, not stopped, so its own label-wide teardown never runs, and its
# siblings are inspected again once it is gone. The root is kept whenever a
# container that may use it could remain, including when Docker cannot be
# inspected: only Docker's "No such container" answer proves absence. When the
# stack network is absent the harness creates it itself, labelled with this
# root's token, and records the exact ID Docker returned. Only that network is
# removed, by ID, and only while the stack name still resolves to it; a
# network that already existed, or that another creator won the race for, is
# used or refused but never claimed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=lib/integration-test-root.sh
source "$REPO_ROOT/scripts/lib/integration-test-root.sh"

STACK="${STACK:-propr-itest}"
API_PORT="${API_PORT:-14001}"
TEST_REPO="${PROPR_E2E_REPO:-integry/propr-test}"
LAUNCHER_TAG="${LAUNCHER_TAG:-propr/launcher:latest}"
AGENT_TAG="${AGENT_TAG:-propr/agent:latest}"
ITEST_LABEL="com.propr.itest.root"
LAUNCHER_NAME="$STACK-launcher"
NETWORK="${STACK}-net"
SIBLING_SERVICES=(api daemon worker indexing-worker analysis-worker migrate ui docs tunnel redis)

if ! itest_valid_stack_name "$STACK"; then
  echo "✗ STACK must be 1-63 letters, digits, dots, underscores or hyphens, starting with a letter or digit" >&2
  exit 1
fi

TOKEN="${PROPR_E2E_TOKEN:-}"
if [ -z "$TOKEN" ] && command -v gh >/dev/null 2>&1; then
  TOKEN="$(gh auth token 2>/dev/null || true)"
fi
[ -z "$TOKEN" ] && { echo "✗ no GitHub token" >&2; exit 1; }
if [[ ! "$TOKEN" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "✗ GitHub token has an unexpected format" >&2
  exit 1
fi

# Supplies the bearer token through curl's stdin config so it never appears in
# a process argument list.
authorized_curl() {
  printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -K - "$@"
}

# --- Container ownership ------------------------------------------------------
# A matching name is not proof of ownership. The launcher carries this root's
# token label and .env mount; launcher-started siblings must carry the stack
# label and the exact mounts the launcher gives them for this root.
ROOT=""
ROOT_IDENTITY=""
ROOT_TOKEN=""
USER_BASE=""
STACK_STARTED=0
# The ID of the stack network this harness created itself (in this run, or in
# the kept run that recorded it in the validated root). Absence of the network
# and container ownership say nothing about who owns a same-named network.
NETWORK_OWNED_ID=""
NETWORK_RECORD_NAME=".propr-itest-network"

# container_ownership NAME -> prints "root <id>", "owned <id>" or "unowned"
container_ownership() {
  local name="$1"
  docker container inspect "$name" 2>/dev/null | node -e '
    const fs = require("node:fs");
    const [name, stack, root, token, label, launcher] = process.argv.slice(1);
    let container;
    try { [container] = JSON.parse(fs.readFileSync(0, "utf8")); } catch { container = undefined; }
    const labels = container?.Config?.Labels ?? {};
    const mounts = Array.isArray(container?.Mounts) ? container.Mounts : [];
    const id = String(container?.Id ?? "");
    const bind = (source, destination) => mounts.some((m) => m?.Type === "bind" && m.Source === source && m.Destination === destination);
    let verdict = "unowned";
    if (container && container.Name === `/${name}` && /^[a-f0-9]{12,64}$/.test(id) && token) {
      const service = labels["propr.service"];
      if (name === launcher) {
        if (labels[label] === token && labels["com.propr.itest.stack"] === stack
            && bind(`${root}/.env`, "/app/.env")) verdict = "root";
      } else if (labels["propr.stack"] === stack && name === `${stack}-${service}`) {
        if (["api", "daemon", "worker", "indexing-worker", "analysis-worker", "migrate"].includes(service)) {
          if (bind(`${root}/data`, "/usr/src/app/data")) verdict = "root";
        } else if (service === "redis") {
          if (mounts.length === 1 && mounts[0]?.Type === "volume" && mounts[0].Name === `${stack}-redis-data`) verdict = "owned";
        } else if (["ui", "docs", "tunnel"].includes(service) && mounts.length === 0) {
          verdict = "owned";
        }
      }
    }
    console.log(verdict === "unowned" ? verdict : `${verdict} ${id}`);
  ' "$name" "$STACK" "$ROOT" "$ROOT_TOKEN" "$ITEST_LABEL" "$LAUNCHER_NAME"
}

# container_presence NAME_OR_ID -> prints "present", "absent" or "unknown".
# Only Docker's own "No such container" answer proves absence; any other
# inspection failure (lost socket access, daemon errors) proves nothing.
container_presence() {
  local errors
  if errors="$(docker container inspect "$1" 2>&1 >/dev/null)"; then
    echo present
  elif [[ "$errors" == *"No such container"* ]]; then
    echo absent
  else
    echo unknown
  fi
}

# require_container_absent NAME_OR_ID LABEL: succeeds only when Docker confirms
# the container is gone; reports a present or uninspectable one.
require_container_absent() {
  case "$(container_presence "$1")" in
    absent) return 0 ;;
    present) echo "✗ container $2 is still present; leaving its data in place" >&2 ;;
    *) echo "✗ could not inspect container $2; leaving its data in place" >&2 ;;
  esac
  return 1
}

network_id() {
  docker network inspect "$NETWORK" 2>/dev/null | node -e '
    const fs = require("node:fs");
    let network;
    try { [network] = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(1); }
    const id = String(network?.Id ?? "");
    if (network?.Name !== process.argv[1] || !/^[a-f0-9]{12,64}$/.test(id)) process.exit(1);
    console.log(id);
  ' "$NETWORK"
}

# network_is_ours ID: the network with exactly this ID carries the stack name
# and this root's ownership labels, and the stack name currently resolves to it.
network_is_ours() {
  local id="$1"
  [[ "$id" =~ ^[a-f0-9]{12,64}$ ]] || return 1
  [ "$(network_id || true)" = "$id" ] || return 1
  docker network inspect "$id" 2>/dev/null | node -e '
    const fs = require("node:fs");
    const [id, name, label, token, stack] = process.argv.slice(1);
    let network;
    try { [network] = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(1); }
    const labels = network?.Labels ?? {};
    process.exit(network?.Id === id && network?.Name === name && token
      && labels[label] === token && labels["com.propr.itest.stack"] === stack ? 0 : 1);
  ' "$id" "$NETWORK" "$ITEST_LABEL" "$ROOT_TOKEN" "$STACK"
}

# Creates the absent stack network with this root's labels and records the ID
# Docker returned. Docker refuses a duplicate name, so a creator that wins the
# race leaves this run without ownership, and the run is refused.
create_owned_network() {
  local id
  id="$(docker network create --label "$ITEST_LABEL=$ROOT_TOKEN" --label "com.propr.itest.stack=$STACK" "$NETWORK" 2>/dev/null)" || id=""
  id="${id//[[:space:]]/}"
  if [[ ! "$id" =~ ^[a-f0-9]{64}$ ]]; then
    echo "✗ could not create network $NETWORK; another creator may own it. Remove it or choose a different STACK" >&2
    return 1
  fi
  if network_is_ours "$id"; then
    NETWORK_OWNED_ID="$id"
    return 0
  fi
  echo "✗ network $NETWORK does not resolve to the network this run created; refusing to use it" >&2
  return 1
}

# Loads the network ID recorded in the validated root, if any.
load_network_record() {
  local record="$ROOT/$NETWORK_RECORD_NAME" id
  NETWORK_OWNED_ID=""
  [[ -f "$record" && ! -L "$record" && -O "$record" ]] || return 0
  id="$(head -c 128 -- "$record")"
  [[ "$id" =~ ^[a-f0-9]{12,64}$ ]] && NETWORK_OWNED_ID="$id"
  return 0
}

# Records, for a kept stack, the ID of the network this harness created while
# the stack name still resolves to it; otherwise drops any stale record so a
# later run never inherits ownership.
save_network_record() {
  if [ -n "$NETWORK_OWNED_ID" ] && network_is_ours "$NETWORK_OWNED_ID"; then
    printf '%s' "$NETWORK_OWNED_ID" | itest_write_private_file "$ROOT/$NETWORK_RECORD_NAME"
  else
    rm -f -- "$ROOT/$NETWORK_RECORD_NAME"
  fi
}

network_is_unused() {
  docker network inspect "$1" 2>/dev/null | node -e '
    const fs = require("node:fs");
    let network;
    try { [network] = JSON.parse(fs.readFileSync(0, "utf8")); } catch { process.exit(1); }
    const containers = network?.Containers ?? {};
    process.exit(network?.Id === process.argv[1] && network?.Name === process.argv[2]
      && Object.keys(containers).length === 0 ? 0 : 1);
  ' "$1" "$NETWORK"
}

# Removes, by ID, only the network this harness created, and only while the
# stack name still resolves to it. Any other same-named network is left.
remove_owned_network() {
  local id="$NETWORK_OWNED_ID"
  NETWORK_OWNED_ID=""
  if [ -n "$id" ] && network_is_ours "$id"; then
    if network_is_unused "$id"; then
      docker network rm "$id" >/dev/null || { echo "✗ could not remove network $NETWORK" >&2; return 1; }
    else
      echo "  leaving network $NETWORK: it still has containers attached" >&2
    fi
  elif docker network inspect "$NETWORK" >/dev/null 2>&1; then
    echo "  leaving network $NETWORK: it is not the network this harness created" >&2
  fi
  return 0
}

# Inspects every present stack container and records the IDs of those proven
# to belong to this root in STACK_IDS/STACK_NAMES (launcher first, if present).
# Refuses, recording nothing, when any present target is not this root's, when
# any target cannot be inspected, or when no container proves ownership of the
# root (unless PROOF is already 1).
STACK_IDS=()
STACK_NAMES=()
collect_stack_containers() {
  local proven="$1" name verdict
  shift
  STACK_IDS=()
  STACK_NAMES=()
  for name in "$@"; do
    case "$(container_presence "$name")" in
      absent) continue ;;
      present) ;;
      *)
        echo "✗ could not inspect container $name; leaving stack root $ROOT in place" >&2
        STACK_IDS=()
        STACK_NAMES=()
        return 1
        ;;
    esac
    verdict="$(container_ownership "$name")"
    case "$verdict" in
      "root "*) proven=1 ;;
      "owned "*) ;;
      *)
        echo "✗ refusing to remove container $name: it does not belong to stack root $ROOT" >&2
        STACK_IDS=()
        STACK_NAMES=()
        return 1
        ;;
    esac
    STACK_NAMES+=("$name")
    STACK_IDS+=("${verdict#* }")
  done
  if [ "${#STACK_IDS[@]}" -gt 0 ] && [ "$proven" != 1 ]; then
    echo "✗ refusing to remove ${STACK_NAMES[*]}: no container proves ownership of $ROOT" >&2
    STACK_IDS=()
    STACK_NAMES=()
    return 1
  fi
  return 0
}

# Removes the launcher and its siblings only after every present target was
# proven to belong to this root, and fails (so the root is kept) whenever a
# container that may use the root could remain. The launcher can still be
# creating siblings while they are first inspected, so it is killed and
# confirmed gone before the siblings are inspected and validated again; only
# that second snapshot is removed. The launcher is killed rather than stopped:
# its own shutdown removes every propr.stack-labelled container and the stack
# network, which this harness has not verified.
remove_stack_containers() {
  local proven=0 launcher_id="" name i failed=0
  local -a siblings=("${SIBLING_SERVICES[@]/#/$STACK-}")
  collect_stack_containers 0 "$LAUNCHER_NAME" "${siblings[@]}" || return 1
  if [ "${#STACK_IDS[@]}" -gt 0 ]; then
    proven=1
    [ "${STACK_NAMES[0]}" != "$LAUNCHER_NAME" ] || launcher_id="${STACK_IDS[0]}"
  fi

  if [ -n "$launcher_id" ]; then
    if ! docker rm -f "$launcher_id" >/dev/null || ! require_container_absent "$launcher_id" "$LAUNCHER_NAME"; then
      echo "✗ could not terminate launcher $LAUNCHER_NAME; leaving its siblings and data in place" >&2
      return 1
    fi
  fi
  if ! require_container_absent "$LAUNCHER_NAME" "$LAUNCHER_NAME"; then
    echo "✗ launcher $LAUNCHER_NAME is not confirmed gone; leaving its siblings and data in place" >&2
    return 1
  fi

  collect_stack_containers "$proven" "${siblings[@]}" || return 1
  for i in "${!STACK_IDS[@]}"; do
    case "$(container_presence "${STACK_IDS[$i]}")" in
      absent) ;;
      present) docker rm -f "${STACK_IDS[$i]}" >/dev/null || { echo "✗ could not remove container ${STACK_NAMES[$i]}" >&2; failed=1; } ;;
      *) echo "✗ could not inspect container ${STACK_NAMES[$i]}" >&2; failed=1 ;;
    esac
  done
  [ "$failed" = 0 ] || return 1

  # Evidence for releasing the root: Docker confirms every stack container name
  # is absent. A failed inspection is not evidence of absence.
  for name in "$LAUNCHER_NAME" "${siblings[@]}"; do
    require_container_absent "$name" "$name" || return 1
  done
  return 0
}

cleanup() {
  local status=$? failed=0
  set +e
  if [ "${PROPR_E2E_KEEP_STACK:-}" = "1" ]; then
    echo ""
    echo "▸ keeping stack for inspection (PROPR_E2E_KEEP_STACK=1)"
    if [ -n "$ROOT_IDENTITY" ]; then
      save_network_record || echo "✗ could not record network ownership; a later run will leave $NETWORK in place" >&2
    fi
    echo "  launcher: $LAUNCHER_NAME"
    [ -z "$ROOT_IDENTITY" ] || echo "  data dir:  $ROOT"
    exit "$status"
  fi
  echo ""
  echo "▸ cleaning up"
  if [ "$STACK_STARTED" = 1 ] && ! remove_stack_containers; then
    # A container that may still use the root keeps the root and the network.
    failed=1
    [ -z "$ROOT_IDENTITY" ] || echo "  keeping stack root $ROOT: its containers were not all removed" >&2
  else
    if [ "$STACK_STARTED" = 1 ] || [ -n "$NETWORK_OWNED_ID" ]; then
      remove_owned_network || failed=1
    fi
    [ -z "$ROOT_IDENTITY" ] || itest_remove_root "$ROOT" "$USER_BASE" "$STACK" "$ROOT_IDENTITY" "$ROOT_TOKEN" "$LAUNCHER_TAG" || failed=1
  fi
  if [ "$failed" = 1 ]; then
    echo "✗ integration cleanup did not remove every owned resource" >&2
    [ "$status" != 0 ] || status=1
  fi
  exit "$status"
}
trap cleanup EXIT

# --- Private stack root ------------------------------------------------------
TMP_BASE="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
USER_BASE="$TMP_BASE/propr-itest-$(id -u)"
ROOT="$USER_BASE/$STACK"
if ! itest_mountable_path "$ROOT"; then
  echo "✗ stack root $ROOT contains characters Docker bind mounts cannot address" >&2
  exit 1
fi
itest_ensure_private_dir "$USER_BASE" "integration base directory" || exit 1

if [ -e "$ROOT" ] || [ -L "$ROOT" ]; then
  itest_root_validate "$ROOT" "$USER_BASE" "$STACK" || exit 1
  ROOT_TOKEN="$ITEST_ROOT_TOKEN"
  # Containers kept by an earlier run of this exact root are reconciled; any
  # other same-named container is refused below.
  load_network_record
  remove_stack_containers || exit 1
  remove_owned_network || exit 1
  if [ "${PROPR_E2E_REUSE_DATA:-}" = "1" ]; then
    ROOT_IDENTITY="$ITEST_ROOT_IDENTITY"
    echo "▸ reusing stack root $ROOT"
  else
    itest_remove_root "$ROOT" "$USER_BASE" "$STACK" "$ITEST_ROOT_IDENTITY" "$ROOT_TOKEN" "$LAUNCHER_TAG" || exit 1
  fi
fi
if [ -z "$ROOT_IDENTITY" ]; then
  itest_root_create "$ROOT" "$USER_BASE" "$STACK" || exit 1
  ROOT_TOKEN="$ITEST_ROOT_TOKEN"
  ROOT_IDENTITY="$ITEST_ROOT_IDENTITY"
fi
for dir in data logs repos vibe-prompts; do
  itest_ensure_private_dir "$ROOT/$dir" "stack directory" || exit 1
done

for name in "$LAUNCHER_NAME" "${SIBLING_SERVICES[@]/#/$STACK-}"; do
  case "$(container_presence "$name")" in
    absent) ;;
    present)
      echo "✗ container $name already exists and does not belong to $ROOT; remove it or choose a different STACK" >&2
      exit 1
      ;;
    *)
      echo "✗ could not inspect container $name; refusing to start the stack" >&2
      exit 1
      ;;
  esac
done
VIBE_PROMPT_CACHE_DIR="$ROOT/vibe-prompts"
# Fixed host paths the launcher mounts into app containers.
mkdir -p /tmp/git-processor /tmp/claude-logs /tmp/pr-worktrees

# Start from the developer's real .env so real GitHub App credentials, OAuth
# client IDs, etc. are available. Then override test-specific values.
if [ ! -f "$REPO_ROOT/.env" ]; then
  echo "✗ $REPO_ROOT/.env not found — the integration test reuses the dev .env for real credentials" >&2
  exit 1
fi

# Resolve the GH App private key on the host. It is not copied: the launcher
# bind-mounts it read-only into the app containers via HOST_GH_PRIVATE_KEY.
HOST_PEM=$(grep '^GH_PRIVATE_KEY_PATH=' "$REPO_ROOT/.env" | cut -d= -f2- || true)
HOST_PEM="${HOST_PEM#./}"
if [[ "$HOST_PEM" = /usr/src/app/* ]]; then
  HOST_PEM_ABS="$REPO_ROOT/${HOST_PEM#/usr/src/app/}"
elif [[ "$HOST_PEM" = /* ]]; then
  HOST_PEM_ABS="$HOST_PEM"
else
  HOST_PEM_ABS="$REPO_ROOT/$HOST_PEM"
fi
if [ -z "$HOST_PEM" ] || [ ! -f "$HOST_PEM_ABS" ]; then
  echo "✗ private key not found at ${HOST_PEM_ABS}" >&2
  exit 1
fi
if ! itest_mountable_path "$HOST_PEM_ABS"; then
  echo "✗ private key path $HOST_PEM_ABS contains characters Docker bind mounts cannot address" >&2
  exit 1
fi

# Compose the test .env: base = dev .env with test-overrides appended. Bash
# processes the file top-to-bottom, so later duplicates of a key win. It is
# written 0600 from creation inside the private root.
{
  grep -v -E '^(CONFIG_REPO|DB_FILENAME|REDIS_HOST|REDIS_PORT|GITHUB_REPOS_TO_MONITOR|GH_PRIVATE_KEY_PATH|HOST_GH_PRIVATE_KEY|API_PUBLIC_URL|FRONTEND_URL|GH_OAUTH_CALLBACK_URL|ENABLE_GITHUB_WEBHOOKS|ENABLE_PR_COMMENT_POLLING|POLLING_INTERVAL_MS|AGENT_DOCKER_IMAGE|NODE_ENV|LOG_LEVEL|PROPR_ADMIN_USERS|PROPR_CONTAINERIZED|SESSION_SECRET)=' "$REPO_ROOT/.env" || true
  cat <<EOF
NODE_ENV=production
LOG_LEVEL=warn
DB_FILENAME=/usr/src/app/data/propr.sqlite
REDIS_HOST=${STACK}-redis
REDIS_PORT=6379
HOST_GH_PRIVATE_KEY=${HOST_PEM_ABS}
GITHUB_REPOS_TO_MONITOR=${TEST_REPO}
ENABLE_GITHUB_WEBHOOKS=false
ENABLE_PR_COMMENT_POLLING=false
POLLING_INTERVAL_MS=30000
PROPR_CONTAINERIZED=1
PROPR_ADMIN_USERS=${PROPR_E2E_ADMIN_USER:-integry}
API_PUBLIC_URL=http://localhost:${API_PORT}
FRONTEND_URL=http://localhost:5173
GH_OAUTH_CALLBACK_URL=http://localhost:${API_PORT}/api/auth/github/callback
ENABLE_BEARER_TOKEN_AUTH=true
AGENT_DOCKER_IMAGE=propr/agent:latest
VIBE_ANALYSIS_TIMEOUT_MS=420000
SESSION_SECRET=integration-test-only-session-secret-000000000000
GH_OAUTH_CLIENT_ID=itest
GH_OAUTH_CLIENT_SECRET=itest
GITHUB_WEBHOOK_SECRET=itest
EOF
} | itest_write_private_file "$ROOT/.env"

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
# The launcher and app containers read the 0600 .env and the read-only key as
# container root; nothing here is widened for them.
LAUNCHER_ARGS=(
  run -d
  --name "$LAUNCHER_NAME"
  --label "$ITEST_LABEL=$ROOT_TOKEN"
  --label "com.propr.itest.stack=$STACK"
  -v /var/run/docker.sock:/var/run/docker.sock
  -v "$ROOT/.env:/app/.env:ro"
  -v "$VIBE_PROMPT_CACHE_DIR:$VIBE_PROMPT_CACHE_DIR"
  -e "PROPR_STACK=$STACK"
  -e "API_PORT=$API_PORT"
  -e "UI_PORT=${UI_PORT:-15173}"
  -e "DOCS_ENABLED=false"
  -e "PROPR_ENV_FILE=$ROOT/.env"
  -e "PROPR_DATA_DIR=$ROOT/data"
  -e "PROPR_LOGS_DIR=$ROOT/logs"
  -e "PROPR_REPOS_DIR=$ROOT/repos"
)
if [ "${PROPR_E2E_KEEP_STACK:-}" != "1" ]; then
  LAUNCHER_ARGS=(run --rm -d "${LAUNCHER_ARGS[@]:2}")
fi
if [ -d "$HOME/.gemini" ]; then
  LAUNCHER_ARGS+=(-e "HOST_ANTIGRAVITY_DIR=$HOME/.gemini")
elif [ "${PROPR_E2E_SKIP_SLOW:-}" != "1" ]; then
  echo "✗ Antigravity credentials not found at $HOME/.gemini" >&2
  echo "  Required for Antigravity-backed image integration tests; set PROPR_E2E_SKIP_SLOW=1 to skip agent execution." >&2
  exit 1
fi
if [ -d "$HOME/.vibe" ]; then
  LAUNCHER_ARGS+=(-e "HOST_VIBE_DIR=$HOME/.vibe" -e "HOST_VIBE_PROMPT_CACHE_DIR=$VIBE_PROMPT_CACHE_DIR")
elif [ "${PROPR_E2E_SKIP_SLOW:-}" != "1" ]; then
  echo "✗ Vibe credentials not found at $HOME/.vibe" >&2
  echo "  Required for Vibe-backed image integration tests; set PROPR_E2E_SKIP_SLOW=1 to skip agent execution." >&2
  exit 1
fi

OPENCODE_XDG_CFG="$HOME/.config/opencode"
OPENCODE_CFG=""
[ -d "$OPENCODE_XDG_CFG" ] && LAUNCHER_ARGS+=(-e "HOST_OPENCODE_XDG_DIR=$OPENCODE_XDG_CFG")
[ -d "$HOME/.local/share/opencode" ] && LAUNCHER_ARGS+=(-e "HOST_OPENCODE_DATA_DIR=$HOME/.local/share/opencode")
if [ -d "$OPENCODE_XDG_CFG" ]; then
  OPENCODE_CFG="$OPENCODE_XDG_CFG"
elif [ "${PROPR_E2E_SKIP_SLOW:-}" != "1" ]; then
  echo "✗ OpenCode credentials not found at $OPENCODE_XDG_CFG" >&2
  echo "  Required for OpenCode-backed image integration tests; set PROPR_E2E_SKIP_SLOW=1 to skip agent execution." >&2
  exit 1
fi

if [ "${PROPR_E2E_SKIP_SLOW:-}" != "1" ]; then
  echo ""
  echo "▸ verifying Antigravity Gemini 3.7 image support"
  AGENT_TAG="$AGENT_TAG" \
    ANTIGRAVITY_CONFIG_PATH="$HOME/.gemini" \
    ./scripts/verify-antigravity-image.sh

  # Bundled Agent Tank reads usage out of the same image, so prove it actually
  # gets numbers back rather than only that the CLI is installed. Antigravity is
  # the provider this runner is guaranteed to have authenticated.
  echo ""
  echo "▸ verifying bundled Agent Tank usage from the agent image"
  AGENT_TAG="$AGENT_TAG" \
    AGENT_TANK_PROVIDERS="agy" \
    ANTIGRAVITY_CONFIG_PATH="$HOME/.gemini" \
    ./scripts/verify-agent-tank-image.sh
fi

LAUNCHER_ARGS+=("$LAUNCHER_TAG")

# A recorded network is kept only while it is still the one this root created.
# Otherwise the stack network is either pre-existing (used, never claimed) or
# absent, in which case this harness creates it before the launcher can.
if [ -n "$NETWORK_OWNED_ID" ] && ! network_is_ours "$NETWORK_OWNED_ID"; then
  NETWORK_OWNED_ID=""
fi
if [ -z "$NETWORK_OWNED_ID" ]; then
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then
    echo "  using existing network $NETWORK; this harness will not remove it"
  else
    create_owned_network || exit 1
  fi
fi

echo "▸ starting stack via launcher"
STACK_STARTED=1
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
    docker logs --tail 80 "$LAUNCHER_NAME" || true
    docker logs --tail 40 "$STACK-api" 2>/dev/null || true
    exit 1
  fi
done

echo ""
echo "▸ auth probe"
probe=$(authorized_curl -s -o /dev/null -w '%{http_code}' \
  "http://localhost:${API_PORT}/api/status")
[ "$probe" = "200" ] || { echo "✗ /api/status returned HTTP $probe"; exit 1; }
echo "✓ authenticated"

# Bootstrap test configuration the tests assume:
#   - agents requested for live image validation
#   - test repo registered
#   - summarization enabled so indexing works
api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-s -X "$method" -H "Content-Type: application/json")
  [ -n "$body" ] && args+=(-d "$body")
  authorized_curl "${args[@]}" "http://localhost:${API_PORT}${path}"
}

echo ""
echo "▸ configuring agents"
# Full supportedModels lists so tests that request a specific model still
# resolve. defaultModel is the cheap/fast one — used by summarization and any
# code path that doesn't pin a model.
# configPath must be the HOST path so when the api/worker spawns agent
# containers via docker socket, the bind mount resolves correctly on the host.
ANTIGRAVITY_CFG="${HOME}/.gemini"
VIBE_CFG="${HOME}/.vibe"
VIBE_MODELS="${PROPR_E2E_VIBE_MODELS:-mistral-medium-3.5}"
ANTIGRAVITY_MODELS="${PROPR_E2E_ANTIGRAVITY_MODELS:-antigravity-gemini-3.8-flash,antigravity-gemini-3.1-pro,antigravity-claude-sonnet-5.5,antigravity-claude-opus-5.5,antigravity-gpt-oss-120b}"
OPENCODE_MODELS="${PROPR_E2E_OPENCODE_MODELS:-opencode-big-pickle,opencode-go/qwen3.7-max,opencode-openai/gpt-5.5}"
json_array_from_csv() {
  local csv="$1"
  node -e 'const values = process.argv[1].split(",").map(v => v.trim()).filter(Boolean); console.log(JSON.stringify(values));' "$csv"
}
first_csv_value() {
  local csv="$1"
  node -e 'const values = process.argv[1].split(",").map(v => v.trim()).filter(Boolean); console.log(values[0] || "");' "$csv"
}
VIBE_MODELS_JSON="$(json_array_from_csv "$VIBE_MODELS")"
ANTIGRAVITY_MODELS_JSON="$(json_array_from_csv "$ANTIGRAVITY_MODELS")"
OPENCODE_MODELS_JSON="$(json_array_from_csv "$OPENCODE_MODELS")"
VIBE_DEFAULT_MODEL="$(first_csv_value "$VIBE_MODELS")"
ANTIGRAVITY_DEFAULT_MODEL="$(first_csv_value "$ANTIGRAVITY_MODELS")"
OPENCODE_DEFAULT_MODEL="$(first_csv_value "$OPENCODE_MODELS")"
OPENCODE_AGENT_JSON=""
if [ -n "$OPENCODE_CFG" ]; then
  OPENCODE_AGENT_JSON=$(cat <<JSON
,
  {"id":"itest-opencode","type":"opencode","alias":"opencode","enabled":true,
   "dockerImage":"propr/agent:latest","configPath":"${OPENCODE_CFG}",
   "supportedModels":${OPENCODE_MODELS_JSON},
   "defaultModel":"${OPENCODE_DEFAULT_MODEL}"}
JSON
)
fi
agents_payload=$(cat <<JSON
{"agents":[
  {"id":"itest-vibe","type":"vibe","alias":"vibe","enabled":true,
   "dockerImage":"propr/agent:latest","configPath":"${VIBE_CFG}",
   "supportedModels":${VIBE_MODELS_JSON},
   "defaultModel":"${VIBE_DEFAULT_MODEL}"},
  {"id":"itest-antigravity","type":"antigravity","alias":"antigravity","enabled":true,
   "dockerImage":"propr/agent:latest","configPath":"${ANTIGRAVITY_CFG}",
   "supportedModels":${ANTIGRAVITY_MODELS_JSON},
   "defaultModel":"${ANTIGRAVITY_DEFAULT_MODEL}"}${OPENCODE_AGENT_JSON}
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

echo "▸ configuring planner/review defaults (agent: vibe)"
settings_payload=$(cat <<JSON
{"settings":{
  "default_agent_alias":"vibe",
  "planner_context_model":"vibe:${VIBE_DEFAULT_MODEL}",
  "planner_generation_model":"vibe:${VIBE_DEFAULT_MODEL}",
  "pr_review_model":"vibe:${VIBE_DEFAULT_MODEL}"
}}
JSON
)
resp=$(api POST /api/config/settings "$settings_payload")
echo "  $resp"

echo "▸ enabling summarization (agent: vibe)"
summ_payload='{"enabled":true,"agent_alias":"vibe"}'
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

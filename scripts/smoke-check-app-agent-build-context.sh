#!/usr/bin/env bash
# Agent build-context check for a built app image, shared by
# scripts/smoke-test-images.sh and scripts/smoke-test-preview-runtime-images.sh.
#
# The worker prepares custom agent bundles by running the app image's own
# docker CLI against the mounted Docker socket:
#   docker build -f /usr/src/app/Dockerfile.agent ... /usr/src/app
# so /usr/src/app must hold every local COPY/ADD source Dockerfile.agent names.
# This check reads the Dockerfile.agent shipped in the image, then:
#   1. confirms each build-context source exists in the image and is
#      byte-identical to this checkout (the image was built from it);
#   2. runs that worker-style `docker build` from inside the app image with a
#      FROM-scratch Dockerfile that performs exactly Dockerfile.agent's local
#      COPY steps against /usr/src/app, so Docker itself resolves every input
#      without pulling a base image or downloading agent CLIs.
# AGENT_BUILD_CONTEXT_FULL_BUILD=1 additionally builds the real Dockerfile.agent
# from that context (network access and several GB of disk required); the
# throwaway image is removed afterwards. No credentials are mounted.
#
# Usage: smoke-check-app-agent-build-context.sh <app-image>

set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo 'usage: smoke-check-app-agent-build-context.sh <app-image>' >&2
  exit 2
fi
APP_IMAGE="$1"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_CONTEXT=/usr/src/app

# The app image talks to the same engine as this script, exactly as the worker
# does through its mounted socket. Rootless CI publishes the socket via
# DOCKER_HOST; otherwise use the default system socket.
DOCKER_SOCKET=/var/run/docker.sock
if [[ "${DOCKER_HOST:-}" == unix://* ]]; then
  DOCKER_SOCKET="${DOCKER_HOST#unix://}"
elif [[ -n "${DOCKER_HOST:-}" ]]; then
  echo "DOCKER_HOST=$DOCKER_HOST is not a Unix socket; the worker-style build needs one to mount" >&2
  exit 1
fi
[[ -S "$DOCKER_SOCKET" ]] || {
  echo "Docker socket $DOCKER_SOCKET not found" >&2
  exit 1
}

WORK_DIR="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/propr-agent-build-context.XXXXXX")"
CHECK_TAG="propr-agent-build-context-check:$$-$RANDOM"
cleanup() {
  docker image rm -f "$CHECK_TAG" >/dev/null 2>&1 || true
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

docker run --rm --network none --entrypoint cat "$APP_IMAGE" "$APP_CONTEXT/Dockerfile.agent" \
  > "$WORK_DIR/Dockerfile.agent"
if ! cmp -s "$WORK_DIR/Dockerfile.agent" "$REPO_ROOT/Dockerfile.agent"; then
  echo "$APP_IMAGE ships a Dockerfile.agent that differs from this checkout" >&2
  exit 1
fi

mapfile -t SOURCES < <(node "$REPO_ROOT/scripts/lib/agent-build-context.mjs" sources "$WORK_DIR/Dockerfile.agent")
if [[ "${#SOURCES[@]}" -eq 0 ]]; then
  echo 'Dockerfile.agent names no build-context sources; refusing a vacuous check' >&2
  exit 1
fi

# 1. Presence and provenance of every source inside the image.
missing="$(docker run --rm --network none --workdir "$APP_CONTEXT" --entrypoint sh "$APP_IMAGE" \
  -c 'for file do [ -f "$file" ] || echo "$file"; done' sh "${SOURCES[@]}")"
if [[ -n "$missing" ]]; then
  echo "$APP_IMAGE is missing Dockerfile.agent build-context files under $APP_CONTEXT:" >&2
  printf '  %s\n' "$missing" >&2
  exit 1
fi
docker run --rm --network none --workdir "$APP_CONTEXT" --entrypoint sha256sum "$APP_IMAGE" \
  -- "${SOURCES[@]}" > "$WORK_DIR/image.sha256"
(cd "$REPO_ROOT" && sha256sum -- "${SOURCES[@]}") > "$WORK_DIR/source.sha256"
if ! diff -u "$WORK_DIR/source.sha256" "$WORK_DIR/image.sha256" >&2; then
  echo "$APP_IMAGE Dockerfile.agent build-context files differ from this checkout" >&2
  exit 1
fi
echo "✓ $APP_IMAGE ships all ${#SOURCES[@]} Dockerfile.agent build-context files, identical to the checkout"

# 2. Worker-style build: the image's docker CLI, context /usr/src/app.
node "$REPO_ROOT/scripts/lib/agent-build-context.mjs" copy-check-dockerfile "$WORK_DIR/Dockerfile.agent" \
  > "$WORK_DIR/Dockerfile.copy-check"
docker run --rm -i --network none \
  -v "$DOCKER_SOCKET:/var/run/docker.sock" -e DOCKER_HOST=unix:///var/run/docker.sock \
  --entrypoint docker "$APP_IMAGE" \
  build -q -f - -t "$CHECK_TAG" "$APP_CONTEXT" < "$WORK_DIR/Dockerfile.copy-check" >/dev/null
docker image rm -f "$CHECK_TAG" >/dev/null
echo "✓ docker build from $APP_IMAGE:$APP_CONTEXT resolves every Dockerfile.agent build-context COPY"

if [[ "${AGENT_BUILD_CONTEXT_FULL_BUILD:-0}" == 1 ]]; then
  # The same command the worker runs, without version overrides: the
  # Dockerfile.agent ARG defaults are the shipped default CLI versions.
  docker run --rm \
    -v "$DOCKER_SOCKET:/var/run/docker.sock" -e DOCKER_HOST=unix:///var/run/docker.sock \
    --entrypoint docker "$APP_IMAGE" \
    build -f "$APP_CONTEXT/Dockerfile.agent" -t "$CHECK_TAG" "$APP_CONTEXT"
  docker image rm -f "$CHECK_TAG" >/dev/null
  echo "✓ full Dockerfile.agent build from $APP_IMAGE:$APP_CONTEXT succeeded"
fi

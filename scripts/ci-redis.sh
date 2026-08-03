#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:-}"
IMAGE="${CI_REDIS_IMAGE:-redis:7-alpine}"
RUN_KEY="${GITHUB_RUN_ID:-local}-${GITHUB_JOB:-job}"
SAFE_RUN_KEY="$(printf '%s' "$RUN_KEY" | tr -c 'A-Za-z0-9_.-' '-')"
CONTAINER_NAME="propr-ci-redis-${SAFE_RUN_KEY}"
STATE_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
STATE_FILE="${STATE_DIR}/${CONTAINER_NAME}.name"

write_github_env() {
  local key="$1"
  local value="$2"

  if [[ -n "${GITHUB_ENV:-}" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_ENV"
  else
    printf '%s=%s\n' "$key" "$value"
  fi
}

stop_redis() {
  local name="$CONTAINER_NAME"

  if [[ -f "$STATE_FILE" ]]; then
    name="$(<"$STATE_FILE")"
  fi

  case "$name" in
    propr-ci-redis-*) ;;
    *)
      echo "Refusing to remove unexpected container name: $name" >&2
      return 1
      ;;
  esac

  if docker inspect "$name" >/dev/null 2>&1; then
    docker rm --force "$name" >/dev/null
    echo "Stopped Redis container $name"
  fi

  rm -f "$STATE_FILE"
}

start_redis() {
  mkdir -p "$STATE_DIR"

  # The attempt-independent name lets a rerun remove a container left by a
  # cancelled attempt without touching another run or job's Redis instance.
  stop_redis

  docker run \
    --detach \
    --rm \
    --name "$CONTAINER_NAME" \
    --label propr.ci.redis=true \
    --publish 127.0.0.1::6379 \
    --health-cmd 'redis-cli ping' \
    --health-interval 2s \
    --health-timeout 2s \
    --health-retries 15 \
    "$IMAGE" >/dev/null

  printf '%s\n' "$CONTAINER_NAME" > "$STATE_FILE"

  local ready=false
  for _ in $(seq 1 30); do
    if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || true)" == "healthy" ]]; then
      ready=true
      break
    fi
    sleep 1
  done

  if [[ "$ready" != "true" ]]; then
    docker logs "$CONTAINER_NAME" >&2 || true
    stop_redis
    echo "Redis did not become healthy within 30 seconds" >&2
    return 1
  fi

  local mapping
  local port
  mapping="$(docker port "$CONTAINER_NAME" 6379/tcp)"
  port="${mapping##*:}"
  if [[ ! "$port" =~ ^[0-9]+$ ]]; then
    stop_redis
    echo "Could not determine the dynamically assigned Redis port from: $mapping" >&2
    return 1
  fi

  write_github_env REDIS_HOST 127.0.0.1
  write_github_env REDIS_PORT "$port"
  write_github_env REDIS_CONTAINER_NAME "$CONTAINER_NAME"
  write_github_env PROPR_TEST_REDIS_ISOLATION flush
  echo "Redis is healthy on 127.0.0.1:${port} ($CONTAINER_NAME)"
}

case "$ACTION" in
  start) start_redis ;;
  stop) stop_redis ;;
  *)
    echo "Usage: $0 start|stop" >&2
    exit 2
    ;;
esac

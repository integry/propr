#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:-}"
IMAGE="${CI_REDIS_IMAGE:-redis:7-alpine@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2}"
RUN_ID="${GITHUB_RUN_ID:-local}"
JOB_ID="${GITHUB_JOB:-job}"
RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}"
# Matrix entries share GITHUB_RUN_ID and GITHUB_JOB and may run concurrently
# on one host (one per self-hosted runner worker), so each must name its own
# instance. Unset keeps the single-Redis-per-job behaviour of existing callers.
INSTANCE="${CI_REDIS_INSTANCE:-}"
# The Docker daemon runs containers outside the runner service's cgroup, so
# the runner's CPU and memory quotas do not cover this container. These
# explicit limits bound it instead; test data sets are small.
MEMORY_LIMIT="${CI_REDIS_MEMORY:-512m}"
CPU_LIMIT="${CI_REDIS_CPUS:-1}"
PIDS_LIMIT="${CI_REDIS_PIDS_LIMIT:-64}"
# remove_container returns this instead of 1 when ownership is fully verified
# but the daemon still refuses to remove the container. Distinct from 1 so an
# ownership violation and a stuck container never collapse into one outcome.
UNREMOVABLE_STATUS=3

if [[ -n "$INSTANCE" && ! "$INSTANCE" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$ ]]; then
  # Rejected rather than sanitized: rewriting characters could map two
  # instances to one container name.
  echo "CI_REDIS_INSTANCE must match [A-Za-z0-9][A-Za-z0-9_.-]{0,62}, got: $INSTANCE" >&2
  exit 2
fi
if [[ ! "$MEMORY_LIMIT" =~ ^[1-9][0-9]*[kmg]$ || ! "$CPU_LIMIT" =~ ^[0-9]+(\.[0-9]+)?$ || ! "$PIDS_LIMIT" =~ ^[1-9][0-9]*$ ]]; then
  echo "CI_REDIS_MEMORY, CI_REDIS_CPUS and CI_REDIS_PIDS_LIMIT must be a Docker size (e.g. 512m), CPU count and positive integer" >&2
  exit 2
fi
if [[ ! "$RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]; then
  echo "GITHUB_RUN_ATTEMPT must be a positive integer, got: $RUN_ATTEMPT" >&2
  exit 2
fi

# NUL separates fields unambiguously (environment variables cannot contain it).
# Hash the raw values, including the empty instance and the attempt; never
# concatenate/sanitize components, which aliases shard/default and shard-default.
OWNER_HASH="$(printf '%s\0' "$RUN_ID" "$JOB_ID" "$INSTANCE" "$RUN_ATTEMPT" | sha256sum)"
CONTAINER_NAME="propr-ci-redis-${OWNER_HASH%% *}"
STATE_DIR="${CI_REDIS_STATE_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"
STATE_FILE="${STATE_DIR}/${CONTAINER_NAME}.name"
# Owner labels identify exactly this run, job and instance. Label values are
# compared verbatim before every removal, independently of the container name.
LABEL_RUN="propr.ci.redis.run=${RUN_ID}"
LABEL_JOB="propr.ci.redis.job=${JOB_ID}"
# A colon cannot occur in a valid instance name, so the omitted instance
# cannot share ownership with any explicit name (including "default").
LABEL_INSTANCE="propr.ci.redis.instance=${INSTANCE:-:omitted}"

write_env() {
  local key="$1"
  local value="$2"

  # CI_REDIS_ENV_FILE lets one job start several instances without their
  # connection settings overwriting each other in the shared GITHUB_ENV.
  if [[ -n "${CI_REDIS_ENV_FILE:-}" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$CI_REDIS_ENV_FILE"
  elif [[ -n "${GITHUB_ENV:-}" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_ENV"
  else
    printf '%s=%s\n' "$key" "$value"
  fi
}

remove_container() {
  local name="$1" mode="${2:-current}" id key expected actual attempt

  case "$name" in
    propr-ci-redis-*) ;;
    *)
      echo "Refusing to remove unexpected container name: $name" >&2
      return 1
      ;;
  esac

  # Resolve once and remove by immutable ID, so a replacement under the same
  # name cannot be deleted between the ownership check and docker rm.
  id="$(docker inspect --format '{{.Id}}' "$name" 2>/dev/null)" || return 0
  for key in propr.ci.redis propr.ci.redis.run propr.ci.redis.job propr.ci.redis.instance; do
    case "$key" in
      propr.ci.redis) expected=true ;;
      propr.ci.redis.run) expected="$RUN_ID" ;;
      propr.ci.redis.job) expected="$JOB_ID" ;;
      propr.ci.redis.instance) expected="${INSTANCE:-:omitted}" ;;
    esac
    actual="$(docker inspect --format "{{ index .Config.Labels \"$key\" }}" "$id")" || return 1
    if [[ "$actual" != "$expected" ]]; then
      echo "Refusing to remove $name: ownership label $key does not match" >&2
      return 1
    fi
  done
  attempt="$(docker inspect --format '{{ index .Config.Labels "propr.ci.redis.attempt" }}' "$id")" || return 1
  if [[ ! "$attempt" =~ ^[1-9][0-9]*$ ]]; then
    echo "Refusing to remove $name: missing or invalid attempt label" >&2
    return 1
  fi
  if [[ "$mode" == previous ]]; then
    # Never let a delayed cleanup from an earlier attempt delete a newer one.
    (( attempt < RUN_ATTEMPT )) || return 0
  elif [[ "$attempt" != "$RUN_ATTEMPT" ]]; then
    echo "Refusing to remove $name: attempt label does not match" >&2
    return 1
  fi
  docker rm --force "$id" >/dev/null || return "$UNREMOVABLE_STATUS"
  echo "Stopped Redis container $name"
}

stop_redis() {
  local name="$CONTAINER_NAME" status=0

  if [[ -f "$STATE_FILE" ]]; then
    name="$(<"$STATE_FILE")"
  fi
  if [[ "$name" != "$CONTAINER_NAME" ]]; then
    echo "Refusing to remove $name: this caller owns $CONTAINER_NAME" >&2
    return 1
  fi

  remove_container "$name" || status=$?
  # The state file keeps recording the container while it still exists, so a
  # later teardown of the same owner retries the removal instead of skipping it.
  (( status == 0 )) || return "$status"
  rm -f "$STATE_FILE"
}

# The workflows' teardown step. It runs after the tests have already decided the
# job's result, so a container the daemon cannot kill -- a zombie PID under a
# rootless daemon, which no step in this job can reap -- is reported for host
# cleanup rather than failing an otherwise green shard. Ownership violations and
# every other stop failure still fail the step.
stop_for_teardown() {
  local status=0

  stop_redis || status=$?
  if (( status == UNREMOVABLE_STATUS )); then
    echo "Docker could not remove $CONTAINER_NAME; leaving it for host cleanup." >&2
    if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
      echo "::warning::Leaked CI Redis container $CONTAINER_NAME: the daemon could not remove it."
    fi
    return 0
  fi
  return "$status"
}

# Recover only older attempts owned by this exact run, job and instance.
# Filters narrow discovery; inspection by immutable ID authorizes removal.
remove_previous_attempts() {
  local name candidates
  candidates="$(docker ps --all --format '{{.Names}}' \
    --filter "label=${LABEL_RUN}" \
    --filter "label=${LABEL_JOB}" \
    --filter "label=${LABEL_INSTANCE}")" || return 1
  while IFS= read -r name; do
    [[ -n "$name" && "$name" != "$CONTAINER_NAME" ]] || continue
    remove_container "$name" previous || return 1
  done <<< "$candidates"
}

start_redis() {
  mkdir -p "$STATE_DIR"

  stop_redis
  remove_previous_attempts

  # Independent rootless daemons can each auto-allocate the same port (32768)
  # inside their namespaces, then collide when RootlessKit binds the host port.
  # Keep automatic allocation first; on a bind conflict, spread explicit high
  # port candidates by owner and retry. A runner-local free-port probe cannot
  # see listeners in the host namespace, so Docker's bind is authoritative.
  local publish_port="" run_error run_status port_attempt

  # `--init` makes tini PID 1 so it reaps the health-check processes the
  # container's PID namespace reparents to PID 1 once their runc parent exits:
  # redis-server does not reap them, and one check every 2s for the length of a
  # shard both fills --pids-limit with zombies and leaves behind a container the
  # daemon cannot kill at teardown.
  for port_attempt in 1 2 3 4 5; do
    if run_error="$(docker run \
      --detach \
      --rm \
      --init \
      --name "$CONTAINER_NAME" \
      --label propr.ci.redis=true \
      --label "$LABEL_RUN" \
      --label "$LABEL_JOB" \
      --label "$LABEL_INSTANCE" \
      --label "propr.ci.redis.attempt=${RUN_ATTEMPT}" \
      --memory "$MEMORY_LIMIT" \
      --memory-swap "$MEMORY_LIMIT" \
      --cpus "$CPU_LIMIT" \
      --pids-limit "$PIDS_LIMIT" \
      --publish "127.0.0.1:${publish_port}:6379" \
      --health-cmd 'redis-cli ping' \
      --health-interval 2s \
      --health-timeout 2s \
      --health-retries 15 \
      "$IMAGE" 2>&1 >/dev/null)"; then
      break
    else
      run_status=$?
    fi
    printf '%s\n' "$run_error" >&2
    # Failed starts can leave a created container even with --rm. Recheck
    # every ownership label and remove by immutable ID before reusing its name.
    remove_container "$CONTAINER_NAME" || return 1
    if [[ "$run_status" != 125 || ( "$run_error" != *'bind: address already in use'* && "$run_error" != *'port is already allocated'* ) ]]; then
      return "$run_status"
    fi
    if (( port_attempt == 5 )); then
      echo 'Redis port allocation failed after 5 attempts' >&2
      return "$run_status"
    fi
    # The odd stride visits different candidates within 49152..65535.
    publish_port=$((49152 + (16#${OWNER_HASH:0:8} + port_attempt * 7919) % 16384))
    echo "Retrying Redis startup with loopback port $publish_port" >&2
  done

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

  write_env REDIS_HOST 127.0.0.1
  write_env REDIS_PORT "$port"
  write_env REDIS_CONTAINER_NAME "$CONTAINER_NAME"
  # Flushing is only enabled for the Redis this script just created.
  write_env PROPR_TEST_REDIS_ISOLATION flush
  echo "Redis is healthy on 127.0.0.1:${port} ($CONTAINER_NAME)"
}

case "$ACTION" in
  start) start_redis ;;
  stop) stop_for_teardown ;;
  name) printf '%s\n' "$CONTAINER_NAME" ;;
  *)
    echo "Usage: $0 start|stop|name" >&2
    exit 2
    ;;
esac

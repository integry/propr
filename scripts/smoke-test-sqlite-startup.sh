#!/usr/bin/env bash
# Release-validation harness for serialized SQLite startup.
#
# Uses the packaged launcher and app images, an isolated host data directory,
# and the real daemon/worker/analysis/indexing/API commands. Nothing here is
# mocked. The bounded retry loops make failures actionable in CI instead of
# leaving a launcher or service running indefinitely.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

APP_TAG="${APP_TAG:-propr/app:latest}"
LAUNCHER_TAG="${LAUNCHER_TAG:-propr/launcher:latest}"
STARTUP_ATTEMPTS="${SQLITE_STARTUP_ATTEMPTS:-3}"
TIMEOUT_SECONDS="${SQLITE_STARTUP_TIMEOUT_SECONDS:-45}"
RUN_ID="sqlite-smoke-${GITHUB_RUN_ID:-local}-$$-$RANDOM"
ROOT_DIR="$(mktemp -d "/tmp/propr-${RUN_ID}.XXXXXX")"
OWNER_FILE="$ROOT_DIR/.propr-sqlite-smoke-owner"
ACTIVE_STACKS=()
DATABASE_SERVICES=(daemon worker analysis-worker indexing-worker api)

if [[ ! "$STARTUP_ATTEMPTS" =~ ^[0-9]+$ ]] || (( STARTUP_ATTEMPTS < 2 || STARTUP_ATTEMPTS > 10 )); then
  echo "SQLITE_STARTUP_ATTEMPTS must be an integer from 2 through 10" >&2
  exit 1
fi
if [[ ! "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || (( TIMEOUT_SECONDS < 10 || TIMEOUT_SECONDS > 180 )); then
  echo "SQLITE_STARTUP_TIMEOUT_SECONDS must be an integer from 10 through 180" >&2
  exit 1
fi

printf '%s\n' "$RUN_ID" > "$OWNER_FILE"

cleanup_stack() {
  local stack="$1" launcher="${1}-launcher"
  local -a ids=()
  if docker container inspect "$launcher" >/dev/null 2>&1; then
    docker stop --time 15 "$launcher" >/dev/null 2>&1 || true
    docker rm -f "$launcher" >/dev/null 2>&1 || true
  fi
  mapfile -t ids < <(docker ps -aq --filter "label=propr.stack=$stack")
  if [ "${#ids[@]}" -gt 0 ]; then
    # Every selected container carries the exact unique stack label generated
    # by this process; no broad name/glob deletion is used.
    docker rm -f "${ids[@]}" >/dev/null 2>&1 || true
  fi
  docker network rm "${stack}-net" >/dev/null 2>&1 || true
}

cleanup() {
  local stack
  for stack in "${ACTIVE_STACKS[@]}"; do
    cleanup_stack "$stack"
  done
  if [[ "$ROOT_DIR" == /tmp/propr-sqlite-smoke-* ]] \
      && [ -f "$OWNER_FILE" ] \
      && [ "$(< "$OWNER_FILE")" = "$RUN_ID" ]; then
    rm -rf -- "$ROOT_DIR"
  else
    echo "refusing to remove unowned SQLite smoke directory $ROOT_DIR" >&2
  fi
}
trap cleanup EXIT

for image in "$APP_TAG" "$LAUNCHER_TAG"; do
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "image $image is not available locally" >&2
    exit 1
  fi
done

baked_app_tag="$(docker run --rm --entrypoint node "$LAUNCHER_TAG" --input-type=module -e \
  'import fs from "node:fs"; process.stdout.write(JSON.parse(fs.readFileSync("/app/manifest.json", "utf8")).images.app)')"
if [ "$baked_app_tag" != "$APP_TAG" ]; then
  echo "launcher $LAUNCHER_TAG selects $baked_app_tag, not requested PR app image $APP_TAG" >&2
  exit 1
fi

free_port() {
  node --input-type=module -e '
    import net from "node:net";
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      process.stdout.write(String(server.address().port));
      server.close();
    });
  '
}

write_env() {
  local cycle_dir="$1" api_port="$2" ui_port="$3"
  mkdir -p "$cycle_dir"/{data,logs,repos}
  openssl genrsa -out "$cycle_dir/data/gh-app.pem" 2048 2>/dev/null
  chmod 644 "$cycle_dir/data/gh-app.pem"
  cat > "$cycle_dir/.env" <<EOF
NODE_ENV=production
LOG_LEVEL=info
DB_FILENAME=/usr/src/app/data/propr.sqlite
REDIS_PORT=6379
GH_APP_ID=0
GH_INSTALLATION_ID=0
GH_PRIVATE_KEY_PATH=/usr/src/app/data/gh-app.pem
GH_AUTH_MODE=app
GITHUB_EVENT_INTAKE_MODE=direct_webhook
GITHUB_REPOS_TO_MONITOR=smoketest/fake-repo
WORKER_CONCURRENCY=1
PROPR_CONTAINERIZED=1
PROPR_ADMIN_USERS=smoketest-admin
PROPR_MIGRATIONS_PREAPPLIED=1
API_PORT=127.0.0.1:${api_port}
UI_PORT=127.0.0.1:${ui_port}
API_PUBLIC_URL=http://127.0.0.1:${api_port}
FRONTEND_URL=http://127.0.0.1:${ui_port}
GH_OAUTH_CALLBACK_URL=http://127.0.0.1:${api_port}/api/auth/github/callback
SESSION_SECRET=sqlite-smoke-only-session-secret-0000000000000000
GH_OAUTH_CLIENT_ID=smoke-test
GH_OAUTH_CLIENT_SECRET=smoke-test
GITHUB_WEBHOOK_SECRET=smoke-test
DOCS_ENABLED=false
EOF
}

start_launcher() {
  local stack="$1" cycle_dir="$2"
  docker run -d --name "${stack}-launcher" \
    --label "com.propr.sqlite-startup-smoke=$RUN_ID" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$cycle_dir/.env:/app/.env:ro" \
    -e "PROPR_STACK=$stack" \
    -e "PROPR_NETWORK=${stack}-net" \
    -e "PROPR_LAUNCHER_ENV_FILE=/app/.env" \
    -e "PROPR_ENV_FILE=$cycle_dir/.env" \
    -e "PROPR_DATA_DIR=$cycle_dir/data" \
    -e "PROPR_LOGS_DIR=$cycle_dir/logs" \
    -e "PROPR_REPOS_DIR=$cycle_dir/repos" \
    -e PROPR_SKIP_REMOTE_IMAGE_CHECK=1 \
    -e PROPR_STRICT_AGENT_PULL=false \
    "$LAUNCHER_TAG" >/dev/null
}

wait_for_stack() {
  local stack="$1" api_port="$2" deadline=$((SECONDS + TIMEOUT_SECONDS)) launcher_state
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${api_port}/health" >/dev/null 2>&1; then
      return 0
    fi
    launcher_state="$(docker inspect --format '{{.State.Status}}' "${stack}-launcher" 2>/dev/null || true)"
    if [ "$launcher_state" = "exited" ] || [ "$launcher_state" = "dead" ]; then
      echo "launcher exited before the API became healthy" >&2
      docker logs "${stack}-launcher" >&2 || true
      return 1
    fi
    sleep 1
  done
  echo "stack $stack did not become healthy within ${TIMEOUT_SECONDS}s" >&2
  docker logs "${stack}-launcher" >&2 || true
  return 1
}

assert_packaged_topology() {
  local stack="$1" launcher_logs service state restarts command service_logs deadline all_logs
  local -A commands=(
    [daemon]='["node","dist/src/daemon.js"]'
    [worker]='["node","dist/src/worker.js"]'
    [analysis-worker]='["node","dist/src/analysis_worker.js"]'
    [indexing-worker]='["node","dist/src/indexing_worker.js"]'
    [api]='["node","dist/packages/api/server.js"]'
  )

  launcher_logs="$(docker logs "${stack}-launcher" 2>&1)"
  if [ "$(grep -c 'running database migrations' <<< "$launcher_logs")" -ne 1 ]; then
    echo "expected exactly one migration owner for $stack" >&2
    echo "$launcher_logs" >&2
    return 1
  fi

  for service in "${DATABASE_SERVICES[@]}"; do
    deadline=$((SECONDS + TIMEOUT_SECONDS))
    while (( SECONDS < deadline )); do
      service_logs="$(docker logs "${stack}-${service}" 2>&1 || true)"
      if grep -Fq 'Database migrations were completed by the launcher migration phase' <<< "$service_logs"; then
        break
      fi
      sleep 1
    done
    if ! grep -Fq 'Database migrations were completed by the launcher migration phase' <<< "$service_logs"; then
      echo "$stack-$service never accepted the launcher migration handoff" >&2
      echo "$service_logs" >&2
      return 1
    fi

    state="$(docker inspect --format '{{.State.Status}}' "${stack}-${service}")"
    restarts="$(docker inspect --format '{{.RestartCount}}' "${stack}-${service}")"
    command="$(docker inspect --format '{{json .Config.Cmd}}' "${stack}-${service}")"
    if [ "$state" != "running" ] || [ "$restarts" != "0" ] || [ "$command" != "${commands[$service]}" ]; then
      echo "$stack-$service state=$state restartCount=$restarts command=$command" >&2
      docker logs "${stack}-${service}" >&2 || true
      return 1
    fi
  done

  all_logs="$launcher_logs"
  for service in "${DATABASE_SERVICES[@]}"; do
    all_logs+=$'\n'"$(docker logs "${stack}-${service}" 2>&1 || true)"
  done
  if grep -Eiq 'duplicate column|failed to run database migrations|migration.*error' <<< "$all_logs"; then
    echo "migration error found in $stack logs" >&2
    return 1
  fi
}

run_success_cycle() {
  local stack="$1" cycle_dir="$2" label="$3" api_port ui_port
  api_port="$(free_port)"
  ui_port="$(free_port)"
  write_env "$cycle_dir" "$api_port" "$ui_port"
  ACTIVE_STACKS+=("$stack")
  start_launcher "$stack" "$cycle_dir"
  wait_for_stack "$stack" "$api_port"
  assert_packaged_topology "$stack"
  sleep 3
  assert_packaged_topology "$stack"
  cleanup_stack "$stack"
  echo "passed: $label"
}

echo "SQLite packaged-startup smoke: $STARTUP_ATTEMPTS blank databases"
last_cycle_dir=""
for ((attempt = 1; attempt <= STARTUP_ATTEMPTS; attempt += 1)); do
  last_cycle_dir="$ROOT_DIR/blank-$attempt"
  run_success_cycle "${RUN_ID}-blank-${attempt}" "$last_cycle_dir" "blank startup $attempt/$STARTUP_ATTEMPTS"
done

# Roll the final blank database back by one packaged migration, then reuse it.
# This gives the owner a real existing schema with a pending upgrade rather
# than merely checking that migrate.latest() is idempotent on a current DB.
docker run --rm --env-file "$last_cycle_dir/.env" --entrypoint node \
  -v "$last_cycle_dir/data:/usr/src/app/data" \
  "$APP_TAG" --input-type=module -e '
    import knex from "knex";
    const { default: configs } = await import("./dist/knexfile.js");
    const db = knex(configs.production);
    try {
      await db.migrate.down();
    } finally {
      await db.destroy();
    }
  '
run_success_cycle "${RUN_ID}-upgrade" "$last_cycle_dir" "existing/upgraded database startup"

# Seed valid Knex metadata that names a migration absent from the packaged
# image. Knex rejects this as a corrupt migration directory: a real owner-phase
# failure, not a synthetic launcher exit code.
failure_dir="$ROOT_DIR/failure"
failure_api_port="$(free_port)"
failure_ui_port="$(free_port)"
write_env "$failure_dir" "$failure_api_port" "$failure_ui_port"
docker run --rm --entrypoint node \
  -v "$failure_dir/data:/usr/src/app/data" \
  "$APP_TAG" --input-type=module -e '
    import Database from "better-sqlite3";
    const db = new Database("/usr/src/app/data/propr.sqlite");
    db.exec("CREATE TABLE knex_migrations (id integer primary key autoincrement, name varchar(255), batch integer, migration_time datetime)");
    db.prepare("INSERT INTO knex_migrations (name, batch, migration_time) VALUES (?, 1, CURRENT_TIMESTAMP)").run("19000101000000_missing_release_smoke.js");
    db.close();
  '

failure_stack="${RUN_ID}-failure"
ACTIVE_STACKS+=("$failure_stack")
start_launcher "$failure_stack" "$failure_dir"
deadline=$((SECONDS + TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
  failure_state="$(docker inspect --format '{{.State.Status}}' "${failure_stack}-launcher" 2>/dev/null || true)"
  [ "$failure_state" = "exited" ] && break
  sleep 1
done
if [ "${failure_state:-}" != "exited" ]; then
  echo "migration-failure launcher did not exit within ${TIMEOUT_SECONDS}s" >&2
  exit 1
fi
if [ "$(docker inspect --format '{{.State.ExitCode}}' "${failure_stack}-launcher")" = "0" ]; then
  echo "migration-failure launcher exited successfully" >&2
  exit 1
fi
if ! docker logs "${failure_stack}-launcher" 2>&1 | grep -Fq 'Database migration phase failed'; then
  echo "launcher did not report the genuine migration failure" >&2
  docker logs "${failure_stack}-launcher" >&2 || true
  exit 1
fi
for service in "${DATABASE_SERVICES[@]}"; do
  if docker container inspect "${failure_stack}-${service}" >/dev/null 2>&1; then
    echo "migration failure created database consumer ${failure_stack}-${service}" >&2
    exit 1
  fi
done

echo "passed: genuine migration failure blocked every database consumer"
echo "SQLite packaged-startup smoke passed"

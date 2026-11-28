#!/bin/sh
# Fly dashboard launch (#3827): ProPR and Redis in ONE container, started by
# the committed fly.toml ([processes] app). `propr deploy fly` runs Redis as a
# separate container of the same Machine instead; the flags below are the
# same (FLY_REDIS_PERSISTENCE_FLAGS in packages/cli, pinned by a test). The
# server is Valkey, the BSD-licensed Redis fork Alpine ships (the app image
# installs valkey and valkey-cli); BullMQ and the session store use it as Redis.
#
# Redis starts first and stops last: on SIGTERM (a Fly stop) ProPR drains
# against a live Redis, then Redis saves and exits. ProPR exiting by itself
# (an idle stop exits 0, a failure 1) ends the container with its code, so
# the Machine stops and fly.toml's on-failure policy decides on a restart.
set -u

data_dir="${DATA_DIR:-/usr/src/app/data}"
redis_dir="$data_dir/redis"
redis_port="${REDIS_PORT:-6379}"
mkdir -p "$redis_dir"

valkey-server --bind 127.0.0.1 --port "$redis_port" --dir "$redis_dir" --appendonly yes --save 300 1 --maxmemory-policy noeviction &
redis_pid=$!

tries=0
until valkey-cli -h 127.0.0.1 -p "$redis_port" ping >/dev/null 2>&1; do
  if ! kill -0 "$redis_pid" 2>/dev/null; then
    echo "fly-launch: valkey-server exited during startup" >&2
    exit 1
  fi
  tries=$((tries + 1))
  if [ "$tries" -ge 300 ]; then
    echo "fly-launch: valkey-server did not answer within 30s" >&2
    kill -TERM "$redis_pid" 2>/dev/null
    exit 1
  fi
  sleep 0.1
done

node dist/src/flyLaunch.js &
app_pid=$!
trap 'kill -TERM "$app_pid" 2>/dev/null' TERM INT

# wait returns early when a trapped signal arrives; keep waiting until ProPR has exited.
status=0
while :; do
  wait "$app_pid"
  status=$?
  kill -0 "$app_pid" 2>/dev/null || break
done

valkey-cli -h 127.0.0.1 -p "$redis_port" shutdown >/dev/null 2>&1 || kill -TERM "$redis_pid" 2>/dev/null
wait "$redis_pid" 2>/dev/null
exit "$status"

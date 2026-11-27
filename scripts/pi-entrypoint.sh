#!/bin/bash
# Entrypoint script for Pi coding agent execution containers.
#
# ProPR starts agent containers as root (--user 0:0) and drops to node. Pi gets
# a disposable agent dir (PI_CODING_AGENT_DIR) seeded from the mounted host Pi
# agent dir (PROPR_PI_SOURCE_DIR), so sessions, extensions and package installs
# from a run never reach the host. After the run, OAuth refreshes are written
# back to the host auth.json by pi-credentials.py (per-entry compare-and-swap).
# Diagnostic output goes to stderr to keep `pi --mode json` stdout parseable.

set -euo pipefail

pi_source_dir="${PROPR_PI_SOURCE_DIR:-/home/node/.pi/agent}"
pi_runtime_home="${PROPR_PI_RUNTIME_HOME:-/tmp/propr-pi-home}"
pi_agent_dir="$pi_runtime_home/agent"
pi_seed_snapshot="$pi_runtime_home/propr-seeded-auth.json"
pi_credentials_helper="${PROPR_PI_CREDENTIALS_HELPER:-/opt/propr/pi-credentials.py}"
# Goal runs only: the goal's persisted session store, mounted outside the
# disposable home so its sessions survive the run and are resumed next time.
pi_goal_session_dir="${PROPR_PI_GOAL_SESSION_DIR:-}"
# Only these host files are imported. Host sessions/, extensions/ and mcp.json
# are never copied: sessions and extensions stay on the host, and ProPR
# generates mcp.json itself (PROPR_PI_MCP_CONFIG).
pi_imported_files=(auth.json settings.json models.json AGENTS.md SYSTEM.md APPEND_SYSTEM.md)

case "$pi_runtime_home" in
    /|"") echo "Refusing to use $pi_runtime_home as the disposable Pi home" >&2; exit 64 ;;
esac
# The disposable home is deleted and chowned below, so it must not overlap the
# host Pi dir in either direction: inside it would write into the host dir, and
# containing it (e.g. PROPR_PI_RUNTIME_HOME=/home/node/.pi) would delete it.
# Compare canonical paths so symlinks and `..` cannot hide an overlap.
pi_runtime_home_real="$(realpath -m -- "$pi_runtime_home")"
pi_source_dir_real="$(realpath -m -- "$pi_source_dir")"
if [ "$pi_runtime_home_real" = "/" ]; then
    echo "Refusing to use $pi_runtime_home as the disposable Pi home" >&2
    exit 64
fi
case "$pi_runtime_home_real/" in
    "$pi_source_dir_real/"*)
        echo "The disposable Pi home must not be inside the host Pi dir ($pi_source_dir)" >&2
        exit 64
        ;;
esac
case "$pi_source_dir_real/" in
    "$pi_runtime_home_real/"*)
        echo "The disposable Pi home must not contain the host Pi dir ($pi_source_dir)" >&2
        exit 64
        ;;
esac

if [ -n "$pi_goal_session_dir" ]; then
    # The disposable home is deleted every run: the goal's sessions must not live in it.
    pi_goal_session_dir_real="$(realpath -m -- "$pi_goal_session_dir")"
    case "$pi_goal_session_dir_real/" in
        "$pi_runtime_home_real/"*|"$pi_source_dir_real/"*)
            echo "The Pi goal session dir must be outside the disposable Pi home and the host Pi dir" >&2
            exit 64
            ;;
    esac
    if [ "$pi_goal_session_dir_real" = "/" ]; then
        echo "Refusing to use $pi_goal_session_dir as the Pi goal session dir" >&2
        exit 64
    fi
fi

export PI_CODING_AGENT_DIR="$pi_agent_dir"
export PI_CODING_AGENT_SESSION_DIR="$pi_agent_dir/sessions"
# Pi's own update check, install telemetry and startup catalog fetches go to
# pi.dev, which is not on the agent egress allowlist.
export PI_SKIP_VERSION_CHECK=1
export PI_TELEMETRY=0
export PI_OFFLINE="${PI_OFFLINE:-1}"

is_root() { [ "$(id -u)" = "0" ]; }

# Everything Pi-related runs as node, never as root: a root-owned file in the
# node-owned disposable dir (a log, lock or models-store.json) breaks the run.
run_as_node() {
    if is_root; then
        su-exec node env HOME=/home/node USER=node LOGNAME=node "$@"
    else
        "$@"
    fi
}

# The same, replacing the current (sub)shell, so a backgrounded task's PID is
# the task itself and signals sent to it reach Pi rather than a subshell.
exec_as_node() {
    if is_root; then
        exec su-exec node env HOME=/home/node USER=node LOGNAME=node "$@"
    else
        exec "$@"
    fi
}

# Session files hold the whole goal conversation: owner-only (node), before Pi
# writes and after it exits, whatever modes Pi created them with.
restrict_goal_sessions() {
    [ -n "$pi_goal_session_dir" ] || return 0
    if is_root; then
        chown -R node:node "$pi_goal_session_dir"
    fi
    chmod -R u+rwX,go-rwx "$pi_goal_session_dir"
}

prepare_goal_sessions() {
    [ -n "$pi_goal_session_dir" ] || return 0
    if [ ! -d "$pi_goal_session_dir" ]; then
        echo "Pi goal session dir not mounted at $pi_goal_session_dir" >&2
        exit 64
    fi
    restrict_goal_sessions
    echo "Using persisted Pi goal sessions at $pi_goal_session_dir" >&2
}

prepare_runtime_home() {
    # A fresh dir every run, created owner-only: auth.json holds tokens.
    rm -rf -- "$pi_agent_dir" "$pi_seed_snapshot"
    (umask 077 && mkdir -p "$pi_agent_dir/sessions")

    if [ -d "$pi_source_dir" ]; then
        echo "Pi agent directory mounted at $pi_source_dir" >&2
        for file in "${pi_imported_files[@]}"; do
            if [ -f "$pi_source_dir/$file" ]; then
                (umask 077 && cp -L -- "$pi_source_dir/$file" "$pi_agent_dir/$file") \
                    || echo "Warning: could not import Pi $file" >&2
            fi
        done
    else
        echo "WARNING: Pi agent directory not mounted at $pi_source_dir" >&2
    fi

    if [ -n "${PROPR_PI_MCP_CONFIG:-}" ]; then
        (umask 077 && printf '%s\n' "$PROPR_PI_MCP_CONFIG" > "$pi_agent_dir/mcp.json")
        echo "Configured ProPR-generated Pi MCP servers" >&2
    fi

    if is_root; then
        chown -R node:node "$pi_runtime_home"
    fi
    echo "Using disposable Pi agent directory at $pi_agent_dir" >&2
}

# Managed login (PROPR_PI_LOGIN=1, `pi auth login <provider>` from ProPR's
# login session): Pi writes auth.json straight into the mounted credential dir.
# No disposable copy and no write-back are involved, because a new login is
# not a refresh of a seeded entry and sync would never keep it.
if [ "${PROPR_PI_LOGIN:-}" = "1" ]; then
    if [ ! -d "$pi_source_dir" ]; then
        echo "Pi agent directory not mounted at $pi_source_dir" >&2
        exit 64
    fi
    if is_root; then
        if [ "${PROPR_MANAGED_CREDENTIALS:-}" = "1" ]; then
            # This directory belongs to this ProPR agent, so it is safe to
            # normalize ownership before dropping privileges to node.
            chown -R node:node "$pi_source_dir" 2>/dev/null || true
            chmod -R u+rwX "$pi_source_dir" 2>/dev/null || true
        else
            echo "Skipping Pi agent directory ownership changes to avoid mutating host bind mounts" >&2
        fi
    fi
    if ! run_as_node test -w "$pi_source_dir"; then
        echo "The Pi agent directory at $pi_source_dir is not writable by the node user (UID 1000)" >&2
        exit 73
    fi
    export PI_CODING_AGENT_DIR="$pi_source_dir"
    unset PI_CODING_AGENT_SESSION_DIR
    if [ $# -eq 0 ]; then
        echo "No Pi login command provided" >&2
        exit 64
    fi
    case "$1" in
        -*) set -- pi "$@" ;;
    esac
    # Log the command and subcommand only. API keys are typed at Pi's prompt,
    # never passed as arguments.
    echo "Executing command: $1 ${2:-} ${3:-}" >&2
    cd /home/node/workspace 2>/dev/null || true
    exec_as_node "$@"
fi

prepare_runtime_home
prepare_goal_sessions

if [ -f "$pi_agent_dir/auth.json" ]; then
    # Record what was imported before Pi can rewrite it.
    run_as_node python3 "$pi_credentials_helper" seed "$pi_agent_dir/auth.json" "$pi_seed_snapshot"
    echo "Pi credentials imported" >&2
else
    echo "Warning: no Pi auth.json imported; relying on provider API key environment variables" >&2
fi

if [ -z "${GH_TOKEN:-}" ]; then
    echo "Warning: GH_TOKEN environment variable not set" >&2
else
    echo "GitHub token detected (using environment variable)" >&2
fi

git config --global --add safe.directory '*' 2>/dev/null || echo "Git safe directory config already set" >&2

if [ -x "/usr/local/bin/gh-wrapper" ]; then
    echo "Setting up GitHub CLI wrapper to filter operational comments" >&2
    mkdir -p /home/node/bin
    if [ ! /home/node/bin/gh -ef /usr/local/bin/gh-wrapper ]; then
        ln -sf /usr/local/bin/gh-wrapper /home/node/bin/gh
    fi
    export PATH="/home/node/bin:$PATH"
fi

if [ -d "/home/node/workspace" ] && ! is_root && [ "$(id -u)" != "1000" ]; then
    echo "Warning: Running as UID $(id -u) instead of expected 1000" >&2
fi

if [ $# -eq 0 ]; then
    echo "No command provided, starting interactive shell" >&2
    exec /bin/bash
fi

# Callers may pass only Pi flags after the image.
case "$1" in
    -*) set -- pi "$@" ;;
esac

if pi_version="$(run_as_node pi --version 2>/dev/null)"; then
    echo "Pi CLI version: $pi_version" >&2
fi

# Prompts come from stdin or @file arguments; log only the executable.
echo "Executing command: $1" >&2
if is_root && [ -d /home/node/workspace ]; then
    cd /home/node/workspace
fi
# The task runs as a supervised child rather than in the foreground: tini only
# signals this shell, and a foreground child would neither see `docker stop`
# nor let the credential sync below run. Termination is forwarded to the task,
# the shell waits for it to exit, and then syncs once like a normal exit.
# Without job control bash points a background command's stdin at /dev/null,
# so stdin (the prompt) is passed through explicitly, and ignores SIGINT and
# SIGQUIT in it, so env restores their default handling for the task.
pi_task_pid=""
pi_received_signal=""
forward_signal() {
    pi_received_signal="$1"
    if [ -n "$pi_task_pid" ]; then
        kill -s "$1" "$pi_task_pid" 2>/dev/null || true
    fi
}
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT
trap 'forward_signal HUP' HUP
set +e
exec_as_node env --default-signal=INT,QUIT "$@" 0<&0 &
pi_task_pid=$!
while :; do
    wait "$pi_task_pid"
    command_status=$?
    # A trapped signal interrupts wait with 128+n while the task still runs.
    if [ "$command_status" -le 128 ] || [ -z "$pi_received_signal" ]; then
        break
    fi
    if ! kill -0 "$pi_task_pid" 2>/dev/null; then
        # Already reaped: bash keeps its status for one more wait.
        wait "$pi_task_pid"
        final_status=$?
        if [ "$final_status" -ne 127 ]; then command_status=$final_status; fi
        break
    fi
done
pi_task_pid=""
set -e
# A task that exits cleanly after being told to stop still reports the stop.
if [ -n "$pi_received_signal" ] && [ "$command_status" -eq 0 ]; then
    command_status=$((128 + $(kill -l "$pi_received_signal")))
fi

# Signals arriving during the sync are deferred until it finishes, so the
# write-back completes once before the container exits.
if [ -f "$pi_seed_snapshot" ]; then
    run_as_node python3 "$pi_credentials_helper" sync "$pi_source_dir/auth.json" "$pi_agent_dir/auth.json" "$pi_seed_snapshot" \
        || echo "Warning: could not write refreshed Pi credentials back to the host" >&2
fi

restrict_goal_sessions || echo "Warning: could not restrict Pi goal session permissions" >&2

exit "$command_status"

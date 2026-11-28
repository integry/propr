#!/bin/bash
# Entrypoint script for Pi coding agent execution containers.
#
# ProPR starts agent containers as root (--user 0:0) and drops to node. Pi gets
# a disposable agent dir (PI_CODING_AGENT_DIR) seeded from the mounted host Pi
# agent dir (PROPR_PI_SOURCE_DIR), so sessions, extensions and package installs
# from a run never reach the host. After the run, OAuth refreshes are written
# back to the host auth.json by pi-credentials.py (per-entry compare-and-swap).
# Diagnostic output goes to stderr to keep `pi --mode json` stdout parseable.
#
# Trust boundary: the task runs as node and can rewrite everything node owns,
# including /home/node itself (so /home/node/bin wholesale), the disposable Pi
# home and the workspace. The host Pi dir is mounted under /root (0700 root),
# which node cannot traverse whatever the host dir's own owner and mode. Every
# step after the task returns runs with POST_TASK_PATH, calls binaries by
# absolute path, executes nothing from task-writable locations and reads
# task-writable files only as size-limited, O_NOFOLLOW, validated JSON data.

set -euo pipefail

pi_node_path="${PROPR_PI_NODE_PATH:-$PATH}"
pi_trusted_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if [ "$EUID" = "0" ]; then
    export PATH="$pi_trusted_path"
fi

pi_protected_source=/root/propr-pi-source
if [ "${PROPR_PI_LOGIN:-}" = "1" ]; then
    pi_source_dir="${PROPR_PI_SOURCE_DIR:-/home/node/.pi/agent}"
else
    pi_source_dir="${PROPR_PI_SOURCE_DIR:-$pi_protected_source}"
fi
pi_source_auth="$pi_source_dir/auth.json"
case "$pi_source_auth" in
    /*) ;;
    *) pi_source_auth="$PWD/$pi_source_auth" ;;
esac
pi_runtime_home="${PROPR_PI_RUNTIME_HOME:-/tmp/propr-pi-home}"
# Post-task steps run from /, so every path they use must be absolute.
case "$pi_runtime_home" in
    /*|"") ;;
    *) pi_runtime_home="$PWD/$pi_runtime_home" ;;
esac
pi_agent_dir="$pi_runtime_home/agent"
# The privileged writer always comes from the image; an override (used by the
# unprivileged tests) is honoured only when not running as root.
if [ "$EUID" = "0" ]; then
    pi_credentials_helper=/opt/propr/pi-credentials.py
else
    pi_credentials_helper="${PROPR_PI_CREDENTIALS_HELPER:-/opt/propr/pi-credentials.py}"
fi
# Goal runs only: the goal's persisted session store, mounted outside the
# disposable home so its sessions survive the run and are resumed next time.
pi_goal_session_dir="${PROPR_PI_GOAL_SESSION_DIR:-}"
case "$pi_goal_session_dir" in
    /*|"") ;;
    *) pi_goal_session_dir="$PWD/$pi_goal_session_dir" ;;
esac
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
pi_runtime_home_real="$(/usr/bin/realpath -m -- "$pi_runtime_home")"
pi_source_dir_real="$(/usr/bin/realpath -m -- "$pi_source_dir")"
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
    pi_goal_session_dir_real="$(/usr/bin/realpath -m -- "$pi_goal_session_dir")"
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

is_root() { [ "$EUID" = "0" ]; }

# Pi and readers of its disposable credentials run as node.
run_as_node() {
    if is_root; then
        /usr/local/bin/su-exec node /usr/bin/env HOME=/home/node USER=node LOGNAME=node PATH="$pi_node_path" "$@" 8<&- 9<&-
    else
        PATH="$pi_node_path" "$@" 8<&- 9<&-
    fi
}

# The same, replacing the current (sub)shell, so a backgrounded task's PID is
# the task itself and signals sent to it reach Pi rather than a subshell.
exec_as_node() {
    if is_root; then
        exec /usr/local/bin/su-exec node /usr/bin/env HOME=/home/node USER=node LOGNAME=node PATH="$pi_node_path" "$@" 8<&- 9<&-
    else
        export PATH="$pi_node_path"
        exec "$@" 8<&- 9<&-
    fi
}

# Fixed PATH for everything after the task returns. It never contains the
# task-time PATH (which starts with /home/node/bin) or any node-owned dir.
POST_TASK_PATH=/usr/sbin:/usr/bin:/sbin:/bin
# The write-back runs with an empty environment. Unprivileged test runs may
# shorten its credential-lock wait (never longer than the built-in 30 s).
pi_sync_env=("PATH=$POST_TASK_PATH")
if [ "$EUID" != "0" ] && [ -n "${PROPR_PI_LOCK_WAIT_SECONDS:-}" ]; then
    pi_sync_env+=("PROPR_PI_LOCK_WAIT_SECONDS=$PROPR_PI_LOCK_WAIT_SECONDS")
fi

# Post-task commands that only need node's rights (reading the disposable
# auth.json, restricting goal sessions) drop to node with a clean environment
# and the fixed PATH, so neither the task's PATH nor its environment applies.
run_post_task_as_node() {
    if is_root; then
        /usr/local/bin/su-exec node /usr/bin/env -i HOME=/nonexistent PATH="$POST_TASK_PATH" "$@" 8<&- 9<&-
    else
        /usr/bin/env -i PATH="$POST_TASK_PATH" "$@" 8<&- 9<&-
    fi
}

# Session files hold the whole goal conversation: owner-only (node, 0600),
# before Pi writes and after it exits, whatever modes Pi created them with.
# They are restricted by node, their owner, so root never walks a tree a task
# wrote.
#
# The store directory itself always stays owned by the ProPR worker, whatever
# its UID: the worker lists the saved sessions at the next boundary and deletes
# the store with the goal, and a container stopped with SIGKILL runs no
# epilogue that could hand it back. So nothing ever chowns it. When the worker
# is not node, root pins the directory (fd 8, never passed to a node process)
# and opens it to node for the run through its "other" bits (0707), then
# returns it to 0700 through the pinned descriptor. A run killed before that
# leaves a worker-owned 0707 directory, which preparePiGoalSession chmods back
# to 0700 at the next boundary, before it lists or deletes anything. The other
# bits widen no host access: the per-goal dir sits in the worker's owner-only
# sessions root, and inside the container only node runs besides root.
pi_goal_session_opened=""
restrict_goal_session_files() {
    run_post_task_as_node /usr/bin/find "$pi_goal_session_dir" -mindepth 1 ! -type l -exec /bin/chmod -- u+rwX,go-rwx {} +
}

restrict_goal_sessions_before_task() {
    [ -n "$pi_goal_session_dir" ] || return 0
    local owner node_uid
    if is_root; then
        exec 8<"$pi_goal_session_dir/" || return
        owner="$(/usr/bin/stat -L -c %u -- /proc/self/fd/8)" || return
        node_uid="$(/usr/bin/id -u node)" || return
        if [ "$owner" = "$node_uid" ]; then
            /bin/chmod -- 0700 /proc/self/fd/8 || return
        else
            /bin/chmod -- 0707 /proc/self/fd/8 || return
            pi_goal_session_opened=1
        fi
    else
        /bin/chmod -- 0700 "$pi_goal_session_dir" || return
    fi
    restrict_goal_session_files || echo "Warning: could not restrict every saved Pi goal session file to owner-only" >&2
}

restrict_goal_sessions_after_task() {
    [ -n "$pi_goal_session_dir" ] || return 0
    restrict_goal_session_files
}

prepare_goal_sessions() {
    [ -n "$pi_goal_session_dir" ] || return 0
    if [ ! -d "$pi_goal_session_dir" ]; then
        echo "Pi goal session dir not mounted at $pi_goal_session_dir" >&2
        exit 64
    fi
    restrict_goal_sessions_before_task
    echo "Using persisted Pi goal sessions at $pi_goal_session_dir" >&2
}

# Non-recursive, through the descriptor pinned before the task: only the
# store directory's own mode changes, never anything the task created in it.
close_goal_session_store() {
    [ -n "$pi_goal_session_opened" ] || return 0
    /usr/bin/env -i /bin/chmod -- 0700 /proc/self/fd/8
}

prepare_runtime_home() {
    local file import_status
    # Repository setup may already have run as node. Claim the standard home
    # before copying anything so setup cannot redirect privileged writes.
    if is_root && [ "$pi_runtime_home" = /tmp/propr-pi-home ]; then
        if ! /bin/mkdir -m 0700 -- "$pi_runtime_home"; then
            echo "Could not create a private disposable Pi home at $pi_runtime_home" >&2
            exit 73
        fi
    fi
    # A fresh dir every run, created owner-only: auth.json holds tokens.
    /bin/rm -rf -- "$pi_agent_dir" "$pi_runtime_home/propr-seeded-auth.json"
    (umask 077 && /bin/mkdir -p -- "$pi_agent_dir/sessions")

    if [ -d "$pi_source_dir" ]; then
        echo "Pi agent directory mounted at $pi_source_dir" >&2
        # Pin the source directory (fd 9, never passed to a node process).
        # Every import, like the write-back, opens a plain file name under this
        # descriptor with O_NOFOLLOW through the image's helper, run with the
        # fixed PATH and an empty environment, and copies only regular files:
        # no symlink in the host dir can make root read (or later write)
        # anything outside it, and nothing task-writable is executed.
        if { exec 9<"$pi_source_dir/"; }; then
            for file in "${pi_imported_files[@]}"; do
                import_status=0
                /usr/bin/env -i PATH="$POST_TASK_PATH" /usr/bin/python3 -I -B "$pi_credentials_helper" import "$file" "$pi_agent_dir/$file" \
                    || import_status=$?
                case "$import_status" in
                    0) if [ "$file" = auth.json ]; then pi_host_auth=auth.json; fi ;;
                    2|3) ;;  # missing, or refused with the helper's own warning
                    *) echo "Warning: could not import Pi $file" >&2 ;;
                esac
            done
        else
            echo "Warning: could not open the Pi host agent directory; nothing imported" >&2
        fi
    else
        echo "WARNING: Pi agent directory not mounted at $pi_source_dir" >&2
    fi

    if [ -n "${PROPR_PI_MCP_CONFIG:-}" ]; then
        (umask 077 && printf '%s\n' "$PROPR_PI_MCP_CONFIG" > "$pi_agent_dir/mcp.json")
        echo "Configured ProPR-generated Pi MCP servers" >&2
    fi

    if is_root; then
        /bin/chown -hR -- node:node "$pi_runtime_home"
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
            /bin/chown -hR -- node:node "$pi_source_dir" 2>/dev/null || true
            /bin/chmod -R -- u+rwX "$pi_source_dir" 2>/dev/null || true
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

pi_host_auth=""
prepare_runtime_home
prepare_goal_sessions

pi_seeded_auth=""
if [ -f "$pi_agent_dir/auth.json" ]; then
    # Keep the baseline in this shell, out of the disposable agent's reach.
    if [ -n "$pi_host_auth" ]; then
        pi_seeded_auth="$(run_as_node /usr/bin/python3 -I -B "$pi_credentials_helper" seed "$pi_agent_dir/auth.json" - 9<&-)"
    fi
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
    run_as_node /usr/bin/mkdir -p /home/node/bin 9<&-
    if ! run_as_node /usr/bin/test /home/node/bin/gh -ef /usr/local/bin/gh-wrapper 9<&-; then
        run_as_node /usr/bin/ln -sf /usr/local/bin/gh-wrapper /home/node/bin/gh 9<&-
    fi
    pi_node_path="/home/node/bin:$pi_node_path"
fi

if [ -d "/home/node/workspace" ] && ! is_root && [ "$(id -u)" != "1000" ]; then
    echo "Warning: Running as UID $(id -u) instead of expected 1000" >&2
fi

if [ $# -eq 0 ]; then
    echo "No command provided, starting interactive shell" >&2
    exec_as_node /bin/bash 9<&-
fi

# Callers may pass only Pi flags after the image.
case "$1" in
    -*) set -- pi "$@" ;;
esac

if pi_version="$(run_as_node pi --version 9<&- 2>/dev/null)"; then
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
exec_as_node env --default-signal=INT,QUIT "$@" 0<&0 9<&- &
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

# ---- Post-task privileged steps -------------------------------------------
# The task may have replaced anything node can write, including /home/node/bin
# wholesale. From here on: the fixed PATH, absolute binaries, no task-writable
# working directory, and task-written files are data only.
export PATH="$POST_TASK_PATH"
pi_node_path="$POST_TASK_PATH"
cd /

# Signals arriving during the sync are deferred until it finishes, so the
# write-back completes once before the container exits.
if [ -n "$pi_seeded_auth" ]; then
    # Node reads the disposable auth.json (O_NOFOLLOW, size-limited, JSON) so
    # root never follows a path through the task's directories. The root
    # writer validates both records and writes only into the pinned source dir.
    {
        printf '%s\n' "$pi_seeded_auth"
        run_post_task_as_node /usr/bin/python3 -I -B "$pi_credentials_helper" seed "$pi_agent_dir/auth.json" - 9<&-
    } | /usr/bin/env -i "${pi_sync_env[@]}" /usr/bin/python3 -I -B "$pi_credentials_helper" sync-from-stdin "$pi_source_auth" "${pi_host_auth##*/}" \
        || echo "Warning: could not write refreshed Pi credentials back to the host; the task's exit status is kept" >&2
fi
exec 9<&-

restrict_goal_sessions_after_task || echo "Warning: could not restrict Pi goal session permissions" >&2
close_goal_session_store || echo "Warning: could not return the Pi goal session dir to owner-only; the worker restores it at the next boundary" >&2
exec 8<&-

exit "$command_status"

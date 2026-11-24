#!/bin/bash
# ProPR Sprites launcher: installed root-owned at /opt/propr/launcher.sh by
# sprites-agent-setup.sh and run by the worker through `sudo -n`.
#
#   launcher.sh run                      run the uploaded payload (one per Sprite, from the clean checkpoint)
#   launcher.sh follow <stream> <offset> stream stdout|stderr from a 1-based byte offset until the run ends
#   launcher.sh signal <TERM|KILL>       stop the run
#   launcher.sh status                   print the run's exit and export status
#
# Rules this script keeps:
#   1. It is root only to install the run's files and to start the command the
#      worker rendered (the clone wrapper, which drops the setup hook and the
#      provider entrypoint to the unprivileged `node` user). It installs files
#      BEFORE anything of the run starts, on a Sprite restored to its clean
#      checkpoint, so no path it writes can have been prepared by an agent.
#   2. Once the command has started it never writes to, copies from, chowns or
#      removes a path the agent user controls as root. Refreshed credentials
#      are read by a process running AS the agent user (a planted symlink can
#      only yield what that user may read anyway) into the root-owned export
#      directory, after every process of the agent user is gone.
#   3. It cleans nothing up. The worker restores the Sprite's clean checkpoint
#      after every run; that, not this script, keeps runs apart.
set -u

RUN_DIR=/opt/propr/run
AGENT_USER=node
# One byte over the worker's limit, so an oversize file is seen as oversize and refused there.
EXPORT_READ_BYTES=1048577
LAUNCHER_FAILURE=125

# PIDs of every live process running under <uid> (real, effective, saved or filesystem UID).
agent_pids() {
    local uid="$1" entry pid state candidate
    for entry in /proc/[0-9]*; do
        pid="${entry#/proc/}"
        [ "$pid" != "$$" ] || continue
        state="$(sed -n 's/^State:[[:space:]]*\(.\).*/\1/p' "$entry/status" 2>/dev/null)"
        [ -n "$state" ] && [ "$state" != "Z" ] || continue
        for candidate in $(sed -n 's/^Uid:[[:space:]]*//p' "$entry/status" 2>/dev/null); do
            if [ "$candidate" = "$uid" ]; then echo "$pid"; break; fi
        done
    done
}

# SIGKILLs every process of <uid> until none is left; status 1 when some survive.
kill_agent_processes() {
    local uid="$1" pids
    for _ in $(seq 1 40); do
        pids="$(agent_pids "$uid")"
        [ -n "$pids" ] || return 0
        # shellcheck disable=SC2086 # a list of PIDs
        kill -s KILL -- $pids 2>/dev/null
        sleep 0.25
    done
    [ -z "$(agent_pids "$uid")" ]
}

agent_uid() {
    local uid
    uid="$(id -u "$AGENT_USER" 2>/dev/null)" || return 1
    case "$uid" in ''|0|*[!0-9]*) return 1 ;; esac
    printf '%s\n' "$uid"
}

# Runs a command as the agent user with nothing of the launcher's environment.
as_agent() {
    su-exec "$AGENT_USER" env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent "$@" </dev/null
}

# export_output <index> <live path> <export dir>: copies one refreshable
# credential into the root-owned export directory. The path is read by the
# agent user, never by root: only a plain regular file is taken, at most
# EXPORT_READ_BYTES of it. A missing file exports nothing (a deletion is never
# propagated).
export_output() {
    local index="$1" live="$2" out="$3" mtime
    # shellcheck disable=SC2016 # expanded by the inner shell
    mtime="$(as_agent /bin/sh -c '[ ! -L "$1" ] && [ -f "$1" ] && stat -c %Y -- "$1"' propr-export "$live" 2>/dev/null)" || return 0
    case "$mtime" in ''|*[!0-9]*) return 0 ;; esac
    if as_agent timeout 30 head -c "$EXPORT_READ_BYTES" -- "$live" > "$out/$index" 2>/dev/null; then
        printf '%s\n' "$mtime" > "$out/$index.mtime"
    else
        rm -f -- "$out/$index"
    fi
}

run_launcher() {
    local uid owner status child kind src dst mode i count export_state input
    local -a argv envv manifest outputs
    [ "$(id -u)" = "0" ] || { echo "ProPR Sprites launcher: must run as root through passwordless sudo" >&2; exit "$LAUNCHER_FAILURE"; }
    cd "$RUN_DIR" || exit "$LAUNCHER_FAILURE"
    owner="$(stat -c %u:%g .)" || exit "$LAUNCHER_FAILURE"
    umask 077
    : > stdout.log && : > stderr.log || exit "$LAUNCHER_FAILURE"
    printf '%s\n' "$$" > pid

    finish() {
        printf '%s\n' "$2" > export-status
        chown -R "$owner" out result 2>/dev/null
        printf '%s\n' "$1" > exit-status.tmp && mv -f exit-status.tmp exit-status
        exit "$1"
    }
    fail() {
        echo "ProPR Sprites launcher: $*" >> stderr.log
        finish "$LAUNCHER_FAILURE" none
    }

    uid="$(agent_uid)" || fail "the Sprite has no unprivileged $AGENT_USER user; the ProPR setup script has not run"
    command -v su-exec >/dev/null 2>&1 || fail "su-exec is missing; the ProPR setup script has not run"
    # A run only ever starts on a clean checkpoint. These are invariants of that state, not a cleanup.
    [ -z "$(agent_pids "$uid")" ] || fail "processes of the $AGENT_USER user are already running: the Sprite is not at its clean checkpoint"
    [ ! -e in ] && [ ! -e out ] && [ ! -e result ] || fail "the run directory already holds a run: the Sprite is not at its clean checkpoint"
    [ -f payload.tar ] && [ ! -L payload.tar ] || fail "no run payload was uploaded"

    mkdir in out result || fail "cannot create the run directories"
    tar -xf payload.tar -C in --no-same-owner || fail "cannot unpack the run payload"
    rm -f payload.tar
    mapfile -d '' -t argv < in/argv || fail "cannot read the command"
    mapfile -d '' -t envv < in/env || fail "cannot read the environment"
    mapfile -d '' -t manifest < in/manifest || fail "cannot read the manifest"
    rm -f in/env
    [ "${#argv[@]}" -gt 0 ] || fail "the run has no command"

    # Install the run's files. Nothing of the run has started yet and no process of the agent
    # user exists, so every target is still what the clean checkpoint holds there.
    umask 022
    outputs=()
    i=0
    count=${#manifest[@]}
    while [ "$i" -lt "$count" ]; do
        kind="${manifest[$i]}"
        case "$kind" in
            store)
                # A credential store the CLI refreshes in place: owned by the agent user.
                src="in/${manifest[$((i + 1))]}"; dst="${manifest[$((i + 2))]}"; i=$((i + 3))
                rm -rf -- "$dst" && mkdir -p -- "$(dirname -- "$dst")" && cp -a -- "$src" "$dst" && chown -R "$AGENT_USER:$AGENT_USER" -- "$dst" && chmod 700 -- "$dst" \
                    || fail "cannot install credentials at $dst" ;;
            source)
                # A credential source the entrypoint copies from: the agent user can read it, never change it.
                src="in/${manifest[$((i + 1))]}"; dst="${manifest[$((i + 2))]}"; i=$((i + 3))
                rm -rf -- "$dst" && mkdir -p -- "$(dirname -- "$dst")" && cp -a -- "$src" "$dst" && chown -R "root:$AGENT_USER" -- "$dst" && chmod -R u=rwX,g=rX,o= -- "$dst" \
                    || fail "cannot install credentials at $dst" ;;
            file)
                # A read-only file of the worker's (a read-only bind in the image).
                src="in/${manifest[$((i + 1))]}"; dst="${manifest[$((i + 2))]}"; i=$((i + 3))
                rm -rf -- "$dst" && mkdir -p -- "$(dirname -- "$dst")" && install -m 0440 -o root -g "$AGENT_USER" -- "$src" "$dst" || fail "cannot install $dst" ;;
            dir)
                # An empty directory standing in for a log bind or a tmpfs.
                dst="${manifest[$((i + 1))]}"; i=$((i + 2))
                mkdir -p -- "$dst" && chown "$AGENT_USER:$AGENT_USER" -- "$dst" || fail "cannot create $dst" ;;
            output)
                outputs+=("${manifest[$((i + 1))]}" "${manifest[$((i + 2))]}"); i=$((i + 3)) ;;
            *) fail "unknown manifest record $kind" ;;
        esac
    done
    umask 077
    rm -rf in/store in/files in/manifest

    input=/dev/null
    [ ! -f in/stdin ] || input=in/stdin
    # Not a process group leader (no job control), so setsid makes the command the leader of a new session without forking.
    # `env` execs the command at once, before any process of the agent user exists to look at its arguments.
    setsid env -i "${envv[@]}" "${argv[@]}" <"$input" >>stdout.log 2>>stderr.log &
    child=$!
    printf '%s\n' "$child" > child-pid
    envv=()
    # TERM reaches the command only (as `docker stop` signals PID 1): the clone wrapper forwards it and still returns the workspace.
    trap 'kill -s TERM "$child" 2>/dev/null' TERM
    trap 'kill -s INT "$child" 2>/dev/null' INT
    # The launcher lives in a detachable session: a worker connection that drops must not end the run.
    trap '' HUP
    while :; do
        wait "$child"
        status=$?
        kill -0 "$child" 2>/dev/null || break
    done
    trap '' TERM INT HUP

    # Nothing the run started outlives it. While a process of the agent user is alive, nothing is exported.
    if kill_agent_processes "$uid"; then
        export_state=ok
        i=0
        while [ "$i" -lt "${#outputs[@]}" ]; do
            export_output "${outputs[$i]}" "${outputs[$((i + 1))]}" out
            i=$((i + 2))
        done
    else
        export_state=unsafe
        echo "ProPR Sprites launcher: processes of the $AGENT_USER user survived SIGKILL; no credentials are exported" >> stderr.log
    fi
    finish "$status" "$export_state"
}

follow_output() {
    local stream="$1" offset="$2"
    case "$stream" in stdout|stderr) ;; *) exit 2 ;; esac
    case "$offset" in ''|*[!0-9]*) exit 2 ;; esac
    for _ in $(seq 1 300); do [ -s "$RUN_DIR/pid" ] && break; sleep 0.1; done
    [ -s "$RUN_DIR/pid" ] || exit 3
    exec tail -c "+$offset" --pid="$(cat "$RUN_DIR/pid")" -s 0.5 -F -- "$RUN_DIR/$stream.log" 2>/dev/null
}

pid_alive() {
    local state
    state="$(sed -n 's/^State:[[:space:]]*\(.\).*/\1/p' "/proc/$1/status" 2>/dev/null)"
    [ -n "$state" ] && [ "$state" != "Z" ]
}

signal_run() {
    local signal="$1" pid child uid members=0
    pid="$(cat "$RUN_DIR/pid" 2>/dev/null)"
    case "$pid" in ''|*[!0-9]*|0|1) pid="" ;; esac
    if [ "$signal" != "KILL" ]; then
        [ -z "$pid" ] || kill -s TERM "$pid" 2>/dev/null
        exit 0
    fi
    child="$(cat "$RUN_DIR/child-pid" 2>/dev/null)"
    case "$child" in ''|*[!0-9]*|0|1) child="" ;; esac
    # The command leads its own session and process group.
    [ -z "$child" ] || kill -s KILL -- "-$child" 2>/dev/null
    if uid="$(agent_uid)"; then kill_agent_processes "$uid" || members=1; fi
    if [ -n "$pid" ]; then
        # The launcher records the run's status once its command is gone.
        for _ in $(seq 1 40); do pid_alive "$pid" || break; sleep 0.25; done
        if pid_alive "$pid"; then kill -s KILL "$pid" 2>/dev/null; sleep 0.25; fi
        if pid_alive "$pid"; then echo "the launcher $pid survived SIGKILL" >&2; exit 1; fi
    fi
    [ "$members" = 0 ] || { echo "processes of the $AGENT_USER user survived SIGKILL" >&2; exit 1; }
    exit 0
}

print_status() {
    local pid running=0
    pid="$(cat "$RUN_DIR/pid" 2>/dev/null)"
    case "$pid" in ''|*[!0-9]*) ;; *) if pid_alive "$pid"; then running=1; fi ;; esac
    printf 'running=%s\nexit=%s\nexport=%s\n' "$running" "$(cat "$RUN_DIR/exit-status" 2>/dev/null)" "$(cat "$RUN_DIR/export-status" 2>/dev/null)"
}

# Sourcing the script (the unit tests do) only defines the functions above.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then return 0; fi

case "${1:-}" in
    run) run_launcher ;;
    follow) follow_output "${2:-}" "${3:-}" ;;
    signal) signal_run "${2:-TERM}" ;;
    status) print_status ;;
    *) echo "usage: launcher.sh run | follow <stdout|stderr> <offset> | signal <TERM|KILL> | status" >&2; exit 2 ;;
esac

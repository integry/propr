#!/bin/bash
# Entrypoint script for Antigravity CLI execution container.
# Diagnostic output goes to stderr to avoid polluting streamed JSON responses.

set -e

if [ -z "$GH_TOKEN" ]; then
    echo "Warning: GH_TOKEN environment variable not set" >&2
    echo "GitHub operations may fail" >&2
else
    echo "GitHub token detected (using environment variable)" >&2
    echo "GitHub CLI will use GH_TOKEN environment variable for authentication" >&2
fi

antigravity_runtime_home="/home/node"
antigravity_config_dir="/home/node/.gemini"
antigravity_source_config="${PROPR_ANTIGRAVITY_SOURCE_CONFIG:-}"
antigravity_ephemeral="${PROPR_EPHEMERAL_STATE:-0}"
antigravity_state_files=(
    "antigravity-cli/antigravity-oauth-token"
    "antigravity-cli/settings.json"
)

if [ "$antigravity_ephemeral" = "1" ]; then
    antigravity_runtime_home="/tmp/propr-antigravity-home"
    antigravity_config_dir="$antigravity_runtime_home/.gemini"
    mkdir -p "$antigravity_config_dir"

    if [ -n "$antigravity_source_config" ] && [ -d "$antigravity_source_config" ]; then
        for relative_path in "${antigravity_state_files[@]}"; do
            source_path="$antigravity_source_config/$relative_path"
            runtime_path="$antigravity_config_dir/$relative_path"
            if [ -f "$source_path" ]; then
                mkdir -p "$(dirname "$runtime_path")"
                cp -p "$source_path" "$runtime_path"
            fi
        done
    fi

    if [ "${PROPR_REPOSITORY_INSPECTION:-0}" = "1" ]; then
        if [ -z "${PROPR_REPOSITORY_SCOUT_ANTIGRAVITY_MCP_CONFIG:-}" ] || [ -z "${PROPR_REPOSITORY_SCOUT_ANTIGRAVITY_PERMISSIONS:-}" ]; then
            echo "Repository scout Antigravity configuration is missing" >&2
            exit 2
        fi
        mkdir -p "$antigravity_config_dir/config" "$antigravity_config_dir/antigravity-cli"
        printf '%s\n' "$PROPR_REPOSITORY_SCOUT_ANTIGRAVITY_MCP_CONFIG" > "$antigravity_config_dir/config/mcp_config.json"
        printf '%s\n' "$PROPR_REPOSITORY_SCOUT_ANTIGRAVITY_PERMISSIONS" > "$antigravity_config_dir/antigravity-cli/settings.json"
        echo "Configured confined repository scout MCP permissions" >&2
    fi

    if [ "$(id -u)" = "0" ]; then
        chown -R node:node "$antigravity_runtime_home" 2>/dev/null || true
    fi
    echo "Using disposable Antigravity runtime state" >&2
fi

prepare_antigravity_config_dir() {
    local config_dir="$1"
    local required="$2"

    if [ -d "$config_dir" ]; then
        echo "Antigravity config directory mounted at $config_dir" >&2
        echo "Contents of $config_dir:" >&2
        ls -la "$config_dir/" >&2

        for dir in tmp antigravity-cli/log antigravity-cli/cache config/projects; do
            if [ ! -d "$config_dir/$dir" ]; then
                echo "Creating missing directory: $config_dir/$dir" >&2
                mkdir -p "$config_dir/$dir" 2>/dev/null || echo "Could not create $dir (permission issue)" >&2
            fi
        done

        if [ "$(id -u)" = "0" ]; then
            echo "Fixing ownership of Antigravity config files in $config_dir..." >&2
            chown -R node:node "$config_dir" 2>/dev/null || echo "Could not change ownership" >&2
        fi
        return 0
    fi

    if [ "$required" = "1" ]; then
        echo "WARNING: Antigravity config directory not mounted at $config_dir" >&2
    fi
    return 1
}

prepare_antigravity_config_dir "$antigravity_config_dir" "1" || true
prepare_antigravity_config_dir "/home/node/.antigravity" "0" >/dev/null 2>&1 || true

if [ -d "$antigravity_config_dir" ]; then
    auth_files=$(find "$antigravity_config_dir" -maxdepth 3 -type f \( -iname '*auth*' -o -iname '*oauth*' -o -iname '*credential*' -o -iname '*token*' \) 2>/dev/null | head -n 1)
    if [ -n "$auth_files" ]; then
        echo "Antigravity authentication-related configuration found" >&2
    else
        echo "Warning: no obvious Antigravity authentication files found under /home/node/.gemini" >&2
        echo "Ensure the Antigravity config directory is properly mounted and initialized" >&2
        echo "agy stores its login in the OS keyring on desktops, which ProPR containers can't read. Sign in once with \`AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy\`, or use ProPR's managed login." >&2
    fi
fi

git config --global --add safe.directory '*' 2>/dev/null || echo "Git safe directory config already set" >&2

if [ -x "/usr/local/bin/gh-wrapper" ]; then
    echo "Setting up GitHub CLI wrapper to filter operational comments" >&2
    mkdir -p /home/node/bin
    ln -sf /usr/local/bin/gh-wrapper /home/node/bin/gh
    export PATH="/home/node/bin:$PATH"
fi

if [ -d "/home/node/workspace" ]; then
    current_uid=$(id -u)
    if [ "$current_uid" = "1000" ]; then
        echo "Running as correct user (UID 1000)" >&2
        if [ -O "/home/node/workspace" ]; then
            echo "Workspace ownership is correct" >&2
        else
            echo "Warning: Workspace files not owned by container user" >&2
            echo "This may cause permission issues during execution" >&2
        fi
    else
        echo "Warning: Running as UID $current_uid instead of expected 1000" >&2
        echo "Skipping workspace chown to avoid mutating host bind-mount ownership" >&2
    fi
fi

# Run the task as a supervised background child instead of in the foreground.
# docker --init (tini) signals only this shell, so a foreground task would
# neither see `docker stop` (cancel, cost cap, watchdog, deadline) nor let the
# credential write-back after it run: the task would be SIGKILLed with the
# refreshed token still in the disposable state. TERM/INT/HUP are forwarded to
# the task, the shell waits until it has really exited, and the caller then
# writes back once, exactly as after a normal exit. Sets command_status (128+n
# after a forwarded signal, even if the task then exits 0).
# Without job control bash points a background command's stdin at /dev/null and
# ignores SIGINT/SIGQUIT in it, so stdin (the prompt) is passed explicitly and
# env restores default handling of those signals for the task.
supervised_task_pid=""
supervised_signal=""
forward_signal() {
    supervised_signal="$1"
    if [ -n "$supervised_task_pid" ]; then
        kill -s "$1" "$supervised_task_pid" 2>/dev/null || true
    fi
}
run_supervised_task() {
    local task_home="$1"
    shift
    trap 'forward_signal TERM' TERM
    trap 'forward_signal INT' INT
    trap 'forward_signal HUP' HUP
    set +e
    # su-exec and env both exec, so $! is the task itself.
    su-exec node env --default-signal=INT,QUIT HOME="$task_home" USER=node LOGNAME=node "$@" 0<&0 &
    supervised_task_pid=$!
    # A signal that arrived before the PID was known.
    if [ -n "$supervised_signal" ]; then
        kill -s "$supervised_signal" "$supervised_task_pid" 2>/dev/null || true
    fi
    while :; do
        wait "$supervised_task_pid"
        command_status=$?
        # A trapped signal interrupts wait with 128+n while the task still runs.
        if [ "$command_status" -le 128 ] || [ -z "$supervised_signal" ]; then
            break
        fi
        if ! kill -0 "$supervised_task_pid" 2>/dev/null; then
            # Already reaped: bash keeps its status for one more wait.
            wait "$supervised_task_pid"
            local final_status=$?
            if [ "$final_status" -ne 127 ]; then command_status=$final_status; fi
            break
        fi
    done
    supervised_task_pid=""
    set -e
    # A task that exits cleanly after being told to stop still reports the stop.
    if [ -n "$supervised_signal" ] && [ "$command_status" -eq 0 ]; then
        command_status=$((128 + $(kill -l "$supervised_signal")))
    fi
    # Signals arriving from here on only record themselves: bash runs the trap
    # after the current foreground command, so the write-back finishes once
    # before the entrypoint exits with the task's status.
}

# Copy refreshed state (the rotating Google OAuth token in particular) from the
# disposable HOME back to the mounted host config, then export the transcript.
# Runs once per task, after the task has exited normally or after a forwarded
# stop signal, so a refreshed token does not disappear with the container.
write_back_antigravity_state() {
    if [ "${PROPR_REPOSITORY_INSPECTION:-0}" != "1" ] && [ -n "$antigravity_source_config" ] && [ -d "$antigravity_source_config" ]; then
        for relative_path in "${antigravity_state_files[@]}"; do
            runtime_path="$antigravity_config_dir/$relative_path"
            source_path="$antigravity_source_config/$relative_path"
            if [ -f "$runtime_path" ]; then
                mkdir -p "$(dirname "$source_path")"
                temporary_path="${source_path}.propr-tmp-$$"
                if cp -p "$runtime_path" "$temporary_path" && mv "$temporary_path" "$source_path"; then
                    :
                else
                    rm -f "$temporary_path"
                    echo "Warning: could not sync refreshed Antigravity state file $relative_path" >&2
                fi
            fi
        done
    fi

    # The worker mounts a private read-write directory for the transcript;
    # export it before --rm discards the disposable runtime home.
    if [ -n "${PROPR_ANTIGRAVITY_TRANSCRIPT_PATH:-}" ]; then
        transcript_source=$(find "$antigravity_config_dir/antigravity-cli/brain" -type f -path '*/.system_generated/logs/transcript.jsonl' -print -quit 2>/dev/null || true)
        if [ -n "$transcript_source" ]; then
            # Replace rather than write through anything the agent left at the destination.
            if mkdir -p "$(dirname "$PROPR_ANTIGRAVITY_TRANSCRIPT_PATH")" \
                && rm -f "$PROPR_ANTIGRAVITY_TRANSCRIPT_PATH" \
                && cp "$transcript_source" "$PROPR_ANTIGRAVITY_TRANSCRIPT_PATH"; then
                chmod 0644 "$PROPR_ANTIGRAVITY_TRANSCRIPT_PATH" 2>/dev/null || true
            else
                echo "Warning: could not export transient Antigravity transcript" >&2
            fi
        else
            echo "Warning: no Antigravity transcript found to export" >&2
        fi
    fi
}

if [ $# -gt 0 ]; then
    echo "Executing command: $@" >&2
    if [ "$(id -u)" = "0" ] && [ "$antigravity_ephemeral" = "1" ]; then
        echo "Switching to node user with disposable Antigravity HOME..." >&2
        cd /home/node/workspace
        run_supervised_task "$antigravity_runtime_home" "$@"
        write_back_antigravity_state
        exit "$command_status"
    elif [ "$(id -u)" = "0" ]; then
        echo "Switching to node user..." >&2
        # Goal runs mount the host config as HOME/.gemini itself (no
        # PROPR_EPHEMERAL_STATE), so agy refreshes its token in place and
        # nothing needs writing back; exec hands signals straight to agy.
        cd /home/node/workspace
        exec su-exec node env HOME=/home/node USER=node LOGNAME=node "$@"
    else
        exec "$@"
    fi
else
    echo "No command provided, starting interactive shell" >&2
    exec /bin/bash
fi

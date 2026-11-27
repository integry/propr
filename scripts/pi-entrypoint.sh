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
# Only these host files are imported. Host sessions/, extensions/ and mcp.json
# are never copied: sessions and extensions stay on the host, and ProPR
# generates mcp.json itself (PROPR_PI_MCP_CONFIG).
pi_imported_files=(auth.json settings.json models.json AGENTS.md SYSTEM.md APPEND_SYSTEM.md)

case "$pi_runtime_home" in
    /|"") echo "Refusing to use $pi_runtime_home as the disposable Pi home" >&2; exit 64 ;;
esac
case "$(realpath -m "$pi_runtime_home")/" in
    "$(realpath -m "$pi_source_dir")/"*)
        echo "The disposable Pi home must not be inside the host Pi dir ($pi_source_dir)" >&2
        exit 64
        ;;
esac

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

prepare_runtime_home

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
set +e
run_as_node "$@"
command_status=$?
set -e

if [ -f "$pi_seed_snapshot" ]; then
    run_as_node python3 "$pi_credentials_helper" sync "$pi_source_dir/auth.json" "$pi_agent_dir/auth.json" "$pi_seed_snapshot" \
        || echo "Warning: could not write refreshed Pi credentials back to the host" >&2
fi

exit "$command_status"

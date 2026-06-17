#!/bin/bash
# Entrypoint script for OpenCode CLI execution container.
# Diagnostic output goes to stderr to keep JSON stdout parseable.

set -euo pipefail

echo "Skipping firewall setup (would require --privileged Docker flag)" >&2

if [ -z "${GH_TOKEN:-}" ]; then
    echo "Warning: GH_TOKEN environment variable not set" >&2
else
    echo "GitHub token detected (using environment variable)" >&2
fi

opencode_config_dir="${OPENCODE_CONFIG_DIR:-${OPENCODE_CONFIG_PATH:-/home/node/.config/opencode}}"
xdg_data_home="${XDG_DATA_HOME:-/home/node/.local/share}"
xdg_state_home="${XDG_STATE_HOME:-/home/node/.local/state}"
opencode_data_dir="$xdg_data_home/opencode"

if [ -d "$opencode_config_dir" ]; then
    echo "OpenCode config directory available at $opencode_config_dir" >&2
    mkdir -p "$opencode_data_dir" "$xdg_state_home"
    if [ "$(id -u)" = "0" ]; then
        chown -R node:node "$xdg_data_home" "$xdg_state_home" 2>/dev/null || true
        chmod -R u+rwX "$xdg_data_home" "$xdg_state_home" 2>/dev/null || true
        echo "Skipping OpenCode config ownership changes to avoid mutating host bind mounts" >&2
    fi
else
    echo "WARNING: OpenCode config directory not mounted at $opencode_config_dir" >&2
    mkdir -p "$opencode_config_dir" "$opencode_data_dir" "$xdg_state_home"
    if [ "$(id -u)" = "0" ]; then
        chown -R node:node "$opencode_config_dir" "$xdg_data_home" "$xdg_state_home" 2>/dev/null || true
        chmod -R u+rwX "$opencode_config_dir" "$xdg_data_home" "$xdg_state_home" 2>/dev/null || true
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
    else
        echo "Warning: Running as UID $current_uid instead of expected 1000" >&2
        echo "Skipping workspace chown to avoid mutating host bind-mount ownership" >&2
    fi
fi

if [ $# -gt 0 ]; then
    echo "Executing command: $@" >&2
    if [ "$(id -u)" = "0" ]; then
        echo "Switching to node user..." >&2
        cd /home/node/workspace
        exec su-exec node "$@"
    else
        exec "$@"
    fi
else
    echo "No command provided, starting interactive shell" >&2
    exec /bin/bash
fi

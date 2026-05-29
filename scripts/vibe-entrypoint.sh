#!/bin/bash
# Entrypoint script for Mistral Vibe CLI execution container
# Handles initialization and executes Vibe CLI with proper security
# NOTE: Diagnostic output goes to stderr to avoid polluting Vibe JSON output.

set -e

echo "Skipping firewall setup (would require --privileged Docker flag)" >&2

if [ -z "$GH_TOKEN" ]; then
    echo "Warning: GH_TOKEN environment variable not set" >&2
    echo "GitHub operations may fail" >&2
else
    echo "GitHub token detected (using environment variable)" >&2
    echo "GitHub CLI will use GH_TOKEN environment variable for authentication" >&2
fi

if [ -d "/home/node/.vibe" ]; then
    echo "Vibe config directory mounted" >&2

    if command -v sudo >/dev/null 2>&1; then
        echo "Fixing ownership of Vibe config files..." >&2
        sudo chown -R node:node /home/node/.vibe 2>/dev/null || echo "Could not change ownership" >&2
        sudo chmod -R u+rw /home/node/.vibe 2>/dev/null || true
    fi

    for dir in logs sessions skills; do
        if [ ! -d "/home/node/.vibe/$dir" ]; then
            echo "Creating missing directory: /home/node/.vibe/$dir" >&2
            mkdir -p "/home/node/.vibe/$dir" 2>/dev/null || echo "Could not create $dir (permission issue)" >&2
        fi
    done
else
    echo "WARNING: Vibe config directory not mounted at /home/node/.vibe" >&2
fi

if [ ! -f "/home/node/.vibe/config.toml" ]; then
    echo "Warning: Vibe config.toml not found" >&2
    echo "Ensure Vibe config directory is properly mounted, or set MISTRAL_API_KEY" >&2
    echo "Expected path: /home/node/.vibe/config.toml" >&2
else
    echo "Vibe configuration found" >&2
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

if [ $# -gt 0 ]; then
    echo "Executing command: $@" >&2
    if [ "$(id -u)" = "0" ]; then
        echo "Switching to node user..." >&2
        cd /home/node/workspace
        exec sudo -E -u node -H "$@"
    else
        exec "$@"
    fi
else
    echo "No command provided, starting interactive shell" >&2
    exec /bin/bash
fi

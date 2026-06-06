#!/bin/bash
# Entrypoint script for Antigravity CLI execution container.
# Diagnostic output goes to stderr to avoid polluting streamed JSON responses.

set -e

echo "Skipping firewall setup (would require --privileged Docker flag)" >&2

if [ -z "$GH_TOKEN" ]; then
    echo "Warning: GH_TOKEN environment variable not set" >&2
    echo "GitHub operations may fail" >&2
else
    echo "GitHub token detected (using environment variable)" >&2
    echo "GitHub CLI will use GH_TOKEN environment variable for authentication" >&2
fi

prepare_antigravity_config_dir() {
    local config_dir="$1"
    local required="$2"

    if [ -d "$config_dir" ]; then
        echo "Antigravity config directory mounted at $config_dir" >&2
        echo "Contents of $config_dir:" >&2
        ls -la "$config_dir/" >&2

        if command -v sudo >/dev/null 2>&1; then
            echo "Fixing ownership of Antigravity config files in $config_dir..." >&2
            sudo chown -R node:node "$config_dir" 2>/dev/null || echo "Could not change ownership" >&2
        fi

        for dir in tmp antigravity-cli/log antigravity-cli/cache config/projects; do
            if [ ! -d "$config_dir/$dir" ]; then
                echo "Creating missing directory: $config_dir/$dir" >&2
                mkdir -p "$config_dir/$dir" 2>/dev/null || echo "Could not create $dir (permission issue)" >&2
            fi
        done
        return 0
    fi

    if [ "$required" = "1" ]; then
        echo "WARNING: Antigravity config directory not mounted at $config_dir" >&2
    fi
    return 1
}

prepare_antigravity_config_dir "/home/node/.gemini" "1" || true
prepare_antigravity_config_dir "/home/node/.antigravity" "0" >/dev/null 2>&1 || true

if [ -d "/home/node/.gemini" ]; then
    auth_files=$(find /home/node/.gemini -maxdepth 3 -type f \( -iname '*auth*' -o -iname '*oauth*' -o -iname '*credential*' -o -iname '*token*' \) 2>/dev/null | head -n 1)
    if [ -n "$auth_files" ]; then
        echo "Antigravity authentication-related configuration found" >&2
    else
        echo "Warning: no obvious Antigravity authentication files found under /home/node/.gemini" >&2
        echo "Ensure the Antigravity config directory is properly mounted and initialized" >&2
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
        if sudo chown -R node:node /home/node/workspace 2>/dev/null; then
            echo "Workspace permissions set" >&2
        else
            echo "Workspace permissions already set (sudo not available in restricted container)" >&2
        fi
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

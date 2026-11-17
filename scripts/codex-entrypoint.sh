#!/bin/bash
# Entrypoint script for Codex CLI execution container
# Handles initialization and executes Codex CLI with proper security

set -e

# Ensure GitHub token is available
if [ -z "$GH_TOKEN" ]; then
    echo "Warning: GH_TOKEN environment variable not set"
    echo "GitHub operations may fail"
else
    echo "GitHub token detected (using environment variable)"
    echo "GitHub CLI will use GH_TOKEN environment variable for authentication"
fi

# Codex config should be directly mounted at /home/node/.codex
if [ -d "/home/node/.codex" ]; then
    echo "Codex config directory mounted"

    # Fix ownership if running as root. The container keeps Docker's
    # no-new-privileges boundary for the entire run, so do not rely on sudo here.
    # This is crucial because Docker volume mounts often default to root ownership,
    # but Codex running as 'node' needs to read/write config files.
    if [ "$(id -u)" = "0" ]; then
        echo "Fixing ownership of Codex config files..."
        # First try recursive chown
        chown -R node:node /home/node/.codex 2>/dev/null || true
        # Also fix permissions on files that might be 600 (root-only readable)
        chmod -R u+rw /home/node/.codex 2>/dev/null || true

        # For files that still aren't readable (e.g., on some volume mounts),
        # copy them with correct permissions
        for file in config.toml history.jsonl auth.json; do
            if [ -f "/home/node/.codex/$file" ] && ! su-exec node test -r "/home/node/.codex/$file" 2>/dev/null; then
                echo "Fixing permissions for $file..."
                cp "/home/node/.codex/$file" "/tmp/codex-$file"
                chown node:node "/tmp/codex-$file"
                chmod 644 "/tmp/codex-$file"
                mv "/tmp/codex-$file" "/home/node/.codex/$file"
            fi
        done
    fi

    # Ensure necessary subdirectories exist to prevent runtime errors
    # 'sessions' is used for thread persistence
    # 'rules' is used for execpolicy
    for dir in sessions rules; do
        if [ ! -d "/home/node/.codex/$dir" ]; then
            echo "Creating missing directory: /home/node/.codex/$dir"
            mkdir -p "/home/node/.codex/$dir" 2>/dev/null || echo "Could not create $dir (permission issue)"
        fi
    done
else
    echo "WARNING: Codex config directory not mounted at /home/node/.codex"
fi

# Ensure Codex config is accessible
if [ ! -f "/home/node/.codex/config.toml" ]; then
    echo "Warning: Codex config.toml not found"
    echo "Ensure Codex config directory is properly mounted"
    echo "Expected path: /home/node/.codex/config.toml"
else
    echo "Codex configuration found"
fi

# Configure Git to trust all directories (security: container environment)
git config --global --add safe.directory '*' 2>/dev/null || echo "Git safe directory config already set"

# Set up gh wrapper to filter propr bot comments
# This ensures Codex doesn't see operational bot comments when analyzing issues
if [ -x "/usr/local/bin/gh-wrapper" ]; then
    echo "Setting up GitHub CLI wrapper to filter operational comments"
    # Create a directory for our wrapper in PATH
    mkdir -p /home/node/bin
    ln -sf /usr/local/bin/gh-wrapper /home/node/bin/gh
    export PATH="/home/node/bin:$PATH"
fi

# Set proper permissions for workspace
if [ -d "/home/node/workspace" ]; then
    # Check if we're running as the correct user (should be UID 1000)
    current_uid=$(id -u)
    if [ "$current_uid" = "1000" ]; then
        echo "Running as correct user (UID 1000)"
        # Check if files are already owned by us
        if [ -O "/home/node/workspace" ]; then
            echo "Workspace ownership is correct"
        else
            echo "Warning: Workspace files not owned by container user"
            echo "This may cause permission issues during execution"
        fi
    else
        echo "Warning: Running as UID $current_uid instead of expected 1000"
        # Do not recursively chown the bind-mounted workspace. On hosts using
        # Docker user namespace remapping this can rewrite ownership on the host
        # repo (for example to nobody:nogroup) and trip Git's safe-directory
        # protections. The container can still execute the command as node; if
        # the mount is not writable enough, fail there rather than mutating host
        # ownership implicitly.
        echo "Skipping workspace chown to avoid mutating host bind-mount ownership"
    fi
fi

# Check the container-visible ancestry after repository setup has completed.
# The user config is intentionally ignored by --ignore-user-config; project
# config remains loadable by the pinned CLI and can expand the MCP catalog.
if [ "${PROPR_EXTENSION_EXCLUSIVE_MCP:-0}" = "1" ]; then
    extension_config_cursor=$(cd /home/node/workspace && pwd -P) || { echo "Codex extension workspace unavailable" >&2; exit 1; }
    while :; do
        extension_config_candidate="$extension_config_cursor/.codex/config.toml"
        if [ "$extension_config_candidate" != "${CODEX_HOME:-/home/node/.codex}/config.toml" ] && { [ -e "$extension_config_candidate" ] || [ -L "$extension_config_candidate" ]; }; then
            echo "Codex extension runs cannot load project MCP configuration" >&2
            exit 1
        fi
        [ "$extension_config_cursor" = "/" ] && break
        extension_config_cursor=$(dirname "$extension_config_cursor")
    done
fi

# Codex 0.168 and older saved trust for the workspace in CODEX_HOME whenever
# `codex exec` ran with --dangerously-bypass-approvals-and-sandbox. From 0.169
# an untrusted workspace's .codex/config.toml and project MCP servers are
# ignored unless `--trust` is passed; that flag saves the same entry, still
# respects a project the operator marked untrusted, and older CLIs reject it.
# The worker only asks for this on runs that load the user configuration
# (not repository inspection or exclusive-MCP extension runs).
# Even `--help` writes helper links under CODEX_HOME, so probe as node.
codex_exec_offers_trust() {
    local help
    if [ "$(id -u)" = "0" ]; then
        help=$(su-exec node env HOME=/home/node USER=node LOGNAME=node codex exec --help 2>/dev/null) || return 1
    else
        help=$(codex exec --help 2>/dev/null) || return 1
    fi
    printf '%s\n' "$help" | grep -Eq -- '^[[:space:]]+--trust([[:space:]]|$)'
}
if [ "${PROPR_CODEX_TRUST_WORKSPACE:-0}" = "1" ] && [ "${PROPR_EXTENSION_EXCLUSIVE_MCP:-0}" != "1" ] \
    && [ "${1:-}" = "codex" ] && [ "${2:-}" = "exec" ] && codex_exec_offers_trust; then
    shift 2
    set -- codex exec --trust "$@"
fi

# If arguments are provided, execute them
if [ $# -gt 0 ]; then
    echo "Executing command: $@"
    # If running as root, switch to node user after setup
    if [ "$(id -u)" = "0" ]; then
        echo "Switching to node user..."
        cd /home/node/workspace
        exec su-exec node env HOME=/home/node USER=node LOGNAME=node "$@"
    else
        exec "$@"
    fi
else
    echo "No command provided, starting interactive shell"
    exec /bin/bash
fi

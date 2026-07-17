#!/bin/bash
# Entrypoint script for Codex CLI execution container
# Handles initialization and executes Codex CLI with proper security

set -e

# Skip firewall initialization for now (requires privileged container)
echo "Skipping firewall setup (would require --privileged Docker flag)"

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

# If arguments are provided, execute them
if [ $# -gt 0 ]; then
    echo "Executing command: $@"
    # If running as root, switch to node user after setup
    if [ "$(id -u)" = "0" ]; then
        echo "Switching to node user..."
        cd /home/node/workspace
        exec su-exec node env HOME=/home/node "$@"
    else
        exec "$@"
    fi
else
    echo "No command provided, starting interactive shell"
    exec /bin/bash
fi

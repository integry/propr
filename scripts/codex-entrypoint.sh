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

    # Fix ownership if running with sudo capability
    # This is crucial because Docker volume mounts often default to root ownership,
    # but Codex running as 'node' needs to write to 'sessions' and 'history.jsonl'.
    if command -v sudo >/dev/null 2>&1; then
        echo "Fixing ownership of Codex config files..."
        sudo chown -R node:node /home/node/.codex 2>/dev/null || echo "Could not change ownership (may already be correct)"
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

# Set up gh wrapper to filter gitfixio comments
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
        # Try to ensure the user owns the workspace
        if sudo chown -R node:node /home/node/workspace 2>/dev/null; then
            echo "Workspace permissions set"
        else
            echo "Workspace permissions already set (sudo not available in restricted container)"
        fi
    fi
fi

# If arguments are provided, execute them
if [ $# -gt 0 ]; then
    echo "Executing command: $@"
    # If running as root, switch to node user after setup
    if [ "$(id -u)" = "0" ]; then
        echo "Switching to node user..."
        # Switch to node user and execute the command
        cd /home/node/workspace
        exec sudo -u node -H "$@"
    else
        exec "$@"
    fi
else
    echo "No command provided, starting interactive shell"
    exec /bin/bash
fi

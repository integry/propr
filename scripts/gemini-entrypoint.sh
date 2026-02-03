#!/bin/bash
# Entrypoint script for Gemini CLI execution container
# Handles initialization and executes Gemini CLI with proper security
# NOTE: All diagnostic output goes to stderr to avoid polluting Gemini's stdout response

set -e

# Skip firewall initialization for now (requires privileged container)
echo "Skipping firewall setup (would require --privileged Docker flag)" >&2

# Ensure GitHub token is available
if [ -z "$GH_TOKEN" ]; then
    echo "Warning: GH_TOKEN environment variable not set" >&2
    echo "GitHub operations may fail" >&2
else
    echo "GitHub token detected (using environment variable)" >&2
    echo "GitHub CLI will use GH_TOKEN environment variable for authentication" >&2
fi

# Gemini config should be directly mounted now
if [ -d "/home/node/.gemini" ]; then
    echo "Gemini config directory mounted" >&2
    echo "Contents of /home/node/.gemini:" >&2
    ls -la /home/node/.gemini/ >&2

    # Fix ownership if running with sudo capability
    if command -v sudo >/dev/null 2>&1; then
        echo "Fixing ownership of Gemini config files..." >&2
        sudo chown -R node:node /home/node/.gemini 2>/dev/null || echo "Could not change ownership" >&2
    fi

    # Ensure necessary subdirectories exist
    for dir in tmp; do
        if [ ! -d "/home/node/.gemini/$dir" ]; then
            echo "Creating missing directory: /home/node/.gemini/$dir" >&2
            mkdir -p "/home/node/.gemini/$dir" 2>/dev/null || echo "Could not create $dir (permission issue)" >&2
        fi
    done
else
    echo "WARNING: Gemini config directory not mounted at /home/node/.gemini" >&2
fi

# Ensure Gemini config is accessible
if [ ! -f "/home/node/.gemini/oauth_creds.json" ]; then
    echo "Warning: Gemini OAuth credentials not found" >&2
    echo "Ensure Gemini config directory is properly mounted" >&2
    echo "Expected path: /home/node/.gemini/oauth_creds.json" >&2
else
    echo "Gemini authentication configuration found" >&2
fi

# Configure Git to trust all directories (security: container environment)
git config --global --add safe.directory '*' 2>/dev/null || echo "Git safe directory config already set" >&2

# Set up gh wrapper to filter gitfixio comments
# This ensures Gemini doesn't see operational bot comments when analyzing issues
if [ -x "/usr/local/bin/gh-wrapper" ]; then
    echo "Setting up GitHub CLI wrapper to filter operational comments" >&2
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
        echo "Running as correct user (UID 1000)" >&2
        # Check if files are already owned by us
        if [ -O "/home/node/workspace" ]; then
            echo "Workspace ownership is correct" >&2
        else
            echo "Warning: Workspace files not owned by container user" >&2
            echo "This may cause permission issues during execution" >&2
        fi
    else
        echo "Warning: Running as UID $current_uid instead of expected 1000" >&2
        # Try to ensure the user owns the workspace (skip if sudo fails in restricted container)
        if sudo chown -R node:node /home/node/workspace 2>/dev/null; then
            echo "Workspace permissions set" >&2
        else
            echo "Workspace permissions already set (sudo not available in restricted container)" >&2
        fi
    fi
fi

# If arguments are provided, execute them
if [ $# -gt 0 ]; then
    echo "Executing command: $@" >&2
    # If running as root, switch to node user after setup
    if [ "$(id -u)" = "0" ]; then
        echo "Switching to node user..." >&2
        # Switch to node user and execute the command
        cd /home/node/workspace
        exec sudo -u node -H "$@"
    else
        exec "$@"
    fi
else
    echo "No command provided, starting interactive shell" >&2
    exec /bin/bash
fi

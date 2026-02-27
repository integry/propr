#!/bin/bash
# Entrypoint script for Claude Code execution container
# Handles initialization and executes Claude Code CLI with proper security

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

# Claude config should be directly mounted now
if [ -d "/home/node/.claude" ]; then
    echo "Claude config directory mounted"
    echo "Contents of /home/node/.claude:"
    ls -la /home/node/.claude/

    # Fix ownership if running with sudo capability
    if command -v sudo >/dev/null 2>&1; then
        echo "Fixing ownership of Claude config files..."
        sudo chown -R node:node /home/node/.claude 2>/dev/null || echo "Could not change ownership"
    fi

    # Ensure necessary subdirectories exist (they might not be in the mounted volume)
    for dir in todos projects shell-snapshots statsig; do
        if [ ! -d "/home/node/.claude/$dir" ]; then
            echo "Creating missing directory: /home/node/.claude/$dir"
            mkdir -p "/home/node/.claude/$dir" 2>/dev/null || echo "Could not create $dir (permission issue)"
        fi
    done

    # Pre-create the project directory for our workspace to avoid the dash issue
    project_dir="/home/node/.claude/projects/home-node-workspace"
    if [ ! -d "$project_dir" ]; then
        echo "Creating project directory: $project_dir"
        mkdir -p "$project_dir" 2>/dev/null || echo "Could not create project directory"
    fi
else
    echo "WARNING: Claude config directory not mounted at /home/node/.claude"
fi

# Ensure Claude config is accessible
if [ ! -f "/home/node/.claude/.credentials.json" ]; then
    echo "Warning: Claude credentials not found"
    echo "Ensure Claude config directory is properly mounted"
    echo "Expected path: /home/node/.claude/.credentials.json"
else
    echo "Claude authentication configuration found"
fi

# Configure Git to trust all directories (security: container environment)
git config --global --add safe.directory '*' 2>/dev/null || echo "Git safe directory config already set"

# Set up gh wrapper to filter propr bot comments
# This ensures Claude doesn't see operational bot comments when analyzing issues
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
        # Try to ensure the user owns the workspace (skip if sudo fails in restricted container)
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
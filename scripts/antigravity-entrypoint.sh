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

        # The entrypoint runs as root so it can repair bind-mounted credentials.
        # Do this after mkdir: otherwise fresh runtime directories are root-owned
        # and become unwritable as soon as execution drops to the node user.
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

prepare_antigravity_login_defaults() {
    local config_dir="$1"
    local settings_path="$config_dir/antigravity-cli/settings.json"

    node - "$settings_path" <<-'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const settingsPath = process.argv[2];
const settingsDirectory = path.dirname(settingsPath);

function ensureSafeDirectoryTree(directory) {
    const resolved = path.resolve(directory);
    const root = path.parse(resolved).root;
    let current = root;
    for (const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        let stat;
        try {
            stat = fs.lstatSync(current);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            fs.mkdirSync(current, { mode: 0o755 });
            stat = fs.lstatSync(current);
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error(`Unsafe Antigravity settings parent: ${current}`);
        }
    }
}

function readRegularFileNoFollow(filePath) {
    const pathStat = fs.lstatSync(filePath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
        throw new Error(`Unsafe Antigravity settings file: ${filePath}`);
    }
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        if (!fs.fstatSync(descriptor).isFile()) {
            throw new Error(`Antigravity settings are not a regular file: ${filePath}`);
        }
        return fs.readFileSync(descriptor, 'utf8');
    } finally {
        fs.closeSync(descriptor);
    }
}

function writeRegularFileAtomicNoFollow(filePath, contents) {
    ensureSafeDirectoryTree(path.dirname(filePath));
    const temporaryPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.propr-tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
    );
    let descriptor;
    try {
        descriptor = fs.openSync(
            temporaryPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
            0o600,
        );
        fs.writeFileSync(descriptor, contents);
        fs.fsyncSync(descriptor);
        const descriptorStat = fs.fstatSync(descriptor);
        const pathStat = fs.lstatSync(temporaryPath);
        if (!descriptorStat.isFile() || pathStat.isSymbolicLink()
            || descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) {
            throw new Error('Antigravity settings temporary file changed unexpectedly');
        }
        ensureSafeDirectoryTree(path.dirname(filePath));
        fs.renameSync(temporaryPath, filePath);
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        try { fs.unlinkSync(temporaryPath); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
}

ensureSafeDirectoryTree(settingsDirectory);
let settings = {};
try {
    const parsed = JSON.parse(readRegularFileNoFollow(settingsPath));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('settings must contain a JSON object');
    }
    settings = parsed;
} catch (error) {
    if (error.code !== 'ENOENT') {
        const pathStat = fs.lstatSync(settingsPath);
        if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw error;
        const backupPath = `${settingsPath}.invalid-${Date.now()}`;
        fs.renameSync(settingsPath, backupPath);
        console.error(`Warning: invalid Antigravity settings were backed up to ${backupPath}; recreating safe defaults`);
        settings = {};
    }
}
settings.enableTelemetry = false;
if (typeof settings.colorScheme !== 'string') settings.colorScheme = 'terminal';
const trustedWorkspaces = Array.isArray(settings.trustedWorkspaces)
    ? settings.trustedWorkspaces.filter(value => typeof value === 'string')
    : [];
if (!trustedWorkspaces.includes('/home/node/workspace')) {
    trustedWorkspaces.push('/home/node/workspace');
}
settings.trustedWorkspaces = trustedWorkspaces;
writeRegularFileAtomicNoFollow(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
NODE

    if [ "$(id -u)" = "0" ]; then
        chown -R node:node "$config_dir"
    fi
}

if [ "${PROPR_AGENT_LOGIN:-0}" = "1" ]; then
    prepare_antigravity_login_defaults "$antigravity_config_dir"
fi

if [ -d "$antigravity_config_dir" ]; then
    auth_files=$(find "$antigravity_config_dir" -maxdepth 3 -type f \( -iname '*auth*' -o -iname '*oauth*' -o -iname '*credential*' -o -iname '*token*' \) 2>/dev/null | head -n 1)
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
        echo "Skipping workspace chown to avoid mutating host bind-mount ownership" >&2
    fi
fi

if [ $# -gt 0 ]; then
    echo "Executing command: $@" >&2
    if [ "$(id -u)" = "0" ] && [ "$antigravity_ephemeral" = "1" ]; then
        echo "Switching to node user with disposable Antigravity HOME..." >&2
        cd /home/node/workspace
        set +e
        su-exec node env HOME="$antigravity_runtime_home" USER=node LOGNAME=node "$@"
        command_status=$?
        set -e

        if [ -n "$antigravity_source_config" ] && [ -d "$antigravity_source_config" ]; then
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

        if [ -n "${PROPR_ANTIGRAVITY_TRANSCRIPT_PATH:-}" ]; then
            transcript_source=$(find "$antigravity_config_dir/antigravity-cli/brain" -type f -path '*/.system_generated/logs/transcript.jsonl' -print -quit 2>/dev/null || true)
            if [ -n "$transcript_source" ]; then
                mkdir -p "$(dirname "$PROPR_ANTIGRAVITY_TRANSCRIPT_PATH")"
                cp "$transcript_source" "$PROPR_ANTIGRAVITY_TRANSCRIPT_PATH" || echo "Warning: could not export transient Antigravity transcript" >&2
            fi
        fi

        exit "$command_status"
    elif [ "$(id -u)" = "0" ]; then
        echo "Switching to node user..." >&2
        cd /home/node/workspace
        exec su-exec node env HOME=/home/node USER=node LOGNAME=node "$@"
    else
        exec "$@"
    fi
else
    echo "No command provided, starting interactive shell" >&2
    exec /bin/bash
fi

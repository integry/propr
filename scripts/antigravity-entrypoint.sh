#!/bin/bash
# Entrypoint script for Antigravity CLI execution container.
# Diagnostic output goes to stderr to avoid polluting streamed JSON responses.

set -e

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

# Extension and ProPR MCP servers for this run. agy reads
# <HOME>/.gemini/config/mcp_config.json and does not expand ${VAR} in headers,
# so the worker passes a template that names each token variable and this
# writes the real header into the disposable runtime home only: owned by node,
# mode 0600, deleted after the run and never synced back to the host directory.
# Prints the token variable names, which the agent itself does not need.
write_antigravity_mcp_config() {
    node - "$1" "${PROPR_EXTENSION_EXCLUSIVE_MCP:-0}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [target, exclusive] = process.argv.slice(2);
const fail = message => { process.stderr.write(`Antigravity MCP configuration refused: ${message}\n`); process.exit(2); };
let template;
try { template = JSON.parse(process.env.PROPR_ANTIGRAVITY_MCP_CONFIG || ''); } catch { fail('invalid template'); }
if (!template || typeof template.mcpServers !== 'object' || Array.isArray(template.mcpServers)) fail('invalid template');
const servers = {};
const tokenEnvs = [];
for (const [name, server] of Object.entries(template.mcpServers)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || !server || typeof server !== 'object') fail('invalid server');
    if (typeof server.serverUrl === 'string') {
        if (!/^https?:\/\//.test(server.serverUrl)) fail(`server ${name} has an invalid URL`);
        const env = server.bearerTokenEnv;
        if (typeof env !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(env)) fail(`server ${name} has an invalid token variable`);
        const token = process.env[env];
        if (!token || /[\s"\\]/.test(token)) fail(`server ${name} has no usable run token`);
        servers[name] = { serverUrl: server.serverUrl, headers: { Authorization: `Bearer ${token}` } };
        tokenEnvs.push(env);
    } else if (typeof server.command === 'string' && Array.isArray(server.args) && server.args.every(a => typeof a === 'string')) {
        servers[name] = { command: server.command, args: server.args };
    } else fail(`server ${name} is invalid`);
}
// Exclusive runs replace any configuration already in the runtime home;
// other runs keep it, and the run's servers win on a name clash.
let existing = {};
if (exclusive !== '1') {
    try { existing = JSON.parse(fs.readFileSync(target, 'utf8')).mcpServers || {}; } catch { existing = {}; }
}
fs.mkdirSync(path.dirname(target), { recursive: true });
const temporary = `${target}.propr-tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify({ mcpServers: { ...existing, ...servers } }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
fs.chmodSync(temporary, 0o600);
if (process.getuid && process.getuid() === 0) fs.chownSync(temporary, 1000, 1000);
fs.renameSync(temporary, target);
process.stdout.write(tokenEnvs.join(' '));
NODE
}

# A 401 makes agy fall back to OAuth discovery and wait until the run times
# out. Check each remote server with the run credential first and stop with a
# clear error instead. Other failures are left to agy, which reports them.
preflight_antigravity_mcp_servers() {
    node - "$1" <<'NODE'
const fs = require('node:fs');
const servers = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).mcpServers || {};
const initialize = { jsonrpc: '2.0', id: 'propr-preflight', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'propr-antigravity-preflight', version: '1' } } };
(async () => {
    for (const [name, server] of Object.entries(servers)) {
        if (typeof server.serverUrl !== 'string' || !server.headers) continue;
        try {
            const response = await fetch(server.serverUrl, { method: 'POST', headers: { ...server.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(initialize), signal: AbortSignal.timeout(15000) });
            await response.arrayBuffer().catch(() => undefined);
            if (response.status === 401) {
                process.stderr.write(`PROPR_MCP_AUTH_FAILED: MCP server "${name}" refused the run credential (HTTP 401). Antigravity would fall back to OAuth discovery and wait until the run times out, so the run stops here.\n`);
                process.exit(3);
            }
        } catch {
            process.stderr.write(`Warning: could not check MCP server "${name}" before launch\n`);
        }
    }
})();
NODE
}

# Copy the run's staged skill bundles (<id>:<name> pairs) to
# <HOME>/.gemini/skills/<name>, where agy loads global skills. Exclusive runs
# start from an empty skills directory.
install_antigravity_skills() {
    local skills_dir="$1"
    local source_root="${PROPR_EXTENSION_SKILLS_ROOT:-/opt/propr/extensions}"
    local pair id name
    if [ "${PROPR_EXTENSION_EXCLUSIVE_MCP:-0}" = "1" ]; then
        rm -rf "$skills_dir"
    fi
    mkdir -p "$skills_dir"
    for pair in ${PROPR_ANTIGRAVITY_SKILLS:-}; do
        id="${pair%%:*}"
        name="${pair#*:}"
        if ! [[ "$id" =~ ^[A-Za-z0-9_-]+$ ]] || ! [[ "$name" =~ ^[a-z][a-z0-9-]{0,63}$ ]] || [ ! -f "$source_root/$id/SKILL.md" ]; then
            echo "Antigravity skill bundle unavailable: $pair" >&2
            return 1
        fi
        if [ -e "$skills_dir/$name" ]; then
            echo "Warning: skipping duplicate Antigravity skill name $name" >&2
            continue
        fi
        cp -R "$source_root/$id" "$skills_dir/$name"
    done
}

antigravity_mcp_config_path=""
antigravity_mcp_token_envs=""

if [ "$antigravity_ephemeral" = "1" ]; then
    antigravity_runtime_home="${PROPR_ANTIGRAVITY_RUNTIME_HOME:-/tmp/propr-antigravity-home}"
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

    if [ "${PROPR_REPOSITORY_INSPECTION:-0}" = "1" ]; then
        if [ -z "${PROPR_REPOSITORY_SCOUT_ANTIGRAVITY_MCP_CONFIG:-}" ] || [ -z "${PROPR_REPOSITORY_SCOUT_ANTIGRAVITY_PERMISSIONS:-}" ]; then
            echo "Repository scout Antigravity configuration is missing" >&2
            exit 2
        fi
        mkdir -p "$antigravity_config_dir/config" "$antigravity_config_dir/antigravity-cli"
        printf '%s\n' "$PROPR_REPOSITORY_SCOUT_ANTIGRAVITY_MCP_CONFIG" > "$antigravity_config_dir/config/mcp_config.json"
        printf '%s\n' "$PROPR_REPOSITORY_SCOUT_ANTIGRAVITY_PERMISSIONS" > "$antigravity_config_dir/antigravity-cli/settings.json"
        echo "Configured confined repository scout MCP permissions" >&2
    fi

    if [ -n "${PROPR_ANTIGRAVITY_MCP_CONFIG:-}" ] || [ -n "${PROPR_ANTIGRAVITY_SKILLS:-}" ]; then
        if [ "${PROPR_REPOSITORY_INSPECTION:-0}" = "1" ]; then
            echo "Antigravity run MCP servers are not available to repository inspection" >&2
            exit 2
        fi
        install_antigravity_skills "$antigravity_config_dir/skills" || exit 2
    fi

    if [ -n "${PROPR_ANTIGRAVITY_MCP_CONFIG:-}" ]; then
        antigravity_mcp_config_path="$antigravity_config_dir/config/mcp_config.json"
        trap 'rm -f "$antigravity_mcp_config_path"' EXIT
        antigravity_mcp_token_envs=$(write_antigravity_mcp_config "$antigravity_mcp_config_path") || exit 2
        echo "Configured run MCP servers for Antigravity" >&2
    fi

    if [ "$(id -u)" = "0" ]; then
        chown -R node:node "$antigravity_runtime_home" 2>/dev/null || true
        # chown -R must not widen the config: it stays node-owned and 0600.
        if [ -n "$antigravity_mcp_config_path" ]; then
            chmod 600 "$antigravity_mcp_config_path"
        fi
    fi
    echo "Using disposable Antigravity runtime state" >&2
elif [ -n "${PROPR_ANTIGRAVITY_MCP_CONFIG:-}" ] || [ -n "${PROPR_ANTIGRAVITY_SKILLS:-}" ]; then
    echo "Antigravity run MCP servers require disposable runtime state" >&2
    exit 2
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
    if [ "$antigravity_ephemeral" = "1" ]; then
        if [ -n "$antigravity_mcp_config_path" ]; then
            preflight_antigravity_mcp_servers "$antigravity_mcp_config_path" || exit $?
        fi
        # The tokens are in the config file only; the agent process does not get them.
        antigravity_env_unset=(-u PROPR_ANTIGRAVITY_MCP_CONFIG)
        for token_env in $antigravity_mcp_token_envs; do
            antigravity_env_unset+=(-u "$token_env")
        done
        if [ "$(id -u)" = "0" ] || [ -d /home/node/workspace ]; then
            cd /home/node/workspace
        fi
        set +e
        if [ "$(id -u)" = "0" ]; then
            echo "Switching to node user with disposable Antigravity HOME..." >&2
            su-exec node env "${antigravity_env_unset[@]}" HOME="$antigravity_runtime_home" USER=node LOGNAME=node "$@"
        else
            env "${antigravity_env_unset[@]}" HOME="$antigravity_runtime_home" "$@"
        fi
        command_status=$?
        set -e
        if [ -n "$antigravity_mcp_config_path" ]; then
            rm -f "$antigravity_mcp_config_path"
        fi

        if [ "${PROPR_REPOSITORY_INSPECTION:-0}" != "1" ] && [ -n "$antigravity_source_config" ] && [ -d "$antigravity_source_config" ]; then
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

#!/bin/bash
# Entrypoint script for OpenCode CLI execution container.
# Diagnostic output goes to stderr to keep JSON stdout parseable.

set -euo pipefail

if [ -z "${GH_TOKEN:-}" ]; then
    echo "Warning: GH_TOKEN environment variable not set" >&2
else
    echo "GitHub token detected (using environment variable)" >&2
fi

opencode_config_dir="${OPENCODE_CONFIG_DIR:-${OPENCODE_CONFIG_PATH:-/home/node/.config/opencode}}"
xdg_data_home="${XDG_DATA_HOME:-/home/node/.local/share}"
xdg_state_home="${XDG_STATE_HOME:-/home/node/.local/state}"
opencode_data_dir="$xdg_data_home/opencode"
opencode_source_data="${PROPR_OPENCODE_SOURCE_DATA:-}"
opencode_ephemeral="${PROPR_EPHEMERAL_STATE:-0}"
opencode_credential_files=("auth.json" "account.json")

if [ "$opencode_ephemeral" = "1" ]; then
    mkdir -p "$opencode_data_dir"
    if [ -n "$opencode_source_data" ] && [ -d "$opencode_source_data" ]; then
        for credential_file in "${opencode_credential_files[@]}"; do
            if [ -f "$opencode_source_data/$credential_file" ]; then
                cp -p "$opencode_source_data/$credential_file" "$opencode_data_dir/$credential_file"
            fi
        done
    fi
    echo "Using disposable OpenCode data directory at $opencode_data_dir" >&2
fi

if [ -d "$opencode_config_dir" ]; then
    echo "OpenCode config directory available at $opencode_config_dir" >&2
    mkdir -p "$opencode_data_dir" "$xdg_state_home"
    if [ "$(id -u)" = "0" ]; then
        chown -R node:node "$xdg_data_home" "$xdg_state_home" 2>/dev/null || true
        chmod -R u+rwX "$xdg_data_home" "$xdg_state_home" 2>/dev/null || true
        if [ "${PROPR_MANAGED_CREDENTIALS:-}" = "1" ]; then
            # This directory belongs to this ProPR agent, so it is safe to
            # normalize ownership before dropping privileges to the node user.
            chown -R node:node "$opencode_config_dir" 2>/dev/null || true
            chmod -R u+rwX "$opencode_config_dir" 2>/dev/null || true
        else
            echo "Skipping OpenCode config ownership changes to avoid mutating host bind mounts" >&2
        fi
    fi
else
    echo "WARNING: OpenCode config directory not mounted at $opencode_config_dir" >&2
    mkdir -p "$opencode_config_dir" "$opencode_data_dir" "$xdg_state_home"
    if [ "$(id -u)" = "0" ]; then
        chown -R node:node "$opencode_config_dir" "$xdg_data_home" "$xdg_state_home" 2>/dev/null || true
        chmod -R u+rwX "$opencode_config_dir" "$xdg_data_home" "$xdg_state_home" 2>/dev/null || true
    fi
fi

# Extension runs (PROPR_OPENCODE_EXCLUSIVE_CONFIG=1) get only the run's MCP
# servers and skills from OPENCODE_CONFIG_CONTENT. OpenCode 2.x deep-merges its
# config sources, so an inline empty `mcp.servers` cannot remove the host's
# servers. Point OPENCODE_CONFIG_DIR at a disposable copy instead: the config
# documents lose `mcp` and `skills`, the skills folders are left out, and every
# other entry (agents, commands, plugins) links back to the mounted host dir,
# so the host's providers and settings still apply. The host dir is not changed.
# OPENCODE_CONFIG_PROJECT_DISABLE and OPENCODE_DISABLE_CLAUDE_CODE (set by the
# launcher) drop the workspace and ~/.claude sources.
prepare_exclusive_opencode_config() {
    local source_dir="$1"
    local runtime_dir="${PROPR_OPENCODE_EXCLUSIVE_CONFIG_DIR:-/tmp/propr-opencode-run-config}"
    rm -rf "$runtime_dir"
    mkdir -p "$runtime_dir"
    chmod 700 "$runtime_dir"
    if [ -d "$source_dir" ]; then
        local entry name
        for entry in "$source_dir"/* "$source_dir"/.[!.]*; do
            [ -e "$entry" ] || [ -L "$entry" ] || continue
            name="$(basename "$entry")"
            case "$name" in
                skills|skill|opencode.json|opencode.jsonc|config.json) ;;
                *) ln -s "$entry" "$runtime_dir/$name" ;;
            esac
        done
        local document
        for document in opencode.json opencode.jsonc config.json; do
            [ -f "$source_dir/$document" ] || continue
            if ! python3 - "$source_dir/$document" "$runtime_dir/$document" <<'PY'
import json
import sys


def strip_jsonc(text):
    """Remove // and /* */ comments and trailing commas outside strings."""
    out, i, n, in_string = [], 0, len(text), False
    while i < n:
        c = text[i]
        if in_string:
            out.append(c)
            if c == '\\' and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_string = False
            i += 1
        elif c == '"':
            in_string = True
            out.append(c)
            i += 1
        elif text.startswith('//', i):
            while i < n and text[i] != '\n':
                i += 1
        elif text.startswith('/*', i):
            end = text.find('*/', i + 2)
            if end < 0:
                raise ValueError('unterminated comment')
            i = end + 2
        elif c == ',':
            j = i + 1
            while j < n and text[j] in ' \t\r\n':
                j += 1
            if j < n and text[j] in '}]':
                i += 1
                continue
            out.append(c)
            i += 1
        else:
            out.append(c)
            i += 1
    return ''.join(out)


with open(sys.argv[1], encoding='utf-8') as handle:
    text = handle.read()
config = json.loads(strip_jsonc(text)) if text.strip() else {}
if not isinstance(config, dict):
    raise ValueError('config root is not an object')
config.pop('mcp', None)
config.pop('skills', None)
with open(sys.argv[2], 'w', encoding='utf-8') as handle:
    json.dump(config, handle)
PY
            then
                echo "Error: could not remove MCP servers and skills from OpenCode config $document for an extension run" >&2
                return 1
            fi
        done
    fi
    if [ "$(id -u)" = "0" ]; then
        chown -h -R node:node "$runtime_dir"
    fi
    export OPENCODE_CONFIG_DIR="$runtime_dir"
    echo "Using exclusive OpenCode config directory at $runtime_dir" >&2
}

if [ "${PROPR_OPENCODE_EXCLUSIVE_CONFIG:-0}" = "1" ]; then
    prepare_exclusive_opencode_config "$opencode_config_dir" || exit 1
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
    if [ "$(id -u)" = "0" ] && [ "$opencode_ephemeral" = "1" ]; then
        echo "Switching to node user with disposable OpenCode state..." >&2
        cd /home/node/workspace
        source_db="$opencode_source_data/opencode.db"
        runtime_db="$opencode_data_dir/opencode.db"
        sync_database=0
        # Probe as node: OpenCode opens its log file even for --version, and a
        # root-owned log/ under the node-owned data dir breaks every later run.
        if [ -n "$opencode_source_data" ] && { [ -f "$source_db" ] || [ -f "$opencode_source_data/auth.json" ]; } && [[ "$(su-exec node env HOME=/home/node opencode --version)" == "opencode v2."* ]]; then
            # Initialize the disposable schema (including v1 JSON migration)
            # before importing credentials. Keep the host session DB out of it.
            # seed classifies the host by schema: a 2.x DB is authoritative even
            # when empty; a 1.x host (only auth.json, no credential table, or a
            # 1.x schema) gets refreshes written back to auth.json by sync.
            su-exec node env HOME=/home/node opencode auth list --standalone >/dev/null
            su-exec node python3 /opt/propr/opencode-credentials.py seed "$source_db" "$runtime_db"
            sync_database=1
        fi
        set +e
        su-exec node env HOME=/home/node USER=node LOGNAME=node "$@"
        command_status=$?
        set -e

        if [ -n "$opencode_source_data" ] && [ -d "$opencode_source_data" ]; then
            for credential_file in "${opencode_credential_files[@]}"; do
                runtime_path="$opencode_data_dir/$credential_file"
                source_path="$opencode_source_data/$credential_file"
                # OpenCode 2 never updates auth.json; sync owns write-backs, and
                # copying the seeded file back would undo a host login.
                if [ "$sync_database" = "1" ] && [ "$credential_file" = "auth.json" ]; then
                    continue
                fi
                if [ -f "$runtime_path" ]; then
                    temporary_path="${source_path}.propr-tmp-$$"
                    if cp -p "$runtime_path" "$temporary_path" && mv "$temporary_path" "$source_path"; then
                        :
                    else
                        rm -f "$temporary_path"
                        echo "Warning: could not sync refreshed OpenCode credential file $credential_file" >&2
                    fi
                fi
            done
        fi

        if [ "$sync_database" = "1" ]; then
            su-exec node python3 /opt/propr/opencode-credentials.py sync "$source_db" "$runtime_db"
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

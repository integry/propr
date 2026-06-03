#!/bin/bash
# Entrypoint script for Mistral Vibe CLI execution container
# Handles initialization and executes Vibe CLI with proper security
# NOTE: Diagnostic output goes to stderr to avoid polluting Vibe JSON output.

set -e

echo "Skipping firewall setup (would require --privileged Docker flag)" >&2

SOURCE_VIBE_HOME="${VIBE_SOURCE_HOME:-/home/node/.vibe}"
RUNTIME_VIBE_HOME="${VIBE_RUNTIME_HOME:-/tmp/propr-vibe-home}"
VIBE_READ_ONLY_CONFIG="${VIBE_READ_ONLY_CONFIG:-0}"
export HOME="$RUNTIME_VIBE_HOME"
export VIBE_HOME="$RUNTIME_VIBE_HOME"

copy_vibe_home() {
    mkdir -p "$RUNTIME_VIBE_HOME"
    if [ -d "$SOURCE_VIBE_HOME" ] && [ "$SOURCE_VIBE_HOME" != "$RUNTIME_VIBE_HOME" ]; then
        if [ "$VIBE_READ_ONLY_CONFIG" = "1" ] && [ -f "$SOURCE_VIBE_HOME/config.toml" ]; then
            cp "$SOURCE_VIBE_HOME/config.toml" "$RUNTIME_VIBE_HOME/config.toml" 2>/dev/null || true
            echo "Copied read-only Vibe config for analysis mode" >&2
        elif [ "$VIBE_READ_ONLY_CONFIG" != "1" ]; then
            cp -a "$SOURCE_VIBE_HOME"/. "$RUNTIME_VIBE_HOME"/ 2>/dev/null || true
        fi
    fi
    normalize_vibe_config_paths
    chown -R node:node "$RUNTIME_VIBE_HOME" 2>/dev/null || true
    chmod -R u+rw "$RUNTIME_VIBE_HOME" 2>/dev/null || true
}

normalize_vibe_config_paths() {
    local config_file="$RUNTIME_VIBE_HOME/config.toml"
    if [ ! -f "$config_file" ]; then
        return
    fi

    local escaped_source escaped_runtime
    escaped_source="$(printf '%s\n' "$SOURCE_VIBE_HOME" | sed 's/[\/&]/\\&/g')"
    escaped_runtime="$(printf '%s\n' "$RUNTIME_VIBE_HOME" | sed 's/[\/&]/\\&/g')"
    sed -i "s/$escaped_source/$escaped_runtime/g" "$config_file" 2>/dev/null || true
    sed -i "s/\/root\/\.vibe/$escaped_runtime/g" "$config_file" 2>/dev/null || true
}

configure_active_model() {
    if [ -z "${VIBE_ACTIVE_MODEL:-}" ]; then
        return
    fi

    if [ "$VIBE_READ_ONLY_CONFIG" = "1" ] && [ -f "$RUNTIME_VIBE_HOME/config.toml" ]; then
        echo "Skipping Vibe active model config mutation in read-only analysis mode" >&2
        return
    fi

    mkdir -p "$RUNTIME_VIBE_HOME"
    touch "$RUNTIME_VIBE_HOME/config.toml"
    escaped_model="$(toml_escape_string "$VIBE_ACTIVE_MODEL")"
    active_model_line="active_model = \"${escaped_model}\""
    if grep -q '^[[:space:]]*active_model[[:space:]]*=' "$RUNTIME_VIBE_HOME/config.toml"; then
        replace_active_model_line "$RUNTIME_VIBE_HOME/config.toml" "$active_model_line"
    else
        printf '\n%s\n' "$active_model_line" >> "$RUNTIME_VIBE_HOME/config.toml"
    fi
    chown node:node "$RUNTIME_VIBE_HOME/config.toml" 2>/dev/null || true
    echo "Configured Vibe active model override" >&2
}

toml_escape_string() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    value="${value//$'\r'/\\r}"
    value="${value//$'\n'/\\n}"
    printf '%s' "$value"
}

replace_active_model_line() {
    local config_file="$1"
    local replacement="$2"
    local tmp_file
    local replaced=false
    tmp_file="$(mktemp)"

    while IFS= read -r line || [ -n "$line" ]; do
        if [ "$replaced" = false ] && printf '%s\n' "$line" | grep -q '^[[:space:]]*active_model[[:space:]]*='; then
            printf '%s\n' "$replacement" >> "$tmp_file"
            replaced=true
        else
            printf '%s\n' "$line" >> "$tmp_file"
        fi
    done < "$config_file"

    mv "$tmp_file" "$config_file"
}

load_vibe_env_file() {
    local env_file="$1"
    if [ ! -f "$env_file" ]; then
        return
    fi
    if [ ! -r "$env_file" ]; then
        echo "Vibe .env file is not readable: $env_file" >&2
        return
    fi

    while IFS='=' read -r key value || [ -n "$key" ]; do
        key="${key#"${key%%[![:space:]]*}"}"
        key="${key%"${key##*[![:space:]]}"}"
        case "$key" in
            ''|\#*) continue ;;
        esac
        if ! printf '%s\n' "$key" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$'; then
            echo "Skipping invalid Vibe .env key: $key" >&2
            continue
        fi
        if [ -n "${!key:-}" ]; then
            continue
        fi
        value="${value#"${value%%[![:space:]]*}"}"
        value="${value%"${value##*[![:space:]]}"}"
        case "$value" in
            \"*\") value="${value#\"}"; value="${value%\"}" ;;
            \'*\') value="${value#\'}"; value="${value%\'}" ;;
        esac
        export "$key=$value"
    done < "$env_file"
    echo "Loaded Vibe .env defaults from $env_file" >&2
}

load_vibe_env_defaults() {
    load_vibe_env_file "$SOURCE_VIBE_HOME/.env"
    if [ "$SOURCE_VIBE_HOME" != "$RUNTIME_VIBE_HOME" ]; then
        load_vibe_env_file "$RUNTIME_VIBE_HOME/.env"
    fi
}

format_command_for_log() {
    if [ $# -eq 0 ]; then
        return
    fi

    local executable="$1"
    shift
    local redacted=()
    local redact_next=false
    for arg in "$@"; do
        if [ "$redact_next" = true ]; then
            redacted+=("<redacted>")
            redact_next=false
            continue
        fi
        case "$arg" in
            -p|--prompt)
                redacted+=("$arg")
                redact_next=true
                ;;
            -p=*|--prompt=*)
                redacted+=("${arg%%=*}=<redacted>")
                ;;
            *)
                redacted+=("$arg")
                ;;
        esac
    done
    echo "$executable ${redacted[*]}" >&2
}

expand_vibe_prompt_file_args() {
    EXPANDED_VIBE_ARGS=()
    if [ $# -eq 0 ] || [ "$1" != "vibe" ]; then
        EXPANDED_VIBE_ARGS=("$@")
        return
    fi

    EXPANDED_VIBE_ARGS=("$1")
    shift
    while [ $# -gt 0 ]; do
        case "$1" in
            --prompt-file)
                if [ $# -lt 2 ]; then
                    echo "Missing value for --prompt-file" >&2
                    exit 2
                fi
                if [ ! -f "$2" ]; then
                    echo "Prompt file not found: $2" >&2
                    exit 2
                fi
                EXPANDED_VIBE_ARGS+=("-p" "$(cat "$2")")
                shift 2
                ;;
            --prompt-file=*)
                prompt_file="${1#--prompt-file=}"
                if [ ! -f "$prompt_file" ]; then
                    echo "Prompt file not found: $prompt_file" >&2
                    exit 2
                fi
                EXPANDED_VIBE_ARGS+=("-p" "$(cat "$prompt_file")")
                shift
                ;;
            *)
                EXPANDED_VIBE_ARGS+=("$1")
                shift
                ;;
        esac
    done
}

if [ -z "$GH_TOKEN" ]; then
    echo "Warning: GH_TOKEN environment variable not set" >&2
    echo "GitHub operations may fail" >&2
else
    echo "GitHub token detected (using environment variable)" >&2
    echo "GitHub CLI will use GH_TOKEN environment variable for authentication" >&2
fi

if [ -d "$SOURCE_VIBE_HOME" ]; then
    echo "Vibe config directory mounted" >&2

    copy_vibe_home
    configure_active_model
    load_vibe_env_defaults

    for dir in logs sessions skills; do
        if [ ! -d "$RUNTIME_VIBE_HOME/$dir" ]; then
            echo "Creating missing directory: $RUNTIME_VIBE_HOME/$dir" >&2
            mkdir -p "$RUNTIME_VIBE_HOME/$dir" 2>/dev/null || echo "Could not create $dir (permission issue)" >&2
        fi
    done
else
    echo "WARNING: Vibe config directory not mounted at $SOURCE_VIBE_HOME" >&2
    copy_vibe_home
    configure_active_model
    load_vibe_env_defaults
fi

if [ ! -f "$RUNTIME_VIBE_HOME/config.toml" ]; then
    echo "Warning: Vibe config.toml not found" >&2
    echo "Ensure Vibe config directory is properly mounted, or set MISTRAL_API_KEY" >&2
    echo "Expected path: $RUNTIME_VIBE_HOME/config.toml" >&2
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
    # When the first argument is a flag (starts with -), prepend 'vibe' so callers
    # can pass only CLI flags after the Docker image without duplicating the binary name.
    case "$1" in
        -*) set -- vibe "$@" ;;
    esac
    expand_vibe_prompt_file_args "$@"
    set -- "${EXPANDED_VIBE_ARGS[@]}"
    echo -n "Executing command: " >&2
    format_command_for_log "$@"
    if [ "$(id -u)" = "0" ]; then
        echo "Switching to node user..." >&2
        cd /home/node/workspace
        if command -v sudo >/dev/null 2>&1; then
            exec sudo -E -u node env HOME="$RUNTIME_VIBE_HOME" VIBE_HOME="$RUNTIME_VIBE_HOME" "$@"
        fi
        if command -v su-exec >/dev/null 2>&1; then
            exec su-exec node env HOME="$RUNTIME_VIBE_HOME" VIBE_HOME="$RUNTIME_VIBE_HOME" "$@"
        fi
        echo "Cannot switch to node user: sudo or su-exec is required" >&2
        exit 127
    else
        exec "$@"
    fi
else
    echo "No command provided, starting interactive shell" >&2
    exec /bin/bash
fi

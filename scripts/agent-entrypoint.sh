#!/bin/bash

set -e

agent_type="${PROPR_AGENT_TYPE:-}"
if [ -z "$agent_type" ] && [ "$#" -gt 0 ]; then
    case "$1" in
        /home/node/claude-entrypoint.sh|/home/node/codex-entrypoint.sh|/home/node/antigravity-entrypoint.sh|/home/node/opencode-entrypoint.sh|/home/node/vibe-entrypoint.sh)
            exec "$1" "${@:2}"
            ;;
    esac
    case "$1" in
        claude) agent_type=claude ;;
        codex) agent_type=codex ;;
        agy|antigravity) agent_type=antigravity ;;
        opencode|opencode-run|/usr/local/bin/opencode-run) agent_type=opencode ;;
        vibe) agent_type=vibe ;;
    esac
    if [ -z "$agent_type" ]; then
        case "$1" in
            bash|sh|/bin/bash|/bin/sh)
                exec "$@"
                ;;
        esac
    fi
fi

case "$agent_type" in
    claude|codex|antigravity|opencode|vibe)
        exec "/home/node/${agent_type}-entrypoint.sh" "$@"
        ;;
    *)
        echo "Set PROPR_AGENT_TYPE to claude, codex, antigravity, opencode, or vibe" >&2
        exit 64
        ;;
esac

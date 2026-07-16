#!/bin/bash

set -e

agent_type="${PROPR_AGENT_TYPE:-}"
if [ -z "$agent_type" ] && [ "$#" -gt 0 ]; then
    case "$1" in
        claude) agent_type=claude ;;
        codex) agent_type=codex ;;
        agy) agent_type=antigravity ;;
        opencode) agent_type=opencode ;;
        vibe) agent_type=vibe ;;
    esac
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

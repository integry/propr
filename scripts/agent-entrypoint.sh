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
        # Agent Tank inspects every provider's credentials read-only, so it owns
        # no single agent type and must not run a per-agent entrypoint or its
        # ownership repair. Its mounts are :ro by construction, so there is
        # nothing to chown anyway.
        agent-tank|/usr/local/bin/agent-tank) agent_type=agent-tank ;;
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
    agent-tank)
        # Run the command as given, dropping privileges the same way the agent
        # entrypoints do so Agent Tank never reads credentials as root.
        if [ "$#" -eq 0 ]; then set -- agent-tank; fi
        if [ "$(id -u)" = "0" ]; then
            exec gosu node "$@"
        fi
        exec "$@"
        ;;
    *)
        echo "Set PROPR_AGENT_TYPE to claude, codex, antigravity, opencode, vibe, or agent-tank" >&2
        exit 64
        ;;
esac

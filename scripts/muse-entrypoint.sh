#!/bin/bash
set -euo pipefail

config_dir="${XDG_CONFIG_HOME:-/home/node/.config}/muse"
mkdir -p "$config_dir" /home/node/.local/share/muse

if [ "$(id -u)" = "0" ]; then
    if [ "${PROPR_MANAGED_CREDENTIALS:-0}" = "1" ]; then
        chown -R node:node "$config_dir" 2>/dev/null || true
        chmod -R u+rwX "$config_dir" 2>/dev/null || true
    fi
    chown -R node:node /home/node/.local/share/muse 2>/dev/null || true
fi

if [ ! -r "$config_dir/auth.json" ] && [ -z "${META_API_KEY:-}" ]; then
    echo "Warning: Muse Code credentials not found at $config_dir/auth.json" >&2
fi

git config --global --add safe.directory '*' 2>/dev/null || true
if [ -x /usr/local/bin/gh-wrapper ]; then
    mkdir -p /home/node/bin
    ln -sf /usr/local/bin/gh-wrapper /home/node/bin/gh
    export PATH="/home/node/bin:$PATH"
fi

if [ $# -eq 0 ]; then
    exec /bin/bash
fi
if [ "$(id -u)" = "0" ]; then
    cd /home/node/workspace
    exec su-exec node env HOME=/home/node USER=node LOGNAME=node XDG_CONFIG_HOME=/home/node/.config "$@"
fi
exec "$@"

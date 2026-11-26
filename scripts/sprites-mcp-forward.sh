#!/bin/bash
# Starts or stops the per-run sshd that carries ProPR MCP into a Sprite over an
# SSH reverse forward from the worker (Sprites without a public MCP URL).
#
#   mcp-forward.sh start <inbox dir>   install the run's host key, authorized key
#                                      and sshd_config from <inbox dir>, then start sshd
#   mcp-forward.sh stop                stop the run's sshd and remove its files
#
# The worker generates both keys per run. sshd listens on 127.0.0.1 only (the
# Sprites API proxy is its only way in), authorizes that one key, and permits
# nothing but the loopback MCP listener (see spritesMcpSshdConfig).
set -euo pipefail

run_dir=/run/propr-mcp-forward
inbox=/opt/propr/inbox

die() { echo "ProPR MCP forward: $*" >&2; exit 1; }

stop_sshd() {
    local pid
    if [ -f "$run_dir/sshd.pid" ]; then
        pid="$(cat "$run_dir/sshd.pid")"
        # Per-connection children hold the forwarded listener: stop them with the daemon.
        case "$pid" in ''|*[!0-9]*) ;; *) pkill -TERM -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true ;; esac
    fi
    rm -rf -- "$run_dir"
}

# Sourcing the script (the unit tests do) only defines the functions above.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then return 0; fi

[ "$(id -u)" = "0" ] || die "must run as root (sudo -n)"
case "${1:-}" in
start)
    src="${2:?usage: mcp-forward.sh start <inbox dir>}"
    case "$src" in "$inbox"/mcp-forward-*) ;; *) die "refusing files outside $inbox" ;; esac
    case "$src" in */../*|*/..) die "refusing a relative path" ;; esac
    [ -d "$src" ] && [ ! -L "$src" ] || die "missing forward directory"
    for file in host_key authorized_keys sshd_config; do
        [ -f "$src/$file" ] && [ ! -L "$src/$file" ] || die "missing $file"
    done
    sshd="$(command -v sshd || true)"
    [ -n "$sshd" ] || sshd=/usr/sbin/sshd
    [ -x "$sshd" ] || die "sshd is not installed on this Sprite"
    id propr-mcp >/dev/null 2>&1 || die "the propr-mcp user is missing"
    stop_sshd
    install -d -m 0755 -o root -g root "$run_dir"
    install -m 0600 -o root -g root "$src/host_key" "$run_dir/host_key"
    install -m 0644 -o root -g root "$src/authorized_keys" "$run_dir/authorized_keys"
    install -m 0600 -o root -g root "$src/sshd_config" "$run_dir/sshd_config"
    rm -rf -- "$src"
    install -d -m 0755 -o root -g root /run/sshd
    "$sshd" -t -f "$run_dir/sshd_config"
    # sshd binds before it daemonizes, so the listener is up when this returns.
    "$sshd" -f "$run_dir/sshd_config" -E "$run_dir/sshd.log"
    ;;
stop)
    stop_sshd
    ;;
*)
    die "usage: mcp-forward.sh start <inbox dir> | stop"
    ;;
esac

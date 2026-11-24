#!/bin/bash
# Provisions a Fly Sprite for ProPR agent runs (the Sprites agent runtime).
#
# A Sprite cannot boot the propr/agent image, so this reproduces the parts of
# it the provider entrypoints and the clone workspace transport rely on:
#   - an unprivileged `node` user with /home/node (never in sudoers);
#   - su-exec and gosu (shims over setpriv when the Sprite has neither);
#   - the agent CLIs at the versions Dockerfile.agent pins, under /opt/propr,
#     ahead of the Sprite's preinstalled (older) CLIs on the run's PATH;
#   - the entrypoint scripts, which root runs, in the root-owned
#     /opt/propr/entrypoints (not /home/node as in the image: the repository
#     setup hook runs as node before the root-run provider entrypoint, and node
#     owns /home/node), and the gh wrapper at /usr/local/bin/gh-wrapper;
#   - the image's git configuration for the node user.
# It is idempotent and records PROPR_SPRITES_SETUP_HASH in
# /opt/propr/sprites-setup.hash; the runtime checkpoints the Sprite after it.
#
# Usage (as root): env CLAUDE_CLI_VERSION=... CODEX_CLI_VERSION=... \
#   [ANTIGRAVITY_CLI_VERSION=... ANTIGRAVITY_CLI_RELEASE_ID=... ANTIGRAVITY_CLI_SHA512=...] \
#   PROPR_SPRITES_SETUP_HASH=... bash sprites-agent-setup.sh <directory with the entrypoint scripts>
set -euo pipefail

log() { echo "ProPR Sprite setup: $*" >&2; }
die() { log "$*"; exit 1; }

# Sprites ship Node through an nvm shim (/.sprite/bin/node) that only the
# default user's PATH contains; sudo's secure_path drops it, so root and the
# node user would have no node. Link the shim's real bin directory's node, npm
# and npx into <target dir> (a directory on every PATH) when node is missing.
link_sprite_node() {
    local shim="$1" target_dir="$2" real_node real_dir bin
    command -v node >/dev/null 2>&1 && return 0
    [ -x "$shim" ] || return 0
    real_node="$("$shim" -p 'process.execPath' 2>/dev/null || true)"
    if [ -z "$real_node" ] || [ ! -x "$real_node" ]; then return 0; fi
    real_dir="$(dirname "$real_node")"
    log "linking node, npm and npx from $real_dir into $target_dir"
    for bin in node npm npx; do
        if [ -e "$real_dir/$bin" ]; then ln -sf "$real_dir/$bin" "$target_dir/$bin"; fi
    done
    hash -r
}

installed_version() { "$@" --version 2>/dev/null | head -n 1 || true; }
# Installs <package>@<version> under $npm_prefix and links <bin name> into
# $bin_dir. npm 12 (on Sprites) blocks install scripts that allowScripts does
# not cover, which leaves Claude Code without its native binary, so the pinned
# package's own scripts are allowed explicitly.
pin_npm_cli() {
    local package="$1" version="$2" bin_name="$3"
    if ! installed_version "$npm_prefix/bin/$bin_name" | grep -qF "$version"; then
        log "installing $package@$version"
        npm install --global --no-fund --no-audit --allow-scripts="$package" --prefix "$npm_prefix" "$package@$version" >&2
    fi
    ln -sf "$npm_prefix/bin/$bin_name" "$bin_dir/$bin_name"
    installed_version "$bin_dir/$bin_name" | grep -qF "$version" || die "$bin_name is not at the pinned version $version"
}

# su-exec compatible shim over setpriv: like su-exec and gosu, it sets HOME
# to the target user's home (setpriv alone keeps the caller's, e.g. /root).
write_privilege_shim() {
    cat > "$1" <<'SHIM'
#!/bin/sh
# su-exec compatible: <user>[:<group>] <command> [args...]
set -e
spec="$1"; shift
user="${spec%%:*}"
if [ "$user" != "$spec" ]; then group="${spec#*:}"; else group="$(id -gn "$user")"; fi
home="$(getent passwd "$user" | cut -d: -f6)"
if [ -n "$home" ]; then HOME="$home"; export HOME; fi
exec setpriv --reuid="$(id -u "$user")" --regid="$(getent group "$group" | cut -d: -f3)" --init-groups -- "$@"
SHIM
    chmod 755 "$1"
}

# The image's git configuration for <user>, written to <home>/.gitconfig. HOME
# is explicit: setup runs under sudo with HOME=/root, which a privilege drop
# need not change, and git would then target root's unwritable ~/.gitconfig.
configure_agent_git() {
    local user="$1" home="$2"
    su-exec "$user" env HOME="$home" git config --global user.name "ProPR Agent Bot"
    su-exec "$user" env HOME="$home" git config --global user.email "agent-bot@propr.dev"
    su-exec "$user" env HOME="$home" git config --global init.defaultBranch main
    su-exec "$user" env HOME="$home" git config --global --replace-all safe.directory '*'
}

# Whether <user> can modify neither <path> nor any directory above it: none
# is owned by <user>, world-writable, or group-writable for a group <user> is
# in. A symlink is checked along with its target.
beyond_user_control() {
    local user="$1" path="$2" uid groups current mode
    uid="$(id -u "$user")" || return 1
    groups=" $(id -G "$user") "
    for current in "$path" "$(readlink -f -- "$path")"; do
        while :; do
            [ -e "$current" ] || [ -L "$current" ] || return 1
            [ "$(stat -c %u -- "$current")" != "$uid" ] || return 1
            mode="$(stat -c %a -- "$current")"
            (( (8#$mode & 8#002) == 0 )) || [ -L "$current" ] || return 1
            if (( (8#$mode & 8#020) != 0 )) && [ ! -L "$current" ]; then
                case "$groups" in *" $(stat -c %g -- "$current") "*) return 1 ;; esac
            fi
            [ "$current" != / ] || break
            current="$(dirname -- "$current")"
        done
    done
}

# Installs the entrypoint scripts root runs into <directory> (owned by the
# caller, root during setup), pointing their references to each other and to
# the gh wrapper directory at the protected copies instead of /home/node.
install_root_entrypoints() {
    local source_dir="$1" entry_dir="$2" gh_bin_dir="$3" script
    install -d -m 0755 "$entry_dir" "$gh_bin_dir"
    ln -sfn /usr/local/bin/gh-wrapper "$gh_bin_dir/gh"
    for script in agent-entrypoint.sh claude-entrypoint.sh codex-entrypoint.sh antigravity-entrypoint.sh; do
        sed -e "s#/home/node/\([^/\"' ]*-entrypoint\.sh\)#$entry_dir/\1#g" -e "s#/home/node/bin\>#$gh_bin_dir#g" "$source_dir/$script" > "$entry_dir/$script.tmp"
        if grep -qE '/home/node/[^[:space:]]*entrypoint|/home/node/bin\>' "$entry_dir/$script.tmp"; then
            rm -f "$entry_dir/$script.tmp"; die "$script still refers to an entrypoint or PATH directory under /home/node"
        fi
        chmod 0755 "$entry_dir/$script.tmp"
        mv -f "$entry_dir/$script.tmp" "$entry_dir/$script"
    done
}

# Sourcing the script (the unit tests do) only defines the functions above.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then return 0; fi

source_dir="${1:?usage: sprites-agent-setup.sh <directory with the entrypoint scripts>}"
: "${CLAUDE_CLI_VERSION:?CLAUDE_CLI_VERSION is required}"
: "${CODEX_CLI_VERSION:?CODEX_CLI_VERSION is required}"
: "${PROPR_SPRITES_SETUP_HASH:?PROPR_SPRITES_SETUP_HASH is required}"

[ "$(id -u)" = "0" ] || die "must run as root (sudo -n)"
# The launcher reads NUL-separated records with mapfile -d (bash 4.4+).
[ "${BASH_VERSINFO[0]}" -gt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -ge 4 ]; } || die "bash 4.4 or later is required"
link_sprite_node /.sprite/bin/node /usr/local/bin
for tool in node npm git curl tar sha512sum mkfifo tee stat install useradd sed readlink; do
    command -v "$tool" >/dev/null 2>&1 || die "required tool $tool is missing on this Sprite"
done

prefix=/opt/propr
bin_dir="$prefix/bin"
npm_prefix="$prefix/npm"
entry_dir="$prefix/entrypoints"
gh_bin_dir="$prefix/gh-bin"
mkdir -p "$bin_dir" "$npm_prefix"
chown root:root "$prefix" "$bin_dir"
chmod 755 "$prefix" "$bin_dir"

# --- node user -----------------------------------------------------------
if ! id node >/dev/null 2>&1; then
    useradd --create-home --home-dir /home/node --shell /bin/bash --user-group node
fi
[ "$(id -u node)" != "0" ] || die "the node user must not be root"
[ "$(getent passwd node | cut -d: -f6)" = "/home/node" ] || die "the node user's home must be /home/node"
for group in sudo wheel admin; do gpasswd -d node "$group" >/dev/null 2>&1 || true; done
rm -f /etc/sudoers.d/node
mkdir -p /home/node/workspace /home/node/.local/bin
chown node:node /home/node /home/node/workspace /home/node/.local /home/node/.local/bin
chmod 755 /home/node

# --- privilege drop ------------------------------------------------------
if ! command -v su-exec >/dev/null 2>&1; then
    if command -v gosu >/dev/null 2>&1; then ln -sf "$(command -v gosu)" /usr/local/bin/su-exec
    else command -v setpriv >/dev/null 2>&1 || die "neither su-exec, gosu nor setpriv is available"; write_privilege_shim /usr/local/bin/su-exec; fi
fi
command -v gosu >/dev/null 2>&1 || ln -sf "$(command -v su-exec)" /usr/local/bin/gosu
[ "$(su-exec node id -u)" = "$(id -u node)" ] || die "su-exec cannot drop to the node user"

# --- pinned CLIs ---------------------------------------------------------
pin_npm_cli @anthropic-ai/claude-code "$CLAUDE_CLI_VERSION" claude
pin_npm_cli @openai/codex "$CODEX_CLI_VERSION" codex

if [ -n "${ANTIGRAVITY_CLI_VERSION:-}" ] && [ -n "${ANTIGRAVITY_CLI_RELEASE_ID:-}" ] && [ -n "${ANTIGRAVITY_CLI_SHA512:-}" ]; then
    if [ "$(installed_version "$bin_dir/agy")" != "$ANTIGRAVITY_CLI_VERSION" ]; then
        log "installing Antigravity CLI $ANTIGRAVITY_CLI_VERSION"
        work="$(mktemp -d)"
        curl --fail --show-error --silent --location --connect-timeout 20 --max-time 300 --retry 5 --retry-all-errors \
            -o "$work/agy.tar.gz" \
            "https://storage.googleapis.com/antigravity-public/antigravity-cli/${ANTIGRAVITY_CLI_VERSION}-${ANTIGRAVITY_CLI_RELEASE_ID}/linux-x64/cli_linux_x64.tar.gz"
        echo "${ANTIGRAVITY_CLI_SHA512}  $work/agy.tar.gz" | sha512sum -c - >&2
        [ "$(tar -tzf "$work/agy.tar.gz")" = antigravity ] || die "unexpected Antigravity CLI archive layout"
        tar -xzf "$work/agy.tar.gz" -C "$work" antigravity
        install -m 0755 "$work/antigravity" "$bin_dir/agy"
        rm -rf "$work"
    fi
    [ "$(installed_version "$bin_dir/agy")" = "$ANTIGRAVITY_CLI_VERSION" ] || die "agy is not at the pinned version $ANTIGRAVITY_CLI_VERSION"
    ln -sf "$bin_dir/agy" /home/node/.local/bin/agy
fi

# --- entrypoint contract -------------------------------------------------
install -m 0755 "$source_dir/gh-wrapper.sh" /usr/local/bin/gh-wrapper
install_root_entrypoints "$source_dir" "$entry_dir" "$gh_bin_dir"
# Copies an earlier revision installed where node could replace them.
for script in agent-entrypoint.sh claude-entrypoint.sh codex-entrypoint.sh antigravity-entrypoint.sh; do rm -f "/home/node/$script"; done
# Everything root executes for a run, and every directory above it, must stay out of node's reach.
for path in "$entry_dir"/*-entrypoint.sh "$gh_bin_dir/gh" "$bin_dir" "$npm_prefix" /usr/local/bin/gh-wrapper "$(command -v su-exec)" "$(command -v gosu)"; do
    beyond_user_control node "$path" || die "the node user can modify $path or a directory above it, so it could replace what root runs"
done

configure_agent_git node /home/node

{
    echo "claude $("$bin_dir/claude" --version 2>/dev/null | head -n 1)"
    echo "codex $("$bin_dir/codex" --version 2>/dev/null | head -n 1)"
    [ ! -x "$bin_dir/agy" ] || echo "agy $("$bin_dir/agy" --version 2>/dev/null | head -n 1)"
} > "$prefix/sprites-cli-versions"
printf '%s\n' "$PROPR_SPRITES_SETUP_HASH" > "$prefix/sprites-setup.hash"
log "ready ($PROPR_SPRITES_SETUP_HASH)"

#!/bin/bash
# Provisions a Fly Sprite for ProPR agent runs (the Sprites agent runtime).
#
# A Sprite cannot boot the propr/agent image, so this reproduces the parts of
# it the provider entrypoints and the clone workspace transport rely on:
#   - an unprivileged `node` user with /home/node (never in sudoers);
#   - su-exec and gosu (shims over setpriv when the Sprite has neither);
#   - the agent CLIs at the versions Dockerfile.agent pins, under /opt/propr,
#     ahead of the Sprite's preinstalled (older) CLIs on the run's PATH;
#   - the entrypoint scripts at /home/node/<agent>-entrypoint.sh and the gh
#     wrapper at /usr/local/bin/gh-wrapper, as in the image;
#   - the image's git configuration for the node user.
# It is idempotent and records PROPR_SPRITES_SETUP_HASH in
# /opt/propr/sprites-setup.hash; the runtime checkpoints the Sprite after it.
#
# Usage (as root): env CLAUDE_CLI_VERSION=... CODEX_CLI_VERSION=... \
#   [ANTIGRAVITY_CLI_VERSION=... ANTIGRAVITY_CLI_RELEASE_ID=... ANTIGRAVITY_CLI_SHA512=...] \
#   PROPR_SPRITES_SETUP_HASH=... bash sprites-agent-setup.sh <directory with the entrypoint scripts>
set -euo pipefail

source_dir="${1:?usage: sprites-agent-setup.sh <directory with the entrypoint scripts>}"
: "${CLAUDE_CLI_VERSION:?CLAUDE_CLI_VERSION is required}"
: "${CODEX_CLI_VERSION:?CODEX_CLI_VERSION is required}"
: "${PROPR_SPRITES_SETUP_HASH:?PROPR_SPRITES_SETUP_HASH is required}"

log() { echo "ProPR Sprite setup: $*" >&2; }
die() { log "$*"; exit 1; }

[ "$(id -u)" = "0" ] || die "must run as root (sudo -n)"
# The launcher reads NUL-separated records with mapfile -d (bash 4.4+).
[ "${BASH_VERSINFO[0]}" -gt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -ge 4 ]; } || die "bash 4.4 or later is required"
for tool in node npm git curl tar sha512sum mkfifo tee stat install useradd; do
    command -v "$tool" >/dev/null 2>&1 || die "required tool $tool is missing on this Sprite"
done

prefix=/opt/propr
bin_dir="$prefix/bin"
npm_prefix="$prefix/npm"
mkdir -p "$bin_dir" "$npm_prefix"
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
write_privilege_shim() {
    cat > "$1" <<'SHIM'
#!/bin/sh
# su-exec compatible: <user>[:<group>] <command> [args...]
set -e
spec="$1"; shift
user="${spec%%:*}"
if [ "$user" != "$spec" ]; then group="${spec#*:}"; else group="$(id -gn "$user")"; fi
exec setpriv --reuid="$(id -u "$user")" --regid="$(getent group "$group" | cut -d: -f3)" --init-groups -- "$@"
SHIM
    chmod 755 "$1"
}
if ! command -v su-exec >/dev/null 2>&1; then
    if command -v gosu >/dev/null 2>&1; then ln -sf "$(command -v gosu)" /usr/local/bin/su-exec
    else command -v setpriv >/dev/null 2>&1 || die "neither su-exec, gosu nor setpriv is available"; write_privilege_shim /usr/local/bin/su-exec; fi
fi
command -v gosu >/dev/null 2>&1 || ln -sf "$(command -v su-exec)" /usr/local/bin/gosu
[ "$(su-exec node id -u)" = "$(id -u node)" ] || die "su-exec cannot drop to the node user"

# --- pinned CLIs ---------------------------------------------------------
installed_version() { "$@" --version 2>/dev/null | head -n 1 || true; }
pin_npm_cli() {
    local package="$1" version="$2" bin_name="$3"
    if ! installed_version "$npm_prefix/bin/$bin_name" | grep -qF "$version"; then
        log "installing $package@$version"
        npm install --global --no-fund --no-audit --prefix "$npm_prefix" "$package@$version" >&2
    fi
    ln -sf "$npm_prefix/bin/$bin_name" "$bin_dir/$bin_name"
    installed_version "$bin_dir/$bin_name" | grep -qF "$version" || die "$bin_name is not at the pinned version $version"
}
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
for script in agent-entrypoint.sh claude-entrypoint.sh codex-entrypoint.sh antigravity-entrypoint.sh; do
    install -m 0755 -o node -g node "$source_dir/$script" "/home/node/$script"
done
install -m 0755 "$source_dir/gh-wrapper.sh" /usr/local/bin/gh-wrapper

su-exec node git config --global user.name "ProPR Agent Bot"
su-exec node git config --global user.email "agent-bot@propr.dev"
su-exec node git config --global init.defaultBranch main
su-exec node git config --global --replace-all safe.directory '*'

{
    echo "claude $("$bin_dir/claude" --version 2>/dev/null | head -n 1)"
    echo "codex $("$bin_dir/codex" --version 2>/dev/null | head -n 1)"
    [ ! -x "$bin_dir/agy" ] || echo "agy $("$bin_dir/agy" --version 2>/dev/null | head -n 1)"
} > "$prefix/sprites-cli-versions"
printf '%s\n' "$PROPR_SPRITES_SETUP_HASH" > "$prefix/sprites-setup.hash"
log "ready ($PROPR_SPRITES_SETUP_HASH)"

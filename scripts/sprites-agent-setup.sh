#!/bin/bash
# Provisions a Fly Sprite for ProPR agent runs (the Sprites agent runtime).
#
set -euo pipefail

log() { echo "ProPR Sprite setup: $*" >&2; }
die() { log "$*"; exit 1; }

# Sprites ship Node through an nvm shim (/.sprite/bin/node) that only the
# default user's PATH contains; sudo's secure_path drops it, so root and the
# node user would have no node. Link the shim's real bin directory's node, npm
# and npx into <target dir> (a directory on every PATH).
link_sprite_node() {
    local shim="$1" target_dir="$2" real_node real_dir bin
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
    ln -sf "$bin_dir/$bin_name" "/usr/local/bin/$bin_name"
    installed_version "$bin_dir/$bin_name" | grep -qF "$version" || die "$bin_name is not at the pinned version $version"
}

# Installs uv <version> (Dockerfile.agent's uv image pin) into $bin_dir from its
# release archive, checked against the release's published SHA-256.
pin_uv() {
    local version="$1" arch work archive url
    if installed_version "$bin_dir/uv" | grep -qF "uv $version"; then return 0; fi
    case "$(uname -m)" in
        x86_64|amd64) arch=x86_64 ;;
        aarch64|arm64) arch=aarch64 ;;
        *) die "no uv release for $(uname -m)" ;;
    esac
    log "installing uv $version"
    work="$(mktemp -d)"
    archive="uv-$arch-unknown-linux-gnu.tar.gz"
    url="https://github.com/astral-sh/uv/releases/download/$version/$archive"
    curl --fail --show-error --silent --location --connect-timeout 20 --max-time 300 --retry 5 --retry-all-errors -o "$work/$archive" "$url"
    curl --fail --show-error --silent --location --connect-timeout 20 --max-time 60 --retry 5 --retry-all-errors -o "$work/$archive.sha256" "$url.sha256"
    (cd "$work" && sha256sum -c "$archive.sha256" >&2) || die "uv $version archive checksum mismatch"
    tar -xzf "$work/$archive" -C "$work"
    install -m 0755 "$work/uv-$arch-unknown-linux-gnu/uv" "$work/uv-$arch-unknown-linux-gnu/uvx" "$bin_dir/"
    rm -rf "$work"
    installed_version "$bin_dir/uv" | grep -qF "uv $version" || die "uv is not at the pinned version $version"
}

# Installs mistral-vibe <version> on uv-managed Python <python> (mistral-vibe
# publishes only cp312 wheels), as Dockerfile.agent's vibe-cli stage does.
# The tool and the interpreter live under /opt/uv, readable by node, at the
# image's paths (the prompt-file adapter's shebang names the tool's Python).
pin_vibe() {
    local version="$1" python="$2"
    export UV_TOOL_DIR=/opt/uv/tools UV_TOOL_BIN_DIR="$bin_dir" UV_PYTHON_INSTALL_DIR=/opt/uv/python UV_CACHE_DIR=/opt/uv/cache
    if ! installed_version "$bin_dir/vibe" | grep -qF "$version"; then
        log "installing mistral-vibe $version on Python $python"
        "$bin_dir/uv" tool install --force --python "$python" "mistral-vibe==$version" >&2
        "$bin_dir/uv" cache clean >&2 || true
        rm -rf "$UV_CACHE_DIR"
    fi
    chmod -R a+rX /opt/uv
    if [ ! -e "$bin_dir/vibe-acp" ]; then ln -s "$bin_dir/vibe" "$bin_dir/vibe-acp"; fi
    ln -sf "$bin_dir/vibe" /usr/local/bin/vibe
    ln -sf "$bin_dir/vibe-acp" /usr/local/bin/vibe-acp
    installed_version su-exec node "$bin_dir/vibe" | grep -qF "$version" || die "vibe is not at the pinned version $version"
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
exec setpriv --reuid="$(id -u "$user")" --regid="$(getent group "$group" | cut -d: -f3)" --clear-groups --no-new-privs -- "$@"
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

verify_node_sudo() {
    local sudo_listing
    # Some sudo versions return success even for an explicit denial.
    sudo_listing="$(LC_ALL=C sudo -l -U node 2>&1)" || true
    case "$sudo_listing" in
        *"may run the following"*) die "node has sudo privileges" ;;
        *"User node is not allowed to run sudo"*) ;;
        *) die "could not verify sudo privileges for node: $sudo_listing" ;;
    esac
}

# openssh-server for the per-run ProPR MCP reverse forward (scripts/sprites-mcp-forward.sh).
# Package scripts must not start a system sshd (it would listen on every
# address); the forward starts its own loopback-only sshd per run.
install_forward_sshd() {
    local policy=/usr/sbin/policy-rc.d had_policy=0
    if [ -x /usr/sbin/sshd ]; then return 0; fi
    command -v apt-get >/dev/null 2>&1 || { log "apt-get is unavailable; runs without a public ProPR MCP URL will be refused"; return 0; }
    log "installing openssh-server for the ProPR MCP reverse forward"
    if [ -e "$policy" ]; then had_policy=1; mv "$policy" "$policy.propr"; fi
    printf '#!/bin/sh\nexit 101\n' > "$policy"
    chmod 755 "$policy"
    if ! DEBIAN_FRONTEND=noninteractive apt-get update -qq >&2 \
        || ! DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openssh-server >&2; then
        log "openssh-server could not be installed; runs without a public ProPR MCP URL will be refused"
    fi
    rm -f "$policy"
    if [ "$had_policy" = 1 ]; then mv "$policy.propr" "$policy"; fi
}

# Keep any packaged sshd from starting at boot and stop one that is running now.
disable_system_sshd() {
    if command -v systemctl >/dev/null 2>&1; then
        systemctl disable --now ssh.service ssh.socket sshd.service >/dev/null 2>&1 || true
        systemctl mask ssh.service ssh.socket sshd.service >/dev/null 2>&1 || true
    fi
    pkill -x sshd >/dev/null 2>&1 || true
}

# The forward's login user: no shell, no password (non-locked so key auth works without PAM).
ensure_forward_user() {
    local shell=/usr/sbin/nologin
    [ -x "$shell" ] || shell=/bin/false
    if ! id propr-mcp >/dev/null 2>&1; then
        useradd --system --no-create-home --home-dir /nonexistent --shell "$shell" --user-group propr-mcp
    fi
    [ "$(id -u propr-mcp)" != "0" ] || die "the propr-mcp user must not be root"
    usermod -p '*' propr-mcp
    for group in sudo wheel admin; do gpasswd -d propr-mcp "$group" >/dev/null 2>&1 || true; done
}

# Sourcing the script (the unit tests do) only defines the functions above.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then return 0; fi

source_dir="${1:?usage: sprites-agent-setup.sh <directory with the entrypoint scripts>}"
: "${CLAUDE_CLI_VERSION:?CLAUDE_CLI_VERSION is required}"
: "${CODEX_CLI_VERSION:?CODEX_CLI_VERSION is required}"
: "${OPENCODE_CLI_VERSION:?OPENCODE_CLI_VERSION is required}"
: "${VIBE_CLI_VERSION:?VIBE_CLI_VERSION is required}"
: "${VIBE_PYTHON_VERSION:?VIBE_PYTHON_VERSION is required}"
: "${UV_VERSION:?UV_VERSION is required}"


[ "$(id -u)" = "0" ] || die "must run as root (sudo -n)"
link_sprite_node /.sprite/bin/node /usr/local/bin
for tool in node npm git curl tar sha512sum mkfifo tee stat install useradd sed readlink unshare mount find; do
    command -v "$tool" >/dev/null 2>&1 || die "required tool $tool is missing on this Sprite"
done

prefix=/opt/propr
bin_dir="$prefix/bin"
npm_prefix="$prefix/npm"
mkdir -p "$bin_dir" "$npm_prefix"
chown root:root "$prefix" "$bin_dir"
chmod 755 "$prefix" "$bin_dir"
install -d -m 0700 -o "${SUDO_UID:?missing Sprite filesystem user}" "$prefix/inbox"

# --- node user -----------------------------------------------------------
if ! id node >/dev/null 2>&1; then
    useradd --create-home --home-dir /home/node --shell /bin/bash --user-group node
fi
[ "$(id -u node)" != "0" ] || die "the node user must not be root"
[ "$(getent passwd node | cut -d: -f6)" = "/home/node" ] || die "the node user's home must be /home/node"
for group in sudo wheel admin; do gpasswd -d node "$group" >/dev/null 2>&1 || true; done
rm -f /etc/sudoers.d/node
verify_node_sudo
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
# Dockerfile.agent's package choice: series 1 pins are opencode-ai, later ones @opencode/cli.
case "$OPENCODE_CLI_VERSION" in 1.*) opencode_package=opencode-ai ;; *) opencode_package=@opencode/cli ;; esac
pin_npm_cli "$opencode_package" "$OPENCODE_CLI_VERSION" opencode
pin_uv "$UV_VERSION"
pin_vibe "$VIBE_CLI_VERSION" "$VIBE_PYTHON_VERSION"

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
ln -sf "$bin_dir/agy" /usr/local/bin/agy

# These entrypoints and the repository hook are invoked only after the privilege drop.
install -d -m 0755 /opt/propr/entrypoints
for script in claude-entrypoint.sh codex-entrypoint.sh antigravity-entrypoint.sh opencode-entrypoint.sh vibe-entrypoint.sh; do
    install -m 0755 "$source_dir/$script" "/opt/propr/entrypoints/$script"
done
# The OpenCode stdin prompt runner and the Vibe prompt-file adapter, at the image's paths.
install -m 0755 "$source_dir/opencode-run.sh" /usr/local/bin/opencode-run
install -m 0755 "$source_dir/vibe-prompt-file-runner.py" /usr/local/bin/propr-vibe-prompt-file
install -m 0755 "$source_dir/gh-wrapper.sh" /usr/local/bin/gh-wrapper
install -m 0755 "$source_dir/sprites-launcher.py" /opt/propr/launcher.py
# Package and catalog stdio MCP servers run through the same bridge as in the Docker task image.
install -m 0644 "$source_dir/extension-stdio-bridge.mjs" /opt/propr/extension-stdio-bridge.mjs

# --- ProPR MCP reverse forward -------------------------------------------
install_forward_sshd
disable_system_sshd
ensure_forward_user
install -m 0755 "$source_dir/sprites-mcp-forward.sh" /opt/propr/mcp-forward.sh
configure_agent_git node /home/node

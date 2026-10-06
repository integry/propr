# Bounded removal of the private temporary root created by smoke-local-runtime.sh
# and by scripts/smoke-test-preview-runtime-images.sh.
#
# A rootful Docker daemon creates files inside the bind-mounted data root as the
# container user (root), e.g. a 0700 `data/web-push` directory the host user
# cannot traverse or empty.  The host user removes what it can; anything left is
# removed by a short-lived, unprivileged, network-less container that mounts only
# this invocation's verified root.  Every refusal or leftover is reported and
# returned as a failure: generated data is never silently left behind.

# Prints a stat field using GNU (`-c`) or BSD (`-f`) syntax.
_smoke_stat() {
  stat -c "$1" -- "$3" 2>/dev/null || stat -f "$2" -- "$3" 2>/dev/null
}

# Device:inode of a path, recorded at creation to pin the exact directory.
smoke_root_identity() {
  _smoke_stat '%d:%i' '%d:%i' "$1"
}

# Refuses anything other than the exact private directory this run created:
# a direct, non-symlink child of the canonical temporary base with one of the
# two smoke mktemp name shapes, owned by the current user, mode 0700 and the
# recorded identity.
smoke_root_is_owned() {
  local root="$1" base="$2" identity="$3" parent name mode
  [[ "$base" == /* && "$root" == /* && -n "$identity" ]] || { echo "smoke cleanup: refusing non-absolute target $root" >&2; return 1; }
  name="${root##*/}"
  parent="${root%/*}"
  if [[ "$parent" != "$base" || ! "$name" =~ ^propr-(desktop|preview)-runtime-smoke\.[A-Za-z0-9]{6}$ ]]; then
    echo "smoke cleanup: refusing target outside the private smoke root shape: $root" >&2
    return 1
  fi
  if [[ -L "$root" || ! -d "$root" ]]; then
    echo "smoke cleanup: refusing non-directory or symlink target: $root" >&2
    return 1
  fi
  if [[ ! -O "$root" ]]; then
    echo "smoke cleanup: refusing target not owned by the current user: $root" >&2
    return 1
  fi
  mode="$(_smoke_stat '%a' '%Lp' "$root")"
  if [[ "$mode" != "700" ]]; then
    echo "smoke cleanup: refusing target with mode ${mode:-unknown} (expected 700): $root" >&2
    return 1
  fi
  if [[ "$(smoke_root_identity "$root")" != "$identity" ]]; then
    echo "smoke cleanup: refusing target whose identity changed since creation: $root" >&2
    return 1
  fi
}

# remove_smoke_root ROOT BASE IDENTITY IMAGE LABEL STACK
remove_smoke_root() {
  local root="$1" base="$2" identity="$3" image="$4" label="$5" stack="$6" host_errors
  [[ -e "$root" || -L "$root" ]] || return 0
  smoke_root_is_owned "$root" "$base" "$identity" || return 1

  host_errors="$(rm -rf -- "$root" 2>&1)" || true
  [[ -e "$root" || -L "$root" ]] || return 0

  # Container-created entries remain.  Re-verify immediately before mounting.
  smoke_root_is_owned "$root" "$base" "$identity" || return 1
  if [[ "$root" == *[,\"$'\n']* ]]; then
    echo "smoke cleanup: refusing to mount a path Docker cannot address exactly: $root" >&2
    return 1
  fi
  if ! docker run --rm --name "$stack-cleanup" --label "$label=$stack" \
    --network none --read-only --user 0:0 \
    --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges \
    --mount "type=bind,source=$root,target=/smoke-root" \
    --entrypoint find "$image" /smoke-root -xdev -mindepth 1 -delete; then
    echo "smoke cleanup: container cleanup of $root failed" >&2
  fi
  rmdir -- "$root" 2>/dev/null || true
  if [[ -e "$root" || -L "$root" ]]; then
    [[ -z "$host_errors" ]] || echo "$host_errors" >&2
    echo "smoke cleanup: generated smoke data remains at $root" >&2
    return 1
  fi
}

# Private temporary authority for scripts/integration-test-images.sh.
#
# The integration harness stages real developer configuration (the dev .env)
# for the launcher.  Everything it writes lives under one private root:
#
#   $TMPDIR/propr-itest-<uid>/            per-user base, 0700, owned by the caller
#   $TMPDIR/propr-itest-<uid>/<STACK>/    stack root, 0700, ownership marker 0600
#
# Directories are created 0700 and files 0600 at creation, independent of the
# caller's umask.  Existing paths are validated, never chmod/chown-ed into
# shape: a symlink, a wrong owner or mode, a missing or foreign ownership
# marker, or a directory whose identity changed is refused before any write,
# bind mount, or deletion.
#
# A rootful Docker daemon creates root-owned entries inside bind-mounted
# directories that the host user cannot remove.  Those are removed by a
# short-lived, network-less, minimum-capability container that mounts only the
# exact verified stack root.

ITEST_MARKER_NAME=".propr-itest-owner"
ITEST_MARKER_HEADER="propr-itest-root v1"
ITEST_STACK_PATTERN='^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$'

# Prints a stat field using GNU (`-c`) or BSD (`-f`) syntax.
_itest_stat() {
  stat -c "$1" -- "$3" 2>/dev/null || stat -f "$2" -- "$3" 2>/dev/null
}

# Device:inode of a path, recorded to pin the exact directory.
itest_identity() {
  _itest_stat '%d:%i' '%d:%i' "$1"
}

itest_mode() {
  _itest_stat '%a' '%Lp' "$1"
}

itest_valid_stack_name() {
  [[ "$1" =~ $ITEST_STACK_PATTERN ]]
}

# Refuses paths Docker cannot address exactly in -v/--mount arguments.
itest_mountable_path() {
  [[ "$1" == /* && "$1" != *[,:\"$'\n\r']* ]]
}

# itest_private_dir_ok PATH LABEL
# A real directory (not a symlink) owned by the current user with mode 0700.
itest_private_dir_ok() {
  local path="$1" label="$2" mode
  if [[ -L "$path" || ! -d "$path" ]]; then
    echo "✗ refusing $label $path: not a real directory (symlink or other file type)" >&2
    return 1
  fi
  if [[ ! -O "$path" ]]; then
    echo "✗ refusing $label $path: not owned by the current user" >&2
    return 1
  fi
  mode="$(itest_mode "$path")"
  if [[ "$mode" != "700" ]]; then
    echo "✗ refusing $label $path: mode ${mode:-unknown}, expected 700" >&2
    return 1
  fi
}

# itest_ensure_private_dir PATH LABEL
# Creates PATH as 0700 when absent, otherwise validates it as-is.  A path
# created concurrently by someone else fails validation rather than being used.
itest_ensure_private_dir() {
  local path="$1" label="$2"
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    mkdir -m 700 -- "$path" 2>/dev/null || true
  fi
  itest_private_dir_ok "$path" "$label"
}

# itest_write_private_file PATH < content
# Writes stdin to PATH with mode 0600 from creation.  An existing entry is
# replaced only when it is a regular file owned by the current user.
itest_write_private_file() {
  local path="$1" mode
  if [[ -L "$path" || ( -e "$path" && ! -f "$path" ) ]]; then
    echo "✗ refusing to write $path: not a regular file" >&2
    return 1
  fi
  if [[ -e "$path" ]]; then
    if [[ ! -O "$path" ]]; then
      echo "✗ refusing to write $path: not owned by the current user" >&2
      return 1
    fi
    rm -f -- "$path"
  fi
  ( umask 077 && set -o noclobber && cat > "$path" ) || {
    echo "✗ could not create private file $path" >&2
    return 1
  }
  mode="$(itest_mode "$path")"
  if [[ "$mode" != "600" ]]; then
    echo "✗ private file $path has mode ${mode:-unknown}, expected 600" >&2
    return 1
  fi
}

# itest_root_validate ROOT BASE STACK
# Validates an existing stack root and its ownership marker.  On success sets
# ITEST_ROOT_TOKEN and ITEST_ROOT_IDENTITY.
itest_root_validate() {
  local root="$1" base="$2" stack="$3" marker mode content expected_prefix token
  ITEST_ROOT_TOKEN=""
  ITEST_ROOT_IDENTITY=""
  if ! itest_valid_stack_name "$stack" || [[ "$root" != "$base/$stack" ]]; then
    echo "✗ refusing stack root $root: it is not $base/<STACK>" >&2
    return 1
  fi
  itest_private_dir_ok "$root" "stack root" || return 1
  marker="$root/$ITEST_MARKER_NAME"
  if [[ -L "$marker" || ! -f "$marker" || ! -O "$marker" ]]; then
    echo "✗ refusing stack root $root: it has no ownership marker from this harness." >&2
    echo "  Inspect it and remove it yourself, or choose a different STACK." >&2
    return 1
  fi
  mode="$(itest_mode "$marker")"
  if [[ "$mode" != "600" ]]; then
    echo "✗ refusing stack root $root: ownership marker mode ${mode:-unknown}, expected 600" >&2
    return 1
  fi
  content="$(head -c 512 -- "$marker")"
  expected_prefix="$ITEST_MARKER_HEADER"$'\n'"stack=$stack"$'\n'"token="
  token="${content#"$expected_prefix"}"
  if [[ "$token" == "$content" || ! "$token" =~ ^[0-9a-f]{32}$ ]]; then
    echo "✗ refusing stack root $root: ownership marker does not belong to stack $stack" >&2
    return 1
  fi
  ITEST_ROOT_TOKEN="$token"
  ITEST_ROOT_IDENTITY="$(itest_identity "$root")"
  [[ -n "$ITEST_ROOT_IDENTITY" ]]
}

# itest_root_create ROOT BASE STACK
# Creates a fresh 0700 stack root with a 0600 ownership marker.  Sets
# ITEST_ROOT_TOKEN and ITEST_ROOT_IDENTITY.
itest_root_create() {
  local root="$1" base="$2" stack="$3" token
  ITEST_ROOT_TOKEN=""
  ITEST_ROOT_IDENTITY=""
  if ! itest_valid_stack_name "$stack" || [[ "$root" != "$base/$stack" ]]; then
    echo "✗ refusing stack root $root: it is not $base/<STACK>" >&2
    return 1
  fi
  if ! mkdir -m 700 -- "$root" 2>/dev/null; then
    echo "✗ could not create stack root $root (it may have been created concurrently)" >&2
    return 1
  fi
  itest_private_dir_ok "$root" "stack root" || return 1
  token="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  [[ "$token" =~ ^[0-9a-f]{32}$ ]] || { echo "✗ could not generate a stack root token" >&2; return 1; }
  printf '%s\nstack=%s\ntoken=%s' "$ITEST_MARKER_HEADER" "$stack" "$token" \
    | itest_write_private_file "$root/$ITEST_MARKER_NAME" || return 1
  ITEST_ROOT_TOKEN="$token"
  ITEST_ROOT_IDENTITY="$(itest_identity "$root")"
  [[ -n "$ITEST_ROOT_IDENTITY" ]]
}

# itest_root_is_owned ROOT BASE STACK IDENTITY TOKEN
# Re-validates that ROOT is still the exact directory recorded earlier.
itest_root_is_owned() {
  local root="$1" base="$2" stack="$3" identity="$4" token="$5"
  [[ -n "$identity" && -n "$token" ]] || { echo "✗ refusing $root: no recorded identity" >&2; return 1; }
  itest_root_validate "$root" "$base" "$stack" || return 1
  if [[ "$ITEST_ROOT_IDENTITY" != "$identity" || "$ITEST_ROOT_TOKEN" != "$token" ]]; then
    echo "✗ refusing $root: its identity changed since it was validated" >&2
    return 1
  fi
}

# itest_remove_root ROOT BASE STACK IDENTITY TOKEN IMAGE
# Removes exactly the verified stack root.  Entries the host user cannot remove
# (created as root by containers) are deleted by a network-less container that
# mounts only this root.  Leftovers are reported and returned as a failure.
itest_remove_root() {
  local root="$1" base="$2" stack="$3" identity="$4" token="$5" image="$6" host_errors
  [[ -e "$root" || -L "$root" ]] || return 0
  itest_root_is_owned "$root" "$base" "$stack" "$identity" "$token" || return 1

  host_errors="$(rm -rf -- "$root" 2>&1)" || true
  [[ -e "$root" || -L "$root" ]] || return 0

  # Container-created entries remain.  The marker may already be gone, so pin
  # the directory by its recorded identity before mounting it.
  if [[ -L "$root" || ! -d "$root" || ! -O "$root" || "$(itest_identity "$root")" != "$identity" ]]; then
    echo "✗ refusing container cleanup of $root: its identity changed" >&2
    return 1
  fi
  if ! itest_mountable_path "$root"; then
    echo "✗ refusing to mount a path Docker cannot address exactly: $root" >&2
    return 1
  fi
  if ! docker run --rm --name "$stack-itest-cleanup-${token:0:12}" --label "com.propr.itest.root=$token" \
    --network none --read-only --user 0:0 \
    --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges \
    --mount "type=bind,source=$root,target=/itest-root" \
    --entrypoint find "$image" /itest-root -xdev -mindepth 1 -delete; then
    echo "✗ container cleanup of $root failed" >&2
  fi
  rmdir -- "$root" 2>/dev/null || true
  if [[ -e "$root" || -L "$root" ]]; then
    [[ -z "$host_errors" ]] || echo "$host_errors" >&2
    echo "✗ generated integration data remains at $root" >&2
    return 1
  fi
}

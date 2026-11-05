#!/usr/bin/env bash
# Fail when any layer of an image contains an overlayfs whiteout.
#
# Whiteouts are tar entries whose file name starts with `.wh.`: `.wh.<name>`
# deletes a path from a lower layer and `.wh..wh..opq` marks a directory
# opaque. Applying them needs overlay xattrs or whiteout devices that some
# snapshotters cannot create, for example rootless Docker, userxattr overlay
# mounts and OrbStack's containerd image store, which then refuse the whole
# image ("failed to convert whiteout file ... operation not permitted").
# Dockerfile.agent publishes a single layer so the agent image ships none;
# this check proves it on the image that was actually built.
#
# Usage:
#   scripts/check-image-whiteouts.sh IMAGE          # runs `docker save IMAGE`
#   scripts/check-image-whiteouts.sh --archive FILE # an existing `docker save` tarball
#
# Both the legacy (`<id>/layer.tar`) and the OCI layout written by the
# containerd image store are read through the archive's manifest.json, and
# compressed layer blobs are detected by GNU tar.

set -euo pipefail

usage() {
  echo "usage: $0 IMAGE | --archive DOCKER_SAVE_TARBALL" >&2
  exit 2
}

archive=
image=
case "${1:-}" in
  --archive)
    [[ $# -eq 2 && -n "$2" ]] || usage
    archive="$2"
    ;;
  ''|-*) usage ;;
  *)
    [[ $# -eq 1 ]] || usage
    image="$1"
    ;;
esac

work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/propr-image-whiteouts.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

# Extract once instead of keeping the saved tarball as well: the agent image is
# a few GB and every layer is listed separately below.
if [[ -n "$image" ]]; then
  docker save "$image" | tar -x -C "$work"
  label="$image"
else
  tar -x -C "$work" -f "$archive"
  label="$archive"
fi

if [[ ! -f "$work/manifest.json" ]]; then
  echo "✗ $label: no manifest.json in the saved image" >&2
  exit 1
fi

# A file rather than process substitution, so a bad manifest stops the script.
node -e '
  const manifest = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(manifest) || manifest.length !== 1 || !Array.isArray(manifest[0].Layers)) {
    console.error("expected exactly one image with a Layers list in manifest.json");
    process.exit(1);
  }
  for (const layer of manifest[0].Layers) {
    if (typeof layer !== "string" || layer.startsWith("/") || layer.split("/").includes("..")) {
      console.error(`unsafe layer path in manifest.json: ${JSON.stringify(layer)}`);
      process.exit(1);
    }
    console.log(layer);
  }
' "$work/manifest.json" > "$work/layers.list"
mapfile -t layers < "$work/layers.list"

if [[ "${#layers[@]}" -eq 0 ]]; then
  echo "✗ $label: manifest.json lists no layers" >&2
  exit 1
fi

failed=0
index=0
for layer in "${layers[@]}"; do
  if [[ ! -f "$work/$layer" ]]; then
    echo "✗ $label: layer $index ($layer) is missing from the saved image" >&2
    exit 1
  fi
  listing="$work/layer-$index.list"
  tar -t -f "$work/$layer" > "$listing"
  # Match on the last path component; directory entries end in a slash.
  whiteouts="$(sed -e 's#/*$##' "$listing" | awk -F/ 'index($NF, ".wh.") == 1' || true)"
  if [[ -n "$whiteouts" ]]; then
    failed=1
    count="$(printf '%s\n' "$whiteouts" | wc -l | tr -d ' ')"
    opaque="$(printf '%s\n' "$whiteouts" | awk -F/ '$NF == ".wh..wh..opq"' | wc -l | tr -d ' ')"
    echo "✗ layer $index ($layer): $count whiteout entries ($opaque opaque)" >&2
    printf '%s\n' "$whiteouts" | head -n 20 | sed 's/^/    /' >&2
    if [[ "$count" -gt 20 ]]; then
      echo "    ..." >&2
    fi
  fi
  index=$((index + 1))
done

if (( failed )); then
  echo "✗ $label contains overlayfs whiteouts; restricted snapshotters (rootless, userxattr overlay, OrbStack containerd) cannot unpack it" >&2
  exit 1
fi
echo "✓ $label: none of its ${#layers[@]} layers contains an overlayfs whiteout"

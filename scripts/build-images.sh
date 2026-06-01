#!/usr/bin/env bash
# Build (and optionally push) all Propr production images.
#
# Usage:
#   scripts/build-images.sh                    # build all images, no push
#   scripts/build-images.sh --push             # build + push to Docker Hub + GHCR
#   scripts/build-images.sh --push --dockerhub # push to Docker Hub only
#   scripts/build-images.sh --push --ghcr      # push to GHCR only
#   scripts/build-images.sh --platform linux/amd64,linux/arm64 --push  # multi-arch
#   scripts/build-images.sh --only app,ui      # build a subset
#
# Tags produced per image:
#   <registry>/<name>:<version>   — exact version from package.json
#   <registry>/<name>:<sha>       — short git SHA
#   <registry>/<name>:latest      — latest, unless PUSH_LATEST=false

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- Config -------------------------------------------------------------------
DOCKERHUB_NS="${DOCKERHUB_NS:-propr}"
GHCR_NS="${GHCR_NS:-ghcr.io/proprdev}"
GHCR_PREFIX="${GHCR_PREFIX:-propr-}"   # GHCR uses flat namespace: propr-app instead of propr/app
PUSH_LATEST="${PUSH_LATEST:-true}"

VERSION="$(node -p "require('./package.json').version")"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo 'nogit')"

# --- Arg parsing --------------------------------------------------------------
PUSH=false
PUSH_DH=true
PUSH_GHCR=true
PLATFORM=""   # empty = native platform
ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --push) PUSH=true; shift ;;
    --dockerhub) PUSH_GHCR=false; shift ;;
    --ghcr) PUSH_DH=false; shift ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    -h|--help) sed -n '3,20p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# --- Image definitions --------------------------------------------------------
# Each entry: <logical-name>|<dockerfile>|<context>
IMAGES=(
  "app|docker/Dockerfile.app.prod|."
  "ui|propr-ui/Dockerfile|."
  "docs|docs/Dockerfile|./docs"
  "agent-base|docker/Dockerfile.agent-base|."
  "agent-claude|Dockerfile.claude|."
  "agent-codex|Dockerfile.codex|."
  "agent-gemini|Dockerfile.gemini|."
)

should_build() {
  [[ -z "$ONLY" ]] && return 0
  IFS=',' read -ra SELECTED <<< "$ONLY"
  for s in "${SELECTED[@]}"; do
    [[ "$s" == "$1" ]] && return 0
  done
  return 1
}

# --- Derive tags --------------------------------------------------------------
tags_for() {
  local name="$1"
  local -a tags=()
  if $PUSH_DH; then
    tags+=("$DOCKERHUB_NS/$name:$VERSION")
    tags+=("$DOCKERHUB_NS/$name:$GIT_SHA")
    if [[ "$PUSH_LATEST" == "true" ]]; then
      tags+=("$DOCKERHUB_NS/$name:latest")
    fi
  fi
  if $PUSH_GHCR; then
    tags+=("$GHCR_NS/$GHCR_PREFIX$name:$VERSION")
    tags+=("$GHCR_NS/$GHCR_PREFIX$name:$GIT_SHA")
    if [[ "$PUSH_LATEST" == "true" ]]; then
      tags+=("$GHCR_NS/$GHCR_PREFIX$name:latest")
    fi
  fi
  printf '%s\n' "${tags[@]}"
}

manifest_ns() {
  if [[ -n "${MANIFEST_NS:-}" ]]; then
    echo "$MANIFEST_NS"
  elif $PUSH_DH; then
    echo "$DOCKERHUB_NS"
  else
    echo "$GHCR_NS"
  fi
}

manifest_prefix() {
  if [[ -n "${MANIFEST_PREFIX:-}" ]]; then
    echo "$MANIFEST_PREFIX"
  elif $PUSH_DH; then
    echo ""
  else
    echo "$GHCR_PREFIX"
  fi
}

agent_base_image() {
  if [[ -n "${AGENT_BASE_IMAGE:-}" ]]; then
    echo "$AGENT_BASE_IMAGE"
  elif $PUSH_DH; then
    echo "$DOCKERHUB_NS/agent-base:$VERSION"
  else
    echo "$GHCR_NS/${GHCR_PREFIX}agent-base:$VERSION"
  fi
}

# --- Rewrite launcher manifest ------------------------------------------------
# The launcher image bakes in the image tags it should pull. Write a fresh
# manifest so the baked tags match this build.
write_manifest() {
  local runtime_ns runtime_prefix
  runtime_ns="$(manifest_ns)"
  runtime_prefix="$(manifest_prefix)"
  cat > docker/launcher/manifest.json <<EOF
{
  "version": "$VERSION",
  "git_sha": "$GIT_SHA",
  "registry": "$runtime_ns",
  "images": {
    "app": "$runtime_ns/${runtime_prefix}app:$VERSION",
    "ui": "$runtime_ns/${runtime_prefix}ui:$VERSION",
    "docs": "$runtime_ns/${runtime_prefix}docs:$VERSION",
    "agent-claude": "$runtime_ns/${runtime_prefix}agent-claude:$VERSION",
    "agent-codex": "$runtime_ns/${runtime_prefix}agent-codex:$VERSION",
    "agent-gemini": "$runtime_ns/${runtime_prefix}agent-gemini:$VERSION",
    "redis": "redis:7-alpine"
  }
}
EOF
  echo "  → wrote docker/launcher/manifest.json (version=$VERSION, registry=$runtime_ns/$runtime_prefix*)"
}

refresh_notices() {
  if [[ -x scripts/generate-notices.sh ]]; then
    echo ""
    ./scripts/generate-notices.sh
  fi
}

# --- Build one image ----------------------------------------------------------
build_image() {
  local name="$1" dockerfile="$2" context="$3"
  local -a tag_args=()
  while IFS= read -r t; do tag_args+=("-t" "$t"); done < <(tags_for "$name")

  local -a build_args=()
  if [[ -n "$PLATFORM" ]]; then
    build_args+=("--platform" "$PLATFORM")
  fi

  # Agent images extend agent-base — pin to the exact image built in this run.
  if [[ "$name" == agent-claude || "$name" == agent-codex || "$name" == agent-gemini ]]; then
    build_args+=("--build-arg" "BASE_IMAGE=$(agent_base_image)")
  fi

  echo ""
  echo "━━━ Building: $name ━━━"
  echo "  dockerfile: $dockerfile"
  echo "  context:    $context"
  for t in $(tags_for "$name"); do echo "  tag:        $t"; done

  if $PUSH && [[ -n "$PLATFORM" && "$PLATFORM" == *,* ]]; then
    # Multi-arch requires buildx with --push (can't load multi-arch to local daemon).
    docker buildx build "${build_args[@]}" --push -f "$dockerfile" "${tag_args[@]}" "$context"
  else
    docker build "${build_args[@]}" -f "$dockerfile" "${tag_args[@]}" "$context"
    if $PUSH; then
      for t in $(tags_for "$name"); do
        echo "  pushing $t"
        docker push "$t"
      done
    fi
  fi
}

# --- Main ---------------------------------------------------------------------
echo "Propr image build"
echo "  version:    $VERSION"
echo "  git sha:    $GIT_SHA"
echo "  docker hub: $($PUSH_DH && echo "$DOCKERHUB_NS" || echo 'skip')"
echo "  ghcr:       $($PUSH_GHCR && echo "$GHCR_NS/$GHCR_PREFIX*" || echo 'skip')"
echo "  platform:   ${PLATFORM:-native}"
echo "  push:       $PUSH"
echo "  latest:     $PUSH_LATEST"
[[ -n "$ONLY" ]] && echo "  only:       $ONLY"

write_manifest
refresh_notices

for entry in "${IMAGES[@]}"; do
  IFS='|' read -r name dockerfile context <<< "$entry"
  if should_build "$name"; then
    build_image "$name" "$dockerfile" "$context"
  else
    echo "  · skipping $name (not in --only list)"
  fi
done

# Launcher is built last so it bakes the fresh manifest above.
if should_build "launcher"; then
  build_image "launcher" "docker/Dockerfile.launcher" "."
fi

echo ""
echo "✓ done"

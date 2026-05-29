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
#   <registry>/<name>:latest      — latest

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- Config -------------------------------------------------------------------
DOCKERHUB_NS="${DOCKERHUB_NS:-propr}"
GHCR_NS="${GHCR_NS:-ghcr.io/proprdev}"
GHCR_PREFIX="${GHCR_PREFIX:-propr-}"   # GHCR uses flat namespace: propr-app instead of propr/app

VERSION="$(node -p "require('./package.json').version")"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo 'nogit')"

resolve_vibe_cli_version() {
  if [[ -x node_modules/.bin/tsx ]]; then
    node_modules/.bin/tsx -e "import { AGENT_DEFAULT_VERSIONS } from './packages/core/src/agents/version/types.ts'; console.log(AGENT_DEFAULT_VERSIONS.vibe);"
  else
    npx tsx -e "import { AGENT_DEFAULT_VERSIONS } from './packages/core/src/agents/version/types.ts'; console.log(AGENT_DEFAULT_VERSIONS.vibe);"
  fi
}

VIBE_CLI_VERSION="${VIBE_CLI_VERSION:-$(resolve_vibe_cli_version)}"

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
  "agent-vibe|Dockerfile.vibe|."
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
    tags+=("$DOCKERHUB_NS/$name:latest")
  fi
  if $PUSH_GHCR; then
    tags+=("$GHCR_NS/$GHCR_PREFIX$name:$VERSION")
    tags+=("$GHCR_NS/$GHCR_PREFIX$name:$GIT_SHA")
    tags+=("$GHCR_NS/$GHCR_PREFIX$name:latest")
  fi
  printf '%s\n' "${tags[@]}"
}

# --- Rewrite launcher manifest ------------------------------------------------
# The launcher image bakes in the image tags it should pull. Write a fresh
# manifest so the baked tags match this build.
write_manifest() {
  cat > docker/launcher/manifest.json <<EOF
{
  "version": "$VERSION",
  "git_sha": "$GIT_SHA",
  "registry": "$DOCKERHUB_NS",
  "images": {
    "app": "$DOCKERHUB_NS/app:$VERSION",
    "ui": "$DOCKERHUB_NS/ui:$VERSION",
    "docs": "$DOCKERHUB_NS/docs:$VERSION",
    "agent-claude": "$DOCKERHUB_NS/agent-claude:$VERSION",
    "agent-codex": "$DOCKERHUB_NS/agent-codex:$VERSION",
    "agent-gemini": "$DOCKERHUB_NS/agent-gemini:$VERSION",
    "agent-vibe": "$DOCKERHUB_NS/agent-vibe:$VERSION",
    "redis": "redis:7-alpine"
  }
}
EOF
  echo "  → wrote docker/launcher/manifest.json (version=$VERSION)"
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

  # Agent images extend propr/agent-base — pin to this build's version.
  if [[ "$name" == agent-claude || "$name" == agent-codex || "$name" == agent-gemini || "$name" == agent-vibe ]]; then
    build_args+=("--build-arg" "BASE_TAG=$VERSION")
  fi
  if [[ "$name" == agent-vibe ]]; then
    build_args+=("--build-arg" "CLI_VERSION=$VIBE_CLI_VERSION")
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
[[ -n "$ONLY" ]] && echo "  only:       $ONLY"

write_manifest
refresh_notices

if [[ -n "$ONLY" ]] && ! should_build "agent-base"; then
  for agent_name in agent-claude agent-codex agent-gemini agent-vibe; do
    if should_build "$agent_name"; then
      build_image "agent-base" "docker/Dockerfile.agent-base" "."
      break
    fi
  done
fi

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

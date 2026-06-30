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
CLAUDE_CLI_VERSION="${CLAUDE_CLI_VERSION:-2.1.191}"
CODEX_CLI_VERSION="${CODEX_CLI_VERSION:-0.142.1}"
ANTIGRAVITY_CLI_VERSION="${ANTIGRAVITY_CLI_VERSION:-latest}"
PUSH_LATEST="${PUSH_LATEST:-true}"

VERSION="$(node -p "require('./package.json').version")"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo 'nogit')"
BUILD_DATE="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
IMAGE_SOURCE="${IMAGE_SOURCE:-https://github.com/integry/propr}"
IMAGE_URL="${IMAGE_URL:-https://github.com/integry/propr}"
PACKAGE_LICENSE="$(node -p "require('./package.json').license || 'Apache-2.0'")"
IMAGE_LICENSES="${IMAGE_LICENSES:-$PACKAGE_LICENSE}"

resolve_vibe_cli_version() {
  if [[ -x node_modules/.bin/tsx ]]; then
    node_modules/.bin/tsx -e "import { AGENT_DEFAULT_VERSIONS } from './packages/core/src/agents/version/types.ts'; console.log(AGENT_DEFAULT_VERSIONS.vibe);"
  else
    npx tsx -e "import { AGENT_DEFAULT_VERSIONS } from './packages/core/src/agents/version/types.ts'; console.log(AGENT_DEFAULT_VERSIONS.vibe);"
  fi
}

resolve_opencode_cli_version() {
  if [[ -x node_modules/.bin/tsx ]]; then
    node_modules/.bin/tsx -e "import { AGENT_DEFAULT_VERSIONS } from './packages/core/src/agents/version/types.ts'; console.log(AGENT_DEFAULT_VERSIONS.opencode);"
  else
    npx tsx -e "import { AGENT_DEFAULT_VERSIONS } from './packages/core/src/agents/version/types.ts'; console.log(AGENT_DEFAULT_VERSIONS.opencode);"
  fi
}

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
  "agent-antigravity|Dockerfile.antigravity|."
  "agent-opencode|Dockerfile.opencode|."
  "agent-vibe|Dockerfile.vibe|."
)

should_build() {
  [[ -z "$ONLY" ]] && return 0
  IFS=',' read -ra SELECTED <<< "$ONLY"
  for s in "${SELECTED[@]}"; do
    [[ "$s" == "$1" ]] && return 0
  done
  if [[ "$1" == "agent-base" ]]; then
    for s in "${SELECTED[@]}"; do
      [[ "$s" == agent-* && "$s" != "agent-base" ]] && return 0
    done
  fi
  return 1
}

include_agent_base_when_needed() {
  [[ -z "$ONLY" ]] && return
  should_build "agent-base" && return
  for agent_name in agent-claude agent-codex agent-vibe; do
    if should_build "$agent_name"; then
      ONLY="agent-base,$ONLY"
      return
    fi
  done
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

image_title() {
  case "$1" in
    app) echo "ProPR App" ;;
    ui) echo "ProPR Web UI" ;;
    docs) echo "ProPR Docs" ;;
    agent-base) echo "ProPR Agent Base" ;;
    agent-claude) echo "ProPR Claude Code Agent" ;;
    agent-codex) echo "ProPR Codex Agent" ;;
    agent-antigravity) echo "ProPR Antigravity Agent" ;;
    launcher) echo "ProPR Launcher" ;;
    *) echo "ProPR $1" ;;
  esac
}

image_description() {
  case "$1" in
    app) echo "Backend service image for ProPR daemon, workers, and API roles." ;;
    ui) echo "Static web UI image for operating ProPR." ;;
    docs) echo "Static documentation site image for ProPR." ;;
    agent-base) echo "Shared base image for ProPR coding agent execution containers." ;;
    agent-claude) echo "Claude Code execution container for ProPR agent runs." ;;
    agent-codex) echo "OpenAI Codex execution container for ProPR agent runs." ;;
    agent-antigravity) echo "Antigravity execution container for ProPR agent runs." ;;
    launcher) echo "Single-command launcher that starts and manages the ProPR Docker stack." ;;
    *) echo "ProPR production image." ;;
  esac
}

# --- Rewrite launcher manifest ------------------------------------------------
# The launcher image bakes in the image tags it should pull. Write a fresh
# manifest so the baked tags match this build.
#
# To re-pin the cloudflared tunnel image, update the literal below AND the
# matching fallbacks: DEFAULT_CLOUDFLARED_IMAGE in packages/shared/src/proprServiceUrls.ts
# and its mirror in docker/launcher/orchestrator.mjs. The manifest (regenerated
# here) is the effective source at runtime; the shared constant is only a
# fallback. orchestratorProprUrlsDrift.test.ts reconciles all three and fails if
# they diverge.
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
    "agent-antigravity": "$runtime_ns/${runtime_prefix}agent-antigravity:$VERSION",
    "agent-opencode": "$runtime_ns/${runtime_prefix}agent-opencode:$VERSION",
    "agent-vibe": "$runtime_ns/${runtime_prefix}agent-vibe:$VERSION",
    "redis": "redis:7-alpine",
    "cloudflared": "cloudflare/cloudflared:2024.12.2"
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
  if [[ "$name" == agent-claude || "$name" == agent-codex || "$name" == agent-antigravity || "$name" == agent-opencode || "$name" == agent-vibe ]]; then
    build_args+=("--build-arg" "BASE_IMAGE=$(agent_base_image)")
  fi
  case "$name" in
    agent-claude) build_args+=("--build-arg" "CLI_VERSION=$CLAUDE_CLI_VERSION") ;;
    agent-codex) build_args+=("--build-arg" "CLI_VERSION=$CODEX_CLI_VERSION") ;;
    agent-antigravity) build_args+=("--build-arg" "CLI_VERSION=$ANTIGRAVITY_CLI_VERSION") ;;
    agent-opencode)
      local opencode_cli_version="${OPENCODE_CLI_VERSION:-$(resolve_opencode_cli_version)}"
      build_args+=("--build-arg" "CLI_VERSION=$opencode_cli_version")
      ;;
    agent-vibe)
      local vibe_cli_version="${VIBE_CLI_VERSION:-$(resolve_vibe_cli_version)}"
      build_args+=("--build-arg" "CLI_VERSION=$vibe_cli_version")
      ;;
  esac

  build_args+=(
    "--label" "org.opencontainers.image.title=$(image_title "$name")"
    "--label" "org.opencontainers.image.description=$(image_description "$name")"
    "--label" "org.opencontainers.image.version=$VERSION"
    "--label" "org.opencontainers.image.revision=$GIT_SHA"
    "--label" "org.opencontainers.image.created=$BUILD_DATE"
    "--label" "org.opencontainers.image.source=$IMAGE_SOURCE"
    "--label" "org.opencontainers.image.url=$IMAGE_URL"
    "--label" "org.opencontainers.image.licenses=$IMAGE_LICENSES"
  )

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
include_agent_base_when_needed

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

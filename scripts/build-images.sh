#!/usr/bin/env bash
# Build (and optionally push) all Propr production images.
#
# Usage:
#   scripts/build-images.sh                    # build all images, no push
#   scripts/build-images.sh --push             # build + push to Docker Hub + GHCR
#   scripts/build-images.sh --push --dockerhub # push to Docker Hub only
#   scripts/build-images.sh --push --ghcr      # push to GHCR only
#   scripts/build-images.sh --platform linux/amd64,linux/arm64 --push  # multi-arch
#   scripts/build-images.sh --only app,agent   # build a subset
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
CLAUDE_CLI_VERSION="${CLAUDE_CLI_VERSION:-2.1.211}"
CODEX_CLI_VERSION="${CODEX_CLI_VERSION:-0.144.5}"
ANTIGRAVITY_CLI_VERSION="${ANTIGRAVITY_CLI_VERSION:-latest}"
OPENCODE_CLI_VERSION="${OPENCODE_CLI_VERSION:-1.18.2}"
VIBE_CLI_VERSION="${VIBE_CLI_VERSION:-2.20.0}"
PUSH_LATEST="${PUSH_LATEST:-true}"

VERSION="$(node -p "require('./package.json').version")"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo 'nogit')"
BUILD_DATE="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
IMAGE_SOURCE="${IMAGE_SOURCE:-https://github.com/integry/propr}"
IMAGE_URL="${IMAGE_URL:-https://github.com/integry/propr}"
PACKAGE_LICENSE="$(node -p "require('./package.json').license || 'Apache-2.0'")"
IMAGE_LICENSES="${IMAGE_LICENSES:-$PACKAGE_LICENSE}"

AGENT_BUNDLE_CONTENT_FILES=(
  Dockerfile.agent
  scripts/agent-entrypoint.sh
  scripts/claude-entrypoint.sh
  scripts/codex-entrypoint.sh
  scripts/antigravity-entrypoint.sh
  scripts/opencode-entrypoint.sh
  scripts/opencode-run.sh
  scripts/vibe-entrypoint.sh
  scripts/vibe-prompt-file-runner.py
  scripts/init-firewall.sh
  scripts/gh-wrapper.sh
  NOTICE
  THIRD_PARTY_LICENSES.md
)

resolve_agent_bundle_tag() {
  CLAUDE_CLI_VERSION="$CLAUDE_CLI_VERSION" \
  CODEX_CLI_VERSION="$CODEX_CLI_VERSION" \
  ANTIGRAVITY_CLI_VERSION="$ANTIGRAVITY_CLI_VERSION" \
  OPENCODE_CLI_VERSION="$OPENCODE_CLI_VERSION" \
  VIBE_CLI_VERSION="$VIBE_CLI_VERSION" \
    node --input-type=module -e '
      import crypto from "node:crypto";
      import fs from "node:fs";
      const types = ["claude", "codex", "antigravity", "opencode", "vibe"];
      const versions = Object.fromEntries(types.map(type => [
        type,
        process.env[`${type.toUpperCase()}_CLI_VERSION`]
      ]));
      const content = crypto.createHash("sha256");
      for (const file of process.argv.slice(1)) {
        if (fs.existsSync(file)) content.update(fs.readFileSync(file, "utf8"));
      }
      const contentHash = content.digest("hex").slice(0, 6);
      const matrix = types.map(type => `${type}=${versions[type]}`).join("\n");
      const matrixHash = crypto.createHash("sha256").update(matrix).digest("hex").slice(0, 12);
      process.stdout.write(`bundle-${matrixHash}-${contentHash}`);
    ' "${AGENT_BUNDLE_CONTENT_FILES[@]}"
}

AGENT_BUNDLE_TAG=""

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
  "agent|Dockerfile.agent|."
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
    [[ "$name" == "agent" ]] && tags+=("$DOCKERHUB_NS/$name:$AGENT_BUNDLE_TAG")
  fi
  if $PUSH_GHCR; then
    tags+=("$GHCR_NS/$GHCR_PREFIX$name:$VERSION")
    tags+=("$GHCR_NS/$GHCR_PREFIX$name:$GIT_SHA")
    if [[ "$PUSH_LATEST" == "true" ]]; then
      tags+=("$GHCR_NS/$GHCR_PREFIX$name:latest")
    fi
    [[ "$name" == "agent" ]] && tags+=("$GHCR_NS/$GHCR_PREFIX$name:$AGENT_BUNDLE_TAG")
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

image_title() {
  case "$1" in
    app) echo "ProPR App" ;;
    ui) echo "ProPR Web UI" ;;
    docs) echo "ProPR Docs" ;;
    agent) echo "ProPR Agent Runtime" ;;
    launcher) echo "ProPR Launcher" ;;
    *) echo "ProPR $1" ;;
  esac
}

image_description() {
  case "$1" in
    app) echo "Backend service image for ProPR daemon, workers, and API roles." ;;
    ui) echo "Static web UI image for operating ProPR." ;;
    docs) echo "Static documentation site image for ProPR." ;;
    agent) echo "Unified Claude, Codex, Antigravity, OpenCode, and Vibe execution container for ProPR agent runs." ;;
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
    "agent": "$runtime_ns/${runtime_prefix}agent:$VERSION",
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

  case "$name" in
    agent)
      build_args+=(
        "--build-arg" "CLAUDE_CLI_VERSION=$CLAUDE_CLI_VERSION"
        "--build-arg" "CODEX_CLI_VERSION=$CODEX_CLI_VERSION"
        "--build-arg" "ANTIGRAVITY_CLI_VERSION=$ANTIGRAVITY_CLI_VERSION"
        "--build-arg" "OPENCODE_CLI_VERSION=$OPENCODE_CLI_VERSION"
        "--build-arg" "VIBE_CLI_VERSION=$VIBE_CLI_VERSION"
      )
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
refresh_notices
AGENT_BUNDLE_TAG="$(resolve_agent_bundle_tag)"

echo "Propr image build"
echo "  version:    $VERSION"
echo "  git sha:    $GIT_SHA"
echo "  docker hub: $($PUSH_DH && echo "$DOCKERHUB_NS" || echo 'skip')"
echo "  ghcr:       $($PUSH_GHCR && echo "$GHCR_NS/$GHCR_PREFIX*" || echo 'skip')"
echo "  platform:   ${PLATFORM:-native}"
echo "  push:       $PUSH"
echo "  latest:     $PUSH_LATEST"
echo "  agent tag:  $AGENT_BUNDLE_TAG"
[[ -n "$ONLY" ]] && echo "  only:       $ONLY"

write_manifest

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

#!/usr/bin/env bash
# Build (and optionally push) all Propr production images.
#
# Usage:
#   scripts/build-images.sh                    # build all images, no push
#   scripts/build-images.sh --push             # build + push to Docker Hub + GHCR
#   scripts/build-images.sh --push-only        # stage, preflight, then publish smoke-tested images
#   scripts/build-images.sh --promote-latest   # promote immutable version tags to latest
#   scripts/build-images.sh --push --dockerhub # push to Docker Hub only
#   scripts/build-images.sh --push --ghcr      # push to GHCR only
#   scripts/build-images.sh --platform linux/amd64,linux/arm64 --push  # multi-arch (app/ui/docs only)
#   scripts/build-images.sh --only app,agent   # build a subset
#
# Note: the agent image is pinned to linux/amd64 (Debian package pins include
# amd64 binNMU suffixes), so a multi-arch --platform value cannot build the full
# image set. Build the agent with --platform linux/amd64 (or natively) and use
# multi-arch platforms only for app/ui/docs.
#
# Tags produced per image:
#   <registry>/<name>:<version>   — exact version from package.json
#   <registry>/<name>:<sha>       — full git commit SHA
#   <registry>/<name>:latest      — latest, unless PUSH_LATEST=false

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- Config -------------------------------------------------------------------
DOCKERHUB_NS="${DOCKERHUB_NS:-propr}"
GHCR_NS="${GHCR_NS:-ghcr.io/proprdev}"
GHCR_PREFIX="${GHCR_PREFIX:-propr-}"   # GHCR uses flat namespace: propr-app instead of propr/app
CLAUDE_CLI_VERSION="${CLAUDE_CLI_VERSION:-2.1.220}"
CODEX_CLI_VERSION="${CODEX_CLI_VERSION:-0.146.0}"
ANTIGRAVITY_CLI_VERSION="${ANTIGRAVITY_CLI_VERSION:-1.1.11}"
OPENCODE_CLI_VERSION="${OPENCODE_CLI_VERSION:-1.18.9}"
VIBE_CLI_VERSION="${VIBE_CLI_VERSION:-2.23.1}"
PUSH_LATEST="${PUSH_LATEST:-true}"

VERSION="$(node -p "require('./package.json').version")"
GIT_SHA="${GIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo 'nogit')}"
BUILD_DATE="${BUILD_DATE:-$(git show -s --format=%cI HEAD 2>/dev/null || date -u +'%Y-%m-%dT%H:%M:%SZ')}"
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
PUSH_ONLY=false
PROMOTE_LATEST=false
PUSH_DH=true
PUSH_GHCR=true
PLATFORM=""   # empty = native platform
ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --push) PUSH=true; shift ;;
    --push-only) PUSH=true; PUSH_ONLY=true; shift ;;
    --promote-latest) PROMOTE_LATEST=true; shift ;;
    --dockerhub) PUSH_GHCR=false; shift ;;
    --ghcr) PUSH_DH=false; shift ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    -h|--help) sed -n '3,20p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if $PROMOTE_LATEST && { $PUSH || $PUSH_ONLY || [[ -n "$PLATFORM" ]]; }; then
  echo "--promote-latest cannot be combined with build or push options" >&2
  exit 1
fi
if { $PUSH || $PROMOTE_LATEST; } && [[ ! "$GIT_SHA" =~ ^[0-9a-f]{40,64}$ ]]; then
  echo "Publishing requires a full Git commit SHA; got '$GIT_SHA'" >&2
  exit 1
fi

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
repositories_for() {
  local name="$1"
  $PUSH_DH && printf '%s\n' "$DOCKERHUB_NS/$name"
  $PUSH_GHCR && printf '%s\n' "$GHCR_NS/$GHCR_PREFIX$name"
}

tags_for() {
  local name="$1" repository
  local -a tags=()
  while IFS= read -r repository; do
    tags+=("$repository:$VERSION")
    tags+=("$repository:$GIT_SHA")
    if [[ "$PUSH_LATEST" == "true" ]]; then
      tags+=("$repository:latest")
    fi
    [[ "$name" == "agent" ]] && tags+=("$repository:$AGENT_BUNDLE_TAG")
  done < <(repositories_for "$name")
  printf '%s\n' "${tags[@]}"
}

candidate_ref_for() {
  printf '%s:reconcile-%s\n' "$1" "$GIT_SHA"
}

immutable_suffixes_for() {
  local name="$1"
  printf '%s\n' "$GIT_SHA" "$VERSION"
  [[ "$name" == "agent" ]] && printf '%s\n' "$AGENT_BUNDLE_TAG"
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

inspect_remote_digest() {
  local ref="$1" output digest
  if ! output="$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest.Digest}}' 2>&1)"; then
    if grep -Eqi 'manifest unknown|no such manifest|(^|: )not found([[:space:]]|$)' <<< "$output" \
      && ! grep -Eqi 'unauthorized|denied|insufficient_scope|authorization' <<< "$output"; then
      return 1
    fi
    echo "Failed to inspect remote image $ref:" >&2
    echo "$output" >&2
    return 2
  fi

  if ! digest="$(node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      const digest = JSON.parse(input);
      if (!/^sha256:[0-9a-f]{64}$/.test(digest || "")) process.exit(1);
      process.stdout.write(digest);
    });
  ' <<< "$output")"; then
    echo "Registry returned an invalid manifest digest for $ref" >&2
    return 2
  fi
  printf '%s\n' "$digest"
}

copy_remote_digest() {
  local repository="$1" target="$2" digest="$3" published_digest
  echo "  publishing $target from $repository@$digest"
  docker buildx imagetools create --prefer-index=false --tag "$target" "$repository@$digest"
  if ! published_digest="$(inspect_remote_digest "$target")" \
    || [[ "$published_digest" != "$digest" ]]; then
    echo "Published digest for $target does not match source artifact $digest" >&2
    return 1
  fi
}

reconcile_immutable_tag() {
  local repository="$1" target="$2" rebuilt_digest="$3" existing_digest status
  if existing_digest="$(inspect_remote_digest "$target")"; then
    if [[ "$existing_digest" != "$rebuilt_digest" ]]; then
      echo "Refusing to overwrite immutable image tag $target" >&2
      echo "  existing digest: $existing_digest" >&2
      echo "  rebuilt digest:  $rebuilt_digest" >&2
      return 1
    fi
    echo "  keeping $target (digest already matches rebuilt artifact)"
    return 0
  else
    status=$?
    [[ $status -eq 1 ]] || return "$status"
  fi
  copy_remote_digest "$repository" "$target" "$rebuilt_digest"
}

reconcile_repository() {
  local name="$1" repository="$2" rebuilt_digest="$3" suffix
  while IFS= read -r suffix; do
    reconcile_immutable_tag "$repository" "$repository:$suffix" "$rebuilt_digest" || return
  done < <(immutable_suffixes_for "$name")
  if [[ "$PUSH_LATEST" == "true" ]]; then
    copy_remote_digest "$repository" "$repository:latest" "$rebuilt_digest"
  fi
}

verify_local_release_image() {
  local name="$1" repository source_ref
  while IFS= read -r repository; do
    source_ref="$repository:$VERSION"
    if ! docker image inspect "$source_ref" >/dev/null 2>&1; then
      echo "Refusing to publish missing local image $source_ref; build and smoke-test it first" >&2
      return 1
    fi
  done < <(repositories_for "$name")
}

stage_candidate_image() {
  local name="$1" repository source_ref candidate_ref
  while IFS= read -r repository; do
    source_ref="$repository:$VERSION"
    candidate_ref="$(candidate_ref_for "$repository")"
    docker tag "$source_ref" "$candidate_ref"
    echo "  pushing non-consumer reconciliation tag $candidate_ref"
    docker push "$candidate_ref"
  done < <(repositories_for "$name")
}

preflight_immutable_tag() {
  local target="$1" rebuilt_digest="$2" existing_digest status
  if existing_digest="$(inspect_remote_digest "$target")"; then
    if [[ "$existing_digest" != "$rebuilt_digest" ]]; then
      echo "Refusing to overwrite immutable image tag $target" >&2
      echo "  existing digest: $existing_digest" >&2
      echo "  rebuilt digest:  $rebuilt_digest" >&2
      return 1
    fi
    return 0
  else
    status=$?
    [[ $status -eq 1 ]] || return "$status"
  fi
}

declare -A PREFLIGHTED_CANDIDATE_DIGESTS=()

preflight_candidate_image() {
  local name="$1" repository candidate_ref rebuilt_digest suffix
  while IFS= read -r repository; do
    candidate_ref="$(candidate_ref_for "$repository")"
    if ! rebuilt_digest="$(inspect_remote_digest "$candidate_ref")"; then
      echo "Unable to resolve staged artifact digest from $candidate_ref" >&2
      return 1
    fi
    while IFS= read -r suffix; do
      preflight_immutable_tag "$repository:$suffix" "$rebuilt_digest" || return
    done < <(immutable_suffixes_for "$name")
    PREFLIGHTED_CANDIDATE_DIGESTS["$repository"]="$rebuilt_digest"
  done < <(repositories_for "$name")
}

publish_candidate_image() {
  local name="$1" repository rebuilt_digest
  while IFS= read -r repository; do
    rebuilt_digest="${PREFLIGHTED_CANDIDATE_DIGESTS[$repository]:-}"
    if [[ -z "$rebuilt_digest" ]]; then
      echo "Refusing to publish $repository without a preflighted staged artifact digest" >&2
      return 1
    fi
    reconcile_repository "$name" "$repository" "$rebuilt_digest" || return
  done < <(repositories_for "$name")
}

PROMOTION_REPOSITORIES=()
PROMOTION_TARGETS=()
PROMOTION_DIGESTS=()
PROMOTION_PRIOR_DIGESTS=()

prepare_latest_promotions() {
  local entry name dockerfile context repository version_ref sha_ref target
  local version_digest sha_digest prior_digest status
  local -a published_images=("${IMAGES[@]}" "launcher|docker/Dockerfile.launcher|.")
  for entry in "${published_images[@]}"; do
    IFS='|' read -r name dockerfile context <<< "$entry"
    should_build "$name" || continue
    while IFS= read -r repository; do
      version_ref="$repository:$VERSION"
      sha_ref="$repository:$GIT_SHA"
      target="$repository:latest"
      if ! version_digest="$(inspect_remote_digest "$version_ref")"; then
        echo "Cannot promote latest because immutable release image $version_ref is unavailable" >&2
        return 1
      fi
      if ! sha_digest="$(inspect_remote_digest "$sha_ref")"; then
        echo "Cannot promote latest because immutable commit image $sha_ref is unavailable" >&2
        return 1
      fi
      if [[ "$version_digest" != "$sha_digest" ]]; then
        echo "Cannot promote $target because version and commit tags disagree" >&2
        echo "  version digest: $version_digest" >&2
        echo "  commit digest:  $sha_digest" >&2
        return 1
      fi
      prior_digest=""
      if prior_digest="$(inspect_remote_digest "$target")"; then
        :
      else
        status=$?
        [[ $status -eq 1 ]] || return "$status"
        prior_digest=""
        echo "  warning: $target has no prior tag; a later promotion failure cannot remove a newly created tag with Docker buildx alone" >&2
      fi
      PROMOTION_REPOSITORIES+=("$repository")
      PROMOTION_TARGETS+=("$target")
      PROMOTION_DIGESTS+=("$version_digest")
      PROMOTION_PRIOR_DIGESTS+=("$prior_digest")
    done < <(repositories_for "$name")
  done
}

rollback_latest_promotions() {
  local count="$1" index prior_digest rollback_incomplete=false
  echo "Latest promotion failed; restoring previously published latest tags" >&2
  for ((index = count - 1; index >= 0; index--)); do
    prior_digest="${PROMOTION_PRIOR_DIGESTS[$index]}"
    if [[ -z "$prior_digest" ]]; then
      echo "  NON-ATOMIC PROMOTION: ${PROMOTION_TARGETS[$index]} had no prior tag and may now remain published; delete that tag through the registry before retrying if its digest changed" >&2
      rollback_incomplete=true
      continue
    fi
    if ! copy_remote_digest \
      "${PROMOTION_REPOSITORIES[$index]}" \
      "${PROMOTION_TARGETS[$index]}" \
      "$prior_digest"; then
      echo "  failed to restore ${PROMOTION_TARGETS[$index]} to $prior_digest" >&2
      rollback_incomplete=true
    fi
  done
  if $rollback_incomplete; then
    echo "Latest-tag rollback was incomplete; registry-side reconciliation is required for the targets listed above." >&2
    return 1
  fi
  return 0
}

promote_latest_images() {
  local index
  prepare_latest_promotions || return
  for ((index = 0; index < ${#PROMOTION_TARGETS[@]}; index++)); do
    if ! copy_remote_digest \
      "${PROMOTION_REPOSITORIES[$index]}" \
      "${PROMOTION_TARGETS[$index]}" \
      "${PROMOTION_DIGESTS[$index]}"; then
      if ! rollback_latest_promotions "$((index + 1))"; then
        echo "Latest promotion ended in an explicitly non-atomic state." >&2
      fi
      return 1
    fi
  done
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
  local name="$1" dockerfile="$2" context="$3" repository
  local -a tag_args=()
  if $PUSH && ! $PUSH_ONLY && [[ -n "$PLATFORM" && "$PLATFORM" == *,* ]]; then
    while IFS= read -r repository; do
      tag_args+=("-t" "$(candidate_ref_for "$repository")")
    done < <(repositories_for "$name")
  else
    while IFS= read -r t; do tag_args+=("-t" "$t"); done < <(tags_for "$name")
  fi

  if [[ "$name" == "agent" && -n "$PLATFORM" && "$PLATFORM" != "linux/amd64" ]]; then
    echo "Agent image builds are currently pinned to linux/amd64 because Debian package pins include amd64 binNMU suffixes." >&2
    echo "Use --platform linux/amd64 for agent builds, or build app/ui/docs separately for other platforms." >&2
    exit 1
  fi

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
    # Multi-arch cannot be loaded into the local daemon. Publish only a staging
    # reference. Immutable-tag checks and publication are deferred until every
    # selected image has been staged successfully.
    docker buildx build "${build_args[@]}" --push -f "$dockerfile" "${tag_args[@]}" "$context"
  else
    docker build "${build_args[@]}" -f "$dockerfile" "${tag_args[@]}" "$context"
  fi
}

# --- Main ---------------------------------------------------------------------
AGENT_BUNDLE_TAG="$(resolve_agent_bundle_tag)"
RELEASE_IMAGES=("${IMAGES[@]}" "launcher|docker/Dockerfile.launcher|.")

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

if $PROMOTE_LATEST; then
  promote_latest_images
  echo ""
  echo "✓ latest promotion complete"
  exit 0
fi

if $PUSH_ONLY; then
  # Validate every local source before the first registry mutation. Candidates
  # are intentionally non-consumer tags; all immutable consumer tags across
  # both registries are then preflighted before any are created or changed.
  for entry in "${RELEASE_IMAGES[@]}"; do
    IFS='|' read -r name _dockerfile _context <<< "$entry"
    should_build "$name" && verify_local_release_image "$name"
  done
  for entry in "${RELEASE_IMAGES[@]}"; do
    IFS='|' read -r name _dockerfile _context <<< "$entry"
    should_build "$name" && stage_candidate_image "$name"
  done
  for entry in "${RELEASE_IMAGES[@]}"; do
    IFS='|' read -r name _dockerfile _context <<< "$entry"
    should_build "$name" && preflight_candidate_image "$name"
  done
  for entry in "${RELEASE_IMAGES[@]}"; do
    IFS='|' read -r name _dockerfile _context <<< "$entry"
    should_build "$name" && publish_candidate_image "$name"
  done
  echo ""
  echo "✓ staged artifacts preflighted and published"
  exit 0
fi

refresh_notices
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

if $PUSH; then
  if [[ -z "$PLATFORM" || "$PLATFORM" != *,* ]]; then
    # Native builds remain local until every selected image has built and can be
    # validated. Only then stage all candidates, without publishing consumers.
    for entry in "${RELEASE_IMAGES[@]}"; do
      IFS='|' read -r name _dockerfile _context <<< "$entry"
      should_build "$name" && verify_local_release_image "$name"
    done
    for entry in "${RELEASE_IMAGES[@]}"; do
      IFS='|' read -r name _dockerfile _context <<< "$entry"
      should_build "$name" && stage_candidate_image "$name"
    done
  fi

  # Multi-platform builds have already pushed only their candidate references.
  # Preflight every selected repository before publishing the first consumer.
  for entry in "${RELEASE_IMAGES[@]}"; do
    IFS='|' read -r name _dockerfile _context <<< "$entry"
    should_build "$name" && preflight_candidate_image "$name"
  done
  for entry in "${RELEASE_IMAGES[@]}"; do
    IFS='|' read -r name _dockerfile _context <<< "$entry"
    should_build "$name" && publish_candidate_image "$name"
  done
fi

echo ""
echo "✓ done"

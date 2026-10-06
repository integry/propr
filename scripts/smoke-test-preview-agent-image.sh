#!/usr/bin/env bash
# Credential-free native linux/amd64 smoke test for the managed agent image used
# by Linux desktop previews. It proves the bundled CLI, entrypoint, and runtime
# contracts that first-user setup and task execution depend on. It never mounts
# provider credentials, a workspace, or the Docker socket, and every container
# runs with networking disabled, so it cannot prove provider authentication or
# real task execution.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SOURCE_REVISION="${SOURCE_REVISION:-$(git rev-parse HEAD)}"
AGENT_IMAGE="${AGENT_IMAGE:-propr/agent:$SOURCE_REVISION}"
SMOKE_EVIDENCE="${SMOKE_EVIDENCE:-}"

if [[ ! "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'SOURCE_REVISION must be a full lowercase 40-character Git commit SHA' >&2
  exit 1
fi
if [[ "$AGENT_IMAGE" != "propr/agent:$SOURCE_REVISION" ]]; then
  echo 'Preview agent smoke accepts only the exact propr/agent full-SHA tag' >&2
  exit 1
fi
if [[ -z "$SMOKE_EVIDENCE" ]]; then
  echo 'SMOKE_EVIDENCE must name the JSON evidence file to write' >&2
  exit 1
fi
for name in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY MISTRAL_API_KEY GH_TOKEN GITHUB_TOKEN \
  DOCKERHUB_USERNAME DOCKERHUB_TOKEN; do
  if [[ -n "${!name:-}" ]]; then
    echo "Refusing to run the credential-free agent smoke with $name set" >&2
    exit 1
  fi
done

label() {
  docker image inspect --format "{{ index .Config.Labels \"$1\" }}" "$AGENT_IMAGE"
}

# The managed image is linux/amd64 only (see Dockerfile.agent); never accept an
# image built for, or labelled as, another architecture.
platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$AGENT_IMAGE")"
if [[ "$platform" != linux/amd64 ]]; then
  echo "Agent image must be linux/amd64, got $platform" >&2
  exit 1
fi
if [[ "$(label org.opencontainers.image.revision)" != "$SOURCE_REVISION" \
  || "$(label org.opencontainers.image.source)" != https://github.com/integry/propr \
  || "$(label dev.propr.agent-bundle)" != true ]]; then
  echo 'Agent image labels do not bind the unified bundle to the requested integry/propr source' >&2
  exit 1
fi
config_digest="$(docker image inspect --format '{{.Id}}' "$AGENT_IMAGE")"

run_agent() {
  docker run --rm --network none --pull never "$@"
}

run_agent --entrypoint sh "$AGENT_IMAGE" -c '
  set -eu
  for executable in claude codex agy opencode vibe agent-tank git gh rg python3 tini; do
    command -v "$executable" >/dev/null
  done
'
echo '✓ agent runtime exposes every bundled CLI'

declare -A versions=()
check_version() {
  local cli="$1" label_name="$2" command="$3" expected output
  expected="$(label "$label_name")"
  if [[ -z "$expected" ]]; then
    echo "Agent image has no $label_name label" >&2
    exit 1
  fi
  output="$(run_agent --entrypoint sh "$AGENT_IMAGE" -c "$command --version" 2>&1)"
  if [[ "$output" != *"$expected"* ]]; then
    echo "$cli --version ($output) does not report labelled version $expected" >&2
    exit 1
  fi
  versions[$cli]="$expected"
}
check_version claude dev.propr.agent.claude.version claude
check_version codex dev.propr.agent.codex.version codex
check_version antigravity dev.propr.agent.antigravity.version agy
check_version opencode dev.propr.agent.opencode.version opencode
check_version vibe dev.propr.agent.vibe.version vibe
check_version agent-tank dev.propr.agent-tank.version agent-tank
echo '✓ bundled CLI versions match the image labels'

run_agent -e PROPR_AGENT_TYPE=agent-tank "$AGENT_IMAGE" agent-tank --version >/dev/null
echo '✓ agent-tank runs through the entrypoint without a provider entrypoint'

for entrypoint in claude codex antigravity opencode vibe; do
  run_agent --entrypoint "/home/node/${entrypoint}-entrypoint.sh" "$AGENT_IMAGE" gh --version >/dev/null
done
echo '✓ agent entrypoints can execute GitHub CLI through the wrapper'

run_agent --entrypoint sh "$AGENT_IMAGE" -c '
  set -eu
  for path in \
    /home/node/.claude/.credentials.json \
    /home/node/.codex/auth.json \
    /home/node/.gemini/oauth_creds.json /home/node/.gemini/google_accounts.json \
    /home/node/.local/share/opencode/auth.json \
    /home/node/.vibe/.env \
    /home/node/.config/gh/hosts.yml /root/.config/gh/hosts.yml \
    /home/node/.docker/config.json /root/.docker/config.json; do
    if [ -e "$path" ]; then
      echo "baked credential file present: $path" >&2
      exit 1
    fi
  done
'
echo '✓ no provider, GitHub, or registry credential files are baked into the image'

if [[ "$(docker image inspect --format '{{.Config.User}}' "$AGENT_IMAGE")" != node \
  || "$(run_agent --entrypoint id "$AGENT_IMAGE" -u)" == 0 ]]; then
  echo 'Agent image must default to the unprivileged node user' >&2
  exit 1
fi
echo '✓ agent image defaults to the unprivileged node user'

mkdir -p "$(dirname "$SMOKE_EVIDENCE")"
AGENT_IMAGE="$AGENT_IMAGE" SOURCE_REVISION="$SOURCE_REVISION" SMOKE_CONFIG_DIGEST="$config_digest" \
SMOKE_VERSIONS="$(for cli in "${!versions[@]}"; do printf '%s=%s\n' "$cli" "${versions[$cli]}"; done)" \
node --input-type=module -e '
  import { writeFileSync } from "node:fs";
  const cliVersions = Object.fromEntries(process.env.SMOKE_VERSIONS.trim().split("\n").map(line => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }).sort(([left], [right]) => left.localeCompare(right)));
  writeFileSync(process.argv[1], `${JSON.stringify({
    schemaVersion: 1,
    image: process.env.AGENT_IMAGE,
    sourceRevision: process.env.SOURCE_REVISION,
    configDigest: process.env.SMOKE_CONFIG_DIGEST,
    platform: "linux/amd64",
    network: "none",
    credentials: "none",
    checks: [
      "bundled-clis-present",
      "bundled-cli-versions-match-labels",
      "agent-tank-entrypoint",
      "gh-wrapper-through-every-entrypoint",
      "no-baked-provider-credentials",
      "non-root-runtime-user",
    ],
    cliVersions,
  }, null, 2)}\n`);
' "$SMOKE_EVIDENCE"
echo "✓ credential-free agent smoke evidence written to $SMOKE_EVIDENCE"

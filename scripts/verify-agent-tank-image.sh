#!/usr/bin/env bash
# Verify that bundled Agent Tank really reads usage out of the agent image.
#
# The mocked unit coverage can only prove ProPR *asks* for the right thing: the
# right image, read-only credential mounts, the generated config schema. What it
# cannot prove is that the runtime inside the image answers - that `agent-tank`
# uses the Claude usage API and the shipped Codex/AGY runtimes and
# comes back with real usage numbers. That is what this script does, against the
# operator's own authenticated credentials.
#
# Requires authenticated host state: at least one of ~/.claude, ~/.codex or
# ~/.gemini. Every credential directory found is mounted READ-ONLY at the
# container path the agent runtime uses, exactly as bundled mode does, and the
# run goes through the image ENTRYPOINT with PROPR_AGENT_TYPE=agent-tank so no
# provider entrypoint (and no ownership repair) runs.
#
# By default every provider whose credential directory exists is inspected, and
# each one has to come back with usage. Set AGENT_TANK_PROVIDERS to a subset
# (for example `agy`) on a host where only some accounts are authenticated; a
# provider named there must have credentials.
#
# Agent Tank is open source, so the pinned version does not have to be published
# on npm for this check to be possible: when the image does not already ship the
# pinned version, the run clones the public repository at the pinned ref inside
# the container, builds it there, and drives that build instead. Pick the
# runtime explicitly with AGENT_TANK_RUNTIME=bundled|source (default: auto).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

AGENT_TAG="${AGENT_TAG:-propr/agent:latest}"
CLAUDE_CONFIG_PATH="${CLAUDE_CONFIG_PATH:-$HOME/.claude}"
CODEX_CONFIG_PATH="${CODEX_CONFIG_PATH:-$HOME/.codex}"
ANTIGRAVITY_CONFIG_PATH="${ANTIGRAVITY_CONFIG_PATH:-$HOME/.gemini}"
AGENT_TANK_REPO_URL="${AGENT_TANK_REPO_URL:-https://github.com/integry/agent-tank.git}"
# Empty means "any commit the pinned ref points at"; set it to require one.
AGENT_TANK_GIT_COMMIT="${AGENT_TANK_GIT_COMMIT:-}"
AGENT_TANK_RUNTIME="${AGENT_TANK_RUNTIME:-auto}"
# A cold `/usage` per provider plus, in source mode, a node-pty build.
VERIFY_TIMEOUT_SECONDS="${VERIFY_TIMEOUT_SECONDS:-900}"

# The version pin lives in Dockerfile.agent because it feeds the agent bundle
# content hash; reading it back from there is what keeps this check honest about
# the image it is handed.
DOCKERFILE_PINNED_VERSION="$(
  sed -n 's/^ARG AGENT_TANK_CLI_VERSION=\([^[:space:]]*\).*$/\1/p' Dockerfile.agent | head -n 1
)"
if [ -z "$DOCKERFILE_PINNED_VERSION" ]; then
  echo "Could not read ARG AGENT_TANK_CLI_VERSION from Dockerfile.agent" >&2
  exit 1
fi
AGENT_TANK_VERSION="${AGENT_TANK_VERSION:-$DOCKERFILE_PINNED_VERSION}"
AGENT_TANK_GIT_REF="${AGENT_TANK_GIT_REF:-v$AGENT_TANK_VERSION}"

case "$AGENT_TANK_RUNTIME" in
  auto|bundled|source) ;;
  *)
    echo "AGENT_TANK_RUNTIME must be auto, bundled, or source (got '$AGENT_TANK_RUNTIME')" >&2
    exit 1
    ;;
esac

# Kept byte-identical to CONFIG_BOOTSTRAP in
# packages/core/src/services/agentTankBundledRunner.ts: this script is only
# evidence about production if it runs the command production runs.
# test/agentTankImageVerification.test.ts asserts the two stay in sync.
BUNDLED_BOOTSTRAP='set -e; umask 077; mkdir -p "$(dirname "$1")"; printf %s "$PROPR_AGENT_TANK_CONFIG" > "$1"; exec node /home/node/agent-tank-runtime.mjs "$1" --run'
# Same contract, different binary: clone the pinned ref, build it in the image,
# and exec that build. The clone is quiet and npm's chatter goes to stderr so
# stdout stays the pure JSON document the production parser reads. node-pty
# compiles against the toolchain the agent image already carries.
SOURCE_BOOTSTRAP='set -e
umask 077
mkdir -p "$(dirname "$1")"
printf %s "$PROPR_AGENT_TANK_CONFIG" > "$1"
node /home/node/agent-tank-runtime.mjs "$1"
checkout=/tmp/propr-agent-tank-src
rm -rf "$checkout"
git clone --quiet --depth 1 --branch "$AGENT_TANK_GIT_REF" "$AGENT_TANK_REPO_URL" "$checkout"
cd "$checkout"
head_commit="$(git rev-parse HEAD)"
if [ -n "${AGENT_TANK_GIT_COMMIT:-}" ] && [ "$head_commit" != "$AGENT_TANK_GIT_COMMIT" ]; then
  echo "clone of $AGENT_TANK_GIT_REF is commit $head_commit, expected $AGENT_TANK_GIT_COMMIT" >&2
  exit 1
fi
built_version="$(node -p "require(\"./package.json\").version")"
if [ "$built_version" != "$AGENT_TANK_VERSION" ]; then
  echo "clone of $AGENT_TANK_GIT_REF is version $built_version, expected $AGENT_TANK_VERSION" >&2
  exit 1
fi
echo "built agent-tank $built_version from commit $head_commit" >&2
npm install --omit=dev --no-audit --no-fund --loglevel=error >&2
exec node bin/agent-tank.js --once --json --config "$1"'
# The credential mounts are the whole point of this check, so prove they are
# read-only from inside the container rather than trusting the flag we passed.
# A provider entrypoint would have tried to chown them; that this succeeds as
# the unprivileged node user is the evidence none of them ran.
WRITE_PROBE='set -e
echo "user=$(id -un)"
for target in "$@"; do
  if touch "$target/.propr-agent-tank-write-probe" 2>/dev/null; then
    rm -f "$target/.propr-agent-tank-write-probe" || true
    echo "writable=$target" >&2
    exit 1
  fi
done
echo read-only-confirmed'

CONTAINER_CONFIG_FILE=/tmp/propr-agent-tank/config.json

echo "▸ bundled Agent Tank image verification"
echo "  agent tag:      $AGENT_TAG"
echo "  pinned version: $AGENT_TANK_VERSION"
echo "  runtime:        $AGENT_TANK_RUNTIME"
echo ""

docker image inspect "$AGENT_TAG" >/dev/null

# --- Credential discovery ---------------------------------------------------
providers=()
mount_args=()
container_targets=()
host_paths=()

# Provider keys are Agent Tank's (SUPPORTED_PROVIDERS upstream) and container
# paths are ProPR's (CONTAINER_CONFIG_PATHS in packages/core). Agent Tank knows
# exactly these three; anything else makes the whole run exit non-zero.
SELECTED_PROVIDERS="${AGENT_TANK_PROVIDERS:-claude codex agy}"
for provider in $SELECTED_PROVIDERS; do
  case "$provider" in
    claude|codex|agy) ;;
    *)
      echo "AGENT_TANK_PROVIDERS must list claude, codex, or agy (got '$provider')" >&2
      exit 1
      ;;
  esac
done

add_provider() {
  local provider="$1" host_path="$2" container_path="$3"
  case " $SELECTED_PROVIDERS " in
    *" $provider "*) ;;
    *) return 0 ;;
  esac
  if [ ! -d "$host_path" ]; then
    if [ -n "${AGENT_TANK_PROVIDERS:-}" ]; then
      echo "Provider $provider was requested but has no credentials at $host_path" >&2
      exit 1
    fi
    return 0
  fi
  providers+=("$provider")
  host_paths+=("$host_path")
  container_targets+=("$container_path")
  mount_args+=(--mount "type=bind,source=$host_path,target=$container_path,readonly")
  echo "✓ found $provider credentials at $host_path"
}

add_provider claude "$CLAUDE_CONFIG_PATH" /home/node/.claude
add_provider codex "$CODEX_CONFIG_PATH" /home/node/.codex
add_provider agy "$ANTIGRAVITY_CONFIG_PATH" /home/node/.gemini

if [ "${#providers[@]}" -eq 0 ]; then
  echo "No authenticated agent CLI credentials found." >&2
  echo "  Looked for $CLAUDE_CONFIG_PATH, $CODEX_CONFIG_PATH, $ANTIGRAVITY_CONFIG_PATH." >&2
  echo "  Bundled Agent Tank can only report usage for an authenticated provider." >&2
  exit 1
fi

# --- Generated config (production schema) -----------------------------------
config_entries=""
for index in "${!providers[@]}"; do
  config_entries+="${providers[index]}=${container_targets[index]}"$'\n'
done

config_json="$(
  AGENT_TANK_ENTRIES="$config_entries" node -e '
    const entries = (process.env.AGENT_TANK_ENTRIES || "")
      .split("\n")
      .filter(Boolean)
      .map(line => {
        const separator = line.indexOf("=");
        const provider = line.slice(0, separator);
        // `id` is pinned to the provider key, exactly as
        // buildBundledAgentTankConfig does, so the output map is keyed the way
        // every downstream ProPR consumer parses it.
        return { provider, id: provider, configPath: line.slice(separator + 1) };
      });
    process.stdout.write(JSON.stringify({ agents: entries, dockerAccess: false }, null, 2));
  '
)"

# --- Credential immutability baseline ---------------------------------------
# A directory always contributes its own entry, so an empty manifest means the
# walk failed - and comparing two failed walks would pass without checking
# anything.
EMPTY_MANIFEST="$(printf '' | sha256sum | cut -d' ' -f1)"

credential_manifest() {
  local host_path="$1"
  find "$host_path" -printf '%P %y %s %T@\n' 2>/dev/null | LC_ALL=C sort | sha256sum | cut -d' ' -f1
}

baseline_manifests=()
for host_path in "${host_paths[@]}"; do
  manifest="$(credential_manifest "$host_path")"
  if [ "$manifest" = "$EMPTY_MANIFEST" ]; then
    echo "Could not read the contents of $host_path" >&2
    exit 1
  fi
  baseline_manifests+=("$manifest")
done

# --- Runtime selection ------------------------------------------------------
bundled_version=""
if [ "$AGENT_TANK_RUNTIME" != "source" ]; then
  bundled_version="$(
    docker run --rm \
      -e PROPR_AGENT_TYPE=agent-tank \
      "$AGENT_TAG" agent-tank --version 2>/dev/null |
      grep -Eom1 '[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+-]*' || true
  )"
fi

runtime="$AGENT_TANK_RUNTIME"
if [ "$runtime" = "auto" ]; then
  if [ "$bundled_version" = "$AGENT_TANK_VERSION" ]; then
    runtime=bundled
  else
    runtime=source
    echo "  image ships agent-tank '${bundled_version:-none}', not the pinned $AGENT_TANK_VERSION"
    echo "  building the pinned ref $AGENT_TANK_GIT_REF from $AGENT_TANK_REPO_URL instead"
  fi
fi

if [ "$runtime" = "bundled" ]; then
  if [ "$bundled_version" != "$AGENT_TANK_VERSION" ]; then
    echo "Image ships agent-tank '${bundled_version:-none}', expected the pinned $AGENT_TANK_VERSION" >&2
    exit 1
  fi
  echo "✓ image ships the pinned Agent Tank $bundled_version"
  bootstrap="$BUNDLED_BOOTSTRAP"
else
  echo "▸ building Agent Tank $AGENT_TANK_VERSION from $AGENT_TANK_GIT_REF inside the image"
  bootstrap="$SOURCE_BOOTSTRAP"
fi

# --- The run under test -----------------------------------------------------
echo ""
echo "▸ reading usage for: ${providers[*]}"
# `timeout` can kill the client while the daemon still holds the container, and
# a leftover name would then block the next run.
container_name="propr-agent-tank-verify-$$"
cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

run_args=(
  run --rm
  --name "$container_name"
  -e PROPR_AGENT_TYPE=agent-tank
  -e "PROPR_AGENT_TANK_CONFIG=$config_json"
)
if [ "$runtime" = "source" ]; then
  run_args+=(
    -e "AGENT_TANK_REPO_URL=$AGENT_TANK_REPO_URL"
    -e "AGENT_TANK_GIT_REF=$AGENT_TANK_GIT_REF"
    -e "AGENT_TANK_GIT_COMMIT=$AGENT_TANK_GIT_COMMIT"
    -e "AGENT_TANK_VERSION=$AGENT_TANK_VERSION"
  )
fi
if [ "$runtime" = "bundled" ]; then
  run_args+=(--user 0:0 --entrypoint /bin/sh)
  command_args=(-c)
else
  command_args=(sh -c)
fi
run_args+=(
  "${mount_args[@]}"
  "$AGENT_TAG"
  "${command_args[@]}" "$bootstrap" propr-agent-tank "$CONTAINER_CONFIG_FILE"
)

status_output=""
if ! status_output="$(timeout "$VERIFY_TIMEOUT_SECONDS" docker "${run_args[@]}")"; then
  echo "✗ bundled Agent Tank run failed inside $AGENT_TAG" >&2
  printf '%s\n' "$status_output" >&2
  exit 1
fi

# --- Usage evidence ---------------------------------------------------------
# A provider key alone is not evidence: an unauthenticated CLI still produces an
# entry, with an error and an empty usage object. Every provider whose
# credentials were mounted has to come back with at least one usage number.
if ! usage_summary="$(
  AGENT_TANK_EXPECTED_PROVIDERS="${providers[*]}" node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      const expected = (process.env.AGENT_TANK_EXPECTED_PROVIDERS || "").split(" ").filter(Boolean);
      const trimmed = input.trim();
      // Same tolerance as parseBundledAgentTankOutput: banner lines may precede
      // the JSON document.
      const start = trimmed.indexOf("{");
      if (start < 0) {
        process.stderr.write("Agent Tank produced no JSON document\n");
        process.exit(1);
      }
      let parsed;
      try {
        parsed = JSON.parse(trimmed.slice(start));
      } catch (error) {
        process.stderr.write(`Agent Tank produced unparseable JSON: ${error.message}\n`);
        process.exit(1);
      }
      const agents = parsed && parsed.agents && typeof parsed.agents === "object" ? parsed.agents : parsed;
      // Only metric names and numbers are printed: a status payload can carry
      // account metadata, which has no place in CI logs.
      const metrics = value => {
        const found = [];
        const collect = (key, entry) => {
          if (!entry || typeof entry !== "object") return;
          for (const field of ["percent", "percentUsed", "percentLeft"]) {
            if (typeof entry[field] === "number") found.push(`${key}.${field}=${entry[field]}`);
          }
        };
        for (const [key, entry] of Object.entries(value || {})) {
          if (typeof entry === "number") found.push(`${key}=${entry}`);
          else if (Array.isArray(entry)) {
            entry.forEach((item, index) => collect(`${key}[${typeof item?.model === "string" ? item.model : index}]`, item));
          } else collect(key, entry);
        }
        return found;
      };
      const lines = [];
      for (const provider of expected) {
        const status = agents?.[provider];
        if (!status || typeof status !== "object") {
          process.stderr.write(`Agent Tank reported nothing for provider ${provider}\n`);
          process.exit(1);
        }
        if (typeof status.error === "string" && status.error) {
          process.stderr.write(`Agent Tank reported an error for provider ${provider}: ${status.error}\n`);
          process.exit(1);
        }
        const found = metrics(status.usage);
        if (found.length === 0) {
          process.stderr.write(`Agent Tank reported no usage numbers for provider ${provider}\n`);
          process.exit(1);
        }
        lines.push(`${provider}: ${found.join(", ")}`);
      }
      process.stdout.write(`${lines.join("\n")}\n`);
    });
  ' <<< "$status_output"
)"; then
  echo "✗ bundled Agent Tank produced no usable usage data" >&2
  exit 1
fi
printf '%s\n' "$usage_summary"
echo "✓ every mounted provider returned usage through the bundled runtime"

# --- Read-only mounts, no provider entrypoint -------------------------------
probe_output=""
if ! probe_output="$(
  docker run --rm \
    -e PROPR_AGENT_TYPE=agent-tank \
    "${mount_args[@]}" \
    "$AGENT_TAG" \
    sh -c "$WRITE_PROBE" propr-agent-tank "${container_targets[@]}" 2>&1
)"; then
  if grep -Fq 'writable=' <<< "$probe_output"; then
    echo "✗ a mounted credential directory was writable inside the container" >&2
  else
    echo "✗ read-only mount probe failed inside $AGENT_TAG" >&2
  fi
  printf '%s\n' "$probe_output" >&2
  exit 1
fi
if ! grep -Fq read-only-confirmed <<< "$probe_output"; then
  echo "✗ read-only mount probe produced no verdict" >&2
  printf '%s\n' "$probe_output" >&2
  exit 1
fi
if ! grep -Fq user=node <<< "$probe_output"; then
  echo "✗ the usage probe ran as $(grep -F user= <<< "$probe_output" || echo 'an unknown user'), expected user=node" >&2
  exit 1
fi
echo "✓ credential mounts are read-only and no provider entrypoint ran"

for index in "${!host_paths[@]}"; do
  if [ "$(credential_manifest "${host_paths[index]}")" != "${baseline_manifests[index]}" ]; then
    echo "✗ ${host_paths[index]} changed during the usage probe" >&2
    exit 1
  fi
done
echo "✓ host credential directories are byte-for-byte unchanged"

echo ""
echo "✓ bundled Agent Tank verification passed ($runtime runtime, version $AGENT_TANK_VERSION)"

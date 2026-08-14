#!/usr/bin/env bash
# Verify that the pinned Antigravity image exposes and actually selects Gemini
# 3.7 Flash at every supported effort tier. Requires authenticated host state.

set -euo pipefail

AGENT_TAG="${AGENT_TAG:-propr/agent:latest}"
ANTIGRAVITY_CONFIG_PATH="${ANTIGRAVITY_CONFIG_PATH:-$HOME/.gemini}"
EXPECTED_ANTIGRAVITY_VERSION="${EXPECTED_ANTIGRAVITY_VERSION:-1.1.13}"

if [ ! -d "$ANTIGRAVITY_CONFIG_PATH" ]; then
  echo "Antigravity credentials not found at $ANTIGRAVITY_CONFIG_PATH" >&2
  exit 1
fi
docker image inspect "$AGENT_TAG" >/dev/null

runtime_home="$(mktemp -d "${TMPDIR:-/tmp}/propr-antigravity-verify.XXXXXX")"
cleanup() {
  if [[ "$runtime_home" == "${TMPDIR:-/tmp}"/propr-antigravity-verify.* ]]; then
    rm -rf "$runtime_home"
  fi
}
trap cleanup EXIT

# Only copy the authenticated state used by the production ephemeral runtime.
# This keeps model checks from writing projects, caches, or transcripts to the
# operator's real Antigravity home.
for relative_path in \
  antigravity-cli/antigravity-oauth-token \
  antigravity-cli/settings.json; do
  source_path="$ANTIGRAVITY_CONFIG_PATH/$relative_path"
  if [ -f "$source_path" ]; then
    mkdir -p "$runtime_home/.gemini/$(dirname "$relative_path")"
    cp -p "$source_path" "$runtime_home/.gemini/$relative_path"
  fi
done

run_agy() {
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --env HOME=/tmp/propr-antigravity-home \
    --env AGY_CLI_DISABLE_AUTO_UPDATE=true \
    --volume "$runtime_home:/tmp/propr-antigravity-home" \
    --workdir /tmp/propr-antigravity-home \
    --entrypoint agy \
    "$AGENT_TAG" "$@"
}

actual_version="$(run_agy --version)"
if [ "$actual_version" != "$EXPECTED_ANTIGRAVITY_VERSION" ]; then
  echo "Expected Antigravity CLI $EXPECTED_ANTIGRAVITY_VERSION, got $actual_version" >&2
  exit 1
fi

models_output="$(run_agy models)"
models=(
  "Gemini 3.7 Flash (High)"
  "Gemini 3.7 Flash (Medium)"
  "Gemini 3.7 Flash (Low)"
)
for display_name in "${models[@]}"; do
  if ! grep -Fq "$display_name" <<< "$models_output"; then
    echo "Antigravity CLI did not advertise $display_name" >&2
    printf '%s\n' "$models_output" >&2
    exit 1
  fi
done
echo "✓ Antigravity CLI advertises all Gemini 3.7 Flash tiers"

for display_name in "${models[@]}"; do
  invocation_output="$(run_agy \
    --print \
    --print-timeout 5m \
    --output-format stream-json \
    --model "$display_name" \
    'Reply with exactly OK. Do not use tools.')"

  reported_model="$(node --input-type=module -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      for (const line of input.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event?.type === "init" && typeof event.model === "string") {
            process.stdout.write(event.model);
            return;
          }
        } catch { /* non-protocol diagnostic */ }
      }
      process.exitCode = 1;
    });
  ' <<< "$invocation_output")" || {
    echo "Antigravity $display_name invocation did not report an init model" >&2
    printf '%s\n' "$invocation_output" >&2
    exit 1
  }

  if [[ "$reported_model" != *"3.7"* ]]; then
    echo "Antigravity $display_name silently selected '$reported_model' instead of Gemini 3.7" >&2
    exit 1
  fi
  echo "✓ $display_name invocation reported $reported_model"
done

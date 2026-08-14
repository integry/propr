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
  "gemini-3.7-flash-high|Gemini 3.7 Flash (High)"
  "gemini-3.7-flash-medium|Gemini 3.7 Flash (Medium)"
  "gemini-3.7-flash-low|Gemini 3.7 Flash (Low)"
)
for model in "${models[@]}"; do
  model_id="${model%%|*}"
  display_name="${model#*|}"
  if ! grep -Fq "$model_id" <<< "$models_output" || ! grep -Fq "$display_name" <<< "$models_output"; then
    echo "Antigravity CLI did not advertise $model_id as $display_name" >&2
    printf '%s\n' "$models_output" >&2
    exit 1
  fi
done
echo "✓ Antigravity CLI advertises all Gemini 3.7 Flash tiers"

for model in "${models[@]}"; do
  model_id="${model%%|*}"
  display_name="${model#*|}"
  invocation_output="$(run_agy \
    --print \
    --print-timeout 5m \
    --output-format stream-json \
    --model "$model_id" \
    'Reply with exactly STREAM_OK. Do not use tools.')"

  reported_model="$(EXPECTED_MODEL="$display_name" EXPECTED_RESPONSE=$'STREAM_OK\n' node --input-type=module -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      let reportedModel;
      let terminalStatus;
      let streamedResponse = "";
      let completeResponse;
      for (const line of input.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event?.event === "init" && typeof event.init?.model === "string") {
            reportedModel = event.init.model;
          } else if (event?.type === "init" && typeof event.model === "string") {
            reportedModel = event.model;
          }
          if (event?.event === "step_update" && event.step_update?.step_type === "agent_response" && typeof event.step_update.text_delta === "string") {
            streamedResponse += event.step_update.text_delta;
          } else if (event?.type === "message" && event.role === "assistant" && typeof event.content === "string") {
            if (event.delta) streamedResponse += event.content;
            else completeResponse = event.content;
          }
          if (event?.event === "result" && event.result) {
            terminalStatus = event.result.status;
            if (typeof event.result.response === "string") completeResponse = event.result.response;
          } else if (event?.type === "result") {
            terminalStatus = event.status;
            if (typeof event.response === "string") completeResponse = event.response;
          }
        } catch { /* non-protocol diagnostic */ }
      }
      const response = completeResponse ?? streamedResponse;
      if (reportedModel !== process.env.EXPECTED_MODEL) {
        process.stderr.write(`expected init model ${JSON.stringify(process.env.EXPECTED_MODEL)}, got ${JSON.stringify(reportedModel)}\n`);
        process.exitCode = 1;
      } else if (typeof terminalStatus !== "string" || terminalStatus.toUpperCase() !== "SUCCESS") {
        process.stderr.write(`expected final SUCCESS, got ${JSON.stringify(terminalStatus)}\n`);
        process.exitCode = 1;
      } else if (response !== process.env.EXPECTED_RESPONSE) {
        process.stderr.write(`expected exact sentinel ${JSON.stringify(process.env.EXPECTED_RESPONSE)}, got ${JSON.stringify(response)}\n`);
        process.exitCode = 1;
      } else {
        process.stdout.write(reportedModel);
      }
    });
  ' <<< "$invocation_output")" || {
    echo "Antigravity $model_id invocation failed identity, SUCCESS, or exact-response validation" >&2
    printf '%s\n' "$invocation_output" >&2
    exit 1
  }

  if [ "$reported_model" != "$display_name" ]; then
    echo "Antigravity $model_id silently selected '$reported_model' instead of '$display_name'" >&2
    exit 1
  fi
  echo "✓ $model_id returned exact sentinel with SUCCESS and reported $reported_model"
done

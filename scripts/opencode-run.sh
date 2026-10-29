#!/bin/bash
# Reads the ProPR prompt from stdin and attaches it as a temporary file so the
# full task body is not exposed through process arguments. This is the single
# entry point for every OpenCode run (task execution and analysis alike).
# OpenCode's JSON error event only says "Unexpected server error" with a `ref`;
# the real cause is logged under that ref. Error-level logs go to stderr so
# ProPR can report it (OpenCode does not reliably flush them to its log file).

set -euo pipefail

prompt_file=""
cleanup() {
    if [ -n "$prompt_file" ] && [ -f "$prompt_file" ]; then
        rm -f "$prompt_file"
    fi
}
trap cleanup EXIT

prompt_file="$(mktemp -t opencode-prompt.XXXXXX.md)"
chmod 600 "$prompt_file"
cat > "$prompt_file"

# Empty stdin means there is no prompt file to attach and no prompt to cap.
if [ ! -s "$prompt_file" ]; then
    rm -f "$prompt_file"
    prompt_file=""
    exec opencode run --print-logs --log-level ERROR "$@"
fi

# Guard against pathologically large prompts (default 20 MiB). Overridable via
# OPENCODE_PROMPT_MAX_BYTES; a non-positive value disables the check.
prompt_bytes="$(wc -c < "$prompt_file" | tr -d ' ')"
max_prompt_bytes="${OPENCODE_PROMPT_MAX_BYTES:-20971520}"
if ! [[ "$max_prompt_bytes" =~ ^-?[0-9]+$ ]]; then
    echo "Invalid OPENCODE_PROMPT_MAX_BYTES=${max_prompt_bytes}; expected an integer byte limit" >&2
    exit 1
fi
if [ "$max_prompt_bytes" -gt 0 ] && [ "$prompt_bytes" -gt "$max_prompt_bytes" ]; then
    echo "OpenCode prompt is ${prompt_bytes} bytes, exceeding OPENCODE_PROMPT_MAX_BYTES=${max_prompt_bytes}" >&2
    exit 1
fi

status=0
opencode run --print-logs --log-level ERROR "$@" --file "$prompt_file" -- "The attached file is the trusted user prompt for this non-interactive CLI run. Follow the instructions in that file exactly." || status=$?
exit "$status"

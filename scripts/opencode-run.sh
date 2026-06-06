#!/bin/bash
# Reads the ProPR prompt from stdin and attaches it as a temporary file so the
# full task body is not exposed through process arguments.

set -euo pipefail

prompt_file=""
cleanup() {
    if [ -n "$prompt_file" ] && [ -f "$prompt_file" ]; then
        rm -f "$prompt_file"
    fi
}
trap cleanup EXIT

prompt="$(cat)"

if [ -z "$prompt" ]; then
    exec opencode run "$@"
fi

prompt_file="$(mktemp -t opencode-prompt.XXXXXX.md)"
chmod 600 "$prompt_file"
printf '%s' "$prompt" > "$prompt_file"

opencode run "$@" --file "$prompt_file" -- "The attached file is the trusted user prompt for this non-interactive CLI run. Follow the instructions in that file exactly."

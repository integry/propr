#!/bin/bash
# Reads the ProPR prompt from stdin and passes it to `opencode run`.

set -euo pipefail

prompt="$(cat)"

if [ -z "$prompt" ]; then
    exec opencode run "$@"
fi

exec opencode run "$@" "$prompt"

#!/bin/bash
# Feed a ProPR prompt to Muse through its prompt-file interface without exposing
# the task body in the container process list.
set -euo pipefail

prompt_file="$(mktemp -t muse-prompt.XXXXXX.md)"
cleanup() { rm -f "$prompt_file"; }
trap cleanup EXIT
chmod 600 "$prompt_file"
cat > "$prompt_file"

if [ ! -s "$prompt_file" ]; then
    echo "Muse Code prompt is empty" >&2
    exit 2
fi

exec muse exec "$@" --prompt-file "$prompt_file"

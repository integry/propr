#!/bin/bash
# Reads the ProPR prompt from stdin and attaches it as a temporary file so the
# full task body is not exposed through process arguments. This is the single
# entry point for every OpenCode run (task execution and analysis alike).
# OpenCode's JSON error event only says "Unexpected server error" with a `ref`;
# the real cause is logged under that ref. Error-level logs go to stderr so
# ProPR can report it (OpenCode does not reliably flush them to its log file).

set -euo pipefail

# Standalone keeps the server lifetime and state scoped to this container.
log_flags=(--standalone --log-level error)
if [[ "$(opencode --version)" == 1.* ]]; then
    log_flags=(--print-logs --log-level ERROR)
fi

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
    exec opencode run "${log_flags[@]}" "$@"
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

# OpenCode runs as a background child so this wrapper can forward stop signals
# to it. The entrypoint signals only this wrapper (its own direct child); a
# foreground OpenCode would never see TERM/INT/HUP, and the wrapper would exit
# while OpenCode still ran, so the entrypoint's credential write-back could
# start before OpenCode had exited. The wrapper therefore waits until OpenCode
# has really exited, then removes the prompt file on exit as before.
# Without job control bash points a background command's stdin at /dev/null and
# ignores SIGINT/SIGQUIT in it, so stdin is passed explicitly and env restores
# default handling of those signals for OpenCode.
opencode_pid=""
stop_signal=""
forward_signal() {
    stop_signal="$1"
    if [ -n "$opencode_pid" ]; then
        kill -s "$1" "$opencode_pid" 2>/dev/null || true
    fi
}
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT
trap 'forward_signal HUP' HUP

env --default-signal=INT,QUIT opencode run "${log_flags[@]}" "$@" --file "$prompt_file" -- "The attached file is the trusted user prompt for this non-interactive CLI run. Follow the instructions in that file exactly." 0<&0 &
opencode_pid=$!
# A signal that arrived before the PID was known.
if [ -n "$stop_signal" ]; then
    kill -s "$stop_signal" "$opencode_pid" 2>/dev/null || true
fi

status=0
while :; do
    status=0
    wait "$opencode_pid" || status=$?
    # A trapped signal interrupts wait with 128+n while OpenCode still runs.
    if [ "$status" -le 128 ] || [ -z "$stop_signal" ]; then
        break
    fi
    if ! kill -0 "$opencode_pid" 2>/dev/null; then
        # Already reaped: bash keeps its status for one more wait.
        final_status=0
        wait "$opencode_pid" || final_status=$?
        if [ "$final_status" -ne 127 ]; then status=$final_status; fi
        break
    fi
done
exit "$status"

#!/usr/bin/env bash

set -euo pipefail

# Records where a CI job actually ran: the runner worker, the user its steps
# run as and visible cgroup v2 limits. A container cgroup namespace can hide
# the parent user slice that caps this runner plus sibling Docker workloads.
# These observations do not verify host-wide containment or effective limits.
# Read-only: it changes nothing on the host.

read_limit() {
  local file="$1"
  if [[ -n "$CGROUP_DIR" && -r "$CGROUP_DIR/$file" ]]; then
    tr -d '\n' < "$CGROUP_DIR/$file"
  else
    printf 'unavailable'
  fi
}

CGROUP_PATH=""
if [[ -r /proc/self/cgroup ]]; then
  CGROUP_PATH="$(sed -n 's/^0:://p' /proc/self/cgroup | head -n 1)"
fi
CGROUP_DIR=""
# Walk to the nearest visible level that sets a limit. Container namespace
# roots may hide stricter host-side ancestors.
if [[ -n "$CGROUP_PATH" && -d "/sys/fs/cgroup$CGROUP_PATH" ]]; then
  CGROUP_DIR="/sys/fs/cgroup$CGROUP_PATH"
  while [[ "$CGROUP_DIR" != /sys/fs/cgroup && "$(read_limit memory.max)" == max && "$(read_limit cpu.max)" == max* ]]; do
    CGROUP_DIR="$(dirname "$CGROUP_DIR")"
  done
fi

LIMITING_CGROUP=""
if [[ -n "$CGROUP_DIR" ]]; then
  LIMITING_CGROUP="${CGROUP_DIR#/sys/fs/cgroup}"
  LIMITING_CGROUP="${LIMITING_CGROUP:-/}"
fi

report="$(cat <<REPORT
### Runner placement: ${GITHUB_JOB:-job}${PROPR_EVIDENCE_LABEL:+ ($PROPR_EVIDENCE_LABEL)}

| Field | Value |
| --- | --- |
| Runner name | \`${RUNNER_NAME:-unknown}\` |
| Runner environment | \`${RUNNER_ENVIRONMENT:-unknown}\` |
| OS / architecture | \`${RUNNER_OS:-unknown}\` / \`${RUNNER_ARCH:-unknown}\` |
| User (uid) | \`$(id -un 2>/dev/null || echo unknown)\` (\`$(id -u)\`) |
| Run attempt | \`${GITHUB_RUN_ATTEMPT:-unknown}\` |
| Logical CPUs visible | \`$(nproc 2>/dev/null || echo unknown)\` |
| Process cgroup | \`${CGROUP_PATH:-unavailable}\` |
| Visible limiting cgroup | \`${LIMITING_CGROUP:-unavailable}\` |
| cpu.max | \`$(read_limit cpu.max)\` |
| memory.high | \`$(read_limit memory.high)\` |
| memory.max | \`$(read_limit memory.max)\` |

Container-visible cgroups may hide ancestor limits; host pilot evidence is required for the combined per-user cap.
REPORT
)"

printf '%s\n' "$report"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '%s\n\n' "$report" >> "$GITHUB_STEP_SUMMARY"
fi

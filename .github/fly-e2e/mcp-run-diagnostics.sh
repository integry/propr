#!/usr/bin/env bash
# Prints why a fixture automation run did not complete, while the app is still up.
# Called by .github/workflows/fly-e2e.yml before teardown:
#
#   mcp-run-diagnostics.sh RUN_ID [worker-log.jsonl ...]
#
# Prints, redacted with propr_redact:
#   1. the run's state and failure fields, from GET /api/automation-runs/RUN_ID;
#   2. the timeline of the run's tasks, from GET /api/task/TASK/history;
#   3. the last 80 log events of each task, from GET /api/task/TASK/live-details;
#   4. every worker log line since MCP_TRIGGERED_AT (ms) that names the run or a task,
#      from the given `flyctl logs --json` files and a fresh `flyctl logs --no-tail` read.
# Best-effort: a failing section is reported and the rest still runs. Always exits 0.
# Needs APP and GH_TOKEN (the API), FLY_API_TOKEN (the worker log) and propr-api.sh.
set -uo pipefail
# shellcheck source=.github/fly-e2e/propr-api.sh
source "$(dirname "${BASH_SOURCE[0]}")/propr-api.sh"

run_id=${1:?usage: mcp-run-diagnostics.sh RUN_ID [worker-log.jsonl ...]}
shift
since=${MCP_TRIGGERED_AT:-0}
[[ $since =~ ^[0-9]+$ ]] || since=0

echo "::group::Automation run $run_id: state and failure fields"
run=$(propr_api GET "/automation-runs/$run_id" | jq -ec '.run | objects') || run=''
if [[ -n $run ]]; then
  # The API names the reason failureReason (skipReason for a skipped run); the other names are
  # checked too so a renamed field cannot leave the reason empty again.
  jq -r '"state: \(.state)",
    (["failureReason", "skipReason", "operatorNote", "error", "failure", "errorCode", "lastError"][] as $field
      | .[$field] | select(. != null and . != "") | "\($field): \(if type == "string" then . else tojson end)")' <<< "$run" | propr_redact
  jq -c 'del(.report, .definitionSnapshot) + {report: (.report // "" | .[0:2000])}' <<< "$run" | propr_redact
else
  echo "The automation run could not be read."
fi
echo "::endgroup::"

mapfile -t tasks < <(jq -r '.reportTaskId, .actionTaskId | strings' <<< "${run:-null}" 2>/dev/null)
[[ ${#tasks[@]} -gt 0 ]] || echo "The run has no report or acting task yet."
for task in "${tasks[@]}"; do
  encoded=$(jq -rn --arg task "$task" '$task | @uri')
  echo "::group::Task $task: timeline"
  propr_api GET "/task/$encoded/history" |
    jq -r '.history[]? | "\(.timestamp // "-") \(.state // "-") \(del(.timestamp, .state) | tojson | .[0:800])"' |
    propr_redact || echo "The task timeline could not be read."
  echo "::endgroup::"
  echo "::group::Task $task: last 80 log events"
  propr_api GET "/task/$encoded/live-details" |
    jq -r '(.events // [] | .[-80:][] | tojson | .[0:800]),
      (.currentTask // empty | "currentTask: \(tojson | .[0:800])")' |
    propr_redact || echo "The task log could not be read."
  echo "::endgroup::"
done

echo "::group::Worker log lines since MCP_TRIGGERED_AT naming the run or its tasks"
recent=$(mktemp)
timeout 60s flyctl logs --app "$APP" --no-tail --json > "$recent" 2>/dev/null || true
ids=$(jq -cn --arg run "$run_id" '[$run] + $ARGS.positional' --args "${tasks[@]}")
cat "$@" "$recent" 2>/dev/null |
  jq -Rr --argjson ids "$ids" --argjson since "$since" '
    fromjson? | objects | (.message // empty | strings) as $message
    | select(any($ids[]; . as $id | $message | contains($id)))
    | (($message | fromjson? | objects | .time | numbers)
      // ((.timestamp // "" | strings | sub("\\.[0-9]+"; "") | fromdateiso8601?) * 1000)
      // null) as $time
    | select($time == null or $time >= $since)
    | "\(.timestamp // "-") \($message)"' |
  awk '!seen[$0]++' | tail -n 400 | propr_redact
rm -f "$recent"
echo "::endgroup::"
exit 0

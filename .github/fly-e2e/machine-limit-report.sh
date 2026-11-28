#!/usr/bin/env bash
# Reports the Fly organization machine-limit (HTTP 422) records in the worker log, and fails on the ones that matter.
#
#   machine-limit-report.sh <logs.json>    a JSON array of the worker's parsed log records
#
# Each refusal logs the agent app's Machines as Fly listed them (id, state and name, destroyed ones included), and
# each refused create logs its outcome: "create accepted after retries" or "create given up", with `attempts` (create
# requests, the accepted one included) and `waitedMs` (since the first refusal). The step output and the step summary
# show every Machine list. A retried create that Fly then accepted within the bound is a warning; the check fails when
#   - a create was given up (the run failed with the machine-limit error), or one never logged an outcome;
#   - a record mentions the machine limit outside these records (a run failed with Fly's raw 422);
#   - an accepted create needed more than MAX_RETRIES retries or more than MAX_WAIT_MS since its first refusal.
set -euo pipefail
logs=$1
MAX_RETRIES=${MAX_RETRIES:-3}
MAX_WAIT_MS=${MAX_WAIT_MS:-60000}
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
prefix='Fly organization machine limit reached; '

report=$(jq -c --arg prefix "$prefix" '
  def key: (.run // .builder // "unknown");
  def known: ["Machines in the agent app", "listing the agent app'"'"'s Machines failed", "retrying create",
    "create accepted after retries", "create given up"] | map($prefix + .);
  [.[] | select(tostring | test("machine limit"; "i"))] as $records
  | ($records | map(select((.msg // "") as $msg | known | index($msg)))) as $mine
  | {
      lists: [$mine[] | select(.msg == $prefix + "Machines in the agent app" or .msg == $prefix + "listing the agent app'"'"'s Machines failed")
        | {key: key, attempt, time, machines, err: (.err.message // null)}] | sort_by(.time),
      accepted: [$mine[] | select(.msg == $prefix + "create accepted after retries") | {key: key, machine, attempts, waitedMs}],
      givenUp: [$mine[] | select(.msg == $prefix + "create given up") | {key: key, attempts, waitedMs, reason}],
      unknown: [$records[] | select((.msg // "") as $msg | known | index($msg) | not) | {msg, run, time, err: (.err.message // null)}],
      refused: [$mine[] | key] | unique
    }' "$logs")

lists=$(jq '.lists | length' <<< "$report")
if (( lists == 0 )) && [[ $(jq '.unknown | length' <<< "$report") == 0 ]]; then
  echo "No Fly machine-limit (HTTP 422) refusal"
  echo "- No Fly machine-limit (HTTP 422) refusal" >> "$summary"
  exit 0
fi

# The Machine lists, as Fly answered at each refusal.
machine_lines='.lists[] | "\(.key) attempt \(.attempt) at \((.time // 0) / 1000 | todate): "
  + (if .err then "listing failed (\(.err))" elif (.machines | length) == 0 then "no Machines in the agent app"
     else (.machines | map("\(.id) \(.state // "?") \(.name // "?")") | join(", ")) end)'
echo "Fly machine-limit (HTTP 422) refusals, with the agent app's Machines (id state name) Fly listed at each:"
jq -r "$machine_lines" <<< "$report"
{
  echo "#### Fly machine-limit (HTTP 422) refusals"
  echo "| Create | Attempt | Time | Machines in the agent app (id, state, name) |"
  echo "| --- | --- | --- | --- |"
  jq -r '.lists[] | "| `\(.key)` | \(.attempt) | \((.time // 0) / 1000 | todate) | "
    + (if .err then "listing failed" elif (.machines | length) == 0 then "none"
       else (.machines | map("`\(.id)` \(.state // "?") `\(.name // "?")`") | join("<br>")) end) + " |"' <<< "$report"
} >> "$summary"

failed=0
fail() { echo "::error::$1"; echo "- ❌ $1" >> "$summary"; failed=1; }
while IFS=$'\x1f' read -r key attempts waited reason; do
  fail "The Fly Machine create of $key was given up ($reason) after $attempts machine-limit refusals over $((waited / 1000))s"
done < <(jq -r '.givenUp[] | [.key, .attempts, .waitedMs, .reason] | map(tostring) | join("\u001f")' <<< "$report")
while IFS=$'\x1f' read -r run msg err; do
  fail "A run failed with Fly's machine limit: ${run:-no run}: $msg${err:+ ($err)}"
done < <(jq -r '.unknown[] | [.run // "", .msg // "", .err // ""] | map(tostring) | join("\u001f")' <<< "$report")
while IFS= read -r key; do
  fail "The Fly Machine create of $key was refused for the machine limit and logged no outcome"
done < <(jq -r '.refused as $refused | ([.accepted[], .givenUp[]] | map(.key)) as $settled | $refused - $settled | .[]' <<< "$report")
while IFS=$'\x1f' read -r key machine attempts waited; do
  retries=$((attempts - 1))
  message="The Fly Machine create of $key needed $retries machine-limit retries over $((waited / 1000))s before Fly accepted it (Machine $machine)"
  if (( retries > MAX_RETRIES || waited > MAX_WAIT_MS )); then
    fail "$message: past the bound of $MAX_RETRIES retries and $((MAX_WAIT_MS / 1000))s"
  else
    # One annotation per create, with the Machine list Fly answered at its last refusal.
    last=$(jq -r --arg key "$key" '[.lists[] | select(.key == $key)] | last | if .err then "listing failed"
      else (.machines // [] | map("\(.id) \(.state // "?") \(.name // "?")") | join(", ")) end' <<< "$report")
    echo "::warning::$message. Machines in the agent app at the last refusal: ${last:-none}"
    echo "- ⚠️ $message" >> "$summary"
  fi
done < <(jq -r '.accepted[] | [.key, .machine, .attempts, .waitedMs] | map(tostring) | join("\u001f")' <<< "$report")
exit "$failed"

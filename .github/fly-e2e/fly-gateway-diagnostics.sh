#!/usr/bin/env bash
# Explains a failed URL MCP line on a Fly Machines run, while the apps are still up.
# Called by .github/workflows/fly-e2e.yml when a URL line of the fixture file is wrong:
#
#   fly-gateway-diagnostics.sh [worker-log.jsonl ...]
#
# Prints:
#   1. the extension gateway URL the run's agent was given (the latest "Extension Library items
#      applied to this run" record's gatewayUrl; it is credential-free), and the control plane's
#      non-secret Fly identity (FLY_APP_NAME, FLY_MACHINE_ID, FLY_PROCESS_GROUP, PROPR_FLY_MCP_URL);
#   2. from inside a disposable Machine in the agent app, started from the agents' image: how the
#      gateway host resolves (getent ahosts) and `curl -o /dev/null -w '%{http_code}'` of the
#      gateway URL, unauthenticated. 000 means the API was never reached; any HTTP code means it was.
# Best-effort: a failing section is reported and the rest still runs. Always exits 0.
# Needs APP, AGENT_APP, REGION, OUT (with agent-runtime.env) and FLY_API_TOKEN.
set -uo pipefail

echo "::group::Extension gateway URL of the run"
recent=$(mktemp)
timeout 60s flyctl logs --app "$APP" --no-tail --json > "$recent" 2>/dev/null || true
gateway=$(cat "$@" "$recent" 2>/dev/null | jq -sr '[.[] | .message? | strings | fromjson? | objects
  | select(.msg == "Extension Library items applied to this run" and .runtime == "fly-machines")]
  | max_by(.time) | .gatewayUrl // empty' 2>/dev/null)
rm -f "$recent"
if [[ -n $gateway ]]; then
  echo "gatewayUrl: $gateway"
else
  echo "No 'Extension Library items applied to this run' record with a gatewayUrl."
fi
timeout 90s flyctl ssh console --app "$APP" --container app -C \
  "sh -c 'for k in FLY_APP_NAME FLY_MACHINE_ID FLY_PROCESS_GROUP FLY_PRIVATE_IP PROPR_FLY_MCP_URL DASHBOARD_API_HOST DASHBOARD_API_PORT; do printf \"%s=%s\\n\" \$k \"\$(printenv \$k)\"; done'" 2>&1 |
  grep -E '^[A-Z_]+=' || echo "The control plane's Fly environment could not be read."
echo "::endgroup::"

# Only a credential-free http(s) URL is passed into the probe's shell.
if [[ ! $gateway =~ ^https?://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:[0-9]+)?/[A-Za-z0-9._/-]*$ ]]; then
  echo "No usable gateway URL; skipping the reachability probe from an agent Machine."
  exit 0
fi
host=${BASH_REMATCH[1]}
host=${host#[}; host=${host%]}
image=$(sed -n 's/^PROPR_FLY_IMAGE=//p' "$OUT/agent-runtime.env" 2>/dev/null)
if [[ -z $image ]]; then
  echo "No agent image in $OUT/agent-runtime.env; skipping the reachability probe."
  exit 0
fi

echo "::group::Gateway reachability from a Machine in $AGENT_APP"
name="gateway-probe-${RUN_TOKEN:-$$}"
# A plain sleeper from the agents' image, in the agents' app: the same network position as an agent Machine.
if timeout 180s flyctl machine run "$image" 600 --entrypoint sleep --app "$AGENT_APP" --region "$REGION" \
  --name "$name" --restart no --vm-memory 256 > /dev/null 2>&1; then
  probe=$(flyctl machine list --app "$AGENT_APP" --json 2>/dev/null | jq -r --arg name "$name" '.[] | select(.name == $name) | .id' | head -1)
else
  probe=''
fi
if [[ -n $probe ]]; then
  echo "Probe Machine: $probe"
  timeout 120s flyctl ssh console --app "$AGENT_APP" --machine "$probe" -C \
    "sh -c 'echo \"resolve $host:\"; getent ahosts $host || echo \"  (no address)\"; printf \"curl $gateway: \"; curl -sS -o /dev/null -w \"%{http_code}\\n\" --max-time 15 $gateway; echo \"curl exit: \$?\"'" 2>&1 |
    grep -v -E '^(Connecting to|Warning: Permanently added)' || echo "The probe Machine could not be reached over flyctl ssh."
  flyctl machine destroy "$probe" --app "$AGENT_APP" --force > /dev/null 2>&1 ||
    echo "Could not destroy probe Machine $probe; the agent app's teardown removes it."
else
  echo "Could not start a probe Machine in $AGENT_APP (the org's Machine limit may be reached)."
fi
echo "::endgroup::"
exit 0

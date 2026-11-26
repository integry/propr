# Sourced by .github/workflows/fly-e2e.yml. Calls the fixture instance's REST API.
#
#   propr_api METHOD PATH [curl args...]   prints the response body on a 2xx
#
# Any other status prints the method, path, HTTP status and the JSON error,
# code and message to stderr (never the request or its headers) and returns 1,
# so `x=$(propr_api ... | jq ...)` under `set -euo pipefail` stops the step.
# Needs APP and GH_TOKEN.
propr_api() {
  local method=$1 path=$2 body status reason
  shift 2
  body=$(mktemp)
  if ! status=$(curl --silent --show-error --retry 3 --retry-connrefused -o "$body" -w '%{http_code}' \
      -X "$method" -H "Authorization: Bearer $GH_TOKEN" -H 'Content-Type: application/json' \
      "https://$APP.fly.dev/api$path" "$@"); then
    echo "::error::$method /api$path: the request did not complete (HTTP ${status:-000})" >&2
    rm -f "$body"
    return 1
  fi
  if [[ ! $status =~ ^2[0-9][0-9]$ ]]; then
    reason=$(jq -r 'if type == "object" then [
        (.error | strings | "error: \(.)"), (.code | strings | "code: \(.)"), (.message | strings | "message: \(.)")
      ] | join("; ") else empty end' "$body" 2>/dev/null || true)
    echo "::error::$method /api$path returned HTTP $status: ${reason:-no JSON error in the response body}" >&2
    rm -f "$body"
    return 1
  fi
  cat "$body"
  rm -f "$body"
}

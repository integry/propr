#!/usr/bin/env bash
# Create the protected `hosted-ui-production` GitHub environment that the
# release workflow uses to deploy app.propr.dev, and store its Cloudflare
# credentials as environment secrets.
#
#   scripts/setup-hosted-ui-environment.sh [--repo owner/name] [--env name] [--reviewer]
#
# Requires an authenticated `gh` with admin rights on the repository.
# Secret values are read with hidden prompts (or from CLOUDFLARE_API_TOKEN /
# CLOUDFLARE_ACCOUNT_ID if already exported); they are never echoed, passed on
# a command line or written to disk. Safe to re-run: existing settings are
# updated in place and existing deployment policies are kept.
set -euo pipefail

REPO="integry/propr"
ENVIRONMENT="hosted-ui-production"
ADD_REVIEWER=false

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --env) ENVIRONMENT="$2"; shift 2 ;;
    --reviewer) ADD_REVIEWER=true; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "run 'gh auth login' first" >&2; exit 1; }

permission="$(gh api "repos/$REPO" -q '.permissions.admin' 2>/dev/null || echo false)"
[ "$permission" = "true" ] || { echo "you need admin rights on $REPO" >&2; exit 1; }

echo "▸ environment $ENVIRONMENT on $REPO"
if $ADD_REVIEWER; then
  user_id="$(gh api user -q .id)"
  body="{\"reviewers\":[{\"type\":\"User\",\"id\":$user_id}],\"deployment_branch_policy\":{\"protected_branches\":false,\"custom_branch_policies\":true}}"
else
  body='{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
fi
gh api -X PUT "repos/$REPO/environments/$ENVIRONMENT" --input - <<<"$body" >/dev/null

# Only release refs may use the token: version tags (tag pushes) and main
# (the manual workflow_dispatch release path).
existing="$(gh api "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
  -q '.branch_policies[] | "\(.type):\(.name)"')"
add_policy() {
  local type="$1" name="$2"
  if grep -qxF "$type:$name" <<<"$existing"; then
    echo "  · policy $type $name already present"
  else
    gh api -X POST "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
      -f name="$name" -f type="$type" >/dev/null
    echo "  ✓ policy $type $name added"
  fi
}
add_policy tag 'v*'
add_policy branch main

read_secret() {
  local name="$1" value="${!1:-}"
  if [ -z "$value" ]; then
    read -r -s -p "  $name: " value; echo
  fi
  [ -n "$value" ] || { echo "$name is empty" >&2; exit 1; }
  printf '%s' "$value" | gh secret set "$name" --repo "$REPO" --env "$ENVIRONMENT" >/dev/null
  echo "  ✓ secret $name set"
}

echo "▸ secrets (input hidden)"
read_secret CLOUDFLARE_API_TOKEN
read_secret CLOUDFLARE_ACCOUNT_ID

echo "▸ result"
gh api "repos/$REPO/environments/$ENVIRONMENT" \
  -q '"  rules: " + ([.protection_rules[].type] | join(", "))'
gh api "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
  -q '.branch_policies[] | "  allowed: \(.type) \(.name)"'
gh secret list --repo "$REPO" --env "$ENVIRONMENT" | sed 's/^/  secret: /'
echo "✓ $ENVIRONMENT is ready"

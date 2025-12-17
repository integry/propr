#!/bin/bash
#
# Deploy PR Preview Environment
#
# This script creates a deterministic preview environment for a PR.
# Uses the formula: UI_PORT = 10000 + PR_NUMBER, API_PORT = 20000 + PR_NUMBER
#
# Usage: ./scripts/deploy-pr.sh <pr_number>
#

set -e

PR_NUMBER=$1

if [ -z "$PR_NUMBER" ]; then
  echo "Usage: $0 <pr_number>"
  exit 1
fi

# Validate PR_NUMBER is a positive integer and within safe range
if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || [ "$PR_NUMBER" -lt 1 ] || [ "$PR_NUMBER" -gt 9999 ]; then
  echo "Error: PR number must be a positive integer between 1 and 9999"
  exit 1
fi

# 1. Deterministic Port Calculation
UI_PORT=$((10000 + PR_NUMBER))
API_PORT=$((20000 + PR_NUMBER))

echo "============================================"
echo "Deploying PR Preview Environment"
echo "============================================"
echo "  PR Number:  #$PR_NUMBER"
echo "  UI Port:    $UI_PORT"
echo "  API Port:   $API_PORT"
echo "  UI URL:     http://pr-${PR_NUMBER}.gitfix.dev"
echo "  API URL:    http://pr-${PR_NUMBER}-api.gitfix.dev"
echo "============================================"

# 2. Deploy using the main compose file with Env Overrides
# -p: Sets the project name (isolates the stack)
# --build: Ensures we build the latest code from the branch
UI_PORT=$UI_PORT \
API_PORT=$API_PORT \
API_PUBLIC_URL="http://pr-${PR_NUMBER}-api.gitfix.dev" \
VITE_API_BASE_URL="http://pr-${PR_NUMBER}-api.gitfix.dev" \
docker compose -p "gitfix-pr-${PR_NUMBER}" up -d --build

# 3. Database State Handling (optional - seed from production/staging)
# Uncomment and configure based on your specific setup
CONTAINER_ID=$(docker compose -p "gitfix-pr-${PR_NUMBER}" ps -q dashboard-api 2>/dev/null || true)

if [ -n "$CONTAINER_ID" ]; then
    echo "Preview environment deployed successfully!"
    echo "Dashboard API container: $CONTAINER_ID"

    # Optional: Seed database from a template
    # Uncomment the following lines if you want to copy a template database
    # if [ -f "./data/template.sqlite" ]; then
    #     echo "Seeding database for PR #$PR_NUMBER..."
    #     docker cp ./data/template.sqlite "$CONTAINER_ID":/usr/src/app/data/gitfix.sqlite
    # fi
fi

echo ""
echo "Preview environment is now available at:"
echo "  UI:  http://pr-${PR_NUMBER}.gitfix.dev"
echo "  API: http://pr-${PR_NUMBER}-api.gitfix.dev"

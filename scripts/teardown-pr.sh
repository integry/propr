#!/bin/bash
#
# Teardown PR Preview Environment
#
# This script removes a PR preview environment and its associated resources.
#
# Usage: ./scripts/teardown-pr.sh <pr_number>
#

set -e

PR_NUMBER=$1

if [ -z "$PR_NUMBER" ]; then
  echo "Usage: $0 <pr_number>"
  exit 1
fi

# Validate PR_NUMBER is a positive integer
if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || [ "$PR_NUMBER" -lt 1 ] || [ "$PR_NUMBER" -gt 9999 ]; then
  echo "Error: PR number must be a positive integer between 1 and 9999"
  exit 1
fi

PROJECT_NAME="gitfix-pr-${PR_NUMBER}"

echo "============================================"
echo "Tearing Down PR Preview Environment"
echo "============================================"
echo "  PR Number:  #$PR_NUMBER"
echo "  Project:    $PROJECT_NAME"
echo "============================================"

# Check if the project exists
if ! docker compose -p "$PROJECT_NAME" ps -q >/dev/null 2>&1; then
    echo "Warning: No containers found for project $PROJECT_NAME"
    echo "The environment may have already been torn down."
    exit 0
fi

# Stop containers and remove anonymous volumes
echo "Stopping containers..."
docker compose -p "$PROJECT_NAME" down -v

# Optional: Clean up any orphaned networks
echo "Cleaning up networks..."
docker network prune -f >/dev/null 2>&1 || true

echo ""
echo "Preview environment for PR #$PR_NUMBER has been torn down."

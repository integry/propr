#!/bin/sh
#
# Teardown PR Preview Environment
#
# This script removes a PR preview environment and its associated resources.
#
# Usage: ./scripts/teardown-pr.sh <pr_number>
#

set -e

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Get the repository root (parent of scripts directory)
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PR_NUMBER=$1

if [ -z "$PR_NUMBER" ]; then
  echo "Usage: $0 <pr_number>"
  exit 1
fi

# Validate PR_NUMBER is a positive integer (POSIX-compatible)
case "$PR_NUMBER" in
  ''|*[!0-9]*)
    echo "Error: PR number must be a positive integer between 1 and 9999"
    exit 1
    ;;
esac
if [ "$PR_NUMBER" -lt 1 ] || [ "$PR_NUMBER" -gt 9999 ]; then
  echo "Error: PR number must be a positive integer between 1 and 9999"
  exit 1
fi

PROJECT_NAME="propr-pr-${PR_NUMBER}"

echo "============================================"
echo "Tearing Down PR Preview Environment"
echo "============================================"
echo "  PR Number:  #$PR_NUMBER"
echo "  Project:    $PROJECT_NAME"
echo "============================================"

# Detect docker compose command (v2 plugin vs v1 standalone)
if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose"
else
    echo "Error: Neither 'docker compose' (v2) nor 'docker-compose' (v1) found"
    exit 1
fi

echo "Using compose command: $DOCKER_COMPOSE"

# Check if the project exists
# -f: Points to the compose file at repository root
if ! $DOCKER_COMPOSE -f "$REPO_ROOT/docker-compose.yml" -p "$PROJECT_NAME" ps -q >/dev/null 2>&1; then
    echo "Warning: No containers found for project $PROJECT_NAME"
    echo "The environment may have already been torn down."
    exit 0
fi

# Stop containers and remove anonymous volumes
echo "Stopping containers..."
$DOCKER_COMPOSE -f "$REPO_ROOT/docker-compose.yml" -p "$PROJECT_NAME" down -v --remove-orphans

# Optional: Clean up any orphaned networks
echo "Cleaning up networks..."
docker network prune -f >/dev/null 2>&1 || true

echo ""
echo "Preview environment for PR #$PR_NUMBER has been torn down."

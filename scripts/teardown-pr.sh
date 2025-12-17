#!/bin/bash

# teardown-pr.sh - PR Preview Environment Teardown
# Usage: ./teardown-pr.sh <pr_number>
#
# This script tears down a preview environment for a given PR.
# It stops and removes containers, networks, and volumes associated with the PR.

set -e

PR_NUMBER=$1

if [ -z "$PR_NUMBER" ]; then
    echo "Usage: $0 <pr_number>"
    exit 1
fi

# Configuration
PROJECT_NAME="gitfix-pr-${PR_NUMBER}"
PR_COMPOSE_DIR="${PR_COMPOSE_DIR:-/tmp/pr-environments}"

echo "=== Tearing Down PR Preview Environment for PR #${PR_NUMBER} ==="

# Stop and remove containers with the PR label
CONTAINERS=$(docker ps -a --filter "label=com.gitfix.pr=${PR_NUMBER}" --format "{{.ID}}" 2>/dev/null || true)

if [ -n "$CONTAINERS" ]; then
    echo "Stopping and removing containers..."
    echo "$CONTAINERS" | xargs -r docker stop 2>/dev/null || true
    echo "$CONTAINERS" | xargs -r docker rm -v 2>/dev/null || true
fi

# Try to use docker compose to clean up (handles networks, orphans, etc.)
if [ -f "${PR_COMPOSE_DIR}/${PROJECT_NAME}/docker-compose.override.yml" ]; then
    echo "Running docker compose down..."
    docker compose -p "${PROJECT_NAME}" down -v --remove-orphans 2>/dev/null || true
fi

# Clean up PR-specific compose files
if [ -d "${PR_COMPOSE_DIR}/${PROJECT_NAME}" ]; then
    echo "Cleaning up compose files..."
    rm -rf "${PR_COMPOSE_DIR}/${PROJECT_NAME}"
fi

echo "=== PR Preview Environment Teardown Complete ==="

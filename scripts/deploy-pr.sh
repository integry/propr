#!/bin/bash

# deploy-pr.sh - Idempotent PR Preview Environment Deployment
# Usage: ./deploy-pr.sh <pr_number>
#
# This script deploys or updates a preview environment for a given PR.
# If the stack already exists, it updates it. If not, it creates it.

set -e

PR_NUMBER=$1

if [ -z "$PR_NUMBER" ]; then
    echo "Usage: $0 <pr_number>"
    exit 1
fi

# Configuration
PROJECT_NAME="gitfix-pr-${PR_NUMBER}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
PR_COMPOSE_DIR="${PR_COMPOSE_DIR:-/tmp/pr-environments}"

echo "=== Deploying PR Preview Environment for PR #${PR_NUMBER} ==="

# Create PR-specific compose directory if it doesn't exist
mkdir -p "${PR_COMPOSE_DIR}/${PROJECT_NAME}"

# Check if the stack already exists
EXISTING_CONTAINERS=$(docker ps -a --filter "label=com.gitfix.pr=${PR_NUMBER}" --format "{{.Names}}" 2>/dev/null || true)

if [ -n "$EXISTING_CONTAINERS" ]; then
    echo "Updating existing preview environment..."
    docker compose -p "${PROJECT_NAME}" up -d --build --remove-orphans 2>/dev/null || {
        echo "Warning: docker compose update failed, containers may need manual intervention"
    }
else
    echo "Creating new preview environment..."

    # Create a PR-specific docker-compose override file
    cat > "${PR_COMPOSE_DIR}/${PROJECT_NAME}/docker-compose.override.yml" << EOF
version: '3.8'

services:
  dashboard-api:
    container_name: gitfix-dashboard-api-pr-${PR_NUMBER}
    labels:
      - "com.gitfix.pr=${PR_NUMBER}"
      - "com.gitfix.type=preview"
    environment:
      - PR_NUMBER=${PR_NUMBER}
      - IS_PREVIEW_ENV=true
    networks:
      - gitfix-net

networks:
  gitfix-net:
    external: true
    name: gitfix_gitfix-net
EOF

    # Start the preview environment
    docker compose -p "${PROJECT_NAME}" \
        -f "${COMPOSE_FILE}" \
        -f "${PR_COMPOSE_DIR}/${PROJECT_NAME}/docker-compose.override.yml" \
        up -d dashboard-api 2>/dev/null || {
        echo "Warning: docker compose create failed"
    }
fi

echo "=== PR Preview Environment Deployment Complete ==="
echo "Preview URL: http://gitfix-dashboard-api-pr-${PR_NUMBER}:4000"

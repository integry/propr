#!/bin/sh
#
# Deploy PR Preview Environment
#
# This script creates a deterministic preview environment for a PR.
# Uses the formula: UI_PORT = 10000 + PR_NUMBER, API_PORT = 20000 + PR_NUMBER
#
# Usage: ./scripts/deploy-pr.sh <pr_number>
#
# Environment Variables:
#   STAGING_ENV_FILE    - Path to the staging .env file (defaults to /home/node/workspace/.env)
#   STAGING_DB_PATH     - Path to the staging database file to copy (optional)
#   GITHUB_REPOSITORY   - Repository in format owner/repo (required for PR comments)
#   GITHUB_TOKEN        - GitHub token for API calls (required for PR comments)
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

# Validate PR_NUMBER is a positive integer and within safe range (POSIX-compatible)
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

# 2. Detect docker compose command (v2 plugin vs v1 standalone)
if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose"
else
    echo "Error: Neither 'docker compose' (v2) nor 'docker-compose' (v1) found"
    exit 1
fi

echo "Using compose command: $DOCKER_COMPOSE"

# 3. Determine the env file to use (staging .env provides base config)
# Default to the main .env file in the repository root
ENV_FILE="${STAGING_ENV_FILE:-$REPO_ROOT/.env}"

if [ -f "$ENV_FILE" ]; then
    echo "Using env file: $ENV_FILE"
    ENV_FILE_ARG="--env-file $ENV_FILE"
else
    echo "Warning: Env file not found at $ENV_FILE, proceeding without it"
    # Don't pass --env-file at all when no env file exists
    ENV_FILE_ARG=""
fi

# 4. Deploy using the main compose file
# -f: Points to the compose file at repository root
# -p: Sets the project name (isolates the stack)
# --env-file: Load staging .env as base configuration
# Inline env vars override the env file values for PR-specific settings
# --build: Ensures we build the latest code from the branch
UI_PORT=$UI_PORT \
API_PORT=$API_PORT \
API_PUBLIC_URL="https://pr-${PR_NUMBER}-api.gitfix.dev" \
VITE_API_BASE_URL="https://pr-${PR_NUMBER}-api.gitfix.dev" \
$DOCKER_COMPOSE -f "$REPO_ROOT/docker-compose.yml" $ENV_FILE_ARG -p "gitfix-pr-${PR_NUMBER}" up -d --build

# 5. Database State Handling - copy from staging site
CONTAINER_ID=$($DOCKER_COMPOSE -f "$REPO_ROOT/docker-compose.yml" $ENV_FILE_ARG -p "gitfix-pr-${PR_NUMBER}" ps -q dashboard-api 2>/dev/null || true)

if [ -n "$CONTAINER_ID" ]; then
    echo "Preview environment deployed successfully!"
    echo "Dashboard API container: $CONTAINER_ID"

    # Copy database from staging if STAGING_DB_PATH is set
    if [ -n "$STAGING_DB_PATH" ] && [ -f "$STAGING_DB_PATH" ]; then
        echo "Copying database from staging site..."
        docker cp "$STAGING_DB_PATH" "$CONTAINER_ID":/usr/src/app/data/gitfix.sqlite
        echo "Database seeded successfully from: $STAGING_DB_PATH"
    elif [ -n "$STAGING_DB_PATH" ]; then
        echo "Warning: STAGING_DB_PATH is set but file does not exist: $STAGING_DB_PATH"
    fi
fi

# 6. Post GitHub PR Comment with build link
UI_URL="https://pr-${PR_NUMBER}.gitfix.dev"

post_pr_comment() {
    if [ -z "$GITHUB_TOKEN" ] || [ -z "$GITHUB_REPOSITORY" ]; then
        echo "Skipping PR comment: GITHUB_TOKEN or GITHUB_REPOSITORY not set"
        return 0
    fi

    echo "Posting PR comment to GitHub..."

    # Comment marker to identify preview environment comments
    COMMENT_MARKER="<!-- preview-env-comment -->"

    # Find and delete previous preview environment comments
    echo "Checking for previous preview environment comments..."
    COMMENTS_JSON=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github.v3+json" \
        "https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments")

    # Extract comment IDs that contain our marker
    COMMENT_IDS=$(echo "$COMMENTS_JSON" | grep -B5 "$COMMENT_MARKER" | grep '"id":' | grep -oE '[0-9]+' || true)

    for COMMENT_ID in $COMMENT_IDS; do
        echo "Deleting previous preview comment: $COMMENT_ID"
        curl -s -X DELETE \
            -H "Authorization: token $GITHUB_TOKEN" \
            -H "Accept: application/vnd.github.v3+json" \
            "https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments/${COMMENT_ID}"
    done

    # Post new comment
    COMMENT_BODY="${COMMENT_MARKER}
## 🚀 Preview Environment Deployed

Your PR preview environment is now available:

**UI:** ${UI_URL}

---
*This comment is automatically updated on each deployment.*"

    # Escape the comment body for JSON
    ESCAPED_BODY=$(echo "$COMMENT_BODY" | jq -Rs .)

    curl -s -X POST \
        -H "Authorization: token $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github.v3+json" \
        "https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" \
        -d "{\"body\": $ESCAPED_BODY}" > /dev/null

    echo "PR comment posted successfully!"
}

post_pr_comment

echo ""
echo "Preview environment is now available at:"
echo "  UI:  $UI_URL"

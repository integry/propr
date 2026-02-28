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
DOCS_PORT=$((30000 + PR_NUMBER))
REDIS_EXTERNAL_PORT=$((50000 + PR_NUMBER))

echo "============================================"
echo "Deploying PR Preview Environment"
echo "============================================"
echo "  PR Number:  #$PR_NUMBER"
echo "  UI Port:    $UI_PORT"
echo "  API Port:   $API_PORT"
echo "  Docs Port:  $DOCS_PORT"
echo "  UI URL:     https://pr-${PR_NUMBER}.gitfix.dev"
echo "  API URL:    https://pr-${PR_NUMBER}-api.gitfix.dev"
echo "============================================"

# 1.5. Setup PR branch checkout
PR_CHECKOUT_BASE="/tmp/pr-worktrees"
PR_CHECKOUT_DIR="$PR_CHECKOUT_BASE/pr-${PR_NUMBER}"

# Get the PR branch name from GitHub API
if [ -n "$GITHUB_TOKEN" ] && [ -n "$GITHUB_REPOSITORY" ]; then
    echo "Fetching PR branch info..."
    PR_INFO=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github.v3+json" \
        "https://api.github.com/repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}")
    PR_BRANCH=$(echo "$PR_INFO" | jq -r '.head.ref')
    PR_SHA=$(echo "$PR_INFO" | jq -r '.head.sha')
    PR_CLONE_URL=$(echo "$PR_INFO" | jq -r '.head.repo.clone_url')

    if [ "$PR_BRANCH" = "null" ] || [ -z "$PR_BRANCH" ]; then
        echo "Warning: Could not get PR branch, using current code"
    else
        echo "PR Branch: $PR_BRANCH"
        echo "PR SHA: ${PR_SHA:0:8}"

        mkdir -p "$PR_CHECKOUT_BASE"

        # Always fresh clone - shallow clones don't update well and it's fast anyway
        echo "Cloning PR branch (shallow)..."
        rm -rf "$PR_CHECKOUT_DIR" 2>/dev/null || true
        CLONE_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
        if git clone --depth=1 --single-branch --branch "$PR_BRANCH" "$CLONE_URL" "$PR_CHECKOUT_DIR" 2>/dev/null; then
            echo "Clone successful"
        else
            echo "Warning: Clone failed, using current code"
        fi

        if [ -f "$PR_CHECKOUT_DIR/docker-compose.yml" ]; then
            echo "Using PR checkout at: $PR_CHECKOUT_DIR"
            # Copy .env file to checkout (needed for docker compose)
            if [ -f "/usr/src/app/.env" ]; then
                cp /usr/src/app/.env "$PR_CHECKOUT_DIR/.env"
            fi
            # Copy private key file (gitignored, needed for GitHub App auth)
            for pemfile in /usr/src/app/*.pem; do
                if [ -f "$pemfile" ]; then
                    cp "$pemfile" "$PR_CHECKOUT_DIR/"
                fi
            done
            REPO_ROOT="$PR_CHECKOUT_DIR"
        else
            echo "Warning: PR checkout failed or incomplete, using current code"
        fi
    fi
else
    echo "Warning: GITHUB_TOKEN not set, cannot fetch PR branch info"
fi

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
# When running inside a container, STAGING_ENV_FILE may point to a host path
# that doesn't exist inside the container. We need to check multiple locations.
#
# Priority:
# 1. STAGING_ENV_FILE if it exists (for host execution)
# 2. /usr/src/app/.env (mounted inside container via docker-compose.yml)
# 3. $REPO_ROOT/.env (fallback for local development)

ENV_FILE=""
if [ -n "$STAGING_ENV_FILE" ] && [ -f "$STAGING_ENV_FILE" ]; then
    # STAGING_ENV_FILE is set and exists (running on host or correctly mounted)
    ENV_FILE="$STAGING_ENV_FILE"
elif [ -f "/usr/src/app/.env" ]; then
    # Running inside container - use the mounted .env file
    ENV_FILE="/usr/src/app/.env"
elif [ -f "$REPO_ROOT/.env" ]; then
    # Fallback to repo root (local development)
    ENV_FILE="$REPO_ROOT/.env"
fi

if [ -n "$ENV_FILE" ]; then
    echo "Using env file: $ENV_FILE"
    ENV_FILE_ARG="--env-file $ENV_FILE"
else
    echo "Warning: No env file found, proceeding without it"
    echo "  Checked: STAGING_ENV_FILE=${STAGING_ENV_FILE:-<not set>}"
    echo "  Checked: /usr/src/app/.env"
    echo "  Checked: $REPO_ROOT/.env"
    # Don't pass --env-file at all when no env file exists
    ENV_FILE_ARG=""
fi

# 4. Deploy using the main compose file
# -f: Points to the compose file at repository root
# -p: Sets the project name (isolates the stack)
# --env-file: Load staging .env as base configuration
# Inline env vars override the env file values for PR-specific settings
# --build: Ensures we build the latest code from the branch
#
# IMPORTANT: We must unset STAGING_ENV_FILE when running docker compose because:
# - docker-compose.yml uses ${STAGING_ENV_FILE:-./.env} for volume mounts
# - If STAGING_ENV_FILE is set to a HOST path (e.g., /root/gitfix/.env), docker compose
#   will try to mount that path, which doesn't exist inside the container
# - By unsetting it, docker-compose.yml will use the default "./.env" which is relative
#   to the compose file location (the repo root)
#
# Deploy all services for preview environments
# Note: VITE_OAUTH_API_URL points to main API for OAuth to avoid registering multiple callback URLs
# SESSION_REDIS_HOST points to host's Redis to share sessions across all APIs
UI_PORT=$UI_PORT \
API_PORT=$API_PORT \
DOCS_PORT=$DOCS_PORT \
REDIS_EXTERNAL_PORT=$REDIS_EXTERNAL_PORT \
API_PUBLIC_URL="https://pr-${PR_NUMBER}-api.gitfix.dev" \
VITE_API_BASE_URL="https://pr-${PR_NUMBER}-api.gitfix.dev" \
VITE_OAUTH_API_URL="https://api.gitfix.dev" \
FRONTEND_URL="https://pr-${PR_NUMBER}.gitfix.dev" \
SESSION_REDIS_HOST="host.docker.internal" \
SESSION_REDIS_PORT="6380" \
STAGING_ENV_FILE="" \
$DOCKER_COMPOSE -f "$REPO_ROOT/docker-compose.yml" $ENV_FILE_ARG -p "propr-pr-${PR_NUMBER}" up -d --build

# 5. Database State Handling - copy from staging site
CONTAINER_ID=$(STAGING_ENV_FILE="" $DOCKER_COMPOSE -f "$REPO_ROOT/docker-compose.yml" $ENV_FILE_ARG -p "propr-pr-${PR_NUMBER}" ps -q api 2>/dev/null || true)

if [ -n "$CONTAINER_ID" ]; then
    echo "Preview environment deployed successfully!"
    echo "API container: $CONTAINER_ID"

    # Copy database from staging site
    # When running inside a container, docker cp uses the container's filesystem
    # The daemon has the staging DB mounted at /usr/src/app/data/propr.sqlite
    STAGING_DB_CONTAINER_PATH="/usr/src/app/data/propr.sqlite"
    if [ -f "$STAGING_DB_CONTAINER_PATH" ]; then
        echo "Copying database from staging site..."
        if docker cp "$STAGING_DB_CONTAINER_PATH" "$CONTAINER_ID":/usr/src/app/data/propr.sqlite; then
            echo "Database seeded successfully"
        else
            echo "Warning: Failed to copy database"
        fi
    else
        echo "Warning: Staging database not found at $STAGING_DB_CONTAINER_PATH"
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
        "https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments?per_page=100")

    # Extract comment IDs that contain our marker using jq
    COMMENT_IDS=$(echo "$COMMENTS_JSON" | jq -r '.[] | select(.body | contains("preview-env-comment")) | .id' || true)

    for COMMENT_ID in $COMMENT_IDS; do
        echo "Deleting previous preview comment: $COMMENT_ID"
        curl -s -X DELETE \
            -H "Authorization: token $GITHUB_TOKEN" \
            -H "Accept: application/vnd.github.v3+json" \
            "https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/comments/${COMMENT_ID}"
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

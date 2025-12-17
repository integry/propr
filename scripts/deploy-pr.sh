#!/bin/bash
#
# Deploy PR Preview Environment
#
# This script creates a deterministic preview environment for a PR.
# Uses the formula: UI_PORT = 10000 + PR_NUMBER, API_PORT = 20000 + PR_NUMBER
#
# Usage: ./scripts/deploy-pr.sh <pr_number>
#
# Environment Variables:
#   STAGING_DB_PATH     - Path to the staging database file to copy (optional)
#   GITHUB_REPOSITORY   - Repository in format owner/repo (required for PR comments)
#   GITHUB_TOKEN        - GitHub token for API calls (required for PR comments)
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

# 3. Database State Handling - copy from staging site
CONTAINER_ID=$(docker compose -p "gitfix-pr-${PR_NUMBER}" ps -q dashboard-api 2>/dev/null || true)

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

# 4. Post GitHub PR Comment with build link
UI_URL="https://pr-${PR_NUMBER}.gitfix.dev"
API_URL="https://pr-${PR_NUMBER}-api.gitfix.dev"

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

| Service | URL |
|---------|-----|
| **UI** | ${UI_URL} |
| **API** | ${API_URL} |

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
echo "  API: $API_URL"

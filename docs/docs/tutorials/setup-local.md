---
sidebar_position: 2
---

# Local Setup

Use this path to run ProPR on your own machine from prebuilt Docker images.

## Prerequisites

- Docker
- A GitHub App installed on the repositories you want ProPR to access
- Credentials for at least one coding agent
- Disk space for data, logs, and repository workspaces

You do not need Node.js, Redis, or a source checkout for this path.

## Create A Runtime Directory

```bash
mkdir -p propr-deploy/{data,logs,repos}
cd propr-deploy
```

Place your GitHub App private key in this directory:

```bash
chmod 600 your-app-private-key.pem
```

## Create `.env`

```bash
GH_APP_ID=your_app_id
GH_PRIVATE_KEY_PATH=/app/config/your-app-private-key.pem
GH_INSTALLATION_ID=your_installation_id

DASHBOARD_API_PORT=4000
FRONTEND_URL=http://localhost:5173
GH_OAUTH_CLIENT_ID=your_github_oauth_client_id
GH_OAUTH_CLIENT_SECRET=your_github_oauth_client_secret
GH_OAUTH_CALLBACK_URL=http://localhost:4000/api/auth/github/callback
SESSION_SECRET=generate-a-strong-secret-here

PRIMARY_PROCESSING_LABELS=AI,propr
GITHUB_BOT_USERNAME=your_bot_username

GIT_CLONES_BASE_PATH=/app/repos/clones
GIT_WORKTREES_BASE_PATH=/app/repos/worktrees
GIT_DEFAULT_BRANCH=main
DB_FILENAME=/app/data/propr.sqlite
```

## Prepare Agent Credentials

Authenticate with the provider CLI for the agents you plan to enable. For Claude Code:

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

For Antigravity, install the official CLI and complete a login on the host before starting ProPR:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy login
```

Antigravity stores CLI configuration and credentials under `~/.antigravity`. The launcher command below passes that directory with `HOST_ANTIGRAVITY_DIR` so worker containers can mount the authenticated CLI state.

Use equivalent setup for Codex if you plan to enable it.

## Migration From Gemini

ProPR no longer supports the old Gemini agent setup. Replace any `HOST_GEMINI_DIR` or `GEMINI_TIMEOUT_MS` configuration with `HOST_ANTIGRAVITY_DIR` and `ANTIGRAVITY_TIMEOUT_MS`, replace `~/.gemini` mounts with `~/.antigravity`, replace `propr/agent-gemini` with `propr/agent-antigravity`, and update labels such as `llm-gemini-*` to configured Antigravity labels such as `llm-antigravity-gemini-pro` or `llm-antigravity-opus`.

## Start ProPR

```bash
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD/.env:/app/.env:ro" \
  -v "$PWD/your-app-private-key.pem:/app/config/your-app-private-key.pem:ro" \
  -e PROPR_ENV_FILE="$PWD/.env" \
  -e PROPR_DATA_DIR="$PWD/data" \
  -e PROPR_LOGS_DIR="$PWD/logs" \
  -e PROPR_REPOS_DIR="$PWD/repos" \
  -e HOST_CLAUDE_DIR="$HOME/.claude" \
  -e HOST_CODEX_DIR="$HOME/.codex" \
  -e HOST_ANTIGRAVITY_DIR="$HOME/.antigravity" \
  propr/launcher:latest
```

Open `http://localhost:5173`, then finish repository and agent setup in the Web UI.

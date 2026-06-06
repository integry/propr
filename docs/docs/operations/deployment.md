# Production Deployment

Use this page when ProPR should run on a shared server. For a laptop install, start with [Local Setup](../tutorials/setup-local.md).

## Recommended Path

Use the published launcher image. It starts the ProPR service containers and agent images from published Docker images.

You need:

- Docker
- A runtime directory such as `/srv/propr`
- A GitHub App and private key
- Agent credentials, such as Antigravity CLI state in `~/.gemini`
- Public URLs for the Web UI and OAuth callback
- TLS through your reverse proxy or ingress

## Environment

Use `.env` for server-specific wiring:

```bash
GH_APP_ID=your-github-app-id
GH_PRIVATE_KEY_PATH=/app/config/your-app-private-key.pem
GH_INSTALLATION_ID=your-installation-id

FRONTEND_URL=https://propr.example.com
GH_OAUTH_CALLBACK_URL=https://propr.example.com/api/auth/github/callback
SESSION_SECRET=generate-a-strong-secret-here

DB_FILENAME=/app/data/propr.sqlite
GIT_CLONES_BASE_PATH=/app/repos/clones
GIT_WORKTREES_BASE_PATH=/app/repos/worktrees
```

Manage repositories, labels, branches, and agents in the Web UI after startup.

For Antigravity agents, install the CLI on the host and authenticate before launching the stack:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy login
```

Use `HOST_ANTIGRAVITY_DIR="$HOME/.gemini"` so the launcher can mount the authenticated CLI state into Antigravity worker runs.

## Start The Stack

From the runtime directory:

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
  -e HOST_ANTIGRAVITY_DIR="$HOME/.gemini" \
  propr/launcher:latest
```

## After Startup

1. Open the Web UI.
2. Add repositories.
3. Configure AI Agents.
4. Check labels and PR settings.
5. Run one small test task.

## Server Responsibilities

For production, make sure you also have:

- HTTPS at the reverse proxy or ingress
- Persistent storage for data, logs, and repositories
- Backups for SQLite, Redis, logs, and repository workspaces
- Restricted access to the Docker socket
- Restricted access to mounted credential directories

For updates, backups, troubleshooting, and tuning, see [Maintenance And Troubleshooting](./maintenance.md).

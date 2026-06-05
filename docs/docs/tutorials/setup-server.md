---
sidebar_position: 3
---

# Server Setup

Use this path when ProPR should run on a shared host or production server.

## What Changes From Local Setup

The Docker image flow is the same as [Local Setup](./setup-local.md). The differences are:

- Use a stable runtime directory such as `/srv/propr`.
- Set public URLs in `.env`.
- Put ProPR behind a reverse proxy or ingress.
- Configure TLS at the proxy layer.
- Restrict access to the Docker socket and credential directories.
- Back up data, logs, repositories, Redis, and SQLite state.

## Runtime Directory

```bash
sudo mkdir -p /srv/propr/{data,logs,repos}
sudo chown -R "$USER" /srv/propr
cd /srv/propr
```

Place the GitHub App private key there and restrict it:

```bash
chmod 600 your-app-private-key.pem
```

## Public URLs

Set the URLs in `.env` to your domain:

```bash
FRONTEND_URL=https://propr.example.com
GH_OAUTH_CALLBACK_URL=https://propr.example.com/api/auth/github/callback
```

The GitHub OAuth App callback URL must match.

## Start The Launcher

Use the same launcher command as local setup, but run it from `/srv/propr` or your chosen server directory.

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

## Finish In The Web UI

After the stack is reachable:

1. Add repositories.
2. Configure AI Agents.
3. Review label and PR settings.
4. Run one small test task.

For ongoing server care, see [Maintenance And Troubleshooting](../operations/maintenance.md).

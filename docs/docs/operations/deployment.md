# Production Deployment

Use this page when ProPR should run on a shared server. For a laptop install, start with [Local Setup](../tutorials/setup-local.md). For the initial server walkthrough, see [Server Setup](../tutorials/setup-server.md).

## Recommended Path

Use the published launcher image. The launcher replaces `docker-compose` for production deployments: it reads a pinned image manifest, pulls each image, creates a Docker network, and starts the ProPR service containers as siblings through the mounted Docker socket.

You need:

- Docker
- A runtime directory such as `/srv/propr`
- A GitHub App and private key
- Agent credentials for at least one agent (for example Claude Code state in `~/.claude`, Codex state in `~/.codex`, or Antigravity CLI state in `~/.gemini`)
- Public URLs for the Web UI and OAuth callback
- TLS through your reverse proxy or ingress

## Runtime Directory Layout

Create a stable directory that owns all persistent state:

```bash
sudo mkdir -p /srv/propr/{data,logs,repos}
sudo chown -R "$USER" /srv/propr
cd /srv/propr
chmod 600 your-app-private-key.pem
```

| Path | Contents |
|---|---|
| `.env` | Server configuration (secrets, URLs, paths) |
| `your-app-private-key.pem` | GitHub App private key |
| `data/` | SQLite database (`propr.sqlite` plus `-wal`/`-shm` files) |
| `logs/` | Log directory mounted into the service containers at `/usr/src/app/logs` |
| `repos/` | Git working area: `clones/` (cached repository clones) and `worktrees/` (per-task worktrees) |

Redis data lives in the Docker volume `propr-redis-data`, not in this directory.

## Published Images

The launcher starts these images, pinned to the release version in its manifest:

| Image | Role |
|---|---|
| `propr/launcher` | Orchestrator that spawns the stack |
| `propr/app` | Server image; the start command selects the role (daemon, worker, analysis worker, indexing worker, API) |
| `propr/ui` | Web UI static bundle |
| `propr/docs` | Documentation site (started only with `DOCS_ENABLED=true`) |
| `propr/agent-claude` | Claude Code execution container |
| `propr/agent-codex` | Codex execution container |
| `propr/agent-antigravity` | Antigravity execution container |
| `propr/agent-opencode` | OpenCode execution container |
| `propr/agent-vibe` | Mistral Vibe execution container |
| `redis:7-alpine` | Queue and cache state |

Images are published to Docker Hub under the `propr/` namespace and mirrored to GHCR under `ghcr.io/integry/propr-*`.

## Environment

Use `.env` for server-specific wiring:

```bash
GH_APP_ID=your-github-app-id
GH_PRIVATE_KEY_PATH=/app/config/your-app-private-key.pem
GH_INSTALLATION_ID=your-installation-id

FRONTEND_URL=https://propr.example.com
GH_OAUTH_CLIENT_ID=your_github_oauth_client_id
GH_OAUTH_CLIENT_SECRET=your_github_oauth_client_secret
GH_OAUTH_CALLBACK_URL=https://propr.example.com/api/auth/github/callback
SESSION_SECRET=generate-a-strong-secret-here

DB_FILENAME=/app/data/propr.sqlite
GIT_CLONES_BASE_PATH=/app/repos/clones
GIT_WORKTREES_BASE_PATH=/app/repos/worktrees
```

All `HOST_*_DIR` values and launcher path variables must be absolute host paths. `.env` parsing does not expand `~` or `$HOME`.

Manage repositories, labels, branches, and agents in the Web UI after startup.

For Antigravity agents, install the CLI on the host and authenticate before launching the stack:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy login
```

Use `HOST_ANTIGRAVITY_DIR="$HOME/.gemini"` so the launcher can mount the authenticated CLI state into Antigravity worker runs. For OpenCode and Vibe agents, see the `HOST_OPENCODE_*` and `HOST_VIBE_*` variables documented in `.env.example`.

## Issue Intake: Polling Or Webhooks

By default, the daemon polls configured repositories for trigger labels at `POLLING_INTERVAL_MS` (default `60000`, 60 seconds). Polling requires no inbound network access.

To react to GitHub events immediately, enable the webhook endpoint instead:

```bash
ENABLE_GITHUB_WEBHOOKS=true
GH_WEBHOOK_SECRET=your-webhook-secret
```

The API container serves the endpoint at `POST /webhook` (port 4000). Point the GitHub App's webhook URL at it through your reverse proxy, and set the same secret in the GitHub App settings. The API refuses to start when `ENABLE_GITHUB_WEBHOOKS=true` is set without `GH_WEBHOOK_SECRET`.

If your server cannot expose a public webhook endpoint, the optional hosted GitHub App at propr.dev can route webhook events to your instance instead.

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

The path variables are passed as environment values, not mounts, because the launcher spawns sibling containers through the host Docker daemon — every `-v` value it passes must resolve on the host.

The launcher starts these containers (stack prefix configurable with `PROPR_STACK`, default `propr`):

- `propr-redis`
- `propr-daemon`
- `propr-worker`
- `propr-analysis-worker`
- `propr-indexing-worker`
- `propr-api` — publishes port 4000 (override with `API_PORT`)
- `propr-ui` — publishes port 5173 (override with `UI_PORT`)
- `propr-docs` — only with `DOCS_ENABLED=true`; port 8080 (override with `DOCS_PORT`)

Redis is not published on the host unless `REDIS_EXTERNAL_PORT` is set.

## Reverse Proxy And TLS

Terminate TLS at your reverse proxy or ingress, then:

- Route the public site to the UI container (port 5173).
- Route `/api/*`, `/webhook`, and `/socket.io/` to the API container (port 4000). The Web UI uses WebSockets for live updates, so the proxy must support connection upgrades on `/socket.io/`.
- Set `FRONTEND_URL` and `GH_OAUTH_CALLBACK_URL` to the public HTTPS origins, and configure the same callback URL in the GitHub OAuth App settings.

If the UI and API are served from different origins, the API's CORS configuration uses `FRONTEND_URL` and browser requests send session cookies cross-origin — keep both URLs consistent with the actual public origins.

## After Startup

1. Open the Web UI.
2. Add repositories.
3. Configure AI Agents.
4. Check labels and PR settings.
5. Run one small test task.

## Backups

Back up:

- `.env` and the GitHub App private key (or the secret source that produces them)
- `data/` — the SQLite database is the primary application state; copy it while the stack is stopped, or use `sqlite3 propr.sqlite ".backup backup.sqlite"` for a consistent snapshot of a live database (WAL mode is enabled)
- The `propr-redis-data` Docker volume if you want queue state and sessions to survive a restore
- `logs/` if you need log history

`repos/` is a working area: clones are re-created on demand and worktrees are per-task. It does not need backups, and `repos/` plus `logs/` alone do not contain the application state.

## Security

- Restrict access to the Docker socket. Any process that can reach `/var/run/docker.sock` controls the host's Docker daemon; limit shell access on the server accordingly.
- Restrict the mounted credential directories (`~/.claude`, `~/.codex`, `~/.gemini`, and so on). They contain provider login state and are mounted into worker and agent containers.
- Keep the GitHub App private key at mode `600`.
- Use a strong `SESSION_SECRET` and HTTPS-only public URLs.

## Updating

The launcher manifest pins exact image versions, so updating means running a newer launcher:

```bash
docker pull propr/launcher:latest
```

Stop the running launcher (Ctrl-C, or stop its container — it stops and removes the stack containers on shutdown), then start it again with the same `docker run` command. The new launcher pulls the newer pinned service and agent images on startup. Persistent state in `data/`, `repos/`, and the Redis volume is unaffected.

For ongoing care — backups, troubleshooting, queue resets, and tuning — see [Maintenance And Troubleshooting](./maintenance.md).

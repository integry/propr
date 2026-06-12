---
sidebar_position: 2
---

# Local Setup

Use this path to run ProPR on your own machine from prebuilt Docker images.

## Prerequisites

- A Linux host with Docker. The launcher bind-mounts host paths and the Docker socket directly, so it does not work under Docker Desktop on macOS or Windows; use the Compose-based [Source Development Setup](./setup-source.md) there.
- A GitHub App installed on the repositories you want ProPR to access
- Credentials for at least one coding agent
- Disk space for data, logs, and repository workspaces

You do not need Node.js, Redis, or a source checkout for this path.

## GitHub App Permissions

Create or reuse a GitHub App with these repository permissions:

| Permission | Access |
| --- | --- |
| Contents | Read and write |
| Metadata | Read-only |
| Issues | Read and write |
| Pull Requests | Read and write |
| Actions | Read-only (optional; used to read CI check results) |

Install the app on every repository ProPR should process, and note the App ID and Installation ID for `.env`.

## Create A Runtime Directory

```bash
mkdir -p propr-deploy/{data,logs,repos}
cd propr-deploy
```

Place your GitHub App private key in this directory:

```bash
chmod 600 your-app-private-key.pem
```

After the first run, the directory looks like this:

```text
propr-deploy/
├── .env                        # configuration (created by you, below)
├── your-app-private-key.pem    # GitHub App private key
├── data/                       # SQLite database and persistent state
├── logs/                       # service logs
└── repos/
    ├── clones/                 # full repository clones
    └── worktrees/              # per-task Git worktrees
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

Issue intake polls GitHub every 60 seconds by default. Set `POLLING_INTERVAL_MS` in `.env` to change the interval (milliseconds). For webhook-based intake instead of polling, see [Server Setup](./setup-server.md).

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

Antigravity stores CLI configuration and credentials under `~/.gemini`. The launcher command below passes that directory with `HOST_ANTIGRAVITY_DIR` so worker containers can mount the authenticated CLI state.

Use equivalent setup for Codex (`~/.codex`) if you plan to enable it.

### OpenCode

OpenCode keeps configuration under `~/.config/opencode` and auth state from `opencode auth login` under `~/.local/share/opencode`. Pass both to the launcher:

- `HOST_OPENCODE_XDG_DIR` — usually `$HOME/.config/opencode` (`HOST_OPENCODE_DIR` is accepted as a compatibility alias)
- `HOST_OPENCODE_DATA_DIR` — usually `$HOME/.local/share/opencode`
- `HOST_OPENCODE_LEGACY_DIR` — only for OpenCode agent entries whose saved `configPath` is `~/.opencode`

### Mistral Vibe

Vibe authenticates either through a mounted `~/.vibe` directory (`HOST_VIBE_DIR`) or a `MISTRAL_API_KEY` value in `.env`. Vibe also requires a prompt cache directory that must exist on the host before you start the launcher:

```bash
mkdir -p /tmp/propr-vibe-prompts
```

Pass it with both `HOST_VIBE_PROMPT_CACHE_DIR` and `VIBE_PROMPT_CACHE_DIR` set to `/tmp/propr-vibe-prompts`.

## Start ProPR

All `PROPR_*` and `HOST_*` paths must be absolute. The launcher does not expand `~`; `$PWD` and `$HOME` work because your shell expands them before Docker sees the command.

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

To enable OpenCode, add:

```bash
  -e HOST_OPENCODE_XDG_DIR="$HOME/.config/opencode" \
  -e HOST_OPENCODE_DATA_DIR="$HOME/.local/share/opencode" \
```

To enable Mistral Vibe, add:

```bash
  -e HOST_VIBE_DIR="$HOME/.vibe" \
  -e HOST_VIBE_PROMPT_CACHE_DIR=/tmp/propr-vibe-prompts \
  -e VIBE_PROMPT_CACHE_DIR=/tmp/propr-vibe-prompts \
```

Open `http://localhost:5173`, then finish repository and agent setup in the Web UI. The API listens on port `4000`; override the ports with `UI_PORT` and `API_PORT` if they conflict.

<!-- SCREENSHOT PLACEHOLDER: Capture the Web UI dashboard at `http://localhost:5173` immediately after first launch, showing the empty repository list and the prompt to add a repository. Start the launcher with a fresh `data/` directory to reach this state. -->

## Configure From The CLI (Optional)

Everything the Web UI does for setup can also be done with the [ProPR CLI](../features/propr-cli.md). The CLI talks to the API on port `4000` and authenticates with your GitHub token (Bearer auth is enabled by default):

```bash
npm install -g @propr/cli

propr remote http://localhost:4000
propr login                      # reuses your gh CLI session, or pass a PAT
propr repo add owner/repo -b main
propr agent add my-claude -t claude -m opus48 -d opus48
propr use owner/repo
propr status                     # verify daemon, workers, Redis, GitHub auth
```

From here, `propr plan create "..." --wait` and `propr issue implement <draft-id>/1 --wait` run the same plan-to-PR flow as the Web UI.

## Update ProPR

The launcher manifest pins the service images to the launcher release version. To update, pull the latest launcher and run the same command again:

```bash
docker pull propr/launcher:latest
```

Then re-run the `docker run` command above. The launcher pulls the matching service images and restarts the stack; data, logs, and repositories persist in your runtime directory.

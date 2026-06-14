---
sidebar_position: 2
---

# Local Setup

Use this path to run ProPR on your own machine from prebuilt Docker images.

## Prerequisites

- A Linux host with Docker. The stack bind-mounts host paths and the Docker socket directly, so it does not work under Docker Desktop on macOS or Windows; use the Compose-based [Source Development Setup](./setup-source.md) there.
- GitHub access for the backend — either your own GitHub App (below) or a vendor-provided shared App via the token relay; see [GitHub Authentication](../operations/github-auth.md)
- Credentials for at least one coding agent
- Node.js 22+ for the recommended CLI path (the launcher-container alternative needs no Node.js)
- Disk space for data, logs, and repository workspaces

## GitHub App Permissions

If you register your own GitHub App ("app mode"), create or reuse one with these repository permissions:

| Permission | Access |
| --- | --- |
| Contents | Read and write |
| Metadata | Read-only |
| Issues | Read and write |
| Pull Requests | Read and write |
| Actions | Read-only (optional; used to read CI check results) |

Install the app on every repository ProPR should process, and note the App ID and Installation ID for `.env`.

## Set Up And Start With The CLI (Recommended)

The ProPR CLI doubles as the [stack control plane](../features/propr-cli.md#local-stack-control-plane) — it scaffolds the runtime directory, verifies the host, and starts the stack:

```bash
npm install -g @propr/cli      # Node.js 22+ — prefix sudo if your global npm needs it
which propr && propr --version # confirm the CLI is on PATH (catches root/user prefix mismatches)

mkdir propr-deploy && cd propr-deploy
propr init stack               # creates .env + data/ logs/ repos/, detects agent credentials
```

:::tip Global install permissions
If `npm install -g` fails with `EACCES`, your Node was installed where the global
prefix is root-owned (a system/`apt` install) — prefix the command with `sudo`.
Use the **same convention every time** you install or update the CLI: a `sudo`
install must be updated with `sudo`, and a user-prefix install (e.g. `nvm`, or a
custom `npm config set prefix`) needs no `sudo`. Mixing the two can update a
different copy of the CLI or leave root-owned files in a user-owned prefix.
:::

`propr init stack` writes `.env` from the bundled template and auto-detects agent credential directories on the host (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.config/opencode`, `~/.vibe`). Then configure GitHub access:

- **Own GitHub App:** place the private key in the directory (`chmod 600`), and set `GH_APP_ID`, `GH_INSTALLATION_ID`, and `HOST_GH_PRIVATE_KEY=<absolute path to the .pem>` in `.env`. For `propr start`, use `HOST_GH_PRIVATE_KEY` (a host path the CLI mounts) — do **not** set `GH_PRIVATE_KEY_PATH`, which is the in-container path used only by the [launcher alternative](#alternative-launcher-container-without-the-cli) below. Mixing the two is a common migration mistake.
- **Shared App via relay:** run `propr relay enroll` to mint a relay token straight into `.env` — no private key needed. Enrollment opens the GitHub OAuth flow in your browser to prove your identity (no prior `propr login` or `propr remote` is required; it talks to the vendor relay, not your local backend). See [GitHub Authentication](../operations/github-auth.md).

Review the rest of `.env` (next section), then:

```bash
propr check                    # verifies Docker, images, agents, and GitHub auth mode
propr start                    # pulls images and starts the stack with a live dashboard
propr ui                       # opens http://localhost:5173
```

`propr check --verify` additionally smoke-tests each agent image. `propr start --no-tui` is the non-interactive form for scripts. `propr status` and `propr stop` manage the running stack.

## Runtime Directory Layout

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

## Alternative: Launcher Container Without The CLI

If you prefer not to install Node.js on the host, the launcher container runs the same orchestrator. Create the runtime directory and `.env` manually (`mkdir -p propr-deploy/{data,logs,repos}`, place the key, write `.env`), then:

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

{/* SCREENSHOT PLACEHOLDER: Capture the Web UI dashboard at `http://localhost:5173` immediately after first launch, showing the empty repository list and the prompt to add a repository. Start the launcher with a fresh `data/` directory to reach this state. */}

## Configure Repositories And Agents From The CLI (Optional)

Everything the Web UI does for setup can also be done with the [ProPR CLI](../features/propr-cli.md). Backend commands talk to the API on port `4000` and authenticate with your GitHub token (Bearer auth is enabled by default):

```bash
propr remote http://localhost:4000
propr login                      # reuses your gh CLI session, or pass a PAT
propr repo add owner/repo -b main
propr agent add my-claude -t claude -m opus48 -d opus48
propr use owner/repo
propr remote-status              # verify daemon, workers, Redis, GitHub auth
```

From here, `propr plan create "..." --wait` and `propr issue implement <draft-id>/1 --wait` run the same plan-to-PR flow as the Web UI.

## Update ProPR

Service images are pinned to the release version of the control plane that starts them.

- **CLI path:** update the CLI, then restart — `propr start` pulls the matching images (`npm update -g @propr/cli && propr start --restart`).
- **Launcher path:** `docker pull propr/launcher:latest`, then re-run the `docker run` command; the launcher pulls the matching service images.

Data, logs, and repositories persist in your runtime directory either way.

---
sidebar_position: 2
---

# Local Setup

Use this path to run ProPR on your own machine from prebuilt Docker images.

The end state: ProPR runs from the prebuilt images on your Linux workstation, the Web UI is at `http://localhost:5173`, the API listens on port `4000`, and issue intake streams in over the hosted ProPR GitHub App's WebSocket routing — no inbound public URL and no GitHub App private key to manage.

## Prerequisites

- A Linux host with Docker. The stack bind-mounts host paths and the Docker socket directly, so under Docker Desktop on macOS or Windows use the Compose-based [Source Development Setup](./setup-source.md).
- GitHub access for the backend. By default ProPR uses the shared, hosted ProPR GitHub App through the token relay, and running your own GitHub App is the advanced alternative — see [GitHub Authentication](../operations/github-auth.md).
- Credentials for at least one coding agent — prepared below, or created through the agent image with `propr agent login <agent>` once the CLI is installed
- Node.js 22+ for the recommended CLI path (the launcher-container alternative needs no Node.js)
- Disk space for data, logs, and repository workspaces

## Prepare Agent Credentials

Worker containers run each coding agent from credential directories mounted off the host, so authenticate the agents you plan to enable **before starting the stack**. For Claude Code:

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

For Antigravity, install the official CLI and complete a login on the host:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy login
```

Antigravity stores CLI configuration and credentials under `~/.gemini`. Use equivalent setup for Codex (`~/.codex`) if you plan to enable it.

### OpenCode

OpenCode keeps configuration under `~/.config/opencode` and auth state from `opencode auth login` under `~/.local/share/opencode`. ProPR reads both locations through two settings — `HOST_OPENCODE_XDG_DIR` (usually `$HOME/.config/opencode`) and `HOST_OPENCODE_DATA_DIR` (usually `$HOME/.local/share/opencode`) — set in `.env` on the CLI path, or passed as `-e` flags on the [launcher path](./setup-server.md#alternative-start-the-launcher).

### Mistral Vibe

Vibe authenticates either through `~/.vibe` (`HOST_VIBE_DIR`) or a `MISTRAL_API_KEY` value in `.env`. Vibe also requires a prompt cache directory that must exist on the host before you start the stack:

```bash
mkdir -p "/tmp/propr-vibe-prompts-$(id -u)"
```

`/tmp/propr-vibe-prompts-$(id -u)` is the default host path and `/tmp/propr-vibe-prompts` the in-container path. Override with `HOST_VIBE_PROMPT_CACHE_DIR` (host) and `VIBE_PROMPT_CACHE_DIR` (container) only when needed.

## Set Up And Start With The CLI (Recommended)

The ProPR CLI is the [stack control plane](../features/propr-cli.md#local-stack-control-plane) — it scaffolds the runtime directory, verifies the host, and starts the stack. The quickest way to get everything running is the guided `propr setup` wizard:

```bash
npm install -g propr-cli      # Node.js 22+ — prefix sudo if your global npm needs it
which propr && propr --version # confirm the CLI is on PATH (catches root/user prefix mismatches)

mkdir propr-deploy && cd propr-deploy
propr setup                    # guided wizard: scaffold, verify, configure GitHub + intake, start
```

:::tip[Global install permissions]
If `npm install -g` fails with `EACCES`, your Node was installed where the global
prefix is root-owned (a system/`apt` install) — prefix the command with `sudo`.
Use the **same convention every time** you install or update the CLI: a `sudo`
install must be updated with `sudo`, and a user-prefix install (e.g. `nvm`, or a
custom `npm config set prefix`) needs no `sudo`. Mixing the two can update a
different copy of the CLI or leave root-owned files in a user-owned prefix.
:::

`propr setup` walks through every step interactively: it scaffolds `.env` + `data/ logs/ repos/`, detects the agent credentials you prepared above, pulls images, helps you choose a [GitHub auth mode](../operations/github-auth.md) and issue intake, starts the stack, configures the user whitelist, and can add a first repository and open the Web UI. When you pick **Token relay** at the auth step, it enrolls the shared App for you through [ProPR Connect](../operations/propr-connect.md) and writes the relay/routing credentials to `.env`, so no separate `propr relay enroll` is required. Setup is safe to re-run at any time: it skips already-satisfied steps and never overwrites existing configuration or data.

Over SSH or in terminals without raw-mode support, add `--no-tui` for line-by-line prompts. When stdin is a pipe or CI stream, setup cannot prompt — use the manual flow below instead.

### Manual / Advanced Flow

If you prefer to control each step yourself (for scripting, CI, or troubleshooting), run the underlying commands that `propr setup` orchestrates, in this order.

**1. Scaffold the runtime directory:**

```bash
propr init stack               # creates .env + data/ logs/ repos/, detects agent credentials
```

`propr init stack` writes `.env` from the bundled template and auto-detects agent credential directories on the host (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.config/opencode`, `~/.vibe`). The template defaults to the hosted ProPR GitHub App over WebSocket routing (`GITHUB_EVENT_INTAKE_MODE=routing_websocket`).

**2. Configure GitHub access in `.env`.** On the default path, run `propr relay enroll` from the stack directory — it opens the GitHub OAuth flow to prove your identity and writes the relay/routing credentials and `GH_INSTALLATION_ID` straight into `.env`, with no GitHub App or private key of your own. Running your own GitHub App is the advanced alternative (App permissions, `GH_APP_ID`, `GH_INSTALLATION_ID`, `HOST_GH_PRIVATE_KEY`); [GitHub Authentication](../operations/github-auth.md) covers both modes in full.

:::caution[Own-App path: use `HOST_GH_PRIVATE_KEY` with the CLI]
For `propr start`, point `HOST_GH_PRIVATE_KEY` at the `.pem` on the host (the CLI mounts it). `GH_PRIVATE_KEY_PATH` is the in-container path used only by the [launcher alternative](#alternative-launcher-container-without-the-cli); mixing the two is a common migration mistake.
:::

If you take the own-App path, register the App with these repository permissions and install it on every repository ProPR should process:

| Permission | Access |
| --- | --- |
| Contents | Read and write |
| Metadata | Read-only |
| Issues | Read and write |
| Pull Requests | Read and write |
| Actions | Read-only (optional; used to read CI check results) |

**3. Edit the rest of `.env`.** The relevant local-stack values:

```bash
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

Issue intake defaults to the hosted App's WebSocket routing: events stream to ProPR over an outbound WebSocket with near-immediate delivery, so there is no inbound public URL to expose. Polling and your own GitHub App webhook remain available as advanced intake options — see [Server Setup](./setup-server.md#github-event-intake) and [Deployment](../operations/deployment.md#issue-intake-modes).

**4. Check and start:**

```bash
propr check                    # verifies Docker, images, agents, and GitHub auth mode
propr start                    # pulls images and starts the stack with a live dashboard
```

`propr check --verify` additionally smoke-tests each agent image. `propr start --no-tui` is the non-interactive form for scripts.

## Runtime Directory Layout

After the first run, the directory looks like this:

```text
propr-deploy/
├── .env                        # configuration — written by the setup wizard / propr init stack
├── your-app-private-key.pem    # own-GitHub-App path only; absent on the default relay path
├── data/                       # SQLite database and persistent state
├── logs/                       # service logs
└── repos/
    ├── clones/                 # full repository clones
    └── worktrees/              # per-task Git worktrees
```

## Verify It Works

Confirm the stack is alive before moving on:

```bash
propr status                   # all local stack containers should be running
```

Open `http://localhost:5173`, sign in with GitHub, and confirm the dashboard loads. The API answers on port `4000`. Then finish configuration from the Web UI (add a repository, enable an agent) — or from the CLI:

```bash
propr remote http://localhost:4000
propr login                      # reuses your gh CLI session, or pass a PAT
propr repo add owner/repo -b main
propr agent add my-claude -t claude -m opus48 -d opus48
propr use owner/repo
propr remote-status              # verify daemon, workers, Redis, GitHub auth
```

From here, `propr plan create "..." --wait` and `propr issue implement <draft-id>/1 --wait` run the same plan-to-PR flow as the Web UI. `propr stop` shuts the stack down.

{/* SCREENSHOT PLACEHOLDER: Capture the Web UI dashboard at `http://localhost:5173` immediately after first launch, showing the empty repository list and the prompt to add a repository. Start the launcher with a fresh `data/` directory to reach this state. */}

## Alternative: Launcher Container Without The CLI

If you prefer to keep Node.js off the host, the `propr/launcher:latest` container runs the same orchestrator. Create the runtime directory and `.env` manually (`mkdir -p propr-deploy/{data,logs,repos}`, write `.env`, place the key if you run your own App), then run the `docker run` command documented in [Server Setup → Start The Launcher](./setup-server.md#alternative-start-the-launcher) — it is identical for a local machine. All `PROPR_*` and `HOST_*` paths must be absolute; the launcher does not expand `~`.

## Optional: Drive This Stack From The Hosted UI

By default a local stack is reached at `http://localhost:5173`. If you would rather use the hosted ProPR UI at `https://app.propr.dev` to drive your local stack, enable the optional **hosted UI tunnel** — a managed Cloudflare Tunnel sidecar (the official `cloudflare/cloudflared` image) that publishes this stack to the hosted control plane. It is off by default, so plain localhost use is unaffected.

In brief: provision a tunnel in ProPR Connect, copy the one-time CLI command it shows, and run it in your stack:

```bash
propr tunnel setup --token <connector-token> --url https://t-<id>.propr.dev --start
```

The setup command writes the required tunnel settings to your stack `.env` (hosted CORS origin, public API URL, proxy-host OAuth callback); with `--start` it recreates a running stack so the API picks up the hosted URLs immediately. The architecture — which paths the proxy routes, browser origin vs API host, and the full config block — lives in [Production Deployment → Hosted UI Tunnel](../operations/deployment.md#hosted-ui-tunnel); the commands are covered in [ProPR CLI → Hosted UI Tunnel](../features/propr-cli.md#hosted-ui-tunnel).

## Update ProPR

Service images are pinned to the release version of the control plane that starts them.

- **CLI path:** update the CLI, then restart from the stack directory so it acts on the right runtime root — `propr start` pulls the matching images (`npm update -g propr-cli && cd propr-deploy && propr start --restart`). `propr start --restart` resolves the stack relative to the current directory (or `--root <dir>`), so run it from `propr-deploy` to avoid restarting against the wrong path.
- **Launcher path:** `docker pull propr/launcher:latest`, then re-run the `docker run` command; the launcher pulls the matching service images.

Data, logs, and repositories persist in your runtime directory either way.

---
sidebar_position: 12
---

# ProPR CLI

The ProPR CLI (`propr`, npm package [`propr-cli`](https://www.npmjs.com/package/propr-cli)) is both the **control plane for a local ProPR stack** (scaffold, verify, start, stop — no hand-written `docker run`) and a **client for a running backend** (plans, issue implementation, tasks, repositories, agents, to-dos, settings, logs). Backend commands talk to the same API as the Web UI, so everything shows up in the dashboard and follows the normal review path.

This page documents the end-user CLI. For developing or operating ProPR itself from a source checkout (compose stacks, image builds), see [CLI Workflows](./cli-workflows.md).

## Installation

```bash
npm install -g propr-cli
```

The host CLI requires **Node.js 22 or newer** (the Docker launcher image is separate and unaffected). The package is published at [npmjs.com/package/propr-cli](https://www.npmjs.com/package/propr-cli); the installed command is `propr`.

## Local Stack Control Plane

Bring up a complete ProPR stack from the terminal:

```bash
propr setup              # guided one-time bootstrap: scaffold, verify, configure, start (re-runnable)
propr init stack         # scaffold .env + data/ logs/ repos/, detect agent credentials
propr check              # verify Docker, images, agents, and GitHub auth mode (--verify smoke-tests agents)
propr start              # pull images and start the stack with a live dashboard
propr status             # local stack status (--json for scripts)
propr ui                 # open the Web UI (http://localhost:5173)
propr docs               # open the bundled docs site
propr stop               # stop the stack (--keep to stop without removing containers)
propr tunnel on          # expose the stack to the hosted UI through a Cloudflare Tunnel
propr tunnel off         # stop the tunnel (token and env values are kept)
```

`propr setup` is the recommended way to bring up a local stack — see the [Local Setup](../tutorials/setup-local.md) and [Server Setup](../tutorials/setup-server.md) tutorials. The `init stack` / `check` / `start` commands below are the individual steps it orchestrates, available for scripting, CI, and troubleshooting.

### `propr setup`

A guided, interactive wizard that performs a complete one-time bootstrap of the local stack. In one pass it runs environment checks, scaffolds the stack root, pulls images, records detected agent credentials, helps you choose a [GitHub auth mode](../operations/github-auth.md) and issue intake (App/relay events, polling, or direct webhooks), starts the services, configures the GitHub user whitelist, and optionally adds a first repository and opens the Web UI.

Setup is **safe to re-run at any time**: it re-discovers your environment and skips steps that are already satisfied, so running it again only fills in what is missing. It never overwrites `.env` wholesale (edits are applied per key and never blank an existing value), reuses a running stack instead of recreating it, and never deletes data.

| Option | Description |
|--------|-------------|
| `--root <dir>` | Stack root directory where `.env`, `data/`, `logs/`, and `repos/` live (default: current directory) |
| `--no-tui` | Skip the full-screen wizard and prompt line-by-line instead (use over SSH or in shells without raw-mode support) |
| `--skip-remote-image-check` | Skip the slow registry round-trip that checks whether stack images already exist |

The full-screen wizard requires an interactive terminal. Over SSH or in shells without raw-mode support, setup falls back to line-by-line prompts automatically (or pass `--no-tui`). When stdin is not a terminal at all (piped, redirected, CI), setup cannot prompt and exits with guidance — scaffold non-interactively with `propr init stack`, edit `<root>/.env`, then run `propr start`.

- `propr init stack [--root <dir>]` creates `data/`, `logs/`, `repos/`, writes `.env` from the bundled template, and auto-detects agent credential directories on the host (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.config/opencode`, `~/.vibe`).
- `propr check` reports the detected [GitHub auth mode](../operations/github-auth.md) (own App, relay, or demo) and flags missing or placeholder configuration before anything starts. `--verify` additionally runs an image/CLI smoke test per agent.
- `propr start --no-tui` starts without the interactive dashboard (for scripts/CI); `--no-pull` skips image pulls; `--restart` recreates running services.
- `propr tank [on|off] [--url <url>]` toggles [Agent Tank](../operations/agent-tank.md) LLM usage tracking on a running stack (omit the state to print the current setting).

:::warning[Breaking changes in the control-plane CLI]
Running bare `propr` performs the same environment checks as `propr check` (including a Docker probe) and exits nonzero when prerequisites are missing — use `propr --help` for help text. `propr status` now reports the **local Docker stack**; use `propr remote-status` for the backend health/queue JSON that older scripts read from `propr status --json`.
:::

## GitHub Relay (shared-app auth)

If you use a vendor-provided shared GitHub App instead of registering your own, the stack fetches short-lived installation tokens from a relay. See [ProPR Connect](../operations/propr-connect.md) for the hosted bridge behind the shared App, routing WebSocket, relay tokens, and managed UI tunnels; see [GitHub Authentication](../operations/github-auth.md) for the token configuration details.

**The easiest path is `propr setup`:** choose **Token relay** at the GitHub-authentication step and it enrolls for you — it reuses your `propr login` token, discovers your installation (auto-selecting when there is exactly one, prompting when there are several), mints the relay token, and writes `GH_AUTH_MODE`, `PROPR_GH_RELAY_URL`, `PROPR_GH_RELAY_TOKEN`, and `GH_INSTALLATION_ID` to the stack `.env`. If you are not logged in yet, the line-by-line wizard offers to run `propr login` first. No separate enroll step is needed.

To manage relay tokens directly — or to enroll outside the wizard — use `propr relay`. Run these from the initialized stack directory (the one holding `.env`), so the token is written to the right `.env`:

```bash
propr relay enroll       # mint a relay token and save it to the stack .env
propr relay list         # list relay tokens for the installation
propr relay revoke <id>  # revoke a token
```

`propr relay enroll` discovers the installation automatically from your `propr login` identity when you have exactly one; pass `--installation <id>` to choose among several, or `--url <url>` to target a self-hosted relay.

## Hosted UI Tunnel

The hosted ProPR UI at `https://app.propr.dev` is a single static bundle that can drive a locally-running stack. To make that work, the local stack publishes its **API** (the API container on port 4000) to the hosted control plane through a **Cloudflare Tunnel** — propr-routing forwards only `/api/*` and `/socket.io/*` on the proxy host (the root URL returns 404, and `/webhook` is **not** routed through the tunnel) — an optional managed sidecar (the official `cloudflare/cloudflared` image) that runs alongside the stack like the `propr ui` and `propr docs` services. The UI bundle itself is served by `app.propr.dev`, not through the tunnel; the tunnel only exposes the API the hosted UI calls. It is **off by default**; local development on `http://localhost:5173` is unaffected when the tunnel is off.

```bash
propr tunnel setup --token <connector-token> --url https://<id>.proxy.propr.dev --start
propr tunnel on          # start the cloudflared sidecar
propr tunnel off         # stop it — the token and env values are left untouched
propr tunnel verify      # check the sidecar + public /api/status, /, /socket.io/
```

Cloudflare forwards the tunnel to the **Docker-internal** API service at `http://api:4000` (the address inside the stack's Docker network), **not** to host port 4000. The published host port is therefore irrelevant to tunnel routing, and the two cannot conflict — you do not need to free up host port 4000 for the tunnel to work.

Starting the tunnel always requires a configured token. The hosted ProPR Connect UI shows a one-time connector token and tunnel URL; paste those into `propr tunnel setup` and the CLI writes the required stack `.env` values for you:

```bash
propr tunnel setup --token <connector-token> --url https://<id>.proxy.propr.dev --start
```

If you are on an older CLI or need to inspect the underlying settings, these are the variables `setup` writes:

| Variable | Description |
|---|---|
| `PROPR_UI_TUNNEL_TOKEN` | Cloudflare Tunnel token. **Required to start** the tunnel. Once set, the tunnel is enabled by default, so the next `propr start` brings up the sidecar (unless you have run `propr tunnel off`) |
| `PROPR_UI_TUNNEL_ENABLED` | Explicitly enable the tunnel (`true`/`1`). A **token is still required** — `propr check` fails if this is set without `PROPR_UI_TUNNEL_TOKEN`. Redundant when a token is set, since a token alone already enables the tunnel |
| `PROPR_INSTANCE_ID` | This stack's instance id; must be a valid DNS label (letters, digits, hyphens; 1–63 chars). Derives the public URL `https://<id>.proxy.propr.dev` when no explicit URL is set |
| `PROPR_UI_PUBLIC_API_URL` | Explicit public API URL the hosted UI talks to, overriding the derived one |
| `PROPR_CLOUDFLARED_IMAGE` | cloudflared image. Overrides the version pinned in the stack manifest (currently `cloudflare/cloudflared:2024.12.2`) |

**Enablement, step by step.** With no token and no flag the tunnel is off. `propr tunnel setup` saves `PROPR_UI_TUNNEL_TOKEN`, `PROPR_INSTANCE_ID`, and `PROPR_UI_PUBLIC_API_URL`, and records the tunnel as enabled for later starts. Add `--start` to start a stopped stack or recreate an already-running stack with the hosted tunnel environment applied immediately. Setting `PROPR_UI_TUNNEL_TOKEN` manually has the same default effect, so the next `propr start` (or a restart) starts the sidecar unless you have run `propr tunnel off`. Running `propr tunnel on|off` records an explicit choice in the CLI config that **overrides** the token-derived default and is honored by later `propr start`/restarts; `propr tunnel on` also starts the sidecar immediately on an already-running stack without waiting for a restart, and `propr tunnel off` stops it even while a token remains set.

`propr tunnel on` fails clearly if no token is configured rather than launching a broken container. It likewise refuses to start when the core stack is not running — cloudflared would otherwise point at an unavailable `api:4000` and look superficially healthy — so bring the stack up with `propr start` first, or pass `--force` if you intend to start the sidecar ahead of the stack. `propr tunnel off` only removes the tunnel container — it never touches the token or any other env value, so a later `propr tunnel on` works without rework.

**Verify the tunnel.** `propr tunnel verify` runs a few quick checks against the public proxy URL: the cloudflared sidecar container is running; `GET <url>/api/status` returns an OK or auth-expected response; `GET <url>/` returns **404** (the root is intentionally not routed); and `GET <url>/socket.io/` is reachable (not blocked at Cloudflare ingress). It exits non-zero if any check fails. Note that `propr status` reports tunnel reachability by probing `<url>/api/status` for the same reason — the root `/` and the old `/health` path are not routed through the tunnel.

:::caution The tunnel token is a live credential
`PROPR_UI_TUNNEL_TOKEN` is a live Cloudflare Tunnel credential: anyone holding it can route traffic through your tunnel. Keep it in your stack `.env` only — **do not commit it to source control, paste it into logs or issues, or share it.** `propr tunnel on` prints this reminder when it starts the sidecar.
:::

:::caution Restart the stack after enabling on a running stack
`propr tunnel on` starts only the cloudflared sidecar; it does **not** restart the already-running API/worker containers. Those keep the `API_PUBLIC_URL` / `FRONTEND_URL` they were started with, so OAuth redirects, cookie security, and attachment links still point at their pre-tunnel (localhost) values until you run `propr start --restart`. Enabling the tunnel via the token before `propr start` avoids this, since the API then comes up with the proxy URLs. The command prints this warning when it detects a running stack.

`propr tunnel setup --start` avoids this by recreating the running stack after writing the tunnel settings.
:::

Each enabled stack is reachable at a per-instance hostname `https://<PROPR_INSTANCE_ID>.proxy.propr.dev`, which is how the hosted UI discovers and addresses it. See [ProPR Connect](../operations/propr-connect.md) for the role of each hosted hostname, and [Production Deployment → Hosted UI Tunnel](../operations/deployment.md#hosted-ui-tunnel) for the full config block and the architecture, including how `.proxy.propr.dev` differs from the central ProPR APIs.

:::note[Manual for v1]
In v1 the tunnel is wired up by hand: you provision the Cloudflare Tunnel token and instance id and set them in `.env` yourself. Automated provisioning and selecting among multiple instances from the hosted UI are planned for later work.
:::

## Connect and Authenticate

```bash
# 1. Point the CLI at your ProPR backend
propr remote https://api.propr.example.com

# 2. Authenticate with GitHub
propr login                 # interactive, via the gh CLI
propr login ghp_xxxxxxxx    # or pass a Personal Access Token directly

# 3. Set a default project so commands stay short
propr use owner/repo
```

Configuration is stored in `~/.propr/config.json`.

- Interactive `propr login` reuses an existing `gh` session, or launches `gh auth login` if none exists.
- For a Personal Access Token, create a classic token at `https://github.com/settings/tokens` with the `repo` and `read:org` scopes.
- `propr logout` clears the stored token.

## Global Options

| Option | Description |
|--------|-------------|
| `-p, --project <owner/repo>` | Target project for this invocation (overrides `propr use`) |
| `-j, --json` | Machine-readable output (supported by most commands) |
| `-V, --version` | Print the CLI version |
| `-h, --help` | Help for any command or subcommand |

## Repository Setup Files

Run `propr init` from a repository root to scaffold `.propr/` setup files used inside agent execution containers. The generated `.propr/setup.sh` runs before each implementation execution — edit it to install task-specific tools (for example `sudo apk add --no-cache jq`).

## Plans

```bash
propr plan list                                  # List plans for the default project
propr plan create "Add dark mode" --wait         # Create a plan and wait for generation
propr plan create "Fix bug" -b develop           # Target a specific branch
propr plan get <draft-id>                        # Plan details (--json for JSON)
propr plan generate <draft-id> --wait            # (Re)trigger generation for a draft
propr plan finalize <draft-id>                   # Create GitHub issues from plan items
propr plan issues <draft-id>                     # List the plan's issues
propr plan abort <draft-id>                      # Abort an ongoing generation
propr plan delete <draft-id> --force             # Delete without confirmation
```

| Option | Applies to | Description |
|--------|-----------|-------------|
| `-b, --branch` | `create` | Target branch (default: the repo's configured default) |
| `-w, --wait` | `create`, `generate` | Block until plan generation completes |
| `-f, --force` | `delete` | Skip the confirmation prompt |

## Issue Implementation

```bash
propr issue implement <draft-id>/<issue-number>            # Start implementation
propr issue implement <draft-id>/1 --wait                  # Wait for completion
propr issue implement <draft-id>/1 -a claude -m <model>    # Pick agent and model
propr issue implement <draft-id>/1 --epic --auto-merge     # Epic PR + auto-merge on green CI
```

The issue ID format is `<draft-id>/<issue-number>` (or `<draft-id>:<issue-number>`).

| Option | Description |
|--------|-------------|
| `-a, --agent` | Agent alias to run the implementation |
| `-m, --model` | Model ID for the implementation |
| `-w, --wait` | Block until the task completes |
| `--epic` | Create an Epic PR that collects the related PRs |
| `--auto-merge` | Enable auto-merge once CI checks pass |

## Tasks

```bash
propr task list                            # All tasks
propr task list -s processing              # Filter by status
propr task list --search "auth" -l 100     # Search with a result limit
propr task get <task-id>                   # Details with run history
propr task stop <task-id>                  # Stop a running task
propr task delete <task-id> --force        # Force-delete an active task
propr task revert owner/repo <pr> <sha> <issue>   # Revert a commit from a PR
```

Status values for `-s`: `pending`, `queued`, `processing`, `completed`, `failed`, `cancelled`, `all`. These are queue-level filters; task details additionally display the finer-grained worker states `claude_execution` ("Executing", agent run for any agent type) and `post_processing` (see [Worker Runtime](../architecture/worker-runtime.md)).

## Repositories

```bash
propr repo list                              # Monitored repositories
propr repo add owner/repo -a "Alias" -b dev  # Add with alias and base branch
propr repo remove owner/repo
propr repo toggle owner/repo --enable        # Enable/disable monitoring
propr repo index owner/repo                  # Full reindex
propr repo index owner/repo --incremental    # Incremental reindex
propr repo status                            # Indexing status for all repos
```

## Agents

```bash
propr agent list
propr agent add my-claude -t claude -m model1,model2 -d model1
propr agent add test -t antigravity -m antigravity-gemini-3-pro-preview --disabled
propr agent add opencode -t opencode -m opencode-minimax-m3-free \
  -d opencode-minimax-m3-free --config-path ~/.config/opencode
propr agent add --file agent-config.json     # From a JSON file (or `-` for stdin)
propr agent enable my-agent                  # Enable / disable without deleting
propr agent disable my-agent
propr agent delete my-agent --force
```

Agent types: `claude`, `codex`, `antigravity`, `opencode`, `vibe`.

See [Agents and Models](./agents-and-models.md) for the model catalog, label formats, and per-agent credential setup, including the OpenCode host-authentication steps and the `XDG_DATA_HOME` requirement for file-based OpenCode auth.

## To-Dos

```bash
propr todo list                          # Open todos (-a all, -d completed)
propr todo add "Fix login page" -c <category-id>
propr todo get <todo-id>
propr todo complete <todo-id>            # --undo to reopen
propr todo move <todo-id> 1 -c <cat-id>  # Reorder / move between categories
propr todo delete <todo-id>

propr todo category list
propr todo category add "Bug fixes"
propr todo category rename <id> "New name"
propr todo category move <id> 1
propr todo category delete <id>          # Its todos become uncategorized
```

## Settings, Logs, and System

```bash
propr setting get                                  # All settings
propr setting get -k worker_concurrency
propr setting update worker_concurrency 4
propr setting update github_user_whitelist "a,b,c"

propr log list                       # Recent LLM logs
propr log list -m <model> --failed   # Filter by model, failures only
propr log list --agent my-claude --draft <draft-id> --page 2 -l 100

propr remote-status     # Backend health check (daemon, workers, Redis, GitHub auth)
propr queue             # Queue statistics
```

Settings keys:

| Key | Description |
|-----|-------------|
| `default_agent_alias` | Alias of the default implementation agent |
| `worker_concurrency` | Number of concurrent workers for processing tasks |
| `github_user_whitelist` | GitHub usernames allowed to use the system |
| `analysis_model_fast` | Model for fast analysis operations |
| `planner_context_model` | Model for planner context generation |
| `planner_generation_model` | Model for planner generation |
| `auto_followup_score_threshold` | Score threshold (0–9) for auto-followup |
| `auto_resolve_merge_conflicts` | Automatically resolve merge conflicts |
| `pr_review_model` | Model for full PR reviews |
| `pr_review_prompt` | Override for the PR review prompt guidance (empty = built-in default) |
| `ultrafix_rating_goal` | Target quality rating for ultrafix cycles |
| `ultrafix_max_cycles` | Maximum number of ultrafix cycles |
| `ultrafix_pause_seconds` | Pause duration between ultrafix cycles |

## Scripting

Most commands accept `--json` for programmatic use:

```bash
propr repo list --json | jq '.repos_to_monitor[].name'
```

A terminal-only path from prompt to pull request:

```bash
propr plan create "Split auth cleanup into reviewable PRs" --wait
propr plan issues <draft-id>
propr issue implement <draft-id>/1 --wait
propr task get <task-id>
```

The CLI package also exports its modules for programmatic use from Node.js — see `packages/cli/README.md` in the source repository.

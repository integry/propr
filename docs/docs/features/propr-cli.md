---
sidebar_position: 12
---

# ProPR CLI

The ProPR CLI (`propr`, npm package `@propr/cli`) is both the **control plane for a local ProPR stack** (scaffold, verify, start, stop — no hand-written `docker run`) and a **client for a running backend** (plans, issue implementation, tasks, repositories, agents, to-dos, settings, logs). Backend commands talk to the same API as the Web UI, so everything shows up in the dashboard and follows the normal review path.

This page documents the end-user CLI. For developing or operating ProPR itself from a source checkout (compose stacks, image builds), see [CLI Workflows](./cli-workflows.md).

## Installation

```bash
npm install -g @propr/cli
```

The host CLI requires **Node.js 22 or newer** (the Docker launcher image is separate and unaffected).

## Local Stack Control Plane

Bring up a complete ProPR stack from the terminal:

```bash
propr init stack         # scaffold .env + data/ logs/ repos/, detect agent credentials
propr check              # verify Docker, images, and agent readiness (--verify smoke-tests agents)
propr start              # pull images and start the stack with a live dashboard
propr status             # local stack status (--json for scripts)
propr ui                 # open the Web UI (http://localhost:5173)
propr docs               # open the bundled docs site
propr stop               # stop the stack (--keep to stop without removing containers)
```

- `propr init stack [--root <dir>]` creates `data/`, `logs/`, `repos/`, writes `.env` from the bundled template, and auto-detects agent credential directories on the host (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.config/opencode`, `~/.vibe`).
- `propr check` reports the detected [GitHub auth mode](../operations/github-auth.md) (own App, relay, or demo) and flags missing or placeholder configuration before anything starts. `--verify` additionally runs an image/CLI smoke test per agent.
- `propr start --no-tui` starts without the interactive dashboard (for scripts/CI); `--no-pull` skips image pulls; `--restart` recreates running services.
- `propr tank` toggles Agent Tank LLM usage tracking on a running stack.

:::warning Breaking changes in the control-plane CLI
Running bare `propr` performs the same environment checks as `propr check` (including a Docker probe) and exits nonzero when prerequisites are missing — use `propr --help` for help text. `propr status` now reports the **local Docker stack**; use `propr remote-status` for the backend health/queue JSON that older scripts read from `propr status --json`.
:::

## GitHub Relay (shared-app auth)

If you use a vendor-provided shared GitHub App instead of registering your own, the stack fetches short-lived installation tokens from a relay (see [GitHub Authentication](../operations/github-auth.md)):

Run these from the initialized stack directory (the one holding `.env`), so
`propr relay enroll` writes the token to the right `.env`:

```bash
propr relay enroll       # mint a relay token and save it to the stack .env
propr relay list         # list relay tokens for the installation
propr relay revoke <id>  # revoke a token
```

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

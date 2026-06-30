# ProPR CLI

Command-line interface for interacting with the ProPR backend. ProPR enables AI-powered automated implementation of GitHub issues and pull requests.

## Installation

```bash
npm install -g propr-cli
```

The host CLI requires Node.js 22 or newer. The Docker launcher image is separate
and remains dependency-free on Node 20 because it does not load the Ink-based
interactive CLI.

## Quick Start

```bash
# 1. Configure the backend URL
propr remote https://api.propr.example.com

# 2. Authenticate with GitHub (interactive via gh CLI)
propr login

# Or use a Personal Access Token directly
propr login ghp_xxxxxxxxxxxx

# 3. Set a default project
propr use owner/repo

# 4. Scaffold repo-local ProPR setup files
propr init

# 5. List available plans
propr plan list

# 6. Implement an issue
propr issue implement <draft-id>/<issue-number> --wait
```

## Configuration

ProPR CLI stores configuration in `~/.propr/config.json`.

```bash
propr remote <url>       # Set backend API URL
propr use <owner/repo>   # Set default project
propr login [token]      # Authenticate (interactive or PAT)
propr logout             # Clear stored token
```

## Compatibility Notes

In the control-plane CLI, `propr status` reports the local Docker stack. Use
`propr remote-status` for the backend health/queue status JSON that older
scripts may have read from `propr status --json`.

**Breaking:** running bare `propr` now performs the same environment checks as
`propr check` — including a Docker daemon probe that can take a few seconds —
and exits nonzero when required local stack prerequisites are missing. Scripts
or shell integrations that invoked bare `propr` to print help text should call
`propr --help` instead.

## Hosted UI Tunnel

ProPR Connect can provision a managed Cloudflare Tunnel so the hosted UI at
`https://app.propr.dev` can reach your local stack's API. Run the one-time setup
command shown in ProPR Connect from your initialized stack directory:

```bash
propr tunnel setup --token <connector-token> --url https://t-<id>.propr.dev --start
```

The command writes the tunnel token and public API/OAuth URLs to the stack
`.env`, records tunnel mode as enabled, and with `--start` starts or recreates
the stack so the API picks up the hosted URLs immediately. The public tunnel
origin is always a bare `https://t-<id>.propr.dev` URL; ProPR routes only
`/api/*` and `/socket.io/*` through it, and the root URL intentionally returns
404.

Useful follow-up commands:

```bash
propr tunnel verify      # check cloudflared + /api/status, /, /socket.io/
propr tunnel off         # stop only the sidecar; token/env values stay in .env
propr tunnel on          # restart the sidecar later
```

## Repository Setup

Use `propr init` from a repository root to scaffold `.propr` setup files used by agent execution containers.

```bash
propr init
cd .propr && npm install <package>
```

The generated `.propr/setup.sh` runs before each implementation execution. Edit it to install system tools with commands such as `sudo apk add --no-cache jq`.

### Authentication

When no token is provided, `propr login` uses the GitHub CLI (`gh`) for interactive authentication:
- If you're already logged in to `gh`, your token is used automatically
- If not, `gh auth login` is launched interactively

To use a Personal Access Token instead:
1. Go to https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Select scopes: `repo`, `read:org`
4. Run: `propr login <your-token>`

## Commands Reference

### Global Options

| Option | Description |
|--------|-------------|
| `-p, --project <project>` | Specify the target project (owner/repo) |
| `-V, --version` | Output the version number |
| `-h, --help` | Display help information |

Most commands support `--json` (`-j`) for machine-readable output.

---

### Plans

Manage implementation plans for AI-powered issue resolution.

```bash
propr plan list                                  # List plans for default project
propr plan list -p owner/repo                    # List plans for specific project
propr plan create "Add dark mode" --wait         # Create plan and wait for generation
propr plan create "Fix bug" -b develop           # Target a specific branch
propr plan get <draft-id>                        # View plan details
propr plan get <draft-id> --json                 # View as JSON
propr plan generate <draft-id> --wait            # Trigger generation for existing draft
propr plan finalize <draft-id>                   # Create GitHub issues from plan items
propr plan issues <draft-id>                     # List plan issues
propr plan issues <draft-id> --json              # List issues as JSON
propr plan delete <draft-id>                     # Delete a plan (with confirmation)
propr plan delete <draft-id> --force             # Delete without confirmation
propr plan abort <draft-id>                      # Abort ongoing generation
```

| Option | Command | Description |
|--------|---------|-------------|
| `-p, --project` | `list`, `create` | Target project (owner/repo) |
| `-b, --branch` | `create` | Target branch (default: main) |
| `-w, --wait` | `create`, `generate` | Wait for plan generation to complete |
| `-j, --json` | `get`, `finalize`, `issues` | Output as JSON |
| `-f, --force` | `delete` | Skip confirmation prompt |

---

### Issue Implementation

Implement GitHub issues from plans using AI agents.

```bash
propr issue implement <draft-id>/<issue-number>              # Trigger implementation
propr issue implement <draft-id>/1 --wait                    # Wait for completion
propr issue implement <draft-id>/1 -a claude -m model-name   # Use specific agent/model
propr issue implement <draft-id>/1 -a opencode -m opencode-minimax-m3-free
propr issue implement <draft-id>/1 --epic --auto-merge       # Epic PR + auto-merge
```

| Option | Description |
|--------|-------------|
| `-p, --project` | Target project (owner/repo) |
| `-w, --wait` | Wait for the implementation to complete |
| `-a, --agent` | Agent alias to use for implementation |
| `-m, --model` | Model name to use for implementation |
| `--epic` | Create an Epic PR to collect all related PRs |
| `--auto-merge` | Enable auto-merge when CI checks pass |

The issue ID format is `<draft-id>/<issue-number>` or `<draft-id>:<issue-number>`.

---

### Tasks

View and manage implementation tasks.

```bash
propr task list                          # List all tasks
propr task list -s processing            # Filter by status
propr task list -p owner/repo            # Filter by project
propr task list --search "auth" -l 100   # Search with limit
propr task get <task-id>                 # View task details with history
propr task stop <task-id>                # Stop a running task
propr task delete <task-id>              # Delete a task (with confirmation)
propr task delete <task-id> --force      # Force delete active task
propr task revert owner/repo 123 abc 456 # Revert a commit from a PR
```

| Option | Command | Description |
|--------|---------|-------------|
| `-p, --project` | `list` | Filter by project (owner/repo) |
| `-s, --status` | `list` | Filter by status (see below) |
| `-l, --limit` | `list` | Max results (default: 50) |
| `--search` | `list` | Search by term |
| `-f, --force` | `delete` | Force deletion of active tasks |
| `-o, --owner` | `revert` | Repo owner if not in owner/repo format |

**Status values:** `pending`, `queued`, `processing`, `completed`, `failed`, `cancelled`, `all`

---

### Repositories

Manage monitored repositories and their indexing.

```bash
propr repo list                              # List monitored repositories
propr repo add owner/repo                    # Add a repository
propr repo add owner/repo -a "Alias" -b dev  # With alias and branch
propr repo remove owner/repo                 # Remove a repository
propr repo toggle owner/repo --enable        # Enable monitoring
propr repo toggle owner/repo --disable       # Disable monitoring
propr repo index owner/repo                  # Trigger full indexing
propr repo index owner/repo --incremental    # Incremental indexing
propr repo index owner/repo -b feature       # Index specific branch
propr repo status                            # View all indexing status
propr repo status owner/repo                 # View specific repo status
```

---

### Agents

Manage AI agent configurations for code implementation.

```bash
propr agent list                                         # List configured agents
propr agent add my-claude -t claude -m model1,model2     # Add an agent
propr agent add my-agent -t claude -m model -d model     # With default model
propr agent add test -t antigravity -m antigravity-gemini-3-pro-preview --disabled   # Add in disabled state
propr agent add opencode -t opencode -m opencode-minimax-m3-free -d opencode-minimax-m3-free --config-path /home/your-user/.config/opencode
propr agent add --file agent-config.json                 # From JSON file
cat config.json | propr agent add --file -               # From stdin
propr agent delete my-agent                              # Delete (with confirmation)
propr agent delete my-agent --force                      # Delete without confirmation
```

**Agent types:** `claude`, `codex`, `antigravity`, `opencode`

For OpenCode agents, install and authenticate OpenCode on the host before adding the agent:

```bash
curl -fsSL https://opencode.ai/install | bash
mkdir -p ~/.config/opencode
opencode auth login
mkdir -p ~/.config/opencode/xdg-data/opencode && cp ~/.local/share/opencode/auth.json ~/.config/opencode/xdg-data/opencode/auth.json
```

OpenCode stores `auth.json` under `~/.local/share/opencode`, but ProPR mounts the configured OpenCode config directory into the agent container. When using copied file-based auth, set `XDG_DATA_HOME=/home/node/.config/opencode/xdg-data` on the OpenCode agent. Use `~/.config/opencode` as the agent `configPath`.

The example model `opencode-minimax-m3-free` is a built-in free OpenCode model. OpenCode's model list changes with auth providers; run `opencode models` after logging in and register any desired provider/model IDs with ProPR's `opencode-` prefix, such as `opencode-openai/gpt-5.5`. ProPR converts these IDs back to OpenCode's native `provider/model` syntax at execution time and does not add authenticated provider models by default.
Dynamic OpenCode GitHub labels use the format `llm-<agent-alias>~<propr-opencode-model-id>`, for example `llm-opencode~opencode-openai/gpt-5.5`. The `~` separator is an intentional public contract — these labels are persisted on GitHub issues and resolved later for execution routing.

**JSON file format** for `--file`:

```json
{
  "alias": "opencode",
  "type": "opencode",
  "models": ["opencode-minimax-m3-free"],
  "defaultModel": "opencode-minimax-m3-free",
  "dockerImage": "propr/agent-opencode:latest",
  "configPath": "/home/your-user/.config/opencode",
  "enabled": true,
  "envVars": {
    "XDG_DATA_HOME": "/home/node/.config/opencode/xdg-data"
  }
}
```

---

### To-Dos

Manage repository-level to-dos for tracking work items.

```bash
# List and filter
propr todo list                          # List open todos
propr todo list -a                       # All todos (open + completed)
propr todo list -d                       # Completed todos only
propr todo list -p owner/repo            # Specify project

# CRUD
propr todo get <todo-id>                 # View todo details
propr todo add "Fix login page"          # Create a todo
propr todo add "Task" -c <category-id>   # Create in a category
propr todo complete <todo-id>            # Mark as completed
propr todo complete <todo-id> --undo     # Reopen
propr todo delete <todo-id>              # Delete (with confirmation)

# Reorder and move
propr todo move <todo-id> 1              # Move to top of category
propr todo move <todo-id> 3              # Move to position 3
propr todo move <todo-id> 1 -c <cat-id>  # Move to different category
propr todo move <todo-id> 1 -c none      # Move to uncategorized
```

#### Categories

```bash
propr todo category list                          # List categories
propr todo category add "Bug fixes"               # Create a category
propr todo category rename <id> "New name"        # Rename a category
propr todo category delete <id>                   # Delete (todos go uncategorized)
propr todo category move <id> 1                   # Move to position
```

---

### Settings

```bash
propr setting get                                    # View all settings
propr setting get -k worker_concurrency              # View specific setting
propr setting update worker_concurrency 4            # Update a setting
propr setting update github_user_whitelist "a,b,c"   # Update whitelist
```

**Available settings:** `worker_concurrency`, `github_user_whitelist`, `analysis_model_fast`, `planner_context_model`, `planner_generation_model`, `auto_followup_score_threshold`

---

### Logs

```bash
propr log list                       # List recent LLM logs
propr log list -m model-name         # Filter by model
propr log list --failed              # Failed executions only
propr log list --agent my-claude     # Filter by agent
propr log list --draft <draft-id>    # Filter by plan
propr log list --page 2 -l 100      # Pagination
```

---

### System

```bash
propr status             # System health check
propr status --json      # JSON output
propr queue              # Queue statistics
propr queue --json       # JSON output
```

---

## JSON Output

Most commands support `--json` (`-j`) for programmatic use:

```bash
propr plan list --json
propr task list -j
propr repo list --json | jq '.repos_to_monitor[].name'
```

---

## Programmatic Usage

The CLI package also exports modules for programmatic use:

```typescript
import {
  createConfigManager,
  createApiClient,
  resolveProject,
} from 'propr-cli';

const config = await createConfigManager();
const client = await createApiClient();
const response = await client.get('/api/status');
```

---

## Examples

### Complete Workflow

```bash
# Setup
propr remote https://api.propr.example.com
propr login
propr use myorg/myrepo

# Add and index a repository
propr repo add myorg/myrepo -b main
propr repo index myorg/myrepo

# Create an implementation plan and wait for generation
propr plan create "Add user authentication with JWT tokens" --wait

# Finalize plan to create GitHub issues
propr plan finalize <draft-id>

# View plan issues
propr plan issues <draft-id>

# Implement the first issue from the plan
propr issue implement <draft-id>/1 --wait --auto-merge

# Monitor tasks
propr task list -s processing
propr task get <task-id>
```

### Managing To-Dos

```bash
# Create categories and todos
propr todo category add "Sprint 1"
propr todo add "Implement auth" -c <category-id>
propr todo add "Write tests" -c <category-id>

# Prioritize by reordering
propr todo move <todo-id> 1              # Move to top priority

# Track progress
propr todo complete <todo-id>
propr todo list -d                       # View completed items
```

### Monitoring and Debugging

```bash
propr status                             # System health
propr queue                              # Queue statistics
propr log list --failed                  # Failed LLM executions
propr log list -l 100 --success          # Successful executions
propr task get <task-id>                 # Detailed task info
```

### Managing Multiple Projects

```bash
# Switch default project
propr use org1/repo1
propr plan list

propr use org2/repo2
propr plan list

# Or use -p flag for one-off commands
propr plan list -p org3/repo3
propr todo list -p org3/repo3
```

---

## E2E Testing

End-to-end tests run against a live ProPR instance and exercise the full workflow: system health, repo management, todo CRUD, plan lifecycle (create → generate → finalize), and multi-model implementation across all agents (Claude, Antigravity, Codex, OpenCode).

### Prerequisites

- A running ProPR backend (e.g., `https://api.gitfix.dev`)
- GitHub authentication (via `gh auth login` or a token)
- A dedicated test repo on GitHub (e.g., `integry/propr-e2e-test`) — the tests will auto-add and index it if needed

### Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PROPR_E2E_API_URL` | Yes | — | Backend URL |
| `PROPR_E2E_TOKEN` | No | `gh auth token` | GitHub token (falls back to `gh` CLI) |
| `PROPR_E2E_REPO` | Yes | — | Test repo (e.g., `integry/propr-e2e-test`) |
| `PROPR_E2E_SKIP_SLOW` | No | — | Set to `1` to skip plan/implementation tests |
| `PROPR_E2E_NO_CLEANUP` | No | — | Set to `1` to keep all created resources |

### Running

```bash
# Fast tests only (~20s) — system health, repos, settings, logs, tasks, agents, todo CRUD
PROPR_E2E_REPO=owner/repo PROPR_E2E_API_URL=https://api.example.com \
  PROPR_E2E_SKIP_SLOW=1 npm run test:e2e

# Full suite (~20-30min) — includes plan generation, all-models implementation, report
PROPR_E2E_REPO=owner/repo PROPR_E2E_API_URL=https://api.example.com \
  npm run test:e2e

# Keep everything for manual inspection
PROPR_E2E_REPO=owner/repo PROPR_E2E_API_URL=https://api.example.com \
  PROPR_E2E_NO_CLEANUP=1 npm run test:e2e
```

### Test Groups

| # | Group | Speed | What it tests |
|---|-------|-------|---------------|
| 1 | System health | Fast | API status, queue stats |
| 2 | Repositories | Fast | List repos, auto-add test repo, ensure indexed |
| 3 | Settings | Fast | Setting types and values |
| 4 | Logs | Fast | LLM log listing, filtering, pagination |
| 5 | Tasks | Fast | Task listing and repo filtering |
| 6 | Agents | Fast | Agent listing, stores available models |
| 7 | Todo CRUD | Fast | Full lifecycle: create → list → get → update → reorder → delete |
| 8 | Plan — greenfield | Slow | Create plan → generate → finalize → verify issues |
| 9 | Plan — brownfield | Slow | Same flow with a different prompt type |
| 10 | All-models | Slow | Creates multiple plans, tests multi-model parallel (all models on one issue) + single-model (each model on a separate issue) for every agent/model pair |
| 11 | Report | Slow | Writes markdown report, validates log fields |

### Report

After each full run, a markdown report is written to:

- **`test/reports/e2e-{timestamp}.md`** — timestamped report
- **`test/reports/latest.md`** — symlink to most recent

The report includes:

- **Plans** — ID, name, status, prompt, issues with their agent/model/task assignments
- **Multi-model parallel results** — all models implementing the same issue simultaneously, with state, duration, tokens, PR number, history entries, and log counts
- **Single-model results** — grouped by agent (Claude, Antigravity, Codex, OpenCode), showing each model's performance on its own issue
- **Totals** — models tested, tasks created, completion rate, token usage

### File Structure

```
test/
  e2e.test.ts          # Main test file (groups 1-11)
  e2e/
    helpers.ts          # Shared types, client setup, polling utilities
    report.ts           # Markdown report generator
  reports/              # Generated reports (gitignored)
    latest.md
    e2e-2026-03-18T18-55-26.md
```

---

## Troubleshooting

### Authentication Errors

```bash
propr logout
propr login          # Interactive login via gh CLI
```

Make sure your GitHub token has the required scopes: `repo` and `read:org`.

### Connection Errors

```bash
propr remote https://correct-api-url.example.com
propr status
```

### Task Failures

```bash
propr task get <task-id>
propr log list --draft <draft-id> --failed
```

---

## Getting Help

```bash
propr --help                    # General help
propr <command> --help          # Command group help
propr plan --help               # Plan commands
propr todo category --help      # Category commands
```

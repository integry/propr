# ProPR CLI

Command-line interface for interacting with the ProPR backend. ProPR enables AI-powered automated implementation of GitHub issues and pull requests.

## Installation

```bash
npm install -g @propr/cli
```

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

# 4. List available plans
propr plan list

# 5. Implement an issue
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

### Authentication

When no token is provided, `propr login` uses the GitHub CLI (`gh`) for interactive authentication:
- If you're already logged in to `gh`, your token is used automatically
- If not, `gh auth login` is launched interactively

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

```bash
propr plan list                                  # List plans for default project
propr plan list -p owner/repo                    # List plans for specific project
propr plan create "Add dark mode" --wait         # Create plan and wait for generation
propr plan create "Fix bug" -b develop           # Target a specific branch
propr plan get <draft-id>                        # View plan details
propr plan delete <draft-id>                     # Delete a plan (with confirmation)
propr plan delete <draft-id> --force             # Delete without confirmation
propr plan abort <draft-id>                      # Abort ongoing generation
```

---

### Issue Implementation

```bash
propr issue implement <draft-id>/<issue-number>              # Trigger implementation
propr issue implement <draft-id>/1 --wait                    # Wait for completion
propr issue implement <draft-id>/1 -a claude -m model-name   # Use specific agent/model
propr issue implement <draft-id>/1 --epic --auto-merge       # Epic PR + auto-merge
```

**Options:** `-w, --wait`, `-a, --agent`, `-m, --model`, `--epic`, `--auto-merge`

---

### Tasks

```bash
propr task list                          # List all tasks
propr task list -s processing            # Filter by status
propr task list -p owner/repo            # Filter by project
propr task list --search "auth"          # Search tasks
propr task get <task-id>                 # View task details
propr task stop <task-id>                # Stop a running task
propr task delete <task-id>              # Delete a task
propr task delete <task-id> --force      # Force delete active task
propr task revert owner/repo 123 abc 456 # Revert a commit
```

**Status values:** `pending`, `queued`, `processing`, `completed`, `failed`, `cancelled`, `all`

---

### Repositories

```bash
propr repo list                              # List monitored repositories
propr repo add owner/repo                    # Add a repository
propr repo add owner/repo -a "Alias" -b dev  # With alias and branch
propr repo remove owner/repo                 # Remove a repository
propr repo toggle owner/repo --enable        # Enable monitoring
propr repo toggle owner/repo --disable       # Disable monitoring
propr repo index owner/repo                  # Trigger full indexing
propr repo index owner/repo --incremental    # Incremental indexing
propr repo status                            # View all indexing status
propr repo status owner/repo                 # View specific repo status
```

---

### Agents

```bash
propr agent list                                         # List configured agents
propr agent add my-claude -t claude -m model1,model2     # Add an agent
propr agent add my-agent -t claude -m model -d model     # With default model
propr agent add --file agent-config.json                 # From JSON file
propr agent delete my-agent                              # Delete (with confirmation)
propr agent delete my-agent --force                      # Delete without confirmation
```

**Agent types:** `claude`, `codex`, `gemini`

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
} from '@propr/cli';

const config = await createConfigManager();
const client = await createApiClient();
const response = await client.get('/api/status');
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

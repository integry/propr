# ProPR CLI

Command-line interface for interacting with the ProPR backend. ProPR enables AI-powered automated implementation of GitHub issues and pull requests.

## Installation

```bash
# Using npm
npm install -g @propr/cli

# Using yarn
yarn global add @propr/cli

# Using pnpm
pnpm add -g @propr/cli
```

## Quick Start

```bash
# 1. Configure the backend URL
propr remote https://api.propr.example.com

# 2. Authenticate with your GitHub token
propr login <your-github-token>

# 3. Set a default project (optional, but recommended)
propr use owner/repo

# 4. List available plans
propr list-plans

# 5. Implement an issue
propr implement-issue <draft-id>/<issue-number> --wait
```

## Configuration

ProPR CLI stores configuration in `~/.propr/config.json`. You can configure it using CLI commands:

### Set Remote URL

Connect to your ProPR backend:

```bash
propr remote https://api.propr.example.com
```

### Authentication

Authenticate using a GitHub Personal Access Token:

```bash
propr login <token>
```

To generate a token:
1. Go to https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Select the required scopes: `repo`, `read:org`
4. Copy the generated token
5. Run: `propr login <your-token>`

To clear authentication:

```bash
propr logout
```

### Default Project

Set a default repository to avoid specifying `-p/--project` for every command:

```bash
propr use owner/repo
```

## Commands Reference

### Global Options

| Option | Description |
|--------|-------------|
| `-p, --project <project>` | Specify the target project (owner/repo) |
| `-V, --version` | Output the version number |
| `-h, --help` | Display help information |

---

### Configuration Commands

#### `propr remote <url>`

Set the backend API base URL.

```bash
propr remote https://api.propr.example.com
```

#### `propr use <project>`

Set the default project for subsequent commands.

```bash
propr use integry/my-repo
```

#### `propr login [token]`

Authenticate with a GitHub Personal Access Token.

```bash
# Interactive mode (shows instructions)
propr login

# Direct token input
propr login ghp_xxxxxxxxxxxx
```

#### `propr logout`

Clear the stored GitHub token.

```bash
propr logout
```

---

### Plan Management Commands

#### `propr list-plans`

List all implementation plans for a project.

```bash
# List plans for default project
propr list-plans

# List plans for a specific project
propr list-plans -p owner/repo
```

**Options:**
- `-p, --project <project>` - Target project (owner/repo)

#### `propr create-plan <prompt>`

Create a new implementation plan from a prompt.

```bash
# Create a plan and return immediately
propr create-plan "Add a dark mode toggle to the settings page"

# Create a plan and wait for generation to complete
propr create-plan "Implement user authentication" --wait

# Create a plan targeting a specific branch
propr create-plan "Fix login bug" -b develop --wait
```

**Options:**
- `-p, --project <project>` - Target project (owner/repo)
- `-b, --branch <branch>` - Target branch (default: main)
- `-w, --wait` - Wait for plan generation to complete

#### `propr get-plan <draft-id>`

Get detailed information about a specific plan.

```bash
propr get-plan abc123-def456
```

**Output includes:**
- Plan status and details
- Items in the plan
- Attachments
- Chat history

#### `propr delete-plan <draft-id>`

Delete a plan from the system.

```bash
# With confirmation prompt
propr delete-plan abc123-def456

# Skip confirmation
propr delete-plan abc123-def456 --force
```

**Options:**
- `-f, --force` - Skip the confirmation prompt

#### `propr abort-plan <draft-id>`

Abort ongoing LLM generation for a plan.

```bash
propr abort-plan abc123-def456
```

---

### Implementation Commands

#### `propr implement-issue <issue-id>`

Implement a GitHub issue from a plan. The issue ID format is `<draft-id>/<issue-number>` or `<draft-id>:<issue-number>`.

```bash
# Trigger implementation and return immediately
propr implement-issue abc123/1

# Wait for implementation to complete
propr implement-issue abc123/1 --wait

# Use a specific agent and model
propr implement-issue abc123/1 -a claude -m claude-sonnet-4-20250514

# Create an Epic PR
propr implement-issue abc123/1 --epic

# Enable auto-merge for the PR
propr implement-issue abc123/1 --auto-merge
```

**Options:**
- `-p, --project <project>` - Target project (owner/repo)
- `-w, --wait` - Wait for the implementation to complete
- `-a, --agent <agent>` - Agent alias to use for implementation
- `-m, --model <model>` - Model name to use for implementation
- `--epic` - Create an Epic PR to collect all related PRs
- `--auto-merge` - Enable auto-merge for the created PR

---

### Task Management Commands

#### `propr list-tasks`

List tasks with optional filtering.

```bash
# List all tasks
propr list-tasks

# Filter by project
propr list-tasks -p owner/repo

# Filter by status
propr list-tasks -s processing

# Search tasks
propr list-tasks --search "authentication"

# Limit results
propr list-tasks -l 100
```

**Options:**
- `-p, --project <project>` - Filter by project (owner/repo)
- `-s, --status <status>` - Filter by status: `pending`, `queued`, `processing`, `completed`, `failed`, `cancelled`, or `all` (default: all)
- `-l, --limit <limit>` - Maximum number of tasks to show (default: 50)
- `--search <term>` - Search tasks by term

#### `propr get-task <task-id>`

Get detailed information about a specific task.

```bash
propr get-task task-uuid-here
```

**Output includes:**
- Task status and metadata
- Repository and issue information
- History with timestamps
- Token usage statistics

#### `propr stop-task <task-id>`

Stop a running task.

```bash
propr stop-task task-uuid-here
```

#### `propr delete-task <task-id>`

Delete a task from the system.

```bash
# With confirmation prompt
propr delete-task task-uuid-here

# Force deletion for active tasks
propr delete-task task-uuid-here --force
```

**Options:**
- `-f, --force` - Force deletion even for active tasks

#### `propr revert-task <repo> <pr> <commit> <commentId>`

Revert changes from a specific commit in a PR.

```bash
# Using owner/repo format
propr revert-task owner/repo 123 abc123def 456789

# Using separate owner flag
propr revert-task repo-name 123 abc123def 456789 -o owner
```

**Options:**
- `-o, --owner <owner>` - Repository owner (required if repo is not in owner/repo format)

---

### Repository Management Commands

#### `propr list-repos`

List all monitored repositories.

```bash
propr list-repos
```

#### `propr add-repo <fullName>`

Add a repository to the monitored list.

```bash
# Basic usage
propr add-repo owner/repo

# With alias and branch
propr add-repo owner/repo -a my-alias -b develop
```

**Options:**
- `-a, --alias <alias>` - Display alias for the repository
- `-b, --branch <branch>` - Base branch name

#### `propr remove-repo <fullName>`

Remove a repository from the monitored list.

```bash
propr remove-repo owner/repo
```

#### `propr toggle-repo <fullName>`

Enable or disable monitoring for a repository.

```bash
# Enable monitoring
propr toggle-repo owner/repo --enable

# Disable monitoring
propr toggle-repo owner/repo --disable
```

**Options:**
- `--enable` - Enable monitoring
- `--disable` - Disable monitoring

#### `propr index-repo <fullName>`

Trigger indexing for a repository.

```bash
# Full indexing
propr index-repo owner/repo

# Incremental indexing
propr index-repo owner/repo --incremental

# Index a specific branch
propr index-repo owner/repo -b feature-branch
```

**Options:**
- `-b, --branch <branch>` - Specify base branch
- `--incremental` - Perform incremental indexing

#### `propr repo-status [fullName]`

View indexing status for repositories.

```bash
# View all repositories status
propr repo-status

# View specific repository status
propr repo-status owner/repo
```

---

### Agent Management Commands

#### `propr list-agents`

List all configured AI agents.

```bash
propr list-agents
```

#### `propr add-agent <alias>`

Add a new AI agent configuration.

```bash
# Add a Claude agent
propr add-agent my-claude -t claude -m claude-sonnet-4-20250514,claude-opus-4-20250514

# Add with default model
propr add-agent my-agent -t claude -m claude-sonnet-4-20250514 -d claude-sonnet-4-20250514

# Add in disabled state
propr add-agent test-agent -t gemini -m gemini-pro --disabled
```

**Options:**
- `-t, --type <type>` - Agent type: `claude`, `codex`, or `gemini` (required)
- `-m, --model <models>` - Comma-separated list of models (required)
- `-d, --default-model <model>` - Default model to use
- `--docker-image <image>` - Docker image for the agent
- `--config-path <path>` - Config path to mount
- `--disabled` - Create agent in disabled state

#### `propr delete-agent <alias>`

Delete an AI agent configuration.

```bash
# With confirmation
propr delete-agent my-agent

# Skip confirmation
propr delete-agent my-agent --force
```

**Options:**
- `-f, --force` - Skip the confirmation prompt

---

### System Settings Commands

#### `propr get-settings`

View current system settings.

```bash
# View all settings
propr get-settings

# View a specific setting
propr get-settings -k worker_concurrency

# Output as JSON
propr get-settings --json
```

**Options:**
- `-k, --key <key>` - Show a specific setting
- `-j, --json` - Output as JSON

**Available Settings:**
- `worker_concurrency` - Number of concurrent workers
- `github_user_whitelist` - Allowed GitHub users
- `analysis_model_fast` - Fast analysis model
- `planner_context_model` - Planner context model
- `planner_generation_model` - Planner generation model
- `auto_followup_score_threshold` - Auto-followup threshold (0-9)

#### `propr update-setting <key> <value>`

Update a system setting.

```bash
propr update-setting worker_concurrency 4
propr update-setting auto_followup_score_threshold 7
```

---

### LLM Log Commands

#### `propr list-logs`

List LLM execution logs for auditing and cost analysis.

```bash
# List recent logs
propr list-logs

# Filter by model
propr list-logs -m claude-sonnet-4-20250514

# Filter by execution type
propr list-logs -t implementation

# Filter by agent
propr list-logs --agent my-claude

# Filter by draft/plan
propr list-logs --draft abc123

# Show only successful/failed executions
propr list-logs --success
propr list-logs --failed

# Pagination
propr list-logs --page 2 -l 100
```

**Options:**
- `-l, --limit <limit>` - Maximum logs to return (default: 50)
- `-m, --model <model>` - Filter by model name
- `-t, --type <type>` - Filter by execution type
- `--page <page>` - Page number (default: 1)
- `--success` - Show only successful executions
- `--failed` - Show only failed executions
- `--agent <alias>` - Filter by agent alias
- `--draft <draftId>` - Filter by draft/plan ID

---

### System Status Commands

#### `propr system-status`

Display the health status of backend components.

```bash
# Human-readable output
propr system-status

# JSON output
propr system-status --json
```

**Options:**
- `--json` - Output raw JSON

**Displays status for:**
- API health
- Redis connection
- Daemon status
- Worker status
- GitHub authentication
- Claude authentication

#### `propr queue-stats`

Display queue statistics and job counts.

```bash
# Human-readable output
propr queue-stats

# JSON output
propr queue-stats --json
```

**Options:**
- `--json` - Output raw JSON

**Displays:**
- Waiting jobs
- Active jobs
- Completed jobs
- Failed jobs
- Delayed jobs
- Failure rate

---

## Examples

### Complete Workflow Example

```bash
# Setup
propr remote https://api.propr.example.com
propr login ghp_your_token_here
propr use myorg/myrepo

# Add and index a repository
propr add-repo myorg/myrepo -b main
propr index-repo myorg/myrepo

# Create an implementation plan
propr create-plan "Add user authentication with JWT tokens" --wait

# List plans to get the draft ID
propr list-plans

# Implement the first issue from the plan
propr implement-issue <draft-id>/1 --wait --auto-merge

# Monitor tasks
propr list-tasks -s processing
propr get-task <task-id>

# Check system health
propr system-status
```

### Monitoring and Debugging

```bash
# Check system health
propr system-status

# View queue statistics
propr queue-stats

# Review LLM logs for cost analysis
propr list-logs -l 100 --success

# View detailed task information
propr get-task <task-id>
```

### Managing Multiple Projects

```bash
# Switch between projects
propr use org1/repo1
propr list-plans

propr use org2/repo2
propr list-plans

# Or use -p flag for one-off commands
propr list-plans -p org3/repo3
```

---

## Programmatic Usage

The CLI package also exports modules for programmatic use:

```typescript
import {
  createConfigManager,
  createApiClient,
  createApiClientWithConfig,
  resolveProject,
} from '@propr/cli';

// Create a config manager
const configManager = await createConfigManager();

// Create an API client with custom options
const client = await createApiClientWithConfig({
  baseUrl: 'https://api.propr.example.com',
  timeout: 30000,
});

// Use the API
const plans = await client.listPlans('owner/repo');
```

---

## Troubleshooting

### Authentication Errors

If you see "Unauthorized" errors:

```bash
# Check if you're logged in
propr logout
propr login <your-token>
```

Make sure your GitHub token has the required scopes: `repo` and `read:org`.

### Connection Errors

If you can't connect to the backend:

```bash
# Verify the remote URL
propr remote https://correct-api-url.example.com

# Check system status
propr system-status
```

### Task Failures

To debug failed tasks:

```bash
# Get detailed task information
propr get-task <task-id>

# Check LLM logs
propr list-logs --draft <draft-id> --failed
```

---

## Getting Help

For additional help:

```bash
# General help
propr --help

# Command-specific help
propr <command> --help

# Examples
propr implement-issue --help
propr create-plan --help
```

---

## License

See the main repository LICENSE file for details.

---
sidebar_position: 2
---

# Usage

Learn how to run and operate ProPR for automated issue processing.

## Running the Daemon

The daemon monitors GitHub repositories for AI-eligible issues and adds them to the task queue.

### Start the Daemon

```bash
# Production mode
npm run daemon

# Development mode with debug logging
npm run daemon:dev

# Reset all queue data and issue labels, then start daemon
npm run daemon:reset:dev
```

### What the Daemon Does

The daemon continuously:
- Polls configured repositories at the specified interval
- Searches for open issues with configured primary labels (e.g., 'AI', 'propr')
- Excludes issues already being processed or completed
- Detects model-specific labels to determine which agent/model pairs to use
- Adds detected issues to the appropriate task queue(s)

### Resetting Queue State

If jobs get stuck in failed or processing states, use the reset option:

```bash
# Clear all queue data and remove processing labels
npm run daemon:reset:dev

# Or against a production build
npm run daemon:reset
```

This will:
- Clear all Redis queue data (waiting, active, completed, failed jobs)
- Remove processing and done labels from GitHub issues
- Allow issues to be reprocessed from a clean state

## Running the Worker

Workers pull jobs from the queue and process issues through the complete workflow.

### Start Workers

```bash
# Production mode
npm run worker

# Development mode with debug logging
npm run worker:dev
```

### Running Multiple Workers

For increased throughput, run multiple workers in separate terminals:

```bash
# Terminal 1
npm run worker

# Terminal 2
npm run worker

# Or run in background
npm run worker & npm run worker
```

### Worker Processing Phases

Each worker executes a deterministic 3-phase workflow:

#### Phase 1: Pre-Agent Setup
- Pull job from Redis queue
- Update base branch with latest changes
- Create isolated git worktree
- Push initial branch to GitHub (prevents timing issues)

#### Phase 2: AI Implementation
- Execute the selected coding agent in a secure Docker environment
- The agent analyzes issue details and comments
- Implements solution with focus on code, not git operations

#### Phase 3: Post-Agent Finalization
- Commit any changes the agent made
- Push changes to GitHub
- Create pull request via GitHub API
- Link PR to original issue with proper keywords
- Update issue labels

## Issue Labels for Agent and Model Selection

Add labels to GitHub issues to specify which agent/model(s) should process them:

- `llm-claude-sonnet` - Use Claude Sonnet model
- `llm-claude-opus` - Use Claude Opus model
- `llm-opencode-kimi-k26` - Use an OpenCode agent configured for `opencode-go/kimi-k2.6`
- Multiple labels can be added for multi-model processing

The default `MODEL_LABEL_PATTERN` is `^llm-(.+)$`. ProPR strips the `llm-` prefix, resolves the remaining label against its model catalog, and then selects an enabled agent that supports that model. For example, `llm-opencode-kimi-k26` maps to `opencode-go/kimi-k2.6`.

### Example: Multi-Model Processing

```
Issue #123
Labels: AI, llm-claude-sonnet, llm-opencode-kimi-k26
```

This issue will be processed twice:
1. Once by Claude Sonnet (creates branch `ai-fix/123-...-sonnet-...`)
2. Once by OpenCode Kimi K2.6 (creates branch `ai-fix/123-...-kimi-k26-...`)

Each model creates its own branch and pull request.

## Operating OpenCode Agents

Before assigning work to OpenCode, verify the OpenCode agent exists and has credentials:

```bash
propr agent list
opencode auth list
```

An OpenCode agent usually points at `~/.config/opencode` and uses models such as `opencode-go/kimi-k2.6`. OpenCode Go is an optional OpenCode provider/model source, separate from the OpenCode CLI; you can also configure OpenCode with another provider and add that provider/model ID to the ProPR agent's supported models.

OpenCode/provider API keys are operator-owned. If a worker fails with authentication errors, update the provider env vars on the OpenCode agent, or run `opencode auth login` on the host and sync `~/.local/share/opencode/auth.json` into the mounted config tree, for example `~/.config/opencode/xdg-data/opencode/auth.json`, with `XDG_DATA_HOME=/home/node/.config/opencode/xdg-data` set on that agent.

```bash
mkdir -p ~/.config/opencode/xdg-data/opencode && cp ~/.local/share/opencode/auth.json ~/.config/opencode/xdg-data/opencode/auth.json
```

## Docker Compose Usage

Run all services together using Docker Compose:

```bash
# Start all services (builds if necessary)
npm run compose:up

# Stop all services
npm run compose:down

# View logs from all services
npm run compose:logs

# Force rebuild of all images
npm run compose:build
```

### Docker Compose Services

- **propr**: Main application (daemon and worker)
- **redis**: Redis server for task queue management
- **propr-ui**: Web UI for monitoring and management (port 5173)

## GitHub Authentication

For programmatic access to GitHub:

```typescript
import { getAuthenticatedOctokit } from '@propr/core';

const octokit = await getAuthenticatedOctokit();
// Use octokit for GitHub API operations
```

## Logging

ProPR uses structured logging with correlation IDs:

```typescript
import { logger } from '@propr/core';

logger.info('Application started');
logger.error('An error occurred', { error: err });
logger.debug('Debug information', { data: someData });
```

## Configuration

Access configuration values:

```typescript
import config from './config/index.js';

console.log(config.github.appId);
console.log(config.logging.level);
```

## Testing

Run the test suite:

```bash
npm test
```

## Branch Naming Convention

ProPR creates branches with a descriptive naming pattern:

```
ai-fix/{issueId}-{title}-{timestamp}-{model}-{random}
```

Example:
```
ai-fix/349-feat-implement-onboarding-20250529-1506-sonnet-3he
```

This format includes:
- `ai-fix/` - Prefix for all AI-generated branches
- `349` - Issue number
- `feat-implement-onboarding` - Sanitized issue title
- `20250529-1506` - Timestamp (YYYYMMDD-HHMM)
- `sonnet` - Model identifier
- `3he` - Random suffix for uniqueness

## Monitoring and Debugging

### Correlation IDs

Each job is assigned a correlation ID for tracking across logs and systems. Look for this ID in logs to trace a specific issue's processing.

### Job States

Jobs progress through these states:
- `waiting` - In queue, not yet started
- `active` - Currently being processed
- `completed` - Successfully finished
- `failed` - Encountered an error

### Error Recovery

ProPR automatically retries failed operations with exponential backoff:
- GitHub API operations: up to 3 retries
- Git operations: up to 3 retries
- Network requests: automatic retry with backoff

## Security Best Practices

- Never commit sensitive credentials to the repository
- Store all secrets in environment variables
- Keep the GitHub App private key file secure with restricted permissions (`chmod 600`)
- Use `.gitignore` to prevent accidental commits of sensitive files
- Regularly rotate GitHub App credentials

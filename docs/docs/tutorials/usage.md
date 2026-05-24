---
sidebar_position: 2
---

# Usage

Learn how to run and operate ProPR for automated issue processing.

Most users will do day-to-day configuration and monitoring in the Web UI. This page focuses on the backend processes and operator commands that power those UI workflows.

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
- Detects model-specific labels to determine which Claude models to use
- Adds detected issues to the appropriate task queue(s)

### Resetting Queue State

If jobs get stuck in failed or processing states, use the reset option:

```bash
# Clear all queue data and remove processing labels
npm run daemon:reset:dev

# Or with direct node command
node src/daemon.js --reset
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

#### Phase 1: Pre-Claude Setup
- Pull job from Redis queue
- Update base branch with latest changes
- Create isolated git worktree
- Push initial branch to GitHub (prevents timing issues)

#### Phase 2: AI Implementation
- Execute Claude Code in secure Docker environment
- Claude analyzes issue and comments
- Implements solution with focus on code, not git operations

#### Phase 3: Post-Claude Finalization
- Commit any changes Claude made
- Push changes to GitHub
- Create pull request via GitHub API
- Link PR to original issue with proper keywords
- Update issue labels

## Issue Labels for Model Selection

Add labels to GitHub issues to specify which Claude model(s) should process them:

- `llm-claude-sonnet` - Use Claude Sonnet model
- `llm-claude-opus` - Use Claude Opus model
- Both labels can be added for multi-model processing

### Example: Multi-Model Processing

```
Issue #123
Labels: AI, llm-claude-sonnet, llm-claude-opus
```

This issue will be processed twice:
1. Once by Claude Sonnet (creates branch `ai-fix/123-...-sonnet-...`)
2. Once by Claude Opus (creates branch `ai-fix/123-...-opus-...`)

Each model creates its own branch and pull request.

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

```javascript
import { getAuthenticatedOctokit } from './src/auth/githubAuth.js';

const octokit = await getAuthenticatedOctokit();
// Use octokit for GitHub API operations
```

## Logging

ProPR uses structured logging with correlation IDs:

```javascript
import logger from './src/utils/logger.js';

logger.info('Application started');
logger.error('An error occurred', { error: err });
logger.debug('Debug information', { data: someData });
```

## Configuration

Access configuration values:

```javascript
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

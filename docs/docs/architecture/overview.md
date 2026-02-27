---
sidebar_position: 1
---

# Architecture Overview

ProPR is designed with a modular, production-ready architecture that separates concerns and ensures reliable operation.

## High-Level Architecture

ProPR consists of three main components:

1. **Daemon** - Monitors GitHub repositories and enqueues issues
2. **Worker** - Processes issues through a deterministic 3-phase workflow
3. **Task Queue** - Redis-based queue for job management

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│             │         │             │         │             │
│   Daemon    │────────▶│    Redis    │◀────────│   Worker    │
│             │         │    Queue    │         │             │
└─────────────┘         └─────────────┘         └─────────────┘
      │                                               │
      │ Poll                                          │ Process
      ▼                                               ▼
┌─────────────┐                               ┌─────────────┐
│   GitHub    │                               │   Claude    │
│   Issues    │                               │    Code     │
└─────────────┘                               └─────────────┘
```

## Project Structure

```
propr/
├── src/
│   ├── auth/
│   │   └── githubAuth.js        # GitHub App authentication
│   ├── claude/
│   │   └── claudeService.js     # Claude Code CLI integration & Docker execution
│   ├── git/
│   │   └── repoManager.js       # Git operations, worktree management, branch handling
│   ├── queue/
│   │   └── taskQueue.js         # BullMQ task queue with Redis
│   ├── utils/
│   │   ├── errorHandler.js      # Comprehensive error handling utilities
│   │   ├── logger.js            # Structured logging with correlation IDs
│   │   ├── prValidation.js      # PR validation and retry mechanisms
│   │   ├── retryHandler.js      # Configurable retry logic with exponential backoff
│   │   ├── workerStateManager.js # Job state management and tracking
│   │   └── idempotentOps.js     # Idempotent operation utilities
│   ├── daemon.js                # Multi-model issue detection daemon
│   ├── worker.js                # 3-phase deterministic job processor
│   ├── githubService.js         # GitHub API operations and PR management
│   └── index.js                 # Application entry point
├── scripts/
│   ├── claude-entrypoint.sh     # Docker entrypoint for secure Claude execution
│   ├── init-firewall.sh         # Security and firewall setup
│   ├── fix-issue-labels.js      # Manual issue label management utility
│   └── list-repo-configs.js     # Repository configuration display utility
├── docs/                        # Technical documentation
├── test/                        # Comprehensive test suite
├── Dockerfile.claude            # Secure Docker image for Claude execution
├── .env.example                 # Complete environment configuration template
└── package.json                 # Dependencies and npm scripts
```

## Workflow Overview

### 1. Issue Detection (Daemon)

The daemon continuously monitors configured GitHub repositories:

1. Polls repositories at configured intervals (default: 60 seconds)
2. Searches for open issues with configured primary labels (e.g., 'AI', 'propr')
3. Checks for model-specific labels (e.g., 'llm-claude-sonnet', 'llm-claude-opus')
4. Excludes issues with state labels (processing, done, failed)
5. Creates job(s) in Redis queue for each detected issue/model combination

### 2. Job Processing (Worker)

Workers pull jobs from the queue and execute a deterministic 3-phase workflow:

#### Phase 1: Pre-Claude Setup (Deterministic)
- Clone or update repository with latest changes
- Create isolated git worktree for the issue
- Generate unique branch name with model identifier
- Push initial branch to GitHub (prevents timing issues)
- Add processing label to issue

#### Phase 2: AI Implementation (Claude Focus)
- Prepare implementation-focused prompt
- Include complete issue context (description + all comments)
- Execute Claude Code in secure Docker container
- Claude analyzes and implements solution
- Parse Claude's output for implementation details

#### Phase 3: Post-Claude Finalization (Deterministic)
- Commit any changes Claude made
- Push changes to GitHub
- Create pull request via GitHub API
- Link PR to issue with proper keywords (`Closes #123`)
- Update issue labels (remove processing, add done/failed)
- Clean up resources

### 3. State Management

Job states are tracked through Redis and GitHub labels:

**Redis Job States:**
- `waiting` - In queue, not yet started
- `active` - Currently being processed by a worker
- `completed` - Successfully finished
- `failed` - Encountered an error

**GitHub Label States:**
- `{label}-processing` - Job is currently active
- `{label}-done` - Job completed successfully
- `{label}-failed-*` - Job failed (with reason suffix)

## Key Design Principles

### Deterministic Operations

Git operations and GitHub API calls are deterministic and handled by the system, not by Claude. This ensures:
- Reliable branch creation and management
- Consistent PR creation process
- Predictable error handling and recovery

### Isolation

Each issue is processed in complete isolation:
- Separate git worktree per issue
- Docker container isolation for Claude execution
- Independent job tracking in Redis

### Concurrency

Multiple workers can process issues simultaneously:
- Model-specific queues prevent conflicts
- Worktree isolation prevents git conflicts
- Unique branch names with model identifiers

### Error Recovery

Comprehensive retry mechanisms with exponential backoff:
- GitHub API operations (3 retries)
- Git operations (3 retries)
- Network requests (automatic backoff)

### Observability

Full observability through structured logging:
- Correlation IDs track jobs across systems
- Detailed error logging with context
- State transitions logged at every step

## Authentication

ProPR uses GitHub App authentication for secure API access:

1. **GitHub App** - Created with specific repository permissions
2. **Private Key** - Used to generate installation access tokens
3. **Installation ID** - Links the app to specific repositories

This approach provides:
- Fine-grained permission control
- Automatic token refresh
- Support for private repositories
- Audit trail of all operations

## Data Flow

```
GitHub Issue (labeled)
    ↓
Daemon detects issue
    ↓
Job added to Redis queue
    ↓
Worker pulls job
    ↓
Git worktree created
    ↓
Branch pushed to GitHub
    ↓
Claude analyzes and codes
    ↓
Changes committed
    ↓
PR created and linked
    ↓
Labels updated
    ↓
Job marked complete
```

## Scalability

ProPR scales horizontally:

- **Multiple workers** can process jobs in parallel
- **Multiple models** can process the same issue independently
- **Multiple repositories** can be monitored simultaneously
- **Redis queue** handles high job volumes efficiently

## Security

Security is built into every layer:

- **Docker isolation** for Claude Code execution
- **Network restrictions** in Docker containers
- **GitHub App permissions** limit access scope
- **Token-based authentication** with automatic refresh
- **Private key protection** with file permissions
- **No credential storage** in code or git

## Related Documentation

- [Daemon Architecture](./daemon.md)
- [Worker Architecture](./worker.md)
- [Claude Integration](./claude-integration.md)
- [Git Management](./git-management.md)

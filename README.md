# GitFix - Automated GitHub Issue Processor

A production-ready automated system that monitors GitHub issues, uses Anthropic's Claude Code to generate solutions, and provides a complete end-to-end workflow from issue detection to pull request creation.

## Features

### ✅ Complete End-to-End Automation
- **Issue Detection**: Automatic monitoring of GitHub repositories for AI-eligible issues
- **Multiple Primary Labels**: Support for multiple trigger labels (e.g., 'AI', 'gitfix') with dynamic state label generation
- **Model-Specific Processing**: Support for multiple Claude models (sonnet, opus) with dedicated job queues
- **Deterministic Git Workflow**: Reliable 3-phase workflow separating AI implementation from git operations
- **Automatic PR Creation**: Direct GitHub API integration with proper issue linking
- **Quality Assurance**: Comprehensive validation and retry mechanisms

### ✅ Advanced Multi-Model Support
- **Model-Specific Enqueueing**: Separate job queues for different Claude models based on issue labels
- **Concurrent Processing**: Multiple workers can process different models simultaneously
- **Model-Specific Branch Naming**: Unique branch names include model identifier for traceability
- **Model Selection**: Automatic model detection from issue labels (`llm-claude-sonnet`, `llm-claude-opus`)

### ✅ Robust Git Management
- **Isolated Worktrees**: Each issue processed in separate git worktree for conflict prevention
- **Repository-Specific Configuration**: Support for different default branches per repository
- **Authentication Handling**: Seamless private repository access with token-based authentication
- **Branch Management**: Automatic creation, pushing, and cleanup of feature branches

### ✅ Intelligent Claude Integration
- **Implementation-Focused Prompts**: Claude focuses solely on code implementation, not git operations
- **Context-Aware Processing**: Reads both issue descriptions and all comments for complete context
- **Docker Isolation**: Secure containerized execution environment with network restrictions
- **Output Parsing**: Intelligent extraction of implementation details and commit messages

### ✅ Production-Ready Reliability
- **Deterministic 3-Phase Workflow**: Pre-Claude setup → AI implementation → Post-Claude finalization
- **Error Recovery**: Comprehensive retry mechanisms with exponential backoff
- **GitHub API Integration**: Direct API calls with timing fixes and proper error handling
- **State Management**: Redis-based job state tracking with correlation IDs for debugging

### ✅ Dynamic Label System
- **Multiple Primary Labels**: Configure multiple labels to trigger processing (e.g., 'AI', 'gitfix', 'automation')
- **Automatic State Labels**: State labels are dynamically generated based on the triggering label:
  - Issue with 'AI' label → Uses 'AI-processing', 'AI-done', 'AI-failed-*' labels
  - Issue with 'gitfix' label → Uses 'gitfix-processing', 'gitfix-done', 'gitfix-failed-*' labels
- **Correct Label Attribution**: Each issue is tracked with labels specific to its trigger, avoiding conflicts
- **Flexible Configuration**: Add or remove primary labels via environment variables or UI without code changes

## Prerequisites

- **Node.js 18+** - Runtime environment
- **GitHub App** - Created with appropriate permissions (see setup below)
- **Claude Subscription** - Anthropic Claude account with API access
- **Redis Server** - For task queue management (v6.0+ recommended)
- **Git 2.25+** - For worktree support and modern git operations
- **Docker** - For secure Claude Code execution environment
- **Disk Space** - Sufficient space for repository clones and worktrees (minimum 10GB recommended)

## Setup

### 1. GitHub App Configuration

Create a GitHub App with the following permissions:

**Repository Permissions:**
- **Contents**: Read & Write (for code changes and file operations)
- **Metadata**: Read (for repository information)
- **Issues**: Read & Write (for issue management and comments)
- **Pull Requests**: Read & Write (for PR creation and management)
- **Actions**: Read (optional, for workflow integration)

**Installation:**
1. Create a new GitHub App in your account/organization settings
2. Generate and download the private key (`.pem` file)
3. Install the app on your repository
4. Note down the App ID and Installation ID

### 2. Environment Configuration

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Fill in your credentials and daemon configuration:
   ```
   # GitHub App Configuration
   GH_APP_ID=your_app_id
   GH_PRIVATE_KEY_PATH=./your-app-private-key.pem
   GH_INSTALLATION_ID=your_installation_id
   
   # Daemon Configuration
   GITHUB_REPOS_TO_MONITOR=owner/repo1,owner/repo2
   POLLING_INTERVAL_MS=60000
   
   # Issue Detection Configuration
   PRIMARY_PROCESSING_LABELS=AI,gitfix
   # Note: State labels (-processing, -done, -failed-*) are now automatically 
   # generated based on the specific primary label that triggered processing
   
   # Model-Specific Configuration
   MODEL_LABELS_SONNET=llm-claude-sonnet
   MODEL_LABELS_OPUS=llm-claude-opus
   
   # PR Comment Monitoring Configuration
   GITHUB_BOT_USERNAME=your_bot_username
   GITHUB_USER_WHITELIST=
   GITHUB_USER_BLACKLIST=
   
   # Git Configuration
   GIT_CLONES_BASE_PATH=/tmp/git-processor/clones
   GIT_WORKTREES_BASE_PATH=/tmp/git-processor/worktrees
   GIT_DEFAULT_BRANCH=main
   GIT_SHALLOW_CLONE_DEPTH=
   
   # Repository-Specific Branch Configuration (optional)
   GIT_DEFAULT_BRANCH_OWNER_REPO=dev
   ```

3. Place your GitHub App private key file in the project root

### 3. Git Environment Setup

Ensure the worker can access repository storage directories:

```bash
# Create directories with appropriate permissions
sudo mkdir -p /tmp/git-processor/{clones,worktrees}
sudo chown -R $(whoami) /tmp/git-processor
chmod 755 /tmp/git-processor

# Verify Git installation and worktree support
git --version
git worktree --help
```

### 4. Claude Code Setup

For Claude Code CLI integration:

1. **Install Claude Code CLI globally:**
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

2. **Authenticate with Claude:**
   ```bash
   claude login
   ```
   This generates `~/.config/claude-code/auth.json` needed for non-interactive execution.

3. **Install Docker:**
   The worker uses Docker to run Claude Code in a secure, isolated environment.
   ```bash
   # Ubuntu/Debian
   sudo apt-get update
   sudo apt-get install docker.io
   sudo usermod -aG docker $USER
   
   # macOS (with Homebrew)
   brew install docker
   
   # Verify installation
   docker --version
   ```

4. **Configure Claude settings in .env:**
   ```bash
   # Claude Code Configuration
   CLAUDE_DOCKER_IMAGE=claude-code-processor:latest
   CLAUDE_CONFIG_PATH=~/.config/claude-code
   CLAUDE_MAX_TURNS=1000
   CLAUDE_TIMEOUT_MS=300000
   
   # Worker Configuration
   WORKER_CONCURRENCY=5
   
   # Retry Configuration
   GITHUB_API_MAX_RETRIES=3
   GIT_OPERATION_MAX_RETRIES=3
   ```

### 5. Installation

```bash
npm install
```

## Project Structure

```
gitfix/
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
├── docs/
│   ├── AI_PR_REVIEW_GUIDELINES.md    # Guidelines for AI-generated code review
│   ├── REPOSITORY_BRANCH_CONFIG.md   # Repository configuration documentation
│   └── SYSTEM_METRICS.md             # System metrics and monitoring guide
├── test/                             # Comprehensive test suite
│   ├── *.test.js                     # Unit and integration tests
│   ├── worker.modelSpecific.test.js  # Multi-model processing tests
│   └── repoManager.modelSpecific.test.js # Git worktree isolation tests
├── Dockerfile.claude                 # Secure Docker image for Claude execution
├── .env.example                      # Complete environment configuration template
└── package.json                      # Dependencies and npm scripts
```

## Usage

### Running the Issue Detection Daemon

Start the daemon to monitor GitHub repositories for AI-eligible issues:

```bash
# Production mode
npm run daemon

# Development mode with debug logging
npm run daemon:dev

# Reset all queue data and issue labels, then start daemon
npm run daemon:reset:dev
```

The daemon will:
- Poll configured repositories at the specified interval
- Search for open issues with the AI tag
- Exclude issues already being processed or completed
- Add detected issues to the task queue for processing

#### Resetting Queue State

If jobs get stuck in failed/processing states, use the reset option to clear all queue data:

```bash
# Clear all queue data and remove processing labels from issues
npm run daemon:reset:dev

# Or with direct node command
node src/daemon.js --reset
```

This will:
- Clear all Redis queue data (waiting, active, completed, failed jobs)
- Remove "AI-processing" and "AI-done" labels from GitHub issues
- Allow issues to be reprocessed from a clean state

### Running the Worker Process

Start one or more workers to process issues from the queue:

```bash
# Production mode
npm run worker

# Development mode with debug logging
npm run worker:dev

# Run multiple workers (in separate terminals)
npm run worker & npm run worker
```

The worker will:
- **Phase 1 (Pre-Claude Setup)**: Pull jobs from queue, update base branch, create isolated git worktree, push initial branch to GitHub
- **Phase 2 (AI Implementation)**: Execute Claude Code with implementation-focused prompts in secure Docker environment
- **Phase 3 (Post-Claude Finalization)**: Commit any changes, push to GitHub, create pull request with automatic issue linking
- Handle multiple models concurrently with model-specific delays to prevent conflicts
- Provide comprehensive error handling and retry mechanisms

### GitHub Authentication

```javascript
import { getAuthenticatedOctokit } from './src/auth/githubAuth.js';

const octokit = await getAuthenticatedOctokit();
// Use octokit for GitHub API operations
```

### Logging

```javascript
import logger from './src/utils/logger.js';

logger.info('Application started');
logger.error('An error occurred', { error: err });
logger.debug('Debug information', { data: someData });
```

### Configuration

```javascript
import config from './config/index.js';

console.log(config.github.appId);
console.log(config.logging.level);
```

## Docker Compose Setup

The project includes a complete Docker Compose configuration for running all services in containers. This simplifies development and deployment by managing GitFix, Redis, and the UI in a unified environment.

### Docker Compose Commands

Manage the entire application stack with these npm scripts:

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

These commands use the `scripts/compose.sh` script which wraps Docker Compose operations for convenience.

### Docker Compose Services

- **gitfix**: Main application (daemon and worker)
- **redis**: Redis server for task queue management
- **gitfix-ui**: Web UI for monitoring and management (port 5173)

All services are configured in `docker-compose.yml` with proper networking and volume management.

## Redis Setup

The task queue requires Redis. Install and start Redis:

```bash
# macOS
brew install redis
brew services start redis

# Ubuntu/Debian
sudo apt-get install redis-server
sudo systemctl start redis

# Docker
docker run -d -p 6379:6379 redis:alpine
```

**Note**: When using Docker Compose, Redis is automatically included and configured - no separate installation needed.

## Error Handling

The project implements consistent error handling patterns:

1. All async operations use try-catch blocks
2. Errors are logged with full context
3. Critical configuration errors cause early exit
4. Non-critical errors are handled gracefully
5. Queue jobs retry automatically with exponential backoff

## Security Best Practices

- **Never commit sensitive credentials** to the repository
- Store all secrets in environment variables
- Keep the GitHub App private key file secure with restricted permissions
- Use `.gitignore` to prevent accidental commits of sensitive files

## Testing

Run tests with:
```bash
npm test
```

## Workflow Overview

### Issue Labels for Model Selection
Add labels to GitHub issues to specify which Claude model(s) should process them:
- `llm-claude-sonnet` - Use Claude Sonnet model
- `llm-claude-opus` - Use Claude Opus model
- Both labels can be used together for multi-model processing

### Deterministic 3-Phase Processing
1. **Pre-Claude Setup** (Deterministic)
   - Repository cloning/updating with latest changes
   - Isolated git worktree creation with unique model-specific branch names
   - Initial branch push to GitHub (eliminates timing issues)

2. **AI Implementation** (Claude Focus)
   - Implementation-only prompts (no git operations)
   - Complete issue and comment context analysis
   - Code implementation in isolated environment

3. **Post-Claude Finalization** (Deterministic)
   - Automatic commit of any changes Claude made
   - Branch push and PR creation via GitHub API
   - Proper issue linking with keywords (`Closes #123` or `Addresses #123`)
   - Label management and cleanup

### Branch Naming Convention
`ai-fix/{issueId}-{title}-{timestamp}-{model}-{random}`

Example: `ai-fix/349-feat-implement-onboarding-20250529-1506-sonnet-3he`

## Advanced Features

### Multi-Model Processing
- Issues with multiple model labels create separate jobs for each model
- Each model gets its own branch and processes the issue independently
- Concurrent execution with conflict prevention mechanisms

### Quality Assurance
- Comprehensive PR validation and retry mechanisms
- Anti-hallucination prompts and repository validation
- Automatic detection and handling of edge cases

### Error Recovery
- Exponential backoff retry for API operations
- Graceful handling of git conflicts and timing issues
- State management with correlation IDs for debugging

### Repository Configuration
- Per-repository default branch configuration
- Custom branch naming and processing rules
- Flexible label-based model selection

## Contributing

When contributing to this project:
1. Follow existing code patterns and conventions
2. Ensure all tests pass
3. Update documentation as needed
4. Use the structured logger for all output
5. Handle errors consistently

<!-- CI trigger -->
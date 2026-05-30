# ProPR - Automated GitHub Issue Processor

A production-ready automated system that monitors GitHub issues, uses configurable coding agents such as Claude Code and OpenCode to generate solutions, and provides a complete end-to-end workflow from issue detection to pull request creation.

## Features

### ✅ Complete End-to-End Automation
- **Issue Detection**: Automatic monitoring of GitHub repositories for AI-eligible issues
- **Multiple Primary Labels**: Support for multiple trigger labels (e.g., 'AI', 'propr') with dynamic state label generation
- **Model-Specific Processing**: Support for multiple coding agents and models with dedicated job queues
- **Deterministic Git Workflow**: Reliable 3-phase workflow separating AI implementation from git operations
- **Automatic PR Creation**: Direct GitHub API integration with proper issue linking
- **Quality Assurance**: Comprehensive validation and retry mechanisms

### ✅ Advanced Multi-Model Support
- **Model-Specific Enqueueing**: Separate job queues for different agent/model selections based on issue labels
- **Concurrent Processing**: Multiple workers can process different models simultaneously
- **Model-Specific Branch Naming**: Unique branch names include model identifier for traceability
- **Model Selection**: Automatic model detection from issue labels (`llm-claude-sonnet`, `llm-claude-opus`, `llm-opencode-kimi-k26`)

### ✅ Robust Git Management
- **Isolated Worktrees**: Each issue processed in separate git worktree for conflict prevention
- **Repository-Specific Configuration**: Support for different default branches per repository
- **Authentication Handling**: Seamless private repository access with token-based authentication
- **Branch Management**: Automatic creation, pushing, and cleanup of feature branches

### ✅ Intelligent Agent Integration
- **Implementation-Focused Prompts**: AI agents focus solely on code implementation, not git operations
- **Context-Aware Processing**: Reads both issue descriptions and all comments for complete context
- **Docker Isolation**: Secure containerized execution environment with network restrictions
- **Output Parsing**: Intelligent extraction of implementation details and commit messages

### ✅ Production-Ready Reliability
- **Deterministic 3-Phase Workflow**: Pre-agent setup → AI implementation → post-agent finalization
- **Error Recovery**: Comprehensive retry mechanisms with exponential backoff
- **GitHub API Integration**: Direct API calls with timing fixes and proper error handling
- **State Management**: Redis-based job state tracking with correlation IDs for debugging

### ✅ Dynamic Label System
- **Multiple Primary Labels**: Configure multiple labels to trigger processing (e.g., 'AI', 'propr', 'automation')
- **Automatic State Labels**: State labels are dynamically generated based on the triggering label:
  - Issue with 'AI' label → Uses 'AI-processing', 'AI-done', 'AI-failed-*' labels
  - Issue with 'propr' label → Uses 'propr-processing', 'propr-done', 'propr-failed-*' labels
- **Correct Label Attribution**: Each issue is tracked with labels specific to its trigger, avoiding conflicts
- **Flexible Configuration**: Add or remove primary labels via environment variables or UI without code changes

## Prerequisites

- **Node.js 18+** - Runtime environment
- **GitHub App** - Created with appropriate permissions (see setup below)
- **AI Agent Credentials** - Configure at least one coding agent. Claude requires your Anthropic/Claude credentials; OpenCode requires your own OpenCode Go or provider API keys.
- **Redis Server** - For task queue management (v6.0+ recommended)
- **Git 2.25+** - For worktree support and modern git operations
- **Docker** - For secure coding-agent execution environments
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
   PRIMARY_PROCESSING_LABELS=AI,propr
   # Note: State labels (-processing, -done, -failed-*) are now automatically 
   # generated based on the specific primary label that triggered processing
   
   # Model-Specific Configuration
   MODEL_LABEL_PATTERN="^llm-(.+)$"
   
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

### 4. Coding Agent Setup

Configure one or more implementation agents. Each agent needs its own CLI credentials and Docker image.

#### Docker

The worker uses Docker to run all coding agents in secure, isolated environments.

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

#### Claude Code

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

3. **Configure Claude settings in .env:**
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

#### OpenCode

For OpenCode CLI integration:

1. **Install OpenCode CLI globally:**
   ```bash
   curl -fsSL https://opencode.ai/install | bash
   # or: npm install -g opencode-ai
   ```

2. **Initialize local OpenCode directories:**
   ```bash
   mkdir -p ~/.config/opencode ~/.config/opencode/xdg-data/opencode
   opencode --version
   ```

   OpenCode's current config path is `~/.config/opencode`. Use that as the agent `--config-path` for new installs. Legacy deployments can keep using `~/.opencode` by configuring the agent with `--config-path ~/.opencode`.

3. **Authenticate OpenCode with your provider keys:**
   ```bash
   opencode auth login
   ```

   OpenCode stores provider credentials in `~/.local/share/opencode/auth.json`, while ProPR mounts only the configured OpenCode config directory into the agent container. Make credentials available to the container in one of these ways:

   - Prefer provider environment variables when your OpenCode provider supports them. Add those variables to the OpenCode agent's `envVars` through your API/UI deployment flow.
   - If you use `opencode auth login`, copy or sync `~/.local/share/opencode/auth.json` to a data directory under the mounted config path, for example `~/.config/opencode/xdg-data/opencode/auth.json`, and set the agent env var `XDG_DATA_HOME=/home/node/.config/opencode/xdg-data`.

   ```bash
   mkdir -p ~/.config/opencode/xdg-data/opencode && cp ~/.local/share/opencode/auth.json ~/.config/opencode/xdg-data/opencode/auth.json
   ```

   OpenCode Go is an optional OpenCode provider/model source, separate from the OpenCode CLI. You can use an OpenCode Go model such as `opencode-go/kimi-k2.6`, or configure any other provider supported by OpenCode. In all cases, operators must supply their own OpenCode/provider API keys.

4. **Configure an OpenCode agent in ProPR:**
   ```bash
   propr agent add opencode \
     -t opencode \
     -m opencode-go/kimi-k2.6 \
     -d opencode-go/kimi-k2.6 \
     --docker-image propr/agent-opencode:latest \
     --config-path ~/.config/opencode
   ```

   If you keep OpenCode credentials in environment variables or need the `XDG_DATA_HOME` override shown above, add those env vars to the agent configuration through the API/UI deployment flow used by your installation.

   GitHub issue labels are matched by `MODEL_LABEL_PATTERN` (default `^llm-(.+)$`) and then resolved against ProPR's model catalog and configured agents. The built-in label `llm-opencode-kimi-k26` maps to `opencode-go/kimi-k2.6` when an enabled OpenCode agent supports that model.

### 5. Installation

```bash
npm install
```

## Project Structure

```
propr/
├── src/                              # Daemon, worker, polling, and job orchestration
│   ├── daemon.ts                     # Issue detection daemon entry point
│   ├── worker.ts                     # Worker entry point
│   ├── jobs/                         # Issue, PR comment, review, and system task jobs
│   ├── polling/                      # GitHub issue and PR polling
│   └── github/                       # GitHub PR and merge operations
├── packages/
│   ├── core/                         # Agent registry, agent implementations, shared runtime
│   ├── api/                          # Dashboard API and webhook routes
│   ├── cli/                          # ProPR CLI
│   └── shared/                       # Shared model definitions and types
├── propr-ui/                         # Frontend package
├── scripts/
│   ├── claude-entrypoint.sh     # Docker entrypoint for secure Claude execution
│   ├── codex-entrypoint.sh      # Docker entrypoint for secure Codex execution
│   ├── gemini-entrypoint.sh     # Docker entrypoint for secure Gemini execution
│   ├── opencode-entrypoint.sh   # Docker entrypoint for secure OpenCode execution
│   ├── init-firewall.sh         # Security and firewall setup
│   ├── fix-issue-labels.js      # Manual issue label management utility
│   └── list-repo-configs.js     # Repository configuration display utility
├── docs/                             # Docusaurus documentation site
├── test/                             # Unit and integration tests
├── Dockerfile.claude                 # Secure Docker image for Claude execution
├── Dockerfile.codex                  # Secure Docker image for Codex execution
├── Dockerfile.gemini                 # Secure Docker image for Gemini execution
├── Dockerfile.opencode               # Secure Docker image for OpenCode execution
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
- Search for open issues with configured primary labels such as `AI` or `propr`
- Exclude issues already being processed or completed
- Add detected issues to the task queue for processing

#### Resetting Queue State

If jobs get stuck in failed/processing states, use the reset option to clear all queue data:

```bash
# Clear all queue data and remove processing labels from issues
npm run daemon:reset:dev

# Or against a production build
npm run daemon:reset
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
- **Phase 1 (Pre-Agent Setup)**: Pull jobs from queue, update base branch, create isolated git worktree, push initial branch to GitHub
- **Phase 2 (AI Implementation)**: Execute the selected coding agent with implementation-focused prompts in a secure Docker environment
- **Phase 3 (Post-Agent Finalization)**: Commit any changes, push to GitHub, create pull request with automatic issue linking
- Handle multiple models concurrently with model-specific delays to prevent conflicts
- Provide comprehensive error handling and retry mechanisms

### GitHub Authentication

```typescript
import { getAuthenticatedOctokit } from '@propr/core';

const octokit = await getAuthenticatedOctokit();
// Use octokit for GitHub API operations
```

### Logging

```typescript
import { logger } from '@propr/core';

logger.info('Application started');
logger.error('An error occurred', { error: err });
logger.debug('Debug information', { data: someData });
```

### Configuration

```typescript
import config from './config/index.js';

console.log(config.github.appId);
console.log(config.logging.level);
```

## Production Docker Images

For self-hosted production deployments, ProPR ships as a set of pre-built Docker
images orchestrated by a single umbrella `propr/launcher` image. This replaces
`docker-compose` for install-time scenarios and installs in one command.

### Quick install

```bash
# Start the full stack from pre-built images
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $PWD/.env:/app/.env:ro \
  -e PROPR_ENV_FILE=$PWD/.env \
  -e PROPR_DATA_DIR=$PWD/data \
  -e PROPR_LOGS_DIR=$PWD/logs \
  -e PROPR_REPOS_DIR=$PWD/repos \
  -e HOST_CLAUDE_DIR=$HOME/.claude \
  -e HOST_CODEX_DIR=$HOME/.codex \
  -e HOST_GEMINI_DIR=$HOME/.gemini \
  -e HOST_OPENCODE_XDG_DIR=$HOME/.config/opencode \
  propr/launcher:latest
```

Paths are passed as host paths (not mounted into the launcher) because the
launcher uses the host docker daemon via the mounted socket to spawn sibling
containers — any `-v` values it passes need to resolve on the host.
Pass `HOST_OPENCODE_LEGACY_DIR=$HOME/.opencode` only for OpenCode agents whose
saved `configPath` is `~/.opencode`. `HOST_OPENCODE_DIR` is accepted as an alias
for `HOST_OPENCODE_XDG_DIR`.

The launcher pulls redis + app + ui images on first run and orchestrates them
via the mounted docker socket. See `.env.example` for required configuration.

### Images published

| Image | Contents |
|---|---|
| `propr/launcher` | Orchestrator that spawns the stack |
| `propr/app` | Server (daemon / workers / api, command selects role) |
| `propr/ui` | Web UI static bundle |
| `propr/docs` | Docusaurus site (optional) |
| `propr/agent-base` | Shared base for agent images |
| `propr/agent-claude` | Claude Code execution container |
| `propr/agent-codex` | OpenAI Codex execution container |
| `propr/agent-gemini` | Google Gemini CLI execution container |
| `propr/agent-opencode` | OpenCode CLI execution container |

Images are also mirrored to `ghcr.io/proprdev/propr-*` (no rate limits for
unauthenticated pulls).

### Building locally

```bash
npm run images:build          # build all images, no push
npm run images:build:push     # build + push to Docker Hub + GHCR (requires login)
npm run images:smoke          # run the smoke test against locally built images
```

The smoke test boots the full stack from the built images with fake
credentials, confirms the API responds to `/health`, and checks no container
crashes on startup. It's the first-line defense for catching broken images
before release.

### Running integration tests against the stack

Full end-to-end tests in `test/e2e.test.ts` hit a running ProPR API with real
GitHub credentials. To run them against a launcher-started stack:

```bash
# 1. Start the prod stack (see Quick install above)

# 2. Point the test harness at it
export PROPR_E2E_API_URL=http://localhost:4000
export PROPR_E2E_REPO=your-test-org/your-test-repo
export PROPR_E2E_TOKEN=$(gh auth token)   # or a GitHub PAT
npm run test:e2e
```

The test suite creates plans, triggers agent runs, and verifies end-to-end
behavior. Expect it to take several minutes and to consume real API credits.
Use `PROPR_E2E_SKIP_SLOW=1` to skip long-running agent invocations during
quick validation.

### Third-party notices

Bundled third-party software attributions are preserved inside each image at
`/usr/share/licenses/propr/`. See `NOTICE` and `THIRD_PARTY_LICENSES.md` in
the repo root for the offline copies. End users must supply their own API
credentials for Anthropic, OpenAI, Google, OpenCode Go, and/or any other
provider configured through OpenCode, and accept those providers' terms of
service independently.

## Docker Compose Setup (development)

For local development, `docker-compose` builds images from source and runs
the stack with hot-reload-friendly volumes. Use this for iterating on code;
use the production images above for real deployments.

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

- **propr**: Main application (daemon and worker)
- **redis**: Redis server for task queue management
- **propr-ui**: Web UI for monitoring and management (port 5173)

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
Add labels to GitHub issues to specify which agent/model(s) should process them:
- `llm-claude-sonnet` - Use Claude Sonnet model
- `llm-claude-opus` - Use Claude Opus model
- `llm-opencode-kimi-k26` - Use the configured OpenCode Kimi K2.6 model
- Multiple labels can be used together for multi-model processing

### Deterministic 3-Phase Processing
1. **Pre-Agent Setup** (Deterministic)
   - Repository cloning/updating with latest changes
   - Isolated git worktree creation with unique model-specific branch names
   - Initial branch push to GitHub (eliminates timing issues)

2. **AI Implementation** (Agent Focus)
   - Implementation-only prompts (no git operations)
   - Complete issue and comment context analysis
   - Code implementation in isolated environment

3. **Post-Agent Finalization** (Deterministic)
   - Automatic commit of any changes the agent made
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

<!-- CI trigger: 2026-05-28 -->

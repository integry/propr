---
sidebar_position: 1
---

# Setup

This guide walks you through setting up ProPR for your GitHub repositories.

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js 18+** - Runtime environment
- **Redis Server** - For task queue management (v6.0+ recommended)
- **Git 2.25+** - For worktree support and modern git operations
- **Docker** - For secure Claude Code execution environment
- **Disk Space** - Sufficient space for repository clones and worktrees (minimum 10GB recommended)

You'll also need:
- **GitHub App** - Created with appropriate permissions (see below)
- **Claude Subscription** - Anthropic Claude account with API access

## 1. GitHub App Configuration

Create a GitHub App with the following permissions:

### Repository Permissions

- **Contents**: Read & Write (for code changes and file operations)
- **Metadata**: Read (for repository information)
- **Issues**: Read & Write (for issue management and comments)
- **Pull Requests**: Read & Write (for PR creation and management)
- **Actions**: Read (optional, for workflow integration)

### Installation Steps

1. Go to your GitHub account/organization settings
2. Navigate to "Developer settings" → "GitHub Apps" → "New GitHub App"
3. Configure the app with the permissions listed above
4. Generate and download the private key (`.pem` file)
5. Install the app on your target repository
6. Note down the **App ID** and **Installation ID**

## 2. Environment Configuration

### Create Environment File

Copy the example environment file:

```bash
cp .env.example .env
```

### Configure GitHub App

Fill in your GitHub App credentials:

```bash
# GitHub App Configuration
GH_APP_ID=your_app_id
GH_PRIVATE_KEY_PATH=./your-app-private-key.pem
GH_INSTALLATION_ID=your_installation_id
```

### Configure Daemon

Set up repository monitoring:

```bash
# Daemon Configuration
GITHUB_REPOS_TO_MONITOR=owner/repo1,owner/repo2
POLLING_INTERVAL_MS=60000
```

### Configure Issue Detection

Define which labels trigger processing:

```bash
# Issue Detection Configuration
PRIMARY_PROCESSING_LABELS=AI,propr

# Model-Specific Configuration
MODEL_LABELS_SONNET=llm-claude-sonnet
MODEL_LABELS_OPUS=llm-claude-opus
```

**Note**: State labels (`-processing`, `-done`, `-failed-*`) are automatically generated based on the primary label that triggered processing.

### Configure Git Operations

Set up git workspace paths:

```bash
# Git Configuration
GIT_CLONES_BASE_PATH=/tmp/git-processor/clones
GIT_WORKTREES_BASE_PATH=/tmp/git-processor/worktrees
GIT_DEFAULT_BRANCH=main
GIT_SHALLOW_CLONE_DEPTH=

# Repository-Specific Branch Configuration (optional)
GIT_DEFAULT_BRANCH_owner_repo=dev
```

### Configure PR Comment Monitoring

```bash
# PR Comment Monitoring Configuration
GITHUB_BOT_USERNAME=your_bot_username
GITHUB_USER_WHITELIST=
GITHUB_USER_BLACKLIST=
```

## 3. Git Environment Setup

Create the required directories with appropriate permissions:

```bash
# Create directories
sudo mkdir -p /tmp/git-processor/{clones,worktrees}
sudo chown -R $(whoami) /tmp/git-processor
chmod 755 /tmp/git-processor

# Verify Git installation
git --version
git worktree --help
```

## 4. Claude Code Setup

### Install Claude Code CLI

Install the Claude Code CLI globally:

```bash
npm install -g @anthropic-ai/claude-code
```

### Authenticate with Claude

Run the authentication command:

```bash
claude login
```

This generates `~/.config/claude-code/auth.json` needed for non-interactive execution.

### Install Docker

The worker uses Docker to run Claude Code in a secure, isolated environment.

#### Ubuntu/Debian

```bash
sudo apt-get update
sudo apt-get install docker.io
sudo usermod -aG docker $USER
```

#### macOS (with Homebrew)

```bash
brew install docker
```

#### Verify Installation

```bash
docker --version
```

### Configure Claude Settings

Add Claude configuration to your `.env` file:

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

## 5. Install Dependencies

Install the Node.js dependencies:

```bash
npm install
```

## 6. Redis Setup

Install and start Redis for task queue management.

### macOS

```bash
brew install redis
brew services start redis
```

### Ubuntu/Debian

```bash
sudo apt-get install redis-server
sudo systemctl start redis
```

### Docker

```bash
docker run -d -p 6379:6379 redis:alpine
```

### Docker Compose

If using Docker Compose, Redis is automatically included - no separate installation needed.

## 7. Security Configuration

Ensure your private key file has restricted permissions:

```bash
chmod 600 your-app-private-key.pem
```

## Next Steps

Once setup is complete, proceed to the [Usage Guide](./usage.md) to learn how to run ProPR.

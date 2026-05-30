---
sidebar_position: 3
---

# Worker Architecture

The worker is the core processing component that executes the deterministic 3-phase workflow for each issue.

## Overview

The worker (`src/worker.ts` in source, compiled under `dist/`) pulls jobs from the Redis queue and processes them through a reliable, deterministic workflow. Each worker operates independently and can process multiple jobs concurrently.

## Three-Phase Workflow

The worker implements a deterministic 3-phase approach that separates concerns and ensures reliability:

```
┌─────────────────────────────────────────────────────┐
│            Phase 1: Pre-Agent Setup                 │
│                  (Deterministic)                     │
│  - Pull job from queue                              │
│  - Clone/update repository                          │
│  - Create isolated worktree                         │
│  - Generate unique branch name                      │
│  - Push initial branch to GitHub                    │
│  - Add processing label                             │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│          Phase 2: AI Implementation                  │
│                (Agent Focus)                         │
│  - Prepare implementation prompt                    │
│  - Include complete issue context                   │
│  - Execute selected agent in Docker                 │
│  - Agent analyzes and implements                    │
│  - Parse agent output                               │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│       Phase 3: Post-Agent Finalization              │
│                  (Deterministic)                     │
│  - Commit any changes                               │
│  - Push to GitHub                                   │
│  - Create pull request                              │
│  - Link PR to issue                                 │
│  - Update labels                                    │
│  - Clean up resources                               │
└─────────────────────────────────────────────────────┘
```

## Phase 1: Pre-Agent Setup

### Objectives

Prepare a clean, isolated environment for the selected coding agent to work in.

### Operations

#### 1. Job Acquisition
```javascript
// Worker pulls next job from Redis queue
const job = await queue.getNextJob();
```

#### 2. Repository Management
- Clone repository if not already present
- Update base branch with latest changes
- Validate repository access

#### 3. Worktree Creation
- Generate unique worktree path
- Create isolated git worktree from base branch
- Switch to worktree directory

#### 4. Branch Creation
```javascript
// Generate unique branch name
const branchName = generateBranchName({
  issueId: job.data.issueNumber,
  title: job.data.issueTitle,
  model: job.data.model,
  timestamp: Date.now()
});
// Example: ai-fix/123-implement-feature-20250529-1506-sonnet-3he
```

#### 5. Initial Push
- Push newly created branch to GitHub
- Establishes branch existence before the agent runs
- Prevents timing issues with PR creation

#### 6. Label Update
- Add `{primary}-processing` label to issue
- Indicates work has started
- Prevents duplicate job creation by daemon

### Why This Phase Matters

By handling all git setup before the agent runs:
- The agent can focus solely on implementation
- Git state is deterministic and predictable
- Branch already exists on GitHub when needed
- Timing issues are eliminated

## Phase 2: AI Implementation

### Objectives

Let the selected coding agent analyze the issue and implement a solution.

### Operations

#### 1. Prompt Preparation

Build a comprehensive prompt that includes:
- Issue number, title, and description
- All issue comments
- Repository context
- Focus on implementation, not git operations

```javascript
const prompt = `
Please analyze and implement a solution for GitHub issue #${issueNumber}.

**ISSUE DETAILS:**
Title: ${issueTitle}
Description: ${issueBody}

**COMMENTS:**
${comments.map(c => `${c.author}: ${c.body}`).join('\n\n')}

**YOUR FOCUS: IMPLEMENTATION ONLY**
The git workflow is handled automatically. Focus on:
1. Understanding the problem
2. Implementing the solution
3. Testing your changes

Do NOT worry about git operations, commits, or PRs.
`;
```

#### 2. Docker Execution

Execute the selected coding agent in a secure Docker container:

```javascript
const result = await agent.executeTask({
  prompt: prompt,
  workspacePath: worktreePath,
  timeout: agentConfig.timeoutMs,
  maxTurns: agentConfig.maxTurns
});
```

#### 3. Agent Processing

The selected agent:
- Reads issue details and comments
- Searches codebase to understand context
- Analyzes the problem
- Implements a solution
- Makes code changes in the worktree

#### 4. Output Parsing

Parse agent output to extract:
- Implementation summary
- Files changed
- Any error messages or warnings

### Security Isolation

Agents run in Docker containers with:
- Isolated filesystem
- Network restrictions
- Resource limits
- Read-only access to sensitive files

## Phase 3: Post-Agent Finalization

### Objectives

Commit agent changes and create a pull request.

### Operations

#### 1. Change Detection
```bash
git status
git diff
```

Check what files the agent modified.

#### 2. Commit Creation

If changes exist:
```bash
git add .
git commit -m "fix(ai): Resolve issue #123 - Feature implementation

Generated with ProPR
Agent: ${agentAlias}"
```

If no changes:
- Log warning
- Continue with empty commit if needed

#### 3. Branch Push
```bash
git push origin branch-name
```

Push all commits to GitHub.

#### 4. Pull Request Creation

Use GitHub API to create PR:
```javascript
const pr = await octokit.rest.pulls.create({
  owner: repoOwner,
  repo: repoName,
  title: `fix(ai): Resolve issue #${issueNumber} - ${issueTitle}`,
  head: branchName,
  base: baseBranch,
  body: `
## Summary
${summary}

Closes #${issueNumber}

Generated with ProPR
  `
});
```

#### 5. Issue Linking

The PR body includes keywords to auto-link:
- `Closes #123` - Links and auto-closes issue when PR merges
- `Addresses #123` - Links without auto-closing

#### 6. Label Management

Update issue labels:
- Remove `{primary}-processing`
- Add `{primary}-done` (on success)
- Add `{primary}-failed-{reason}` (on failure)

#### 7. Resource Cleanup
- Remove worktree
- Clean up temporary files
- Update job status in Redis

## Concurrency and Scaling

### Multiple Workers

Run multiple workers for increased throughput:

```bash
# Terminal 1
npm run worker

# Terminal 2
npm run worker

# Terminal 3
npm run worker
```

Workers coordinate through Redis:
- Each worker pulls jobs independently
- No direct communication between workers
- Atomic job acquisition prevents conflicts

### Model-Specific Processing

Different models can process the same issue simultaneously:
- Separate branches prevent git conflicts
- Worktree isolation ensures independence
- Model identifier in branch name prevents confusion

### Resource Management

Each worker:
- Uses a separate worktree
- Has independent Docker container
- Manages its own job state
- Cleans up after completion

## Error Handling

### Retry Mechanisms

Failed operations are automatically retried:

```javascript
// GitHub API operations
const pr = await retryWithBackoff(
  () => createPullRequest(data),
  { maxRetries: 3, backoff: 'exponential' }
);

// Git operations
const pushed = await retryWithBackoff(
  () => gitPush(branch),
  { maxRetries: 3, backoff: 'exponential' }
);
```

### Failure Scenarios

#### Git Failures
- Repository clone issues
- Worktree creation failures
- Push conflicts

**Recovery**: Retry with clean state, update labels on final failure

#### Agent Failures
- Timeout after max turns
- Docker execution errors
- Invalid responses

**Recovery**: Log error, create failure issue comment, update labels

#### GitHub API Failures
- Rate limit exceeded
- Network errors
- Invalid responses

**Recovery**: Exponential backoff, retry, fail gracefully

### Correlation IDs

Every job has a correlation ID for tracking:

```javascript
logger.info('Starting job', {
  correlationId: job.data.correlationId,
  issueNumber: job.data.issueNumber,
  model: job.data.model
});
```

Use correlation IDs to:
- Trace job across logs
- Debug specific failures
- Link daemon detection to worker processing

## State Management

### Job States

Jobs progress through these states:

```
waiting → active → completed
                 ↘ failed
```

- **waiting**: In queue, not yet started
- **active**: Currently being processed
- **completed**: Successfully finished
- **failed**: Encountered unrecoverable error

### State Persistence

State is tracked in multiple places:

1. **Redis** - Job queue state and metadata
2. **GitHub Labels** - Visual indicator on issue
3. **Logs** - Detailed state transition logs

## Configuration

### Environment Variables

```bash
# Worker configuration
WORKER_CONCURRENCY=5

# Agent configuration
CLAUDE_DOCKER_IMAGE=claude-code-processor:latest
CLAUDE_TIMEOUT_MS=300000
CLAUDE_MAX_TURNS=1000
# OpenCode tasks run longer because the CLI performs multi-step tool-use
# loops internally; 1 hour matches the Codex default.
OPENCODE_TIMEOUT_MS=3600000

# Retry configuration
GITHUB_API_MAX_RETRIES=3
GIT_OPERATION_MAX_RETRIES=3

# Git paths
GIT_CLONES_BASE_PATH=/tmp/git-processor/clones
GIT_WORKTREES_BASE_PATH=/tmp/git-processor/worktrees
```

### Worker Concurrency

Control how many jobs a single worker processes simultaneously:

```bash
WORKER_CONCURRENCY=5
```

- **Lower** (1-3): Conservative, less resource usage
- **Recommended** (5): Good balance
- **Higher** (10+): Aggressive, requires more resources

## Performance Optimization

### Worktree Reuse

Workers can reuse repository clones:
- Clone once, create multiple worktrees
- Faster than full clone for each job
- Shared object storage saves disk space

### Parallel Operations

Workers perform operations in parallel where possible:
- Multiple workers process different jobs
- Git and GitHub API calls use async/await
- Docker containers run independently

### Resource Limits

Set appropriate limits:
- Agent timeout prevents runaway executions
- Max turns prevents infinite loops
- Concurrency limit prevents resource exhaustion

## Monitoring

### Key Metrics

Track these metrics for worker health:

- Jobs processed per minute
- Success/failure rate
- Average processing time
- Queue depth
- Error rates by type

### Logging

Workers log important events:

```javascript
// Job start
logger.info('Job started', { jobId, issueNumber, model });

// Phase transitions
logger.info('Phase 1 complete', { jobId });
logger.info('Phase 2 complete', { jobId });
logger.info('Phase 3 complete', { jobId });

// Completion
logger.info('Job completed', { jobId, duration, filesChanged });
```

## Best Practices

1. **Run multiple workers** for production workloads
2. **Monitor worker logs** for errors and performance
3. **Set appropriate timeouts** based on issue complexity
4. **Use correlation IDs** for debugging
5. **Configure retry limits** based on infrastructure reliability
6. **Clean up worktrees** regularly if workers crash
7. **Health check workers** and restart if needed

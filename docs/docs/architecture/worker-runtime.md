---
sidebar_position: 4
---

# Worker Runtime Reference

This reference covers worker concurrency, retries, state handling, configuration, and monitoring. For the main workflow, see [Worker Architecture](./worker.md).

## Concurrency And Scaling

Each worker process handles up to `WORKER_CONCURRENCY` jobs at once (code default `5`; the shipped `.env.example` sets `2`; a `worker_concurrency` setting is also available). Multiple workers can run as long as the host has enough CPU, memory, disk, and provider capacity.

```bash
# Direct local runs
npm run worker
npm run worker
```

For source-based Compose deployments, scale the worker service:

```bash
docker-compose -f docker-compose.prod.yml up -d --scale worker=3
```

Higher concurrency is not always better. Watch queue depth, model rate limits, repository size, and average task duration before increasing it.

Separate `analysis-worker` and `indexing-worker` services process repository analysis and indexing jobs independently of implementation work.

## Model-Specific Processing

Jobs carry model and agent metadata. Workers use that metadata to:

- Select the configured agent implementation
- Resolve the model ID
- Use the correct Docker image
- Mount the correct credential path
- Include model identifiers in branch and task metadata

This lets two models work on related tasks without sharing the same branch or worktree.

## Failure Handling

Worker failures generally fall into these categories:

- GitHub API failures
- Git clone, fetch, merge, or push failures
- Agent runtime failures
- Timeout or resource exhaustion
- Empty or invalid agent output
- Pull request creation or update failures

Transient git and GitHub operations are retried with exponential backoff. Retry counts and backoff are hard-coded in `retryHandler.ts`; they are not environment-configurable. Agent failures are recorded with logs and task state so you can inspect the run, retry it, or switch models.

## Job States

Task state is persisted so the Web UI can show progress and outcomes (`packages/core/src/utils/workerStateManager.types.ts`):

- `pending`
- `processing`
- `claude_execution`
- `post_processing`
- `completed`
- `failed`
- `cancelled`

`claude_execution` covers the agent-implementation phase for every agent type, not only Claude Code. State records include enough metadata to connect the original trigger, selected agent, output, commits, and PR.

## Configuration

Common worker settings:

```bash
# Worker configuration
WORKER_CONCURRENCY=2

# Agent runtime timeouts
CLAUDE_TIMEOUT_MS=300000
CODEX_TIMEOUT_MS=3600000
ANTIGRAVITY_TIMEOUT_MS=300000
OPENCODE_TIMEOUT_MS=3600000
VIBE_TIMEOUT_MS=3600000

# Git paths (defaults shown; override for image-based installs)
GIT_CLONES_BASE_PATH=/tmp/git-processor/clones
GIT_WORKTREES_BASE_PATH=/tmp/git-processor/worktrees
```

Adjust agent defaults and routing in the Web UI. Environment variables are mainly for install-time paths, secrets, and service wiring. Retry behavior is hard-coded and has no environment variables.

Use `ANTIGRAVITY_TIMEOUT_MS` for Antigravity runs and configure Antigravity model labels such as `llm-antigravity-pro-high`, `llm-antigravity-flash-medium`, and `llm-antigravity-opus46-thinking` in AI Agents.

## Monitoring

Important worker signals:

- Queue depth
- Task duration
- Agent runtime duration
- Success and failure rates
- Retry counts
- Cost and usage by model
- Disk usage for clones and worktrees

Worker logs include correlation IDs so related GitHub, git, and agent events can be traced together.

## Best Practices

1. Start with conservative concurrency.
2. Keep agent credentials mounted read/write only where required.
3. Monitor disk usage for clones and worktrees.
4. Use model-specific labels for comparative runs.
5. Prefer PR follow-up comments for direct human instructions.
6. Use `/review` and `/fix` for AI review feedback loops.

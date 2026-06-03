---
sidebar_position: 4
---

# Worker Runtime Reference

This reference covers worker concurrency, retries, state handling, configuration, and monitoring. For the main workflow, see [Worker Architecture](./worker.md).

## Concurrency And Scaling

Multiple workers can process jobs at the same time as long as the host has enough CPU, memory, disk, and provider capacity.

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

Transient git and GitHub operations use retry behavior. Agent failures are recorded with logs and task state so you can inspect the run, retry it, or switch models.

## Job States

Task state is persisted so the Web UI can show progress and outcomes:

- `queued`
- `processing`
- `agent_running`
- `finalizing`
- `completed`
- `failed`
- `cancelled`

State records should include enough metadata to connect the original trigger, selected agent, output, commits, and PR.

## Configuration

Common worker settings:

```bash
# Worker configuration
WORKER_CONCURRENCY=5

# Agent runtime configuration
CLAUDE_TIMEOUT_MS=300000
CODEX_TIMEOUT_MS=3600000
GEMINI_TIMEOUT_MS=300000

# Retry configuration
GITHUB_API_MAX_RETRIES=3
GIT_OPERATION_MAX_RETRIES=3

# Git paths
GIT_CLONES_BASE_PATH=/app/repos/clones
GIT_WORKTREES_BASE_PATH=/app/repos/worktrees
```

Adjust agent defaults and routing in the Web UI. Environment variables are mainly for install-time paths, secrets, and service wiring.

## Monitoring

Important worker signals:

- Queue depth
- Task duration
- Agent runtime duration
- Success and failure rates
- Retry counts
- Cost and usage by model
- Disk usage for clones and worktrees

Worker logs should include correlation IDs so related GitHub, git, and agent events can be traced together.

## Best Practices

1. Start with conservative concurrency.
2. Keep agent credentials mounted read/write only where required.
3. Monitor disk usage for clones and worktrees.
4. Use model-specific labels for comparative runs.
5. Prefer PR follow-up comments for direct human instructions.
6. Use `/review` and `/fix` for AI review feedback loops.

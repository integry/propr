---
sidebar_position: 3
---

# Daemon Runtime Reference

This reference covers daemon configuration, reset mode, performance, monitoring, and common failures. For the intake model, see [Daemon Architecture](./daemon.md).

## Configuration

Common settings:

```bash
# Repository monitoring
GITHUB_REPOS_TO_MONITOR=owner/repo1,owner/repo2
POLLING_INTERVAL_MS=60000

# Label configuration
PRIMARY_PROCESSING_LABELS=AI,propr

# GitHub authentication
GH_APP_ID=your_app_id
GH_PRIVATE_KEY_PATH=/app/config/app.pem
GH_INSTALLATION_ID=your_installation_id

# Redis connection
REDIS_HOST=redis
REDIS_PORT=6379
```

Repository, label, branch, and agent settings should normally be managed in the Web UI after install.

## Commands

Source or direct local runs can start the daemon with npm scripts:

```bash
npm run daemon
npm run daemon:dev
npm run daemon:reset:dev
```

Image-based installs start the daemon container through the launcher.

## Reset Mode

Reset mode is a development and recovery tool. It can clear queue state and remove processing labels so stuck work can be retried.

Use reset mode carefully in shared environments because it can affect active work. Prefer targeted recovery from the Web UI when available.

## Multi-Model Jobs

When an issue has multiple model labels, the daemon creates separate jobs. For example:

```text
llm-claude-sonnet46
llm-codex-gpt54
llm-antigravity-gemini-pro
llm-antigravity-opus
```

Each model gets its own branch, task record, and pull request.

## Error Handling

Common daemon failures:

- GitHub API rate limits
- GitHub App permission errors
- Redis connection failures
- Invalid repository configuration
- Invalid or unavailable model labels

The daemon should log enough context to identify the repository, issue or PR, trigger label, and correlation ID.

## Performance

Important tuning knobs:

- Polling interval
- Number of monitored repositories
- GitHub API rate limits
- Queue depth
- Worker capacity

Shorter polling intervals increase responsiveness but use more GitHub API capacity. Webhook-driven flows can reduce polling pressure where configured.

## Monitoring

Watch:

- Intake rate
- Queue depth
- Duplicate-skip count
- GitHub API failures
- Redis connection failures
- Time from eligible issue to queued job

These signals help separate intake problems from worker execution problems.

## Best Practices

1. Keep repository configuration in the Web UI where possible.
2. Use clear primary labels for human-triggered automation.
3. Keep model labels aligned with configured AI Agents.
4. Avoid aggressive polling unless the GitHub API budget supports it.
5. Treat reset mode as a deliberate recovery action.

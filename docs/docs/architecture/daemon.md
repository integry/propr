---
sidebar_position: 2
---

# Daemon Architecture

The daemon detects eligible issues and pull request events, then enqueues jobs for workers. It is responsible for intake, filtering, deduplication, and queue handoff. Workers perform the actual repository setup, agent execution, and pull request finalization.

Runtime settings, reset mode, monitoring, and error handling live in the [Runtime Reference](#runtime-reference) at the end of this page.

## Core Responsibilities

The daemon handles:

- Monitoring configured repositories
- Detecting eligible issues or events
- Resolving processing labels and model labels
- Avoiding duplicate work
- Creating queue jobs
- Recording intake state

It should stay lightweight. The daemon decides what should be processed; workers decide how to process it.

## Intake Flow

<div className="propr-flow" aria-label="Daemon intake algorithm">
  <div className="propr-flow__stack">
    <div className="propr-flow__node"><span className="propr-flow__title">Poll or receive repository signal</span></div>
    <div className="propr-flow__connector">↓</div>
    <div className="propr-flow__node"><span className="propr-flow__title">Find eligible issues or PR events</span></div>
    <div className="propr-flow__connector">↓</div>
    <div className="propr-flow__node"><span className="propr-flow__title">Resolve labels, repository config, and models</span></div>
    <div className="propr-flow__connector">↓</div>
    <div className="propr-flow__node"><span className="propr-flow__title">Skip work already processing or completed</span></div>
    <div className="propr-flow__connector">↓</div>
    <div className="propr-flow__node"><span className="propr-flow__title">Create queue jobs</span></div>
    <div className="propr-flow__connector">↓</div>
    <div className="propr-flow__node"><span className="propr-flow__title">Workers pick up jobs</span></div>
  </div>
</div>

## Intake Modes

The daemon supports three intake modes, selected by `GITHUB_EVENT_INTAKE_MODE`, and runs in exactly one of them — they are mutually exclusive:

- **Routing WebSocket** (`routing_websocket`, default): the daemon opens an outbound WebSocket to the hosted ProPR App's routing service and receives events as they happen. No inbound endpoint, no GitHub App of your own, and no webhook secret are required, and latency is near-immediate.
- **Polling** (`polling`): the daemon queries the GitHub API on an interval (`POLLING_INTERVAL_MS`, default `60000`) for open issues with processing labels and for PR events.
- **Direct webhook** (`direct_webhook`): GitHub delivers events to your own App's public `POST /webhook` endpoint on the dashboard API service (port 4000), verified against `GH_WEBHOOK_SECRET`, and forwarded into the same intake path. This removes polling pressure and latency, but there is no polling backstop — missed deliveries rely on GitHub's webhook redelivery.

The intake mode is independent of how the backend authenticates to GitHub (`GH_AUTH_MODE`); see [GitHub Authentication](../operations/github-auth.md). `GH_WEBHOOK_SECRET` is required only for `direct_webhook` and is not used by `routing_websocket` or `polling`.

> **Migration:** the legacy boolean `ENABLE_GITHUB_WEBHOOKS` is **deprecated** and no longer selects an intake mode. If it is still set, the daemon logs a deprecation warning at startup and ignores it. Use `GITHUB_EVENT_INTAKE_MODE` (`routing_websocket`, `polling`, or `direct_webhook`) instead; leaving it unset resolves to `routing_websocket`.

Each intake event receives a correlation ID so the resulting queue job, worker logs, and task record can be traced back to the original GitHub event.

## Repository Monitoring

The daemon monitors repositories configured through deployment defaults and the Web UI. The Web UI is the source of truth for normal repository management.

The daemon checks:

- Open issues with primary processing labels
- PR comments that should trigger follow-up work
- State labels that show whether work is already running or complete
- Model labels that request a specific agent/model pair

## Label Detection

Primary labels decide whether an issue should be processed. Examples include:

```text
AI
propr
```

State labels are derived from the trigger label and are environment-overridable. With the default `AI` trigger:

```text
AI-processing
AI-waiting
AI-done
AI-failed-*   # e.g. AI-failed-post-processing, set when a phase fails
```

Model labels route work to configured models. They are matched against `MODEL_LABEL_PATTERN` (default `^llm-(.+)$`):

```text
llm-claude-opus48
llm-codex-gpt56-sol
llm-antigravity-pro-high
llm-antigravity-opus46-thinking
```

If an issue carries a trigger label but no model label, the daemon falls back to the deployment default model (`DEFAULT_MODEL_NAME`). The exact model labels available in a deployment come from AI Agents in the Web UI.

Reasoning level labels override the global `model_reasoning_level` setting for one issue. They match `level-low`, `level-medium`, `level-high`, `level-xhigh`, `level-max`, `level-ultra`, `level-ultracode`, or `level-auto`, case-insensitively. If multiple valid reasoning labels are present on the same item, ProPR chooses the highest-priority level in this order: `ultracode`, `ultra`, `max`, `xhigh`, `high`, `medium`, `low`, `auto`; additional valid reasoning labels are logged as a warning. For PR follow-ups, a reasoning label directly on the PR takes precedence over any reasoning label on its linked issue. Reasoning labels do not expand the job matrix, so an issue with multiple `base-*` or `llm-*` labels still creates the same number of jobs, with the selected reasoning level stamped onto each child job.

## Job Creation

When the daemon finds eligible work, it creates BullMQ jobs in Redis containing:

- Repository owner/name
- Issue or PR number
- Trigger type
- Base branch context
- Selected model or model label
- Optional per-issue reasoning level override
- Correlation metadata for logs and task records

For multi-model issue processing, the daemon creates one job per model label so each result can be tracked independently. Each job gets a deterministic ID:

```text
issue-<owner>-<repo>-<number>-<agent>-<model>
```

## Deduplication

Deterministic job IDs are the primary deduplication mechanism: enqueueing the same issue/agent/model combination again is a no-op while the original job exists. The daemon also checks state labels and task state before enqueueing, which prevents repeated processing when polling sees the same issue across multiple cycles, or when a webhook event arrives for an issue that is already being processed.

## Relationship To Workers

The daemon is an intake service. Workers are execution services. Keeping those roles separate makes it easier to scale worker capacity without changing GitHub polling behavior.

## Runtime Reference

### Configuration

Common settings:

```bash
# Repository monitoring
GITHUB_REPOS_TO_MONITOR=owner/repo1,owner/repo2
POLLING_INTERVAL_MS=60000

# Label configuration
PRIMARY_PROCESSING_LABELS=AI,propr
MODEL_LABEL_PATTERN=^llm-(.+)$
DEFAULT_MODEL_NAME=<model-id-used-when-no-llm-label-is-present>

# Event intake mode: routing_websocket (default), polling, or direct_webhook.
# GH_WEBHOOK_SECRET applies only to direct_webhook (your own GitHub App).
GITHUB_EVENT_INTAKE_MODE=routing_websocket
# GH_WEBHOOK_SECRET=your-webhook-secret

# GitHub authentication
GH_APP_ID=your_app_id
GH_PRIVATE_KEY_PATH=/app/config/app.pem
GH_INSTALLATION_ID=your_installation_id

# Redis connection
REDIS_HOST=redis
REDIS_PORT=6379
```

Repository, label, branch, and agent settings should normally be managed in the Web UI after install.

### Commands

Source or direct local runs can start the daemon with npm scripts:

```bash
npm run daemon
npm run daemon:dev
npm run daemon:reset
npm run daemon:reset:dev
```

Image-based installs start the daemon container through the launcher.

### Reset Mode

Reset mode (`npm run daemon:reset`, or `daemon:reset:dev` with debug logging) is a development and recovery tool. It can clear queue state and remove processing labels so stuck work can be retried.

Use reset mode carefully in shared environments because it can affect active work. Prefer targeted recovery from the Web UI when available.

### Error Handling

Common daemon failures:

- GitHub API rate limits
- GitHub App permission errors
- Webhook signature verification failures (`GH_WEBHOOK_SECRET` mismatch)
- Redis connection failures
- Invalid repository configuration
- Invalid or unavailable model labels

The daemon should log enough context to identify the repository, issue or PR, trigger label, and correlation ID.

### Performance

Important tuning knobs:

- Event intake mode (see [Intake Modes](#intake-modes))
- Polling interval (`polling` mode)
- Number of monitored repositories
- GitHub API rate limits
- Queue depth
- Worker capacity

Shorter polling intervals increase responsiveness but use more GitHub API capacity. Event-driven intake (`routing_websocket` by default, or `direct_webhook`) avoids polling pressure entirely by receiving events as they happen.

### Monitoring

Watch:

- Intake rate
- Queue depth
- Duplicate-skip count
- GitHub API failures
- Redis connection failures
- Time from eligible issue to queued job

These signals help separate intake problems from worker execution problems.

### Best Practices

1. Keep repository configuration in the Web UI where possible.
2. Use clear primary labels for human-triggered automation.
3. Keep model labels aligned with configured AI Agents.
4. Prefer event-driven intake for low-latency processing. Reserve `polling` for environments that cannot receive events, and avoid aggressive polling intervals unless the GitHub API budget supports it.
5. Treat reset mode as a deliberate recovery action.

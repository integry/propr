---
sidebar_position: 2
---

# Daemon Architecture

The daemon detects eligible issues and pull request events, then enqueues jobs for workers. It is responsible for intake, filtering, deduplication, and queue handoff. Workers perform the actual repository setup, agent execution, and pull request finalization.

Runtime settings, reset mode, monitoring, and error handling live in [Daemon Runtime Reference](./daemon-runtime.md).

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

The daemon supports two intake modes:

- **Polling** (default): the daemon queries the GitHub API on an interval (`POLLING_INTERVAL_MS`, default `60000`) for open issues with processing labels and for PR events.
- **Webhooks**: when `ENABLE_GITHUB_WEBHOOKS=true`, webhook events are received by the dashboard API service (port 4000), verified against `GH_WEBHOOK_SECRET`, and forwarded into the same intake path. Webhooks reduce polling pressure and latency; polling still acts as a safety net for missed events.

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
llm-claude-sonnet46
llm-codex-gpt55
llm-antigravity-pro-high
llm-antigravity-opus46-thinking
```

If an issue carries a trigger label but no model label, the daemon falls back to the deployment default model (`DEFAULT_MODEL_NAME`). The exact model labels available in a deployment come from AI Agents in the Web UI.

## Job Creation

When the daemon finds eligible work, it creates BullMQ jobs in Redis containing:

- Repository owner/name
- Issue or PR number
- Trigger type
- Base branch context
- Selected model or model label
- Correlation metadata for logs and task records

For multi-model issue processing, the daemon creates one job per model label so each result can be tracked independently. Each job gets a deterministic ID:

```text
issue-<owner>-<repo>-<number>-<agent>-<model>
```

## Deduplication

Deterministic job IDs are the primary deduplication mechanism: enqueueing the same issue/agent/model combination again is a no-op while the original job exists. The daemon also checks state labels and task state before enqueueing, which prevents repeated processing when polling sees the same issue multiple times or when polling and webhooks both report the same event.

## Relationship To Workers

The daemon is an intake service. Workers are execution services. Keeping those roles separate makes it easier to scale worker capacity without changing GitHub polling behavior.

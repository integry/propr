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

State labels are derived from the trigger label, such as:

```text
AI-processing
AI-done
AI-failed
```

Model labels route work to configured models:

```text
llm-claude-sonnet46
llm-codex-gpt54
llm-gemini-pro
```

The exact model labels available in a deployment come from AI Agents in the Web UI.

## Job Creation

When the daemon finds eligible work, it creates queue jobs containing:

- Repository owner/name
- Issue or PR number
- Trigger type
- Base branch context
- Selected model or model label
- Correlation metadata for logs and task records

For multi-model issue processing, the daemon creates one job per selected model so each result can be tracked independently.

## Deduplication

The daemon avoids duplicate work by checking labels, task state, and queue state before enqueueing. This prevents repeated processing when polling sees the same issue multiple times.

## Relationship To Workers

The daemon is an intake service. Workers are execution services. Keeping those roles separate makes it easier to scale worker capacity without changing GitHub polling behavior.

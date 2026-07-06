---
sidebar_position: 1
---

# Architecture Overview

This page gives you a map of how ProPR works. It avoids low-level internals; use the linked reference pages when you need implementation detail.

## The Short Version

ProPR has four main parts:

- **Web UI** for configuration, planning, task records, logs, and control.
- **Daemon** for detecting eligible issues and pull request events.
- **Queue** (Redis + BullMQ) for holding work until a worker can run it.
- **Workers** for preparing repositories, running coding agents, and creating pull requests.

<div className="propr-flow" aria-label="High-level ProPR architecture">
  <div className="propr-flow__row">
    <div className="propr-flow__node"><span className="propr-flow__title">GitHub</span><span className="propr-flow__detail">Issues, PRs, comments</span></div>
    <div className="propr-flow__arrow">→</div>
    <div className="propr-flow__node"><span className="propr-flow__title">ProPR</span><span className="propr-flow__detail">Plans, routes, queues, records</span></div>
    <div className="propr-flow__arrow">→</div>
    <div className="propr-flow__node"><span className="propr-flow__title">Coding Agent</span><span className="propr-flow__detail">Implements in isolation</span></div>
    <div className="propr-flow__arrow">→</div>
    <div className="propr-flow__node"><span className="propr-flow__title">Pull Request</span><span className="propr-flow__detail">Review and follow up</span></div>
  </div>
</div>

## What Happens During A Run

1. A plan, issue label, or PR comment triggers work. Intake runs in one of three modes selected by `GITHUB_EVENT_INTAKE_MODE` — routing WebSocket (the default when unset), polling, or direct webhook.
2. ProPR creates a task record.
3. A worker prepares an isolated branch and worktree.
4. The selected agent runs in a dedicated Docker container.
5. ProPR commits changes, pushes the branch, and opens or updates a PR.
6. Logs, model choice, commits, cost, and outcome remain visible in the Web UI.

## Agent Runtimes

Every supported agent follows the same runtime pattern: a Docker image with ProPR's common tooling, an entrypoint script, and a host credential directory mounted into the container. Most images build on the shared `propr/agent-base` image; Antigravity uses Debian slim for CLI compatibility.

The [Agent Runtime Reference](./agent-runtime.md) holds the canonical table of images, Dockerfiles, entrypoints, and credential mounts, plus runtime-specific notes for Claude Code, Codex, Antigravity, OpenCode, and Mistral Vibe.

## Important Boundaries

- Agents edit files; ProPR handles git and GitHub finalization.
- Each task gets its own worktree and branch context.
- Agent and model choice is a routing decision within the same workflow.
- The Web UI is the normal place for repository, branch, agent, and task visibility.

## Where To Go Next

- [Daemon Architecture](./daemon.md): how work is detected.
- [Worker Architecture](./worker.md): how jobs execute.
- [Agents and Models](../features/agents-and-models.md): how models are selected.
- [Isolated And Safe Execution](../features/execution-safety.md): why runs stay separated.
- [Observability And Control](../features/observability.md): how to inspect what happened.

---
sidebar_position: 1
---

# Architecture Overview

This page gives you a map of how ProPR works. It avoids low-level internals; use the linked reference pages when you need implementation detail.

## The Short Version

ProPR has four main parts:

- **Web UI** for configuration, planning, task records, logs, and control.
- **Daemon** for detecting eligible issues and pull request events.
- **Queue** for holding work until a worker can run it.
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

1. A plan, issue label, or PR comment triggers work.
2. ProPR creates a task record.
3. A worker prepares an isolated branch and worktree.
4. The selected agent runs in a controlled container.
5. ProPR commits changes, pushes the branch, and opens or updates a PR.
6. Logs, model choice, commits, cost, and outcome remain visible in the Web UI.

## Important Boundaries

- Agents edit files; ProPR handles git and GitHub finalization.
- Each task gets its own worktree and branch context.
- Agent and model choice is a routing decision, not a separate workflow.
- The Web UI is the normal place for repository, branch, agent, and task visibility.

## Where To Go Next

- [Daemon Architecture](./daemon.md): how work is detected.
- [Worker Architecture](./worker.md): how jobs execute.
- [Agent Routing](../features/agent-routing.md): how models are selected.
- [Isolated And Safe Execution](../features/execution-safety.md): why runs stay separated.
- [Observability And Control](../features/observability.md): how to inspect what happened.

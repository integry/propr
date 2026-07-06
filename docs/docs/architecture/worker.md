---
sidebar_position: 3
---

# Worker Architecture

Workers execute ProPR jobs. They turn queued issue, plan, or PR follow-up work into isolated agent runs and then finalize the resulting GitHub changes.

This page explains the worker's core workflow. Runtime tuning, error handling, and monitoring details live in [Worker Runtime Reference](./worker-runtime.md).

## Three-Phase Workflow

<div className="propr-flow" aria-label="Worker processing phases">
  <div className="propr-flow__row">
    <div className="propr-flow__node">
      <span className="propr-flow__title">Pre-Agent Setup</span>
      <span className="propr-flow__detail">Prepare repository state, branch, context, labels, and task tracking</span>
    </div>
    <div className="propr-flow__arrow">→</div>
    <div className="propr-flow__node">
      <span className="propr-flow__title">Agent Implementation</span>
      <span className="propr-flow__detail">Run the selected agent inside an isolated workspace</span>
    </div>
    <div className="propr-flow__arrow">→</div>
    <div className="propr-flow__node">
      <span className="propr-flow__title">Post-Agent Finalization</span>
      <span className="propr-flow__detail">Commit changes, push to GitHub, create PR, update labels, clean up resources</span>
    </div>
  </div>
</div>

The split is deliberate: ProPR keeps deterministic git and GitHub operations outside the agent's responsibilities.

## Phase 1: Pre-Agent Setup

The worker prepares a clean execution environment before the agent runs:

- Pulls the job from the Redis-backed BullMQ queue
- Loads issue, pull request, or plan context
- Updates the target repository
- Creates an isolated worktree
- Creates or selects the task branch
- Pushes the initial branch when needed
- Adds processing state to GitHub and the task record

This phase prevents timing problems around branch creation and keeps the agent focused on implementation rather than repository plumbing.

## Phase 2: Agent Implementation

The worker builds an implementation prompt and starts the selected agent in the prepared workspace.

The prompt usually includes:

- The original request
- Relevant issue or PR comments
- Repository and branch context
- Explicit implementation constraints
- Instructions to focus on file changes rather than git operations

During execution, the worker captures output and state transitions so the run remains visible in the Web UI.

## Phase 3: Post-Agent Finalization

After the agent exits, the worker inspects the workspace and finalizes the GitHub result:

- Checks which files changed
- Creates a commit if there are changes
- Pushes the task branch
- Creates or updates a pull request
- Links back to the source issue or task
- Posts status comments where appropriate
- Updates labels and task state

If the agent made no changes, the worker records that result instead of creating an empty commit.

## Job Types

The worker registers BullMQ processors for several job names:

- `processGitHubIssue` — labeled GitHub issues and Planner Studio implementation tasks
- `processPullRequestComment` — PR follow-up comments and AI review/fix commands
- `processTaskImport` — task imports
- `processSystemTask` — signed system tasks such as reverts and recovery actions
- `processMergeConflict` — merge and conflict-resolution commands

Separate `analysis-worker` and `indexing-worker` services handle repository analysis and indexing jobs so heavy implementation work does not block them.

The same worker structure applies across job types: prepare, run, finalize, record.

## Agent Runtimes

Workers run whichever agent the job's routing metadata selects. All agents share the same containerized runtime pattern: a Docker image with ProPR's common tooling, an entrypoint script, and a host credential mount. The [Agent Runtime Reference](./agent-runtime.md) holds the canonical table of images, Dockerfiles, entrypoints, and credential mounts, plus agent-specific runtime detail; see [Coding Agent Integration](./coding-agent-integration.md) for the shared contract.

## Isolation Model

Each job gets its own worktree, branch context, and agent container. That isolation lets ProPR run multiple jobs concurrently, including jobs that use different agents or models, without sharing the same mutable checkout.

See [Git Management](./git-management.md) for worktree and branch details.

## State And Observability

Workers update task state throughout the run so you can see:

- What is queued
- What is running
- Which agent and model are in use
- Where a failure occurred
- Which commit or PR resulted from the task

See [Observability And Control](../features/observability.md) for the product-facing view and [Worker Runtime Reference](./worker-runtime.md) for operational details.

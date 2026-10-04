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

- `processGitHubIssue` — labeled GitHub issues and Planner Studio implementation tasks (a parent job fans out one child job per base branch × model)
- `processPullRequestComment` — PR follow-up comments and AI review/fix commands
- `processTaskImport` — task imports
- `processSystemTask` — signed system tasks such as reverts and recovery actions
- `processMergeConflict` — merge and conflict-resolution commands
- `processGoal` — long-running [goal](../features/goals.md) sessions

The separate `indexing-worker` service handles repository indexing jobs so heavy implementation work does not block them.

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

### Cancellation and terminal reasons

Closing an issue or removing a configured processing trigger (for example `AI`)
cancels its queued implementation jobs and stops running implementations through
the same path as `propr task stop` and the Web UI. Removing a model label such as
`llm-codex-astra` does not cancel work. An already-opened PR stays open and retains
its independent follow-up work.

Webhook intake handles withdrawal immediately. In polling mode, each poll checks
queued and running resources directly, including issues that disappeared from the
open/labeled discovery query. Before dispatch or execution, workers fetch current
GitHub state again; saved queue snapshots cannot authorize work on a closed issue
or an issue missing its processing trigger. GitHub read failures prevent startup
and are retried rather than treated as cancellation.

Cancelled issue work loses its `<trigger>-processing` and `<trigger>-waiting`
labels (and any stale `<trigger>-done` label) and gains `<trigger>-cancelled`. A `<trigger>-done` label stays, and no
cancelled label is added, when a sibling attempt for that trigger already opened a PR. To request new work, restore the issue's
open state and reapply the trigger label; reopening alone, or applying any other label, restarts nothing in
either intake mode. Reapplying a trigger clears its stale
processing and cancelled labels, including after failed withdrawal cleanup.
Withdrawal and user cancellations are terminal and never automatically retried.
Usage-limit retries retain the original task and correlation ID; queue handoffs
recorded as requeued or rescheduled do not prevent resuming that task.
Issue closure does not cancel a task that already has a PR result or whose own
PR closed the issue.

Task state and persisted history carry `terminalReason`, also shown in the task
timeline, Inbox, and MCP `get_task`:

| Reason | Meaning |
| --- | --- |
| `timed_out` | Execution reached the overall timeout (partial work may have been saved). |
| `cancelled_issue_closed` | The source issue was closed. |
| `cancelled_label_removed` | A processing trigger was removed. |
| `cancelled_pr_closed` | The target PR was closed without merging. |
| `cancelled_by_user` | An operator stopped the task. |

Cancellation reasons remain stable if the worker later reports its container's
exit. Timeout failures remain distinct from cancellations and use the existing
failure retry policy. No inactivity timeout is introduced.

See [Observability And Control](../features/observability.md) for the product-facing view and [Worker Runtime Reference](./worker-runtime.md) for operational details.

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
| `stalled` | The activity watchdog stopped an agent that produced no output past its stall threshold (partial work may have been saved). |
| `degenerate_output` | The activity watchdog stopped an agent that emitted only whitespace text (partial work may have been saved). |
| `cancelled_issue_closed` | The source issue was closed. |
| `cancelled_label_removed` | A processing trigger was removed. |
| `cancelled_pr_closed` | The target PR was closed without merging. |
| `cancelled_by_user` | An operator stopped the task. |

Cancellation reasons remain stable if the worker later reports its container's
exit. Timeout failures remain distinct from cancellations and use the existing
failure retry policy.

### Stall and degenerate-output watchdog

The per-agent timeout (`*_TIMEOUT_MS`, 24 hours by default) is the outer
backstop. Inside it, an activity watchdog watches every live implementation
run — Claude, Codex, Antigravity, OpenCode and Vibe alike — at the point where
the Docker executor publishes the run's live output, not inside any one
agent's parser:

- **Inactivity.** Any output counts as activity: a stdout record or partial
  record, a stderr log line, or a changed transcript snapshot (Vibe). With no
  activity for `AGENT_STALL_TIMEOUT_MS` (10 minutes by default) the run stops.
- **Silent tool calls.** When a provider reports that a tool call started
  (Claude `tool_use`, Codex `item.started`/`*_begin`, OpenCode running tool
  parts, Antigravity `tool_use`) without streaming its output, the longer
  `AGENT_TOOL_STALL_TIMEOUT_MS` (30 minutes) applies from the tool start until
  the tool ends or the model speaks again. A tool that keeps printing never
  trips the watchdog; only true silence counts.
- **Degenerate output.** `AGENT_DEGENERATE_OUTPUT_LIMIT` (50) consecutive
  whitespace-only text deltas stop the run. Empty deltas are normal and never
  count; any real text resets the count.

`0` disables a rule. The thresholds are instance settings (Settings →
Automation → Agent watchdog, `propr setting update agent_stall_timeout_ms …`)
read at the start of every run, so a change applies to the next run without a
restart; the environment variables are their defaults.

A tripped watchdog stops the container through the same subprocess-scoped path
as the execution deadline, so the run ends like a timed-out run: partial work
is committed and published, the completion comment on the issue or PR explains
the stop, and the task finishes with `terminalReason` `stalled` or
`degenerate_output`, which the Inbox notification shows. The trip itself is
recorded as a task timeline entry (rule, threshold, seconds silent or
whitespace delta count) and counted per rule in `GET /api/llm-metrics`
(`watchdogTrips`).

The repository capacity lease covers only the container's execution, so it is
released as soon as the stopped container exits. A watchdog-stopped task is
terminal: the task-state reconciler replays its terminal state and reason
rather than treating it as orphaned. Tasks parked for a provider usage limit
(the AI-waiting label) have no running container and are never watched.

### Reconciliation and automatic replacement runs

Every worker runs a periodic task-state reconciler under one shared Redis lease
(`TASK_STATE_RECONCILIATION_*` in the
[Configuration Reference](../operations/configuration-reference.md#workers--queue)).
It compares unfinished tasks in SQLite with their BullMQ job and task
container. A task whose job and container have both disappeared (worker
restart, host reboot, killed container), observed at least twice across the
orphan grace window (60 s by default), is **orphaned**: it is marked failed
with "Task was orphaned after worker restart…".

ProPR then dispatches **replacement runs** instead of leaving that work lost:

- **Infrastructure lost.** An orphaned issue task gets exactly one replacement
  attempt for the same issue. It reuses the original agent, model and per-task
  overrides (base branch, reasoning level, trigger label, cost cap) and
  continues the original's work branch when that branch was pushed; otherwise it
  starts from a fresh worktree. A second orphaning in the same lineage is final.
  Set `INFRA_LOST_REPLACEMENT=false` to disable it.
- **Transient provider errors.** When an issue run ends with a provider error
  that `withRetry` treats as retryable (5xx, overloaded, connection resets,
  timeouts) after the agent's own in-run retries, a replacement attempt is
  dispatched, up to `MAX_PROVIDER_REPLACEMENTS` per lineage (default 2; the
  instance setting **Provider failure replacements** overrides the
  environment; `0` disables it). 429 and usage-limit errors are excluded: they
  already re-queue the same task until the limit resets. Credential errors and
  run timeouts are excluded as well.

Attempts are linked durably: the replaced task records `replaced_by_task_id`,
the replacement records `replaces_task_id`, `attempt_number` and its lineage
root. Claiming `replaced_by_task_id` is atomic, so each attempt is replaced at
most once, and caps are counted from these stamps, so they survive daemon and
worker restarts. A replacement goes through the same repository capacity
admission as any task and never bypasses `limits.max_parallel_tasks`. When a
per-run cost cap is set on the task (`costCapUsd`), the replacement's cap is
the original cap minus what earlier attempts spent.

No replacement is dispatched for user or withdrawal cancellations
(`cancelled_*`), tasks stopped by the stall watchdog, run timeout or cost cap,
goal tasks (see goal recovery), issues closed in the meantime, or PR follow-up
tasks (only issue tasks are replayable today).

Each decision is written to the task timeline without changing its state:
`replacement.dispatched`, `replacement.skipped` (with its reason:
`cap_reached`, `user_cancelled`, `issue_closed`, `watchdog_stop`,
`cost_cap_stop`, `budget_exhausted`, `disabled`, …) and
`replacement.exhausted` when the cap or budget ends a lineage. The Inbox holds
back the failure alert of a replaced attempt and shows one "Replacement
started" card instead. The GitHub failure comment on the final failure lists
every attempt with a link to each task. A decision interrupted by a restart
(the failure was recorded, the replacement not yet queued) is completed by the
reconciler on a later pass.

Task detail shows the attempt lineage, and `propr task get --json` includes
`replacesTaskId`, `replacedByTaskId` and `attemptNumber`.

See [Observability And Control](../features/observability.md) for the product-facing view and [Worker Runtime Reference](./worker-runtime.md) for operational details.

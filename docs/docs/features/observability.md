---
sidebar_position: 7
---

# Observability And Control

Every agent run leaves a record that connects the request, selected agent, logs, commits, costs, outcome, and recovery state. This page covers the signals a run produces and what to look for in them. For the anatomy of each Web UI screen, see the [Web UI Guide](./web-ui.md); for where every number comes from and how to read them over time, see [Metrics](../operations/metrics.md).

## What A Run Leaves Behind

Four kinds of evidence exist after every run:

- **The task record.** Opened from the Tasks page, it answers: what triggered this run, which repository, branch, agent, and model were used, what state the task is in, which commits or pull request came out of it, and where a failure occurred. The [Web UI Guide](./web-ui.md#tasks) walks through the task detail view.
- **The prompt and logs.** Each task keeps the exact prompt sent to the agent, its execution log files, and a live event log (plus a thinking log where the agent emits one). Job state is held in Redis with correlation IDs, so log lines across daemon, worker, and agent containers can be traced back to one task.
- **The completion comment.** When a command or follow-up task finishes, ProPR posts a summary comment on the PR with the commit hash and the available slash commands, so the outcome is visible from GitHub without opening the UI. See [PR Commands](./pr-commands.md).
- **The metrics trail.** Every model call lands in the LLM Log with cost, tokens, and duration, and the dashboard aggregates outcomes per repository and model. [Metrics](../operations/metrics.md) covers both.

{/* SCREENSHOT PLACEHOLDER (P2 — same capture family as the end-to-end tutorial's task record shot; interim: the site's ui-task-detail.png): Capture a task detail view for a completed implementation task: context strip with repository/model/PR link/cost, the result overview, and the file changes section expanded to show at least one diff. */}

## Live Output While Work Runs

The task detail view exposes progress during execution, including streamed output where supported. That helps operators tell the difference between:

- A job waiting in the queue
- A job actively running
- An agent still thinking or editing files
- A git or GitHub finalization failure
- A completed task waiting for review

## Provider Capacity

With the optional [Agent Tank](../operations/agent-tank.md) integration enabled, provider capacity becomes a visible signal too: the sidebar shows live usage bars per subscription provider, and each LLM log entry records the usage delta its call consumed. Turn it on from the dashboard banner ProPR shows when it detects a running instance, from **Settings → LLM Usage Tracking**, or with `propr tank on`.

## Recovery

Observability matters most when a run fails. ProPR tracks enough state to support recovery decisions:

- Transient git and GitHub failures retry automatically with exponential backoff
- Failed runs keep their agent output and failure context for inspection
- Re-run a follow-up with stronger instructions from the PR conversation
- Switch models with `/switch` or `/use` when the current model is a bad fit
- Revert a commit through a signed system task (authorized via `SYSTEM_TASK_SECRET`), which resets the branch and force-pushes

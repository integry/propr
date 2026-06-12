---
sidebar_position: 7
---

# Observability And Control

ProPR is built so you can see what happened after every agent run. A task should not disappear into a terminal session or a provider dashboard; it should leave a record that connects the request, selected agent, logs, commits, costs, outcome, and recovery state.

## Task Records

Each run creates a task record that can be inspected from the Web UI. Task records answer:

- What triggered this run?
- Which repository, branch, agent, and model were used?
- What state is the task in now?
- Which commits or pull request came out of it?
- Where did a failure occur?

The task detail view shows:

- A context strip with the repository, model, pull request link, commit, duration, and token usage
- The exact prompt sent to the agent (View Prompt)
- Execution log files (View Logs)
- A live execution event log and, where the agent emits it, a thinking log
- Live file changes with diffs per file
- A progress bar over the agent's todo list
- Action buttons: Follow Up (compose a follow-up for the task's PR or issue), Stop (while pending or processing), and Delete

<!-- SCREENSHOT PLACEHOLDER: Capture a task detail view for a completed implementation task: context strip with repository/model/PR link/cost, the result overview, and the file changes section expanded to show at least one diff. -->

## Logs And Live Output

Task detail views expose progress while work is running, including streamed output where supported. That helps operators tell the difference between:

- A job waiting in the queue
- A job actively running
- An agent still thinking or editing files
- A git or GitHub finalization failure
- A completed task waiting for review

Job state is held in Redis with correlation IDs, so log lines across daemon, worker, and agent containers can be traced back to one task.

## Dashboard

The dashboard summarizes activity across repositories:

- Queue stats: active, success rate, total, and failed task counts
- Total cost in USD
- A task statistics chart and the recent task list
- Top Repositories (task counts and success rate per repo)
- Top Models (task counts and usage share per model)
- Global search across tasks

<!-- SCREENSHOT PLACEHOLDER: Capture the dashboard with real history: the stats grid (Active / Success / Total / Failed / Total Cost), the task chart, and the Top Repositories and Top Models tables populated. -->

## LLM Log

The LLM Log page records every model call:

- Status, model, execution type, cost, duration, and work type per call
- Expandable details linking each call to its task, plan draft, issue, or PR
- Session ID, correlation ID, and agent alias for tracing
- Cache statistics (cache creation and cache read tokens)
- Filters by execution type, model, status, and work type

This is the page to use when comparing model costs across real work or investigating an unexpectedly expensive run.

<!-- SCREENSHOT PLACEHOLDER: Capture the LLM Log page with one row expanded, showing the Work Reference section (task link, repository) and the cache statistics. -->

## Agent Tank Usage Tracking

Agent Tank is an optional integration that tracks provider capacity and rate-limit usage per task execution for CLI subscriptions (Claude, Codex, Antigravity).

- Configure it in Settings under "LLM Usage Tracking": enable the Agent Tank integration and set the daemon URL (shipped default `http://0.0.0.0:3456`; use `http://localhost:3456` to connect to a local instance, since `0.0.0.0` is a bind address). The Settings section shows whether the daemon is reachable.
- When ProPR detects a running Agent Tank daemon, the dashboard shows a banner offering to enable it.
- Once enabled, the sidebar shows live usage bars per provider (for example Claude session/weekly limits, Codex 5-hour session and weekly limits), refreshed every 60 seconds.
- Tracking is best-effort: if Agent Tank is unavailable, tasks proceed normally without usage data.

## Recovery

Observability matters most when a run fails. ProPR tracks enough state to support recovery decisions:

- Transient git and GitHub failures retry automatically with exponential backoff
- Failed runs keep their agent output and failure context for inspection
- Re-run a follow-up with stronger instructions from the PR conversation
- Switch models with `/switch` or `/use` when the current model is a bad fit
- Revert a commit through a signed system task (authorized via `SYSTEM_TASK_SECRET`), which resets the branch and force-pushes

For deeper operational metrics, see [LLM Metrics](../operations/llm-metrics.md) and [System Metrics](../operations/system-metrics.md).

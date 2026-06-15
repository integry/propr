# System Metrics

System metrics show whether ProPR is helping: better pull requests, faster cycle time, less manual cleanup, controlled cost, and recoverable failures.

## Where The Numbers Come From

The Web UI dashboard combines several API sources:

- `GET /api/queue/stats` — waiting, active, completed, failed, and delayed job counts from the BullMQ queue
- `GET /api/stats/tasks` — daily task counts (last 30 days), status distribution, and average processing time from the SQLite task history
- `GET /api/stats/repositories` — per-repository totals, completed, failed, and in-progress counts
- `GET /api/stats/overview` — completed/planned tasks, average PR iterations, total tokens, total cost, and task counts per model
- `GET /api/status` — daemon heartbeat, active worker count, Redis connectivity, GitHub App configuration, per-agent health, and indexing state

The dashboard refreshes these on task updates over the WebSocket connection, so the numbers track live activity.

{/* SCREENSHOT PLACEHOLDER: Capture the Dashboard page with a populated instance: the Recent Activity task list on the left and the analytics rail on the right showing the Active/Success/Total/Failed grid, Total Cost, the activity sparkline, task status distribution, Repository Breakdown, and Top Models. Run a handful of tasks first so all panels have data. */}

## Watch These First

### Issue Resolution Rate

How many eligible issues become useful pull requests?

Break down by repository, agent, model, trigger label, and failure category. The dashboard's success rate is completed tasks over total tasks; Repository Breakdown splits totals per repository.

### Time To Pull Request

How long does it take from trigger to opened or updated PR?

Split the time into queue wait, agent runtime, and finalization. The task stats include average processing time per day; individual task records show per-phase timing.

### Human Review Effort

How much human cleanup is needed?

Track follow-up comments, review/fix cycles, manual commits, and time to approval. The overview stats report average PR iterations (tasks per issue) and total follow-ups.

### PR Acceptance Rate

How many ProPR-generated PRs are merged, closed, or abandoned?

Low acceptance usually points to weak planning, poor routing, missing context, or tasks that are too broad.

## Cost And Capacity

Track:

- Cost per merged PR
- Cost by repository
- Cost by agent and model
- Review/fix loop cost
- Rate-limit and quota pressure

Total cost and per-model task counts appear on the dashboard (from `/api/stats/overview`); per-call cost detail is on the LLM Log page (see [LLM Metrics](./llm-metrics.md)).

### Agent Tank

For provider capacity, ProPR integrates with [Agent Tank](https://agenttank.io), an optional local service that reports session and rate-limit usage for Claude, Codex, and Antigravity CLI tools. Enable it in **Settings → LLM Usage Tracking** (toggle plus service URL; the shipped default is `http://0.0.0.0:3456`, though `0.0.0.0` is a bind address — use `http://localhost:3456` when connecting to a local instance). When enabled:

- The sidebar shows per-provider usage bars (session, weekly, and per-model windows) with reset countdowns, refreshed every 60 seconds.
- LLM log entries record per-call usage deltas.
- The integration is best-effort: if the Agent Tank service is unreachable, tasks proceed normally and the sidebar hides itself.

{/* SCREENSHOT PLACEHOLDER: Capture the sidebar Usage section with Agent Tank enabled, showing provider rows (for example Claude and Codex) with colored usage bars and percentages, and one provider expanded to show its session and weekly metrics. Requires a running Agent Tank instance configured in Settings. */}

## Failures

Use categories that lead to action:

- GitHub API
- Git operation
- Agent authentication
- Timeout
- Provider rate limit
- Empty output
- PR creation
- Configuration or permissions

Also track whether recovery worked: retry, model switch, clearer instructions, smaller scope, or abandon. Task records keep failure context and retry history per run.

## Daily Dashboard View

Check these on the dashboard each day:

- Queue depth (waiting and active counts)
- Active workers and daemon status (header system status)
- Recent outcomes (Recent Activity list)
- Long-running jobs (the header activity monitor lists running tasks and plans with elapsed time)
- Failure spikes (Failed count and status distribution)
- Top model usage (Top Models panel)
- Cost trends (Total Cost plus the LLM Log page)

For review cadence, see [Metrics Feedback Loop](./metrics-feedback-loop.md).

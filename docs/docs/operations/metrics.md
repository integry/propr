# Metrics

ProPR records every task and every model call. The Web UI turns those records into two surfaces — the dashboard for aggregate health and the LLM Log page for per-call detail — backed by JSON APIs you can query directly. This page covers where each number comes from, how cost is calculated, and how to read the numbers week to week.

## The Dashboard

The dashboard combines several API sources:

- `GET /api/queue/stats` — waiting, active, completed, failed, and delayed job counts from the BullMQ queue
- `GET /api/stats/tasks` — daily task counts (last 30 days), status distribution, and average processing time from the SQLite task history
- `GET /api/stats/repositories` — per-repository totals, completed, failed, and in-progress counts with success rates
- `GET /api/stats/overview` — completed and planned tasks, average PR iterations, total follow-ups, total tokens, total cost, and task counts per model
- `GET /api/status` — daemon heartbeat, active worker count, Redis connectivity, GitHub App configuration, per-agent health, and indexing state

The dashboard refreshes these on task updates over the WebSocket connection, so the numbers track live activity. For the screen layout, see the [Web UI Guide](../features/web-ui.md).

{/* SCREENSHOT PLACEHOLDER: Capture the Dashboard page with a populated instance: the Recent Activity task list on the left and the analytics rail on the right showing the Active/Success/Total/Failed grid, Total Cost, the activity sparkline, task status distribution, Repository Breakdown, and Top Models. Run a handful of tasks first so all panels have data. */}

### Breakdowns the product provides

- **Per repository** — the Repository Breakdown panel (and `GET /api/stats/repositories`) splits totals, completed, failed, in-progress, and success rate per repository.
- **Per model** — the Top Models panel counts tasks per model; the aggregated metrics API adds requests, success rate, cost, turns, and execution time per model.
- **Per call** — the LLM Log page filters by execution type, model, status, and work type, and records the agent alias for every call.

Three overview numbers approximate outcome quality: success rate (completed tasks over total), average PR iterations (tasks per issue), and total follow-ups. Rising iterations and follow-ups mean humans are spending more effort steering each PR.

### The daily glance

Check these on the dashboard each day:

- Queue depth (waiting and active counts)
- Active workers and daemon status (header system status)
- Recent outcomes (Recent Activity list)
- Long-running jobs (the header activity monitor lists running tasks and plans with elapsed time)
- Failure spikes (Failed count and status distribution)
- Top model usage (Top Models panel)
- Cost trends (Total Cost plus the LLM Log page)

## The LLM Log Page

Every LLM execution is recorded in the SQLite `llm_logs` table and shown on the **LLM Log** page in the Web UI. Each entry records:

- Execution type (implementation, task analysis, plan generation, PR review, and so on)
- Model name and agent alias
- Work reference — the task, plan, PR, or repository the call belongs to
- Input/output token counts and cache creation/read tokens
- Estimated cost in USD
- Duration, start/end time, and success or failure state
- Session ID and correlation ID
- Error message on failure
- Agent Tank usage deltas per call, when Agent Tank is enabled

Filter the list by status (success/failed), work type (task/plan/repository), execution type, and model. Expand a row to see the repository, session and correlation IDs, cache statistics, and the error message for failed calls. The data is paginated through `GET /api/llm-logs`.

Providers differ in what they expose. ProPR normalizes what it can and leaves provider-specific gaps visible (for example, token counts may be null for some agents).

{/* SCREENSHOT PLACEHOLDER: Capture the LLM Log page with several entries of different execution types, the filter dropdowns (Status, Work, Type, Model) visible in the header, and one row expanded to show its details (repository, session/correlation IDs, cache statistics). Run a few tasks and a plan generation first so multiple work types appear. */}

This is the page to use when comparing model costs across real work or investigating an unexpectedly expensive run.

### Aggregated metrics API

The API also aggregates run metrics in Redis, available at `GET /api/llm-metrics`:

- Totals: requests, successes, failures, success rate, cost, turns, and average execution time
- Per-model breakdown: requests, success rate, total and average cost, turns, and execution time per model
- Daily metrics for the last 7 days (successful/failed counts and cost per day)
- The 10 most recent high-cost alerts

`GET /api/llm-metrics/<correlationId>` returns the detailed metrics for a single run.

## Cost Tracking

ProPR estimates the cost of every LLM call from its token counts (input, output, cache creation, and cache read) and per-model pricing, then stores the estimate with the call. All cost figures in the UI come from these per-call records: the LLM Log shows cost per call, and the dashboard's Total Cost is their sum.

When a single run crosses the cost threshold (`LLM_COST_THRESHOLD_USD`, default `10.00`), ProPR records a high-cost alert; the 10 most recent appear in the aggregated metrics summary. Investigate when:

- A single run exceeds the expected cost
- A loop repeats too many times
- One repository becomes unusually expensive
- A provider starts returning rate-limit errors

A cost spike should lead to an action: smaller task scope, a different model, or loop limits.

### Provider capacity (Agent Tank)

Subscription plans meter capacity in session and rate-limit windows. To track those, ProPR integrates with [Agent Tank](https://agenttank.io), an optional local service that reports session and rate-limit usage for Claude, Codex, and Antigravity CLI tools. When enabled, the sidebar shows per-provider usage bars with reset countdowns, refreshed every 60 seconds, and each LLM log entry records the usage delta the call consumed. The integration is best-effort: if the service is unreachable, tasks proceed normally and the sidebar hides itself.

See [Agent Tank Usage Tracking](./agent-tank.md) for how to run it, connect ProPR, and read the bars.

## Reading The Numbers Weekly

Review these signals weekly, and weight trends more heavily than one-off failures:

- **Success rate and failure volume** — the dashboard stats grid and status distribution
- **Per-repository health** — Repository Breakdown; a repository with a below-average success rate needs attention before more work is routed to it
- **Time to done** — the average processing time chart (`GET /api/stats/tasks`); individual task records show per-run duration
- **Human steering effort** — average PR iterations and total follow-ups from the overview stats
- **Cost** — Total Cost, the per-model and daily breakdowns from `GET /api/llm-metrics`, and the recent high-cost alerts

### Failure analysis

For each recurring failure pattern, use the task record — failure context, the exact prompt, execution logs, and the event log — to identify:

- Where the failure happened (queue, git setup, agent execution, finalization)
- Which repositories or agents are affected
- Whether the task was too broad
- Whether context was missing
- Whether credentials, routing, or rate limits were involved

Many recurring failures trace back to planning scope, routing, missing context, or operations settings — check those before blaming model quality.

### Turning patterns into changes

Common improvement actions:

- Split larger tasks earlier in Planner Studio
- Add repository summaries or refresh indexing
- Change the default agent or review model
- Tune worker concurrency (`WORKER_CONCURRENCY`)
- Adjust agent timeout settings
- Improve PR follow-up instructions

### Operational signals

Between reviews, the live dashboard flags incidents:

- Sudden queue growth (waiting count in queue stats)
- Repeated provider rate-limit failures
- Authentication failures after credential changes (agent health in the header status)
- Cost spikes (Total Cost and recent high-cost alerts)
- A specific repository causing disproportionate failures (Repository Breakdown)
- Provider capacity pressure ([Agent Tank](./agent-tank.md) usage bars, when enabled)

## Related Pages

- [Observability And Control](../features/observability.md) — what a run leaves behind and how to recover
- [Web UI Guide](../features/web-ui.md) — the anatomy of every screen

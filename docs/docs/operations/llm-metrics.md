# LLM Metrics

LLM metrics help you understand agent usage, cost, and model behavior across real ProPR runs.

## What You Can Learn

Use these metrics to answer:

- Which agents and models are being used most?
- Which runs are unusually expensive?
- Which repositories drive the most usage?
- Are review/fix loops costing more than expected?
- Are provider limits affecting work?

## Per-Call Records: The LLM Log Page

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

Not every provider exposes identical data. ProPR normalizes what it can and leaves provider-specific gaps visible (for example, token counts may be null for some agents).

{/* SCREENSHOT PLACEHOLDER: Capture the LLM Log page with several entries of different execution types, the filter dropdowns (Status, Work, Type, Model) visible in the header, and one row expanded to show its details (repository, session/correlation IDs, cache statistics). Run a few tasks and a plan generation first so multiple work types appear. */}

## Aggregated Metrics

The API also aggregates run metrics in Redis, available at `GET /api/llm-metrics`:

- Totals: requests, successes, failures, success rate, cost, turns, and average execution time
- Per-model breakdown: requests, success rate, total and average cost, turns, and execution time per model
- Daily metrics for the last 7 days (successful/failed counts and cost per day)
- The 10 most recent high-cost alerts

`GET /api/llm-metrics/<correlationId>` returns the detailed metrics for a single run.

## Dashboard Views

The dashboard surfaces usage without requiring Redis inspection:

- Total cost and per-model task counts (Top Models panel, from `/api/stats/overview`)
- Per-repository activity (Repository Breakdown)
- Task success and failure trends

Use this together with the LLM Log page to decide when to switch models, split tasks, tune loops, or adjust worker concurrency.

## Capacity Tracking With Agent Tank

When the optional [Agent Tank](https://agenttank.io) integration is enabled, ProPR records provider session and rate-limit usage deltas alongside each LLM call and shows live per-provider usage bars in the sidebar. The integration is best-effort: tasks proceed normally when the Agent Tank service is unavailable. The LLM Log page shows a dismissible banner suggesting the integration when it is not detected. See [Agent Tank Usage Tracking](./agent-tank.md) for setup and connection details.

## High-Cost Runs

ProPR keeps a rolling list of recent high-cost alerts in the LLM metrics summary. Investigate when:

- A single run exceeds the expected cost
- A loop repeats too many times
- One repository becomes unusually expensive
- A provider starts returning rate-limit errors

A cost spike should lead to an action — smaller task scope, a different model, or loop limits — not just acknowledgment.

## Related Pages

- [Observability And Control](../features/observability.md)
- [System Metrics](./system-metrics.md)
- [Metrics Feedback Loop](./metrics-feedback-loop.md)

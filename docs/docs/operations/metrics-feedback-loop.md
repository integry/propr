# Metrics Feedback Loop

Metrics are only useful if they change how you operate ProPR. This page describes the review process for turning system data into better planning, routing, runs, and recovery.

## Weekly Review

Review these signals regularly:

- Issue resolution rate
- Time to pull request
- PR acceptance rate
- Human review effort
- Cost per accepted PR
- Failure categories
- Agent and model performance

Pull the numbers from the dashboard (queue stats, success rate, repository breakdown, top models, total cost), the Tasks page (per-task outcomes and failure context), and the LLM Log page (per-call cost and duration). See [System Metrics](./system-metrics.md) and [LLM Metrics](./llm-metrics.md) for where each number comes from.

Weight trends more heavily than one-off failures.

## Failure Analysis

For each recurring failure pattern, identify:

- Where the failure happened (queue, git setup, agent execution, finalization)
- Which repositories or agents are affected
- Whether the task was too broad
- Whether context was missing
- Whether credentials, routing, or rate limits were involved
- Whether a human could recover from the task record

Patterns should lead to configuration changes, documentation updates, better planning, or implementation fixes.

## Actionable Improvements

Common improvement actions:

- Split larger tasks earlier in Planner Studio
- Add repository summaries or refresh indexing
- Change default agent or review model
- Tune worker concurrency (`WORKER_CONCURRENCY`)
- Adjust agent timeout settings
- Improve PR follow-up instructions
- Add missing tests or workflow guidance

Avoid treating all failures as model quality problems. Many failures are planning, routing, context, or operations issues.

## Implementation Tracking

For each improvement, track:

- Owner
- Target repository or workflow
- Expected metric change
- Date applied
- Follow-up review date

This keeps the feedback loop from becoming an unowned report.

## Continuous Monitoring

Use live dashboard signals for operational incidents:

- Sudden queue growth (waiting count in queue stats)
- Repeated provider rate-limit failures
- Authentication failures after credential changes (agent health in the header status)
- Increased timeout rate
- Cost spikes (total cost and recent high-cost runs)
- A specific repository causing disproportionate failures (Repository Breakdown)
- Provider capacity pressure ([Agent Tank](./agent-tank.md) usage bars, when enabled)

Use weekly or monthly review for product/process decisions.

## Sample Views

### Weekly Summary

```text
Resolved issues: 42
Generated PRs: 39
Merged PRs: 31
Average time to PR: 18m
Average follow-up comments: 1.7
Failed runs: 6
Top failure category: provider rate limit
```

### Trend Review

```text
Time to PR: down 12%
Review effort: flat
Cost per merged PR: up 8%
Acceptance rate: up 4%
Timeout failures: concentrated in two repositories
```

### Operational Snapshot

```text
Queue depth: 9
Active workers: 4
Running tasks over 30m: 1
Rate-limit failures in last hour: 0
Failed finalization jobs: 1
```

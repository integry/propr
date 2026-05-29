# LLM Metrics

LLM metrics help you understand agent usage, cost, and model behavior across real ProPR runs.

## What You Can Learn

Use these metrics to answer:

- Which agents and models are being used most?
- Which runs are unusually expensive?
- Which repositories drive the most usage?
- Are review/fix loops costing more than expected?
- Are provider limits affecting work?

## Per-Run Metrics

Where available, ProPR records:

- Agent and model
- Correlation ID
- Request duration
- Token or usage totals
- Estimated cost
- Success or failure state
- Related task, issue, PR, or repository

Not every provider exposes identical data. ProPR normalizes what it can and leaves provider-specific gaps visible.

## Dashboard Views

The dashboard should make usage understandable without requiring Redis inspection:

- Recent expensive runs
- Usage by model
- Usage by repository
- Cost trends
- Failure and rate-limit patterns

Use this to decide when to switch models, split tasks, tune loops, or adjust worker concurrency.

## Alerts

High-cost alerts are useful when:

- A single run exceeds the expected cost
- A loop repeats too many times
- One repository becomes unusually expensive
- A provider starts returning rate-limit errors

Cost alerts should lead to an action, not just noise.

## Related Pages

- [Observability And Control](../features/observability.md)
- [System Metrics](./system-metrics.md)
- [Metrics Feedback Loop](./metrics-feedback-loop.md)

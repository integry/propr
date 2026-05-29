# System Metrics

System metrics show whether ProPR is helping: better pull requests, faster cycle time, less manual cleanup, controlled cost, and recoverable failures.

## Watch These First

### Issue Resolution Rate

How many eligible issues become useful pull requests?

Break down by repository, agent, model, trigger label, and failure category.

### Time To Pull Request

How long does it take from trigger to opened or updated PR?

Split the time into queue wait, agent runtime, and finalization.

### Human Review Effort

How much human cleanup is needed?

Track follow-up comments, review/fix cycles, manual commits, and time to approval.

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

Agent Tank and usage views should help you route work before capacity becomes a failure.

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

Also track whether recovery worked: retry, model switch, clearer instructions, smaller scope, or abandon.

## Daily Dashboard View

The dashboard should make these visible:

- Queue depth
- Active workers
- Recent outcomes
- Long-running jobs
- Failure spikes
- Top model usage
- Cost trends

For review cadence, see [Metrics Feedback Loop](./metrics-feedback-loop.md).

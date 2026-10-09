---
sidebar_position: 10
---

# Work Splitting

Large agent tasks should become smaller, reviewable changes whenever possible. ProPR supports this through planning, issue generation, branch isolation, and task records that keep each run understandable.

## Why Split Work

Oversized PRs are hard to review and hard for agents to keep focused:

- Reviewers cannot tell which changes are essential.
- Test failures become harder to attribute.
- Agents are more likely to mix unrelated refactors with requested work.
- Follow-up comments become less precise.

Splitting work gives each PR a clearer goal and a smaller blast radius.

## Planning As The Split Point

Planner Studio is the best place to split work because the code has not changed yet. During the Review Plan stage, you can edit and delete generated issues or send the plan back through refinement chat to turn one large plan into several smaller implementation units (see [Planning Before Execution](./planning.md)).

Good split points include:

- Backend behavior before UI polish
- Schema or API changes before consumers
- Tests and fixtures around one feature area
- Mechanical cleanup separated from behavior changes
- Documentation updates separated from code changes when appropriate

## Reviewable Units

A reviewable unit should have:

- A clear acceptance condition
- A bounded set of files or components
- A branch and PR that can stand on its own
- A test or verification path
- A short explanation of what remains out of scope

If a unit cannot be reviewed independently, it may still be too broad or too tangled.

## Execution Strategy

For larger efforts:

1. Draft the full goal in Planner Studio.
2. Generate a plan.
3. Split the plan into smaller implementation issues during review.
4. Finalize the plan into GitHub issues and run one issue first.
5. Review the resulting PR before launching the next batch.
6. Use PR follow-up comments for local refinements.

That gives you more control than launching every generated issue at once. When the issues are genuinely sequential, Epic mode with auto-merge runs them one after another, merging each PR before starting the next issue. If the repository's [auto-merge policy](./repository-workflow.md#auto-merge-policy) declines to arm auto-merge for a PR (for example because it touches a protected path), the queue waits for a person to merge that PR, shows *Waiting for human merge*, and then continues.

As child PRs merge into the epic branch, ProPR keeps a single progress comment on the epic PR up to date (for example **2 of 5 PRs merged**) instead of posting a new comment for every merge. The total counts every open or merged child PR targeting the epic branch, plus planned issues that do not have a PR yet; issues closed without a merge are left out of the count. If the epic PR cannot be found or created, the plan cannot be read, GitHub rejects the comment update, or the update cannot be serialized against a concurrent one when a child merges, ProPR leaves the comment unchanged rather than risk a false confirmation or a duplicate, and retries the update in the background with increasing delays (at most every 30 minutes), so the final merge is still confirmed. Retries are kept for seven days after the first failure; an update that still cannot be completed by then is dropped and logged as an error (*Dropping Epic PR merge progress retry that could not be completed*), and the next child merge, or a redelivery of the webhook, refreshes the progress comment instead. When the last child PR merges, ProPR posts a one-time *Epic fully merged* confirmation comment so you know the epic PR is ready for final review.

A second kind of splitting works across models instead of across scope: add several `llm-*` labels to one issue and ProPR produces one branch and PR per model, so you can compare implementations of the same unit. See [Agents and Models](./agents-and-models.md).

## Follow-Up Work

When a PR reveals additional work, capture it as a new planned issue or [repository todo](./repository-knowledge.md) if it is outside the current PR's scope. Keeping follow-up separate prevents review loops from absorbing unrelated cleanup.

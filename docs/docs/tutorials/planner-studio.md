---
sidebar_position: 7
---

# Planner Studio Walkthrough

Use Planner Studio when a request needs planning before code changes.

## Before You Start

Check that:

- The repository exists in the Web UI.
- The target branch is correct.
- At least one coding agent is enabled.
- The request is specific enough to plan.

For branch behavior, see [Branch Configuration](../features/branch-config.md).

## Create The Draft

1. Open Planner Studio.
2. Create a new draft.
3. Select the repository.
4. Add the request.
5. Attach screenshots, links, or notes if they matter.

Keep the initial request focused. If it contains several unrelated goals, split it before generation.

## Preview Context

Before generating the plan, inspect the gathered context:

- Does it include the right repository area?
- Are important files missing?
- Are unrelated files dominating the context?
- Is the branch correct?

If the context is weak, revise the draft before continuing.

## Generate And Review The Plan

Generate the plan, then review it like a proposal:

- Remove unnecessary work.
- Split large steps into smaller issues.
- Add missing acceptance criteria.
- Keep risky refactors out of small feature work.
- Regenerate if the plan misunderstood the goal.

Planning is the best point to keep work reviewable.

## Approve Execution

When the plan is ready:

1. Approve one issue or the full plan.
2. Choose the agent/model if needed.
3. Start execution.
4. Watch the task records in the Web UI.
5. Review the created pull requests.

For larger changes, run one planned issue first and review the result before launching the rest.

## If The Plan Goes Wrong

- Refine the draft if the goal is still right but the plan is weak.
- Reset to setup if repository, branch, or context inputs were wrong.
- Split the work if the plan is too broad.
- Add better context if the plan is generic.

Related pages:

- [Planning Before Execution](../features/planning.md)
- [Work Splitting](../features/work-splitting.md)
- [Repository Knowledge](../features/repository-knowledge.md)

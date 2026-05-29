---
sidebar_position: 6
---

# Issue To Pull Request Walkthrough

Use this walkthrough when you want ProPR to turn a GitHub issue into a pull request.

## Before You Start

Make sure:

- Setup is complete.
- The repository is configured in the Web UI.
- An AI Agent and default model are enabled.
- The issue is clear enough to implement.
- You know the processing label for the repository, such as `AI` or `propr`.

## Prepare The Issue

Write the issue for implementation:

- What should change
- Why it should change
- Acceptance criteria
- Relevant screenshots or links
- Anything out of scope

Small, specific issues produce better PRs than broad requests.

## Start The Run

1. Add the processing label to the issue.
2. Optionally add a model label such as `llm-<model-id>`.
3. Open the ProPR Web UI.
4. Watch the task record.

The task record shows the selected repository, branch, model, status, logs, and resulting PR.

## Review The Pull Request

When ProPR opens the PR:

- Read the summary.
- Review the diff.
- Check tests and CI.
- Confirm the change matches the issue.
- Look at the task record if anything is unclear.

Review the PR in your normal process. ProPR helps create and refine it; it does not decide whether it should merge.

## Ask For Follow-Up

For direct changes, write a normal PR comment:

```text
Please add a regression test for the empty state.
```

ProPR processes normal user comments directly.

Use slash commands for specific actions:

- `/review` for AI review comments
- `/fix` to apply AI review comments from `/review`
- `/merge` to update the branch
- `/switch` or `/use` to change models
- `/ultrafix` for a review-fix loop

See [PR Slash Commands](../features/pr-commands.md).

## Recover Or Re-Run

If the run fails:

1. Open the task record.
2. Read the failure message and logs.
3. Check credentials, branch settings, and agent configuration.
4. Add clearer PR or issue instructions if needed.
5. Re-run with a smaller scope or different model.

Related pages:

- [Daily Use](./usage.md)
- [Observability And Control](../features/observability.md)
- [Work Splitting](../features/work-splitting.md)

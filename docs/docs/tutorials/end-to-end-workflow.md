---
sidebar_position: 3
---

# End-to-End Workflow

This tutorial walks through ProPR's standard GitHub issue-to-PR workflow, from labeling an issue to refining the resulting pull request.

## Before You Start

Make sure:

- ProPR is already configured for your repository
- The daemon and at least one worker are running
- Your repository appears in ProPR's monitored repository list, whether that list was seeded with `GITHUB_REPOS_TO_MONITOR` or managed in the Web UI
- You know which primary processing label your team uses, such as `AI` or `propr`

If you have not completed setup yet, start with the [Setup](./setup.md) and [Usage](./usage.md) guides.

## 1. Create Or Choose A GitHub Issue

Open a normal GitHub issue that clearly describes the work you want ProPR to implement.

Actionable advice:

- Use a specific title that describes the change
- Include acceptance criteria or a checklist
- Add links, screenshots, or reproduction steps when the task depends on context
- Keep one issue focused on one deliverable so the generated PR stays reviewable

## 2. Add The Processing Label

Apply one of your configured primary processing labels to the issue.

Example:

```text
Labels: AI
```

What happens next:

1. The daemon detects the labeled issue during polling.
2. ProPR skips issues that already have processing or done labels.
3. A job is added to the queue for a worker to process.

Actionable advice:

- Use the exact label configured in `PRIMARY_PROCESSING_LABELS`
- Remove stale processing labels before retrying a previously failed issue

## 3. Optionally Select A Model

If your team routes work by model, add the relevant model label before the worker starts.

Use the current canonical model IDs and `llm-...` label forms documented in [PR Slash Commands](../features/pr-commands.md#model-naming). That keeps the model catalog in one place as the supported names evolve.

Example:

```text
Labels: AI, llm-your-selected-model
```

Older aliases may still resolve for backward compatibility, but the current docs use the canonical names from that reference page.

If you add more than one model label, ProPR can process the same issue in separate runs, each with its own branch and PR.

## 4. Let The Worker Run The Issue

Once a worker picks up the job, ProPR handles the git workflow automatically.

The worker follows three phases:

1. Prepare the repository, base branch, and isolated worktree
2. Run the coding agent to analyze the issue and make changes
3. Commit, push, and create a linked pull request

You do not need to create a branch or open a PR manually.

Actionable advice:

- Keep the worker logs open while testing a new repository setup
- Check for authentication, branch, or Docker errors first if a run stalls early

## 5. Review The Generated Pull Request

When the run succeeds, ProPR opens a PR linked back to the issue.

Review the PR for:

- Scope matching the issue
- Correct code changes and tests
- Clear PR description and issue linkage
- CI status and required checks

The issue is typically linked with closing keywords such as `Closes #123`, so the issue will close automatically when the PR merges.

## 6. Ask ProPR For Follow-Up Changes In The PR

Use PR comment commands when the first pass needs refinement.

Common follow-up flow:

1. Comment `/review` to get AI review feedback on the PR
2. Edit or trim the review comments if needed
3. Comment `/fix` to apply the outstanding suggestions
4. Repeat until the PR is ready

Other useful commands:

- `/merge` to merge the base branch into the PR branch
- `/switch` to permanently change the PR's model
- `/use` to override the model for one follow-up run
- `/ultrafix` to run an automated review-fix loop

For command details, see [PR Slash Commands](../features/pr-commands.md).

## 7. Merge The Pull Request

After human review and passing checks, merge the PR in GitHub.

After merge:

1. The linked issue closes automatically if the PR body uses a closing keyword
2. The PR becomes the system of record for the completed implementation
3. Your team can continue follow-up work through new issues or additional PR commands on related work

## 8. Re-Run Or Recover When Needed

If a run fails or produces the wrong scope:

1. Update the issue description with clearer requirements
2. Remove stale processing or done labels if your workflow requires a clean retry
3. Reapply the processing label
4. Let the daemon queue the issue again

Actionable advice:

- Prefer improving the issue description before retrying
- Use smaller issues instead of asking one run to make unrelated changes
- Reset queue state only when you are cleaning up stuck jobs across the system

## Practical Checklist

Use this checklist for a smooth first run:

1. Write a focused issue with acceptance criteria
2. Add the correct processing label
3. Add an optional model label if needed
4. Wait for the daemon and worker to create the PR
5. Review the PR and run `/review` or `/fix` if needed
6. Merge when checks and human review are complete

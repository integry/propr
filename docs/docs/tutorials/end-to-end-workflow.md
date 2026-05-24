---
sidebar_position: 3
---

# End-to-End Workflow

This tutorial walks through ProPR's standard GitHub issue-to-PR workflow, from configuring the repository in the Web UI to refining the resulting pull request.

## Before You Start

Make sure:

- ProPR is already configured for your repository
- The daemon and at least one worker are running
- Your repository appears in ProPR's monitored repository list in the Web UI
- You know which primary processing label your team configured in Settings, such as `AI` or `propr`

If you have not completed setup yet, start with the [Setup](./setup.md) and [Usage](./usage.md) guides.

## 1. Confirm Configuration In The Web UI

Before you touch GitHub, open the Web UI and verify the repository-level setup.

Check:

1. The repository is enabled in the Repositories page
2. The base branch is correct for that repository
3. At least one coding agent is available in AI Agents
4. The primary processing label you plan to use is present in Settings

Actionable advice:

- Treat the Web UI as the source of truth for repository and label configuration
- Use environment variables mainly to bootstrap the deployment, not for routine tuning

## 2. Create Or Choose A GitHub Issue

Open a normal GitHub issue that clearly describes the work you want ProPR to implement.

Actionable advice:

- Use a specific title that describes the change
- Include acceptance criteria or a checklist
- Add links, screenshots, or reproduction steps when the task depends on context
- Keep one issue focused on one deliverable so the generated PR stays reviewable

## 3. Add The Processing Label

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

- Use the exact label configured in the Web UI Settings page
- Remove stale processing labels before retrying a previously failed issue

## 4. Optionally Select A Model

If your team routes work by model, add the relevant model label before the worker starts.

Use the current canonical model IDs and `llm-...` label forms documented in [PR Slash Commands](../features/pr-commands.md#model-naming). That keeps the model catalog in one place as the supported names evolve.

Example:

```text
Labels: AI, llm-your-selected-model
```

Older aliases may still resolve for backward compatibility, but the current docs use the canonical names from that reference page.

If you add more than one model label, ProPR can process the same issue in separate runs, each with its own branch and PR.

## 5. Monitor The Run In The Web UI

Once the issue is queued, use the dashboard and task detail views to follow progress.

Watch for:

- The task appearing in the recent activity list
- State changes from queueing to execution
- Streamed agent output or logs
- Failures tied to authentication, branch configuration, or container setup

Actionable advice:

- Prefer checking the task detail view before jumping straight to container logs
- Use the dashboard to confirm which repository, label, and model were actually selected

## 6. Let The Worker Run The Issue

Once a worker picks up the job, ProPR handles the git workflow automatically.

The worker follows three phases:

1. Prepare the repository, base branch, and isolated worktree
2. Run the coding agent to analyze the issue and make changes
3. Commit, push, and create a linked pull request

You do not need to create a branch or open a PR manually.

Actionable advice:

- Keep the worker logs open while testing a new repository setup
- Check for authentication, branch, or Docker errors first if a run stalls early

## 7. Review The Generated Pull Request

When the run succeeds, ProPR opens a PR linked back to the issue.

Review the PR for:

- Scope matching the issue
- Correct code changes and tests
- Clear PR description and issue linkage
- CI status and required checks

The issue is typically linked with closing keywords such as `Closes #123`, so the issue will close automatically when the PR merges.

## 8. Ask ProPR For Follow-Up Changes In The PR

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

## 9. Merge The Pull Request

After human review and passing checks, merge the PR in GitHub.

After merge:

1. The linked issue closes automatically if the PR body uses a closing keyword
2. The PR becomes the system of record for the completed implementation
3. Your team can continue follow-up work through new issues or additional PR commands on related work

## 10. Re-Run Or Recover When Needed

If a run fails or produces the wrong scope:

1. Update the issue description with clearer requirements
2. Keep the original primary processing label on the issue, or add it back if someone removed it
3. Remove the blocking state labels that stop the daemon from picking the issue up again
4. Let the daemon queue the issue again

Actionable advice:

- Prefer improving the issue description before retrying
- The daemon polls for issues that still have the primary label but no longer have `{primary}-processing`, `{primary}-done`, or `{primary}-waiting`, so you usually do not need to remove and re-add the primary label just to retry
- Failure labels usually follow the `{primary}-failed-*` pattern; clear those too if your workflow treats them as part of a manual reset
- Use smaller issues instead of asking one run to make unrelated changes
- Reset queue state only when you are cleaning up stuck jobs across the system

## Practical Checklist

Use this checklist for a smooth first run:

1. Write a focused issue with acceptance criteria
2. Confirm repository, agent, and label setup in the Web UI
3. Add the correct processing label
4. Add an optional model label if needed
5. Monitor the run in the dashboard
6. Review the PR and run `/review` or `/fix` if needed
7. Merge when checks and human review are complete

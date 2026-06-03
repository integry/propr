# Branch Configuration

Branch configuration tells ProPR which branch to plan from or implement against.

## For Planner Studio

Use the Repositories page in the Web UI.

1. Open the repository entry.
2. Set `baseBranch`.
3. Save the repository.

Planner Studio uses the selected repository entry's branch. If you need the same repository on multiple long-lived branches, add separate repository entries with different `baseBranch` values.

## For Labeled Issues

Direct labeled issue execution can target a branch with a `base-<branch>` label:

```text
AI
base-release/2026
```

That issue run targets `release/2026`.

If no `base-<branch>` label is present, ProPR uses the repository default branch detected by the worker.

## For Operators

Environment overrides are fallback configuration for deployments:

```bash
GIT_DEFAULT_BRANCH_OWNER_REPO=dev
GIT_FALLBACK_BRANCH=main
```

Prefer the Web UI for normal repository configuration. Use environment overrides when you need an operator-managed default.

## Common Problems

### Wrong Branch In Planner Studio

Check the selected repository entry in the Web UI. Planner Studio does not use free-form branch input.

### Wrong Branch For A Labeled Issue

Add the correct `base-<branch>` label to the issue before processing starts.

### Environment Override Not Working

Check:

- The variable name matches the owner and repo.
- The branch exists.
- The relevant containers were restarted after `.env` changed.

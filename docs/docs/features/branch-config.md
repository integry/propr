# Branch Configuration

Branch configuration tells ProPR which branch to plan from or implement against.

## For Planner Studio

Use the Repositories page in the Web UI.

1. Open the repository entry (the base branch field is set when adding the repository — "Base Branch (optional)").
2. Set the base branch.
3. Save the repository.

Planner Studio uses the selected repository entry's branch. If you need the same repository on multiple long-lived branches, add separate repository entries with different base branch values.

## For Labeled Issues

Direct labeled issue execution can target a branch with a `base-<branch>` label:

```text
AI
base-release/2026
```

That issue run targets `release/2026`.

Multiple `base-<branch>` labels create one run per base branch. Combined with multiple `llm-*` model labels, ProPR fans out one job per base × model combination.

If no `base-<branch>` label is present, ProPR detects the default branch for the repository (see resolution order below).

## Default Branch Resolution Order

When ProPR needs a default branch, it tries the following in order:

1. The repo-specific environment override `GIT_DEFAULT_BRANCH_<OWNER>_<REPO>` (if the configured branch exists on the remote)
2. The repository's default branch from the GitHub API
3. The remote `HEAD` branch reported by `git remote show origin`
4. The `refs/remotes/origin/HEAD` symbolic ref
5. A common-branch list: `GIT_FALLBACK_BRANCH` (default `main`), then `main`, `master`, `develop`, `dev`, `trunk`
6. The first available remote branch

If none of these resolve, the task fails with an explicit error.

## For Operators

Environment overrides are fallback configuration for deployments:

```bash
GIT_DEFAULT_BRANCH_MYORG_MYREPO=dev
GIT_FALLBACK_BRANCH=main
```

The env var name is built from the owner and repository name, uppercased, with any non-alphanumeric characters replaced by `_`. For example, `my-org/my.repo` becomes `GIT_DEFAULT_BRANCH_MY_ORG_MY_REPO`.

Prefer the Web UI for normal repository configuration. Use environment overrides when you need an operator-managed default.

## Common Problems

### Wrong Branch In Planner Studio

Check the selected repository entry in the Web UI. Planner Studio does not use free-form branch input.

### Wrong Branch For A Labeled Issue

Add the correct `base-<branch>` label to the issue before processing starts.

### Environment Override Not Working

Check:

- The variable name matches the owner and repo (uppercased, non-alphanumeric characters replaced by `_`).
- The branch exists on the remote — a configured branch that does not exist is skipped and detection falls through to the GitHub API.
- The relevant containers were restarted after `.env` changed.

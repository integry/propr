# Repository-Specific Default Branch Configuration

For most teams, branch behavior should be configured in the Web UI. Each monitored repository entry can define its own `baseBranch`, and that UI configuration is what Planner Studio and branch-aware execution flows use first.

Environment variables provide an operator-focused fallback for default branch detection.

## Configure Branches In The Web UI

Use the Repositories section of the Web UI when you want ProPR to work against a branch other than the repository's GitHub default branch:

1. Open the monitored repository entry in the Web UI
2. Set `baseBranch` to the branch you want ProPR to target
3. Save the repository entry

If you need the same `owner/repo` to be planned or executed against multiple long-lived branches, add separate monitored repository entries with different `baseBranch` values.

## Planner Studio Behavior

Planner Studio does not support ad hoc branch input. It resolves the planning branch from the monitored repository entry you selected:

- If the repository entry has `baseBranch`, Planner Studio uses that branch
- If the repository entry has no `baseBranch`, Planner Studio falls back to the repository default branch
- If you need planning against a different branch of the same `owner/repo`, add that repository again as a separate monitored entry with its own `baseBranch`

## Branch Resolution Order

When ProPR needs to determine a branch for a monitored repository, the effective order is:

1. The monitored repository entry's `baseBranch` from the Web UI
2. A repository-specific `GIT_DEFAULT_BRANCH_<OWNER>_<REPO>` environment override, if default branch detection is needed
3. GitHub API default branch metadata
4. Git remote `HEAD` detection
5. Git symbolic-ref detection
6. Common fallback branches: `GIT_FALLBACK_BRANCH`, `main`, `master`, `develop`, `dev`, `trunk`
7. The first available remote branch

In practice, that means the UI controls the branch when you set `baseBranch`, and environment variables mainly matter when you leave `baseBranch` empty and want to override default-branch detection.

## Optional Environment Overrides

Use environment overrides when you want a deployment-wide, operator-managed default branch override for a specific repository.

Set environment variables using this pattern:

```bash
GIT_DEFAULT_BRANCH_<OWNER>_<REPO>=<branch_name>
```

Where:

- `<OWNER>` is the repository owner in uppercase with non-alphanumeric characters replaced by underscores
- `<REPO>` is the repository name in uppercase with non-alphanumeric characters replaced by underscores
- `<branch_name>` is the branch ProPR should treat as that repository's default

Examples:

```bash
# For repository integry/forex, use dev as the detected default branch
GIT_DEFAULT_BRANCH_INTEGRY_FOREX=dev

# For repository my-org/my-repo.com, use release/2026
GIT_DEFAULT_BRANCH_MY_ORG_MY_REPO_COM=release/2026
```

If you change `.env`, container environment variables, or another deployment-time secret source, restart or redeploy the relevant ProPR services so the new values are loaded.

## Environment File Setup

Add optional fallback configuration to your `.env` file:

```bash
# Global fallback branch if no stronger detection succeeds
GIT_FALLBACK_BRANCH=main

# Optional repository-specific default branch overrides
GIT_DEFAULT_BRANCH_INTEGRY_FOREX=dev
GIT_DEFAULT_BRANCH_INTEGRY_BACKEND=develop
GIT_DEFAULT_BRANCH_MYORG_FRONTEND=staging
```

## Verification

You can verify an environment override in the logs when ProPR processes work for that repository:

```text
[INFO] Using repository-specific default branch from environment configuration
  repo: "integry/forex"
  defaultBranch: "dev"
  configKey: "GIT_DEFAULT_BRANCH_INTEGRY_FOREX"
```

## Troubleshooting

### Branch Not Found

If a configured branch does not exist in the repository, ProPR logs a warning and falls back to automatic detection.

### Invalid Configuration

- Environment variable names are case-sensitive
- Special characters in owner or repo names are converted to underscores
- Branch names are used exactly as configured, including case

### Debug Configuration

To inspect configured environment-based overrides, check startup logs or use the `listRepositoryBranchConfigurations()` helper in the codebase.

---
sidebar_position: 6
---

# Git Management

ProPR uses git worktrees and deterministic branch handling so agent runs can happen safely and concurrently. This page explains the model at a high level. See [Git Runtime Reference](./git-runtime.md) for commands, configuration, and troubleshooting.

## Responsibilities

The repository manager (`packages/core/src/git/repoManager.ts`) handles:

- Repository clone and update operations
- Worktree creation and cleanup
- Branch name generation
- Branch push operations
- GitHub App authentication for private repositories
- Retry behavior around transient git failures

Agents should not own these operations. They edit files in the prepared workspace; ProPR handles the surrounding git workflow.

## Repository Clones

Each repository is cloned once and then reused for future work. Reusing clones avoids repeated full network fetches and gives workers a stable base for creating task-specific worktrees.

For large repositories, set `GIT_SHALLOW_CLONE_DEPTH` to clone with `--depth=N`, which reduces disk and network cost. Confirm that the chosen depth still supports your branch and merge workflows before enabling it.

## Worktrees

Worktrees let one repository clone support multiple independent working directories. ProPR creates a separate worktree for each task so concurrent jobs do not share the same checkout.

Worktree directories are named so a run can be identified on disk:

```text
issue-<id>-<timestamp>-<model>-<rand>
```

This matters when:

- Multiple issues are processed at once
- Multiple agents or models are compared
- PR follow-up work is queued while other tasks are running
- A failed task needs inspection without blocking new work

## Branch Management

Branches are generated with task and model information so the result can be traced back to the run that produced it. The format is:

```text
<issueId>/<model>-<sanitized-title>-<YYYYMMDD-HHMM>-<rand>
```

For example:

```text
142/claude-sonnet46-fix-empty-state-20260612-0915-a3f2
```

The name combines:

- The issue, PR, plan, or task identifier
- The model identifier
- A sanitized title or short description
- A timestamp and random suffix for collision resistance

## Repository-Specific Defaults

Repositories can use different default branches. ProPR resolves branch settings in this order:

1. Repository-specific configuration (Web UI, or the `GIT_DEFAULT_BRANCH_<OWNER>_<REPO>` environment variable)
2. Global fallback branch (`GIT_FALLBACK_BRANCH`, default `main`)
3. Repository provider default, where available

Planner Studio and issue automation should use the configured repository entry rather than asking each user to type branch names manually.

## Authentication

Git operations use GitHub App installation access rather than personal credentials for repository access. That keeps repository permissions scoped to the app installation and allows private repositories to be processed consistently.

## Reverts

Reverting a ProPR-created PR runs as a signed system task rather than a direct git command. The revert request is signed with `SYSTEM_TASK_SECRET` and expires after `SYSTEM_TASK_TOKEN_MAX_AGE_MS` (default two hours). Before reverting, the worker verifies that the signed PR head ref **and** head SHA still match the live PR, so a revert cannot apply to a branch that changed after the request was issued.

## Cleanup

Workers clean up task worktrees when they are no longer needed. Operators should still monitor disk usage because repository clones, worktrees, logs, and build artifacts can grow over time.

For troubleshooting and maintenance commands, see [Git Runtime Reference](./git-runtime.md).

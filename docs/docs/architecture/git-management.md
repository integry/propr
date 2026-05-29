---
sidebar_position: 6
---

# Git Management

ProPR uses git worktrees and deterministic branch handling so agent runs can happen safely and concurrently. This page explains the model at a high level. See [Git Runtime Reference](./git-runtime.md) for commands, configuration, and troubleshooting.

## Responsibilities

The repository manager handles:

- Repository clone and update operations
- Worktree creation and cleanup
- Branch name generation
- Branch push operations
- GitHub App authentication for private repositories
- Retry behavior around transient git failures

Agents should not own these operations. They edit files in the prepared workspace; ProPR handles the surrounding git workflow.

## Repository Clones

Each repository is cloned once and then reused for future work. Reusing clones avoids repeated full network fetches and gives workers a stable base for creating task-specific worktrees.

For large repositories, shallow clone settings can reduce disk and network cost, but confirm that the chosen depth still supports your branch and merge workflows.

## Worktrees

Worktrees let one repository clone support multiple independent working directories. ProPR creates a separate worktree for each task so concurrent jobs do not share the same checkout.

This matters when:

- Multiple issues are processed at once
- Multiple agents or models are compared
- PR follow-up work is queued while other tasks are running
- A failed task needs inspection without blocking new work

## Branch Management

Branches are generated with task and model information so the result can be traced back to the run that produced it. A branch name should be unique, readable, and safe for GitHub.

Typical branch metadata includes:

- Issue, PR, plan, or task identifier
- Model identifier
- Sanitized title or short description
- Collision-resistant suffix when needed

## Repository-Specific Defaults

Repositories can use different default branches. ProPR resolves branch settings in this order:

1. Repository-specific configuration
2. Global default branch
3. Repository provider default, where available

Planner Studio and issue automation should use the configured repository entry rather than asking each user to type branch names manually.

## Authentication

Git operations use GitHub App installation access rather than personal credentials for repository access. That keeps repository permissions scoped to the app installation and allows private repositories to be processed consistently.

## Cleanup

Workers should clean up task worktrees when they are no longer needed. Operators should still monitor disk usage because repository clones, worktrees, logs, and build artifacts can grow over time.

For troubleshooting and maintenance commands, see [Git Runtime Reference](./git-runtime.md).

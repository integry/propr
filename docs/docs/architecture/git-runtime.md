---
sidebar_position: 7
---

# Git Runtime Reference

This reference covers git configuration, worktree maintenance, performance, and troubleshooting. For the conceptual model, see [Git Management](./git-management.md).

## Configuration

Common git settings:

```bash
# Git paths (defaults shown)
GIT_CLONES_BASE_PATH=/tmp/git-processor/clones
GIT_WORKTREES_BASE_PATH=/tmp/git-processor/worktrees

# Fallback branch when no repository-specific default is configured
GIT_FALLBACK_BRANCH=main

# Repository-specific default branch override
# Key format: GIT_DEFAULT_BRANCH_<OWNER>_<REPO> — owner and repo are
# uppercased and every non-alphanumeric character becomes "_".
# Example for my-org/web-app:
GIT_DEFAULT_BRANCH_MY_ORG_WEB_APP=dev

# Clone options (sets --depth=N when non-empty)
GIT_SHALLOW_CLONE_DEPTH=
```

Retry behavior for transient git failures is hard-coded (exponential backoff in `retryHandler.ts`) and is not environment-configurable.

For image-based installs, paths should point inside the ProPR containers and be backed by the host directory passed to the launcher through `PROPR_REPOS_DIR`.

## Directory Setup

Source or direct local runs need writable clone and worktree directories:

```bash
mkdir -p /tmp/git-processor/{clones,worktrees}
chmod 755 /tmp/git-processor
```

Image-based installs usually do not require this manual step because the launcher mounts the runtime repository directory into the containers.

## Worktree Operations

Useful inspection commands:

```bash
git worktree list
git worktree prune --dry-run
git worktree repair
```

Use repair or prune only when you understand which worktrees are active. Removing a live worktree can interrupt a running task.

## Performance

Repository reuse is the main performance optimization:

- Clone once, reuse for many jobs
- Fetch updates before each task
- Create task-specific worktrees from the shared clone
- Clean up old worktrees after completion

For very large repositories, consider setting `GIT_SHALLOW_CLONE_DEPTH` and monitor disk pressure closely.

## Common Errors

### Worktree Creation Fails

Check:

- The base clone exists and is healthy
- The target branch exists
- The worktree path is writable
- No stale worktree already uses the same path

### Push Fails With Authentication Error

Check:

- GitHub App installation permissions
- Repository installation scope
- Token generation logs
- Whether the repository was transferred or renamed

### Disk Space Issues

Clean up old worktrees and review clone/cache size:

```bash
git worktree prune
du -sh /tmp/git-processor/*
```

Increase disk space before raising worker concurrency.

### Corrupted Worktree

Remove the failed worktree only after confirming no job is still using it, then let the next run recreate the workspace.

## Best Practices

1. Keep clones and worktrees on fast persistent storage.
2. Do not share one working directory across tasks.
3. Use repository-specific branch defaults (`GIT_DEFAULT_BRANCH_<OWNER>_<REPO>`) for non-`main` repos.
4. Monitor disk usage as part of normal operations.
5. Prefer system-managed branch creation over agent-created branches.

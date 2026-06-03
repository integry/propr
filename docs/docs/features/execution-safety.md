---
sidebar_position: 5
---

# Isolated And Safe Execution

ProPR separates agent runs from git and GitHub operations. Agents focus on implementation inside controlled workspaces; the system handles branch setup, commits, pushes, pull request creation, labels, retries, and recovery.

## Execution Boundaries

Each task runs in its own boundary:

- A dedicated git worktree
- A task-specific branch
- A Docker-backed agent runtime
- Structured output capture
- A durable task record

This makes concurrent work possible across issues, PR comments, and models without sharing the same mutable checkout.

## Three-Phase Workflow

Worker execution is intentionally split into three phases:

1. **Pre-agent setup**: update repository state, create the worktree, create or select the branch, and prepare context.
2. **Agent implementation**: run the selected agent in the isolated workspace with the prepared prompt and context.
3. **Post-agent finalization**: inspect changed files, commit, push, create or update the pull request, and update labels or task state.

The agent does not need to be responsible for the surrounding git and GitHub steps. That reduces accidental branch mistakes and makes failures easier to diagnose.

## Worktree Isolation

Worktrees allow ProPR to reuse repository clones while keeping each job in a separate directory. This is important when:

- Multiple issues run at the same time
- Several models are processing related work
- A PR follow-up runs while another task is queued
- A failed job needs to be inspected without blocking new work

Worktrees are implementation detail enough to live mostly in architecture docs, but the user-facing promise is simple: each task gets its own workspace.

## Containerized Agent Runs

Agent commands run through Docker-backed environments so credentials, filesystem access, and runtime dependencies can be controlled consistently.

The default image-based install starts the ProPR service containers and agent containers from published images. Source builds can use local images during development.

## Failure Handling

Safe runs are also about what happens when something fails:

- GitHub and git operations use retry behavior for transient failures.
- Task state records where the failure happened.
- Logs and streamed output remain available for inspection.
- Recovery actions can be triggered without losing the historical record.

For operational details, see [Observability And Control](./observability.md) and the architecture pages.

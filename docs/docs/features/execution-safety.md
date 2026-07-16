---
sidebar_position: 5
---

# Isolated And Safe Execution

ProPR separates agent runs from git and GitHub operations. Agents focus on implementation inside controlled workspaces; the system handles branch setup, commits, pushes, pull request creation, labels, retries, and recovery.

## Execution Boundaries

Each task runs in its own boundary:

- A dedicated git worktree
- A task-specific branch
- A dedicated Docker container for the agent run
- Structured output capture
- A durable task record

This makes concurrent work possible across issues, PR comments, and models without sharing the same mutable checkout. When several `llm-*` model labels run against the same issue, each model gets its own worktree, branch, and pull request.

## Three-Phase Deterministic Workflow

Worker execution is split into three phases. The agent only participates in the middle one:

1. **Pre-agent setup (ProPR)**: pull the job from the queue, update the base branch, create the isolated git worktree, create the task branch, and prepare the prompt and context.
2. **Agent implementation (agent)**: run the selected agent inside its container against the worktree. The agent edits files; it does not push, create branches, or open pull requests.
3. **Post-agent finalization (ProPR)**: inspect changed files, commit, push to GitHub, create or update the pull request with issue linking, and update labels and task state.

Because the git and GitHub steps are deterministic code rather than agent decisions, branch mistakes are rare and failures are easier to attribute: a failure in phase 1 or 3 is a git/GitHub problem, a failure in phase 2 is an agent problem.

## Worktree And Branch Isolation

ProPR reuses one clone per repository and creates a separate git worktree per task. Clone and worktree locations are configurable:

```bash
GIT_CLONES_BASE_PATH=/tmp/git-processor/clones
GIT_WORKTREES_BASE_PATH=/tmp/git-processor/worktrees
```

Worktree isolation matters when:

- Multiple issues run at the same time
- Several models are processing the same issue in parallel
- A PR follow-up runs while another task is queued
- A failed job needs to be inspected without blocking new work

Branch names include the model identifier, so concurrent multi-model runs never collide and every branch can be traced back to the agent and model that produced it.

## Containerized Agent Runs

Each agent run starts a dedicated container from the unified `propr/agent` image. The container gets:

- The task worktree mounted as its working directory
- The agent credential directories mounted read-write from the host at their original paths (for example `~/.claude`, `~/.codex`, `~/.gemini`) so CLIs can refresh auth state; only the `.env` file is mounted read-only
- A per-agent timeout (`CLAUDE_TIMEOUT_MS`, `CODEX_TIMEOUT_MS`, `ANTIGRAVITY_TIMEOUT_MS`, `OPENCODE_TIMEOUT_MS`, `VIBE_TIMEOUT_MS`)

The image-based install starts service and agent containers from published images. Source builds can use local images during development.

## Network Firewall (Optional, Off By Default)

The unified agent image ships `scripts/init-firewall.sh`, an iptables script that drops all traffic except loopback, DNS, SSH, and HTTPS to provider and GitHub endpoints (for example `api.anthropic.com`, `api.github.com`, `github.com`, `objects.githubusercontent.com`).

The script is **not executed by default**. Every agent entrypoint (`scripts/claude-entrypoint.sh`, `codex-entrypoint.sh`, `antigravity-entrypoint.sh`, `opencode-entrypoint.sh`, `vibe-entrypoint.sh`) currently skips it and logs:

```text
Skipping firewall setup (would require --privileged Docker flag)
```

Applying iptables rules inside a container requires elevated container privileges (`--privileged` or equivalent capabilities), which ProPR does not request for agent containers. Treat the firewall script as available hardening you can wire in yourself if your deployment can grant those privileges; it is inactive by default. Without it, agent containers have ordinary outbound network access.

## Failure Handling And Recovery

Safe runs are also about what happens when something fails:

- Git and GitHub operations retry transient failures with exponential backoff (with jitter).
- Job state lives in Redis with correlation IDs, so every log line can be traced to a task.
- Task records capture where the failure happened; logs and streamed output remain available for inspection.
- Failed runs update the issue's state label (`<trigger>-failed-*`) instead of leaving it ambiguous.
- Revert operations run as signed system tasks: requests are authorized with `SYSTEM_TASK_SECRET`, so a revert cannot be injected through normal intake paths.

For operational details, see [Observability And Control](./observability.md) and the architecture pages.

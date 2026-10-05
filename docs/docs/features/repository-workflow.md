---
title: Repository workflow file
---

Version repository policy in the optional `.propr/workflow.yml`. ProPR reads it for each issue implementation and PR follow-up (including fixes), without restarting workers. `propr init` and `propr init repo` scaffold a commented example without overwriting existing files.

```yaml
# yaml-language-server: $schema=https://docs.propr.dev/schemas/repository-workflow.schema.json
hooks:
  after_create: bash .propr/setup.sh
  before_run: npm run build --if-present
  after_run: ./scripts/collect-artifacts.sh
  before_remove: ./scripts/cleanup.sh
  timeout_ms: 600000
instructions: .propr/instructions.md
validation:
  - npm test
  - npm run lint
previews:
  types: [image]
  instructions: "Capture the settings page at 1280px"
limits:
  max_parallel_tasks: 3
```

All fields are optional. Use `{}` for an empty policy; a file that is empty or contains only comments (for example, the scaffold with every section commented out) is also treated as an empty policy. See the [JSON schema](/schemas/repository-workflow.schema.json) for editor validation. Unknown fields, duplicate YAML keys, aliases, unsupported tags, invalid types and missing instruction files fail the attempt before the implementation agent starts. The task's existing issue/PR error reporting surfaces these errors. Files must be UTF-8 and at most 128 KiB each. Validation accepts at most 100 commands.

## Base branch and revisions

For issues, policy comes from the selected base branch, or the repository default branch when no override is selected. If the selected base branch does not exist yet (for example, an epic branch that is created when its first child PR opens), policy comes from the default branch, which is also where the task's worktree starts. For follow-ups it comes from the PR's base branch, including when the implementation branch contains a different policy. The loader resolves the branch to a commit and reads both the workflow and instruction file from that same commit. Changes take effect on the next run; an active run keeps its snapshot.

The task timeline shows the workflow path, base branch and base commit. Hover over it for the full commit and workflow blob revisions. History metadata also records the effective parallel task cap and hook timeout.

## Lifecycle hooks

Commands run with Bash, in the repository workspace **inside the agent container** and as its unprivileged agent user. They never execute on the worker or host. They receive `PROPR_WORKSPACE`, `PROPR_CACHE_DIR`, and `PROPR_AGENT_TYPE`, like the existing setup script. Hook stdin is closed and output goes to execution logs, preserving the agent's prompt input. In those logs, lines from hooks and validation commands are prefixed `ProPR command output:`, and the agent's own stderr is prefixed `ProPR agent stderr:`.

| Hook | When | Failure |
| --- | --- | --- |
| `after_create` | Container startup, before the agent runs | An explicit hook fails the attempt |
| `before_run` | After setup, immediately before invoking the agent | Fails the attempt |
| `after_run` | After the agent exits and validation finishes, including unsuccessful agent exits | Logged and ignored |
| `before_remove` | Before the execution container exits, including setup and `before_run` failures | Logged and ignored |

Each invocation (including provider retries with a new container) has its own lifecycle. `before_remove` refers to container teardown, not later worktree deletion. When the container receives a stop signal, the wrapper forwards it to the running agent and starts `after_run` and `before_remove` once the agent exits. Hooks are still best effort during cancellation: ProPR also removes the container, and forced removal interrupts any cleanup command still running. Read-only analysis calls do not run workflow hooks.

`hooks.timeout_ms` applies separately to each hook and validation command. It defaults to 600,000 ms and cannot exceed that ceiling. Timeout sends TERM to the command process group, followed by KILL after a five-second grace period. The instance's overall agent execution timeout still applies to the entire container, including hooks.

When `after_create` is omitted, `.propr/setup.sh` remains implicit if present and keeps its existing nonfatal failure behavior (`PROPR_REPO_SETUP_STRICT=1` makes failures fatal). An explicit `after_create` replaces it. Repositories **without a workflow file keep the existing setup execution unchanged**, including its timeout behavior.

## Instructions and validation

`instructions` names a repository-relative text file; absolute paths and `..` traversal are rejected. Its contents are appended to implementation and follow-up prompts alongside the instance's existing instructions.

`validation` adds commands the agent must run and report before finishing. ProPR also executes them in order after the agent exits, with the hook timeout applied to each command, and appends the observed passed, failed, timed-out or not-run results to the completion summary. Validation shares the instance's overall execution timeout with the agent, so ProPR also bounds it as a whole. It stops starting commands early enough to leave time for `after_run`, `before_remove` and container teardown, and shortens a command's timeout to the remaining budget. That reserve is 30 seconds plus, for each configured `after_run` and `before_remove` hook, 60 seconds and a five-second grace period. If `hooks.timeout_ms` is set explicitly, each cleanup hook reserves its full timeout instead (still capped by the instance ceiling), so set it only when cleanup really needs that long. The remaining commands are reported as `Not run (execution time limit reached)`, and the completed agent run is kept rather than reported as an execution timeout. A failing validation command does not suppress later commands or erase implementation work. Command output is available in execution logs. Validation commands should be safe to repeat.

## Instance defaults and hard limits

Repository policy can refine instance configuration but cannot grant permissions:

- `limits.max_parallel_tasks` caps concurrent issue implementations and follow-ups **across all branches and workers for this repository**. It is clamped to the instance `worker_concurrency` setting (or `WORKER_CONCURRENCY`, default 5). Capacity is claimed only after an attempt passes its skip and cancellation checks, and it is released as soon as the agent container exits. Committing, PR creation and completion comments do not count against the cap. Attempts refused admission are delayed in the queue, freeing shared worker slots for other repositories. They check cancellation again on re-entry. Refused attempts are kept in a waiting list in Redis. When a slot is released, ProPR wakes the longest-waiting attempts first instead of leaving them to their backoff. The task timeline shows **Waiting for Repository Capacity** with the number of refusals and the next retry time. Runs without a workflow participate in the count; when branches have different active caps, the smallest cap governs admission. Lowering a cap does not interrupt already-running work.
- `previews.types` selects a subset of the types enabled in repository Settings. It cannot enable previews when Settings disable them. An empty subset disables capture for the run. Repository preview instructions are appended to Settings instructions; upload and storage limits remain unchanged.
- Credentials, container networking, mounts, provider choice and other instance settings cannot be declared in this file. Unsupported keys fail validation.

The generated container wrapper (all hooks and validation commands after shell quoting, including wrapper overhead) must fit within 120 KiB of UTF-8 text. This is checked when preparing the workflow, before agent execution. If it exceeds the limit, move long commands into repository scripts and invoke those scripts from the workflow. The 128 KiB source-file limit still applies independently.

This reference covers issue implementations and PR follow-ups. Planning, reviews, imports and long-running Goals retain their existing policies. Effective configuration is recorded per task; the Settings UI and MCP do not yet provide a merged per-branch editor.

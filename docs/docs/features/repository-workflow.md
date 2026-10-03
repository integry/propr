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

All fields are optional. Use `{}` for an empty policy. See the [JSON schema](/schemas/repository-workflow.schema.json) for editor validation. Unknown fields, duplicate YAML keys, aliases, unsupported tags, invalid types and missing instruction files fail the attempt before the implementation agent starts. The task's existing issue/PR error reporting surfaces these errors. Files must be UTF-8 and at most 128 KiB each. Validation accepts at most 100 commands.

## Base branch and revisions

For issues, policy comes from the selected base branch, or the repository default branch when no override is selected. For follow-ups it comes from the PR's base branch, including when the implementation branch contains a different policy. The loader resolves the branch to a commit and reads both the workflow and instruction file from that same commit. Changes take effect on the next run; an active run keeps its snapshot.

The task timeline shows the workflow path, base branch and base commit. Hover over it for the full commit and workflow blob revisions. History metadata also records the effective parallel task cap and hook timeout.

## Lifecycle hooks

Commands run with Bash, in the repository workspace **inside the agent container** and as its unprivileged agent user. They never execute on the worker or host. They receive `PROPR_WORKSPACE`, `PROPR_CACHE_DIR`, and `PROPR_AGENT_TYPE`, like the existing setup script. Hook stdin is closed and output goes to execution logs, preserving the agent's prompt input.

| Hook | When | Failure |
| --- | --- | --- |
| `after_create` | Container startup, before the agent runs | An explicit hook fails the attempt |
| `before_run` | After setup, immediately before invoking the agent | Fails the attempt |
| `after_run` | After the agent exits and validation finishes, including unsuccessful agent exits | Logged and ignored |
| `before_remove` | Before the execution container exits, including setup and `before_run` failures | Logged and ignored |

Each invocation (including provider retries with a new container) has its own lifecycle. `before_remove` refers to container teardown, not later worktree deletion. Hooks are best effort during cancellation: forced container destruction cannot run cleanup commands. Read-only analysis calls do not run workflow hooks.

`hooks.timeout_ms` applies separately to each hook and validation command. It defaults to 600,000 ms and cannot exceed that ceiling. Timeout sends TERM to the command process group, followed by KILL after a five-second grace period. The instance's overall agent execution timeout still applies to the entire container, including hooks.

When `after_create` is omitted, `.propr/setup.sh` remains implicit if present and keeps its existing nonfatal failure behavior (`PROPR_REPO_SETUP_STRICT=1` makes failures fatal). An explicit `after_create` replaces it. Repositories **without a workflow file keep the existing setup execution unchanged**, including its timeout behavior.

## Instructions and validation

`instructions` names a repository-relative text file; absolute paths and `..` traversal are rejected. Its contents are appended to implementation and follow-up prompts alongside the instance's existing instructions.

`validation` adds commands the agent must run and report before finishing. ProPR also executes them in order after the agent exits, with the hook timeout applied to each command, and appends the observed passed, failed, timed-out or not-run results to the completion summary. A failing validation command does not suppress later commands or erase implementation work. Command output is available in execution logs. Validation commands should be safe to repeat.

## Instance defaults and hard limits

Repository policy can refine instance configuration but cannot grant permissions:

- `limits.max_parallel_tasks` caps concurrent issue implementations and follow-ups **across all branches and workers for this repository**. It is clamped to the instance `worker_concurrency` setting (or `WORKER_CONCURRENCY`, default 5). Attempts refused admission are delayed in the queue, freeing shared worker slots for other repositories. They check cancellation again on re-entry. Runs without a workflow participate in the count; when branches have different active caps, the smallest cap governs admission. Lowering a cap does not interrupt already-running work.
- `previews.types` selects a subset of the types enabled in repository Settings. It cannot enable previews when Settings disable them. An empty subset disables capture for the run. Repository preview instructions are appended to Settings instructions; upload and storage limits remain unchanged.
- Credentials, container networking, mounts, provider choice and other instance settings cannot be declared in this file. Unsupported keys fail validation.

The generated container wrapper (all hooks and validation commands after shell quoting, including wrapper overhead) must fit within 120 KiB of UTF-8 text. This is checked when preparing the workflow, before agent execution. If it exceeds the limit, move long commands into repository scripts and invoke those scripts from the workflow. The 128 KiB source-file limit still applies independently.

This reference covers issue implementations and PR follow-ups. Planning, reviews, imports and long-running Goals retain their existing policies. Effective configuration is recorded per task; the Settings UI and MCP do not yet provide a merged per-branch editor.

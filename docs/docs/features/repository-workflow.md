---
title: Repository workflow file
---

Version repository policy in the optional `.propr/workflow.yml`. ProPR reads it for each issue implementation and PR follow-up (including fixes), without restarting workers. `propr init` and `propr init repo` scaffold a commented example without overwriting existing files.

To shape the titles and descriptions of the pull requests ProPR opens, use [`.propr/pr-template.md`](./pr-templates.md), which is read from the same base-branch commit.

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
  max_cost_usd: 5.00
auto_merge:
  enabled: true
  method: squash
  protected_paths:
    - ".github/workflows/**"
    - "packages/core/src/db/migrations/**"
    - "package.json"
network:
  mode: restricted
  allow:
    - "registry.npmjs.org"
    - "*.internal.example.com"
```

All fields are optional. Use `{}` for an empty policy; a file that is empty or contains only comments (for example, the scaffold with every section commented out) is also treated as an empty policy. See the [JSON schema](/schemas/repository-workflow.schema.json) for editor validation. Unknown fields, duplicate YAML keys, aliases, unsupported tags, invalid types and missing instruction files fail the attempt before the implementation agent starts. The task's existing issue/PR error reporting surfaces these errors once; the job is not retried, because the same base commit would fail the same way. A malformed instance `worker_concurrency` setting is not a workflow error: ProPR falls back to `WORKER_CONCURRENCY` (default 5). Files must be UTF-8 and at most 128 KiB each. Validation accepts at most 100 commands.

## Base branch and revisions

For issues, policy comes from the selected base branch, or the repository default branch when no override is selected. If the selected base branch does not exist yet (for example, an epic branch that is created when its first child PR opens), policy comes from the default branch, which is also where the task's worktree starts. For follow-ups it comes from the PR's base branch, including when the implementation branch contains a different policy. The loader resolves the branch to a commit and reads both the workflow and instruction file from that same commit. An issue's worktree starts from that commit too, so hooks and validation run against the code they were read with. Changes take effect on the next run; an active run keeps its snapshot. An attempt that waited for repository capacity reads the policy again once it is admitted, so a long wait never runs an outdated policy. A repository without any commits has no workflow; ProPR initializes it as before. Transient GitHub errors while reading the policy are retried.

The task timeline shows the workflow path, base branch and base commit. Hover over it for the full commit and workflow blob revisions. History metadata also records the effective parallel task cap and hook timeout.

## Lifecycle hooks

Commands run with Bash, in the repository workspace **inside the agent container** and as its unprivileged agent user. They never execute on the worker or host. They receive `PROPR_WORKSPACE`, `PROPR_CACHE_DIR`, and `PROPR_AGENT_TYPE`, like the existing setup script. Hook stdin is closed and output goes to execution logs, preserving the agent's prompt input. In those logs, lines from hooks and validation commands are prefixed `ProPR command output:`, and the agent's own stderr is prefixed `ProPR agent stderr:`.

| Hook | When | Failure |
| --- | --- | --- |
| `after_create` | Container startup, before the agent runs | An explicit hook fails the attempt |
| `before_run` | After setup, immediately before invoking the agent | Fails the attempt |
| `after_run` | After the agent exits and validation finishes, including unsuccessful agent exits | Logged and ignored |
| `before_remove` | Before the execution container exits, including setup and `before_run` failures | Logged and ignored |

Each invocation (including provider retries with a new container) has its own lifecycle. `before_remove` refers to container teardown, not later worktree deletion. When the container receives a stop signal, the wrapper forwards it to the running agent and starts `after_run` and `before_remove` once the agent exits. A stop received while a hook or validation command runs ends that command (TERM, then KILL after five seconds) instead of waiting for it to finish, and cleanup hooks start after it. Hooks are still best effort during cancellation: ProPR also removes the container, and forced removal interrupts any cleanup command still running. Read-only analysis calls do not run workflow hooks.

`hooks.timeout_ms` applies separately to each hook and validation command. It defaults to 600,000 ms and cannot exceed that ceiling. Timeout sends TERM to the command process group, followed by KILL after a five-second grace period. The instance's overall agent execution timeout still applies to the entire container, including hooks.

When `after_create` is omitted, `.propr/setup.sh` remains implicit if present and keeps its existing nonfatal failure behavior (`PROPR_REPO_SETUP_STRICT=1` makes failures fatal). An explicit `after_create` replaces it. Repositories **without a workflow file keep the existing setup execution unchanged**, including its timeout behavior.

## Instructions and validation

`instructions` names a repository-relative text file; absolute paths and `..` traversal are rejected. Its contents are appended to implementation and follow-up prompts alongside the instance's existing instructions.

`validation` adds commands the agent must run and report before finishing. ProPR also executes them in order after the agent exits, with the hook timeout applied to each command, and appends the observed results to the completion summary: `Passed`, `Failed (exit N)`, `Timed out` (the command reached its time limit), `Killed (exit 137)` (killed before its limit, for example by the out-of-memory killer) or `Not run`. Validation shares the instance's overall execution timeout with the agent, so ProPR also bounds it as a whole. It stops starting commands early enough to leave time for `after_run`, `before_remove` and container teardown, and shortens a command's timeout to the remaining budget. That reserve is 30 seconds plus, for each configured `after_run` and `before_remove` hook, 60 seconds and a five-second grace period. If `hooks.timeout_ms` is set explicitly, each cleanup hook reserves its full timeout instead (still capped by the instance ceiling), so set it only when cleanup really needs that long. The remaining commands are reported as `Not run (execution time limit reached)`, and the completed agent run is kept rather than reported as an execution timeout. A failing validation command does not suppress later commands or erase implementation work. Command output is available in execution logs. Validation commands should be safe to repeat and **must not modify files**: they run in the task workspace after the agent and before ProPR commits, so changes they make (for example `lint --fix`, regenerated snapshots or build output that is not ignored) are committed with the agent's work. Use check-only variants such as `eslint .` or `prettier --check`.

Results are authoritative only when the container wrapper runs as root and drops repository commands and the agent to the unprivileged `node` user, as the supported agent images do. Otherwise each result is marked `(unverified: container wrapper was not running as root)`, because an agent sharing the wrapper's user could write its own results. If an agent's transport did not capture the container output, results read `Not observed`.

## Auto-merge policy

`auto_merge` decides whether ProPR may arm GitHub's native auto-merge on a PR whose issue carries the `auto-merge` label (set by Planner Studio, `--auto-merge` or the MCP `autoMerge` flag). The label states intent; the policy keeps a human in the loop for sensitive changes.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` never arms auto-merge, even when the label is present. |
| `method` | repository default | `merge`, `squash` or `rebase`. Without it ProPR uses squash, as before, unless the repository disallows squash merges. |
| `protected_paths` | none | Globs. If any changed file matches one, auto-merge is not armed. |

`.propr` and everything below it (`.propr/**`) are always protected, whatever the configuration says, including a `.propr` file or symlink added by the PR, so an agent cannot change repository policy and merge it unattended.

Globs are anchored at the repository root. `*` and `?` match within one path segment (including dotfiles), `**` matches any number of directories, and `[...]` is a character class. A pattern that matches a directory protects everything below it, so `infra`, `infra/` and `infra/**` are equivalent. `package.json` matches only the root file; use `**/package.json` to match it at any depth. Matching is case-insensitive. For renames, both the old and the new path are checked.

ProPR reads the policy from the PR's **base branch** through the GitHub API, never from the PR's head branch, and lists the changed files from a fresh GitHub API fetch of the PR diff, not from the worktree the agent wrote to. A head branch that edits `.propr/workflow.yml` therefore cannot loosen its own policy.

The decision fails closed. Each time ProPR would arm auto-merge (after the PR is created, after Ultrafix reaches its goal, and when an Epic queue head opens its PR) it records exactly one task timeline event with one of these reason codes:

| Reason | Armed | When |
| --- | --- | --- |
| `armed` | yes | The policy allows auto-merge for this diff. |
| `skipped_protected_path` | no | A changed file matches a protected path. The event lists the matching paths. |
| `skipped_disabled` | no | `auto_merge.enabled` is `false`. |
| `skipped_empty_diff` | no | The PR has no changed files. |
| `skipped_policy_invalid` | no | The base branch workflow file cannot be read or is invalid (any invalid field, not just `auto_merge`, or an unknown merge method). |
| `skipped_diff_unavailable` | no | GitHub returned an error, an incomplete file list, or the head moved while it was listed. |

A missing `.propr/workflow.yml` is not an error: the defaults apply and only `.propr` and `.propr/**` are protected. When auto-merge is not armed, ProPR posts a one-line PR comment with the reason and leaves the `auto-merge` label in place, so a maintainer can review the PR and merge it or enable auto-merge manually. ProPR's own fallback merge for labelled PRs (when checks pass) applies the same policy.

**New commits.** When an armed PR receives a new head (or is retargeted to another base), ProPR evaluates the policy again. If it no longer allows auto-merge, for example because a follow-up commit touched a protected path, ProPR disables auto-merge on the PR, records a timeline event and comments. Only auto-merge that ProPR itself enabled is withdrawn; auto-merge a person or another GitHub App enabled is left alone.

**Epic queues.** An Epic queue advances when the head's PR is merged, not when auto-merge is armed. If auto-merge is skipped for the head's PR, the queue stays active and shows *Waiting for human merge* with the reason; it resumes as soon as a person merges the PR.

## Network

`network` sets the agent container's network mode for this repository's runs:

```yaml
network:
  mode: restricted      # open (default, current behaviour) | restricted
  allow:
    - "registry.npmjs.org"
    - "*.internal.example.com"
    - "git.example.com:8443"
```

- `mode: restricted` starts the agent container with no network interface. Its only route out is a per-run proxy on the worker that allows the agent's provider API, GitHub, npm and PyPI, the instance's `agent_network_allow` hosts and the hosts in `allow`. `mode: open` gives the container ordinary outbound access. Without `mode`, the instance default (`agent_network_mode`, default `open`) applies.
- `allow` lists extra hosts: exact hostnames, `*.domain` wildcards (subdomains only, not the apex), or IP literals, each optionally with `:port`. Without a port, only ports 80 and 443 are allowed. A bare `*` or one-label wildcard such as `*.com` fails validation. Repository entries reach public addresses only: a host that resolves to a loopback, private or link-local address, or such an IP literal, is refused unless the instance's own `agent_network_allow` lists that address.
- When the instance enforces restricted mode (`agent_network_mode_enforced`), `mode: open` is ignored and the timeline records that it was overridden; `allow` still applies unless the instance also sets `agent_network_ignore_repository_allow`, in which case it is ignored and the timeline says so. A repository can always choose `restricted`.

At the end of each restricted run the task timeline lists every denied host with its attempt count. See [Restricted network mode](./execution-safety.md#restricted-network-mode) for the mechanism, the per-agent compatibility (Antigravity falls back to `open`) and its limitations.

## Instance defaults and hard limits

Repository policy can refine instance configuration but cannot grant permissions:

- `limits.max_parallel_tasks` caps concurrent issue implementations and follow-ups **across all branches and workers for this repository**. It is clamped to the instance `worker_concurrency` setting (or `WORKER_CONCURRENCY`, default 5). Capacity is claimed only after an attempt passes its skip and cancellation checks, and it is released as soon as the agent container exits. Committing, PR creation and completion comments do not count against the cap. Attempts refused admission are delayed in the queue, freeing shared worker slots for other repositories. They check cancellation again on re-entry. Refused attempts are kept in a waiting list in Redis. When a slot is released, ProPR wakes the longest-waiting attempts first instead of leaving them to their backoff. The task timeline shows one **Waiting for Repository Capacity** entry per wait, updated with the number of refusals and the next retry time. While a follow-up waits, its PR is not locked, so a later comment job on the same PR can be admitted first. Runs without a workflow participate in the count; when branches have different active caps, the smallest cap governs admission. Lowering a cap does not interrupt already-running work, but an attempt that waited is checked again against the cap in the base-branch policy it re-reads when admitted; if that cap is now full, the attempt gives up its slot and keeps waiting under the new policy. A run's capacity lease is renewed in Redis while its container runs. Every run counts toward capacity, including runs without a cap. So a lease that cannot be renewed (for example during a Redis outage) stops the container before another worker can take its slot.
- `limits.max_cost_usd` caps what **one run** may spend, in USD (estimated from token usage, like every cost figure in ProPR). It applies to issue implementations, PR follow-ups, `/fix`, ultrafix cycles and reviews; goals keep their own controls. A per-task `maxCostUsd` override (task submissions, MCP `create_task`, `propr issue implement --max-cost`) takes precedence over this value, and the instance `default_max_cost_usd` setting applies when the file sets none. `0` means no cap from this file. Values are clamped to 100000. Unlike other fields, a malformed or negative amount does not fail the attempt: it is logged as a warning and treated as no cap from this file, so a typo can never stop every run at $0 (the editor schema still flags it). When the run's estimated cost reaches the cap, ProPR stops its agent container and publishes the partial work as it does for a timed-out run; see [Spend caps](./execution-safety.md#spend-caps). Unlike `max_parallel_tasks`, the cap is not clamped to an instance setting.
- `previews.types` selects a subset of the types enabled in repository Settings. It cannot enable previews when Settings disable them. An empty subset disables capture for the run. Repository preview instructions are appended to Settings instructions; upload and storage limits remain unchanged.
- `network.mode` can choose `restricted`, or `open` unless the instance enforces restricted mode; `network.allow` only adds hosts to a restricted run. Credentials, other container networking (Docker networks, ports, DNS), mounts, provider choice and other instance settings cannot be declared in this file. Unsupported keys fail validation.

The generated container wrapper (all hooks and validation commands after shell quoting, including wrapper overhead) must fit within 120 KiB of UTF-8 text. This is checked when preparing the workflow, before agent execution. If it exceeds the limit, move long commands into repository scripts and invoke those scripts from the workflow. The 128 KiB source-file limit still applies independently.

This reference covers issue implementations and PR follow-ups. Planning, reviews, imports and long-running Goals retain their existing policies, except that reviews also honor `limits.max_cost_usd`. Effective configuration is recorded per task; the Settings UI and MCP do not yet provide a merged per-branch editor.

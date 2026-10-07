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
2. **Agent implementation (agent)**: run the selected agent inside its container against the worktree. The agent edits files. Read-only git metadata and a read-only GitHub token reserve commits, pushes, and GitHub mutations for ProPR.
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
- The agent's credential directory (for example `~/.claude`, `~/.codex`, `~/.gemini`) mounted read-write into the container's home so the CLI can refresh auth state (Vibe's config is mounted read-only)
- For all five agents, read-only git metadata and shared clones (`/tmp/git-processor`). The task worktree is writable, but its `.git` entry is mounted read-only. Other repositories' working copies cannot be changed.
- Implementation, follow-up, review-fix, direct-goal, and repository-associated analysis runs receive a read-only installation token as `GH_TOKEN`. It grants `contents`, `issues`, `pull_requests`, and `metadata` reads, plus `checks`, `actions`, and `statuses` reads when the installation grants those optional permissions. `gh issue view`, `gh pr view`, `gh pr checks` (with the optional CI permissions), and cloning/fetching related repositories work; pushes, merges, issue/PR comments, and label changes are refused by GitHub. Fetch into an agent-created clone; shared clone metadata remains read-only.
- Memory, CPU, and process limits (defaults `6g`, up to 4 CPUs, and 512 PIDs; override with `AGENT_CONTAINER_MEMORY_LIMIT`, `AGENT_CONTAINER_CPU_LIMIT`, `AGENT_CONTAINER_PIDS_LIMIT`) and the `no-new-privileges` security option
- A per-agent timeout (`CLAUDE_TIMEOUT_MS`, `CODEX_TIMEOUT_MS`, `ANTIGRAVITY_TIMEOUT_MS`, `OPENCODE_TIMEOUT_MS`, `VIBE_TIMEOUT_MS`)
- A stall and degenerate-output watchdog: a run with no output for `AGENT_STALL_TIMEOUT_MS` (10 minutes; 30 minutes, `AGENT_TOOL_STALL_TIMEOUT_MS`, while a silent tool call runs), or with `AGENT_DEGENERATE_OUTPUT_LIMIT` (50) consecutive whitespace-only text deltas, is stopped instead of holding its worker slot and repository capacity until the timeout

GitHub's permission names are not a blanket ban on every mutation: its
[Create a commit comment endpoint](https://docs.github.com/en/rest/commits/comments#create-a-commit-comment)
accepts `contents: read`. Commit comments are therefore an exception to this
boundary. Preventing every API mutation would require a host-side read broker
instead of giving agents a GitHub token.

ProPR's worker retains its full installation credential. Git authenticates through
worker process environment variables, not token-bearing remote URLs in shared
clone configuration. Existing token-bearing clone URLs are removed before agents
can see them. User-configured GitHub credential environment variables cannot
override the agent token.

Orchestrated goals are the explicit exception: they retain write-capable tokens
and git mounts so they can create issues and epic PRs. Their permissions are not
narrowed further in this release.

### Context repositories

By default, agent tokens retain read access to every repository covered by the
installation; no repository filter is sent when minting them. Administrators can
set `contextRepositories` on a repository entry through the repository settings
API (`POST /api/config/repos`, within `repos_to_monitor`):

- `"all"` (or omitted): all installation repositories and local clones.
- `"none"`: only the task repository.
- `["owner/shared-library", "owner/sibling-service"]`: the task repository plus
  the listed repositories. Only those local clones and the task's linked git metadata are mounted. GitHub access to
  private repositories outside the list is refused; public data remains public.

Analysis runs use the same repository policy for tokens and mounted clones. Analyses
without a repository context receive no GitHub token or shared clone mounts.
Repository inspection remains credential-free. Unresolvable configured repositories
stop launch with an error naming the entry and settings to correct; aliases resolving
to the same repository use one token repository ID.

Restrictions also apply to orchestrated goals' repository reach. Multiple branch
entries for the same repository use the intersection of their explicit lists.
Older clients that omit the field preserve the stored restriction.

The token relay must support `permissions` and `repository_ids` on its
`/installation-token` request and return GitHub's minted `permissions` and
`repositories` metadata. Unsupported or broader responses stop agent launch;
there is no fallback to the worker token. Own-App deployments mint scoped tokens
directly using GitHub's installation access-token endpoint. The App installation
must grant the required read permissions; see [own-App prerequisites](../operations/github-auth.md#app-mode-own-github-app).

The image-based install starts service and agent containers from published images. Source builds can use local images during development.

## Network Firewall (Optional, Off By Default)

The unified agent image ships `scripts/init-firewall.sh`, an iptables script that drops all traffic except loopback, DNS, outbound SSH, and HTTPS to `api.anthropic.com`, `api.github.com`, `github.com`, and `objects.githubusercontent.com`. Its allowlist has no entries for OpenAI, Google, OpenCode providers, or Mistral, so enabling it as shipped would block every agent except Claude Code.

The script is **not executed by default**. Every agent entrypoint (`scripts/claude-entrypoint.sh`, `codex-entrypoint.sh`, `antigravity-entrypoint.sh`, `opencode-entrypoint.sh`, `vibe-entrypoint.sh`) currently skips it and logs:

```text
Skipping firewall setup (would require --privileged Docker flag)
```

Applying iptables rules inside a container requires elevated container privileges (`--privileged` or equivalent capabilities), which ProPR does not request for agent containers. Treat the firewall script as available hardening you can wire in yourself if your deployment can grant those privileges; it is inactive by default. Without it, agent containers have ordinary outbound network access.

## Spend Caps

A per-run spend cap stops a run whose estimated cost reaches a limit, instead of letting it spend until the execution timeout. The cap applies to issue implementations, PR follow-ups, `/fix`, ultrafix cycles and reviews; goals keep their own controls.

The cap is resolved per run, highest precedence first:

1. A per-task override: `maxCostUsd` on `POST /api/task-submissions` or the MCP `create_task` tool, or `propr issue implement --max-cost <usd>`.
2. `limits.max_cost_usd` in the repository's [`.propr/workflow.yml`](./repository-workflow.md).
3. The instance `default_max_cost_usd` setting (Settings → Automation → General configuration, `propr setting update default_max_cost_usd <usd>`, or MCP `update_execution_settings`). Empty or `0` means no cap.

A level that is unset or `0` defers to the next one. A malformed or negative value is logged as a warning and treated as no cap at that level; it never cancels runs at $0.

While the run executes, ProPR adds the recorded cost of the task's LLM calls (`llm_executions`, including summarization and analysis calls attributed to the task) to the usage its live agent containers have streamed so far, and checks the total every few seconds. When it reaches the cap:

- the agent container is stopped through the same container teardown that a user stop uses, but the run is treated like a timeout: its partial changes are committed and published, with a warning that the work may be incomplete. Later steps of the same run that publish that work are not stopped again;
- the task timeline records a `budget.exceeded` event with the cap, the observed spend and where the cap came from (task override, `.propr/workflow.yml` or instance default);
- an Inbox notification (task category) and a short comment on the issue or pull request say the run stopped at its cap;
- the task ends with terminal reason `cost_cap_exceeded`.

Retries share the budget. When ProPR re-queues a task (a provider usage-limit re-queue or a BullMQ retry), the retry may spend only what earlier attempts left. Task details, `propr task get --json` (`budget`) and the task history API show the cap, the spend and the percentage used.

Spend is an estimate from token counts and model pricing (see [Cost Tracking](../operations/metrics.md#cost-tracking)), so a run can overshoot the cap by the usage reported between two checks. `LLM_COST_THRESHOLD_USD` is separate: it only records a high-cost alert and never stops a run.

## Agent runs

[Agents](./agents.md) reuse the task boundaries above, with a few differences:

- **Nothing is committed or pushed.** An agent's report run and its acting step are analysis runs. The workspace and its throwaway worktree branch are deleted when the step ends, whatever the agent changed. Changes only come from the tasks the acting step creates, which then run the normal three-phase workflow.
- **No repository code without `repository_read`.** With the capability, the primary repository is checked out and the other definition repositories are shallow read-only copies under `.propr/context/`, with the usual read-only GitHub token. Without it, the container gets an empty git directory with only the input files: no clone mounts and no repository token.
- **Web access** follows the `web` capability. Claude Code and Codex enforce it with native CLI switches. Antigravity, OpenCode and Vibe only receive a prompt instruction, so it is best effort there.
- **Delegated MCP grants.** A report run with `propr_mcp` and every acting step get a run-scoped ProPR MCP grant that acts as the agent's owner. It is limited to the definition's repositories and to `read` scope (report) or `read`, `plan` and `execute` (acting step), and is never `merge`, `deploy`, `review`, `publish` or `manage`. The token reaches the container only through its environment (`PROPR_MCP_BEARER_TOKEN`) and is never written to the worktree, logged or stored. Membership and GitHub access are re-checked on every call. Agent-issued grants cannot trigger, approve or reject agent runs.
- **Grant lifetime and revocation.** The worker revokes the grant as soon as its step ends, successfully or not. Expiry after two hours is only a backstop. Every 10 minutes the daemon also revokes grants left by finished runs or past their expiry, which covers a crashed worker. The grants are listed with the internal client **ProPR Agent** under connected apps, and their calls appear in the MCP access log.
- **Signed grant requests.** The worker asks the API for grants over `POST /api/internal/agent-runs/:runId/mcp-grants`. Each request is signed with `SYSTEM_TASK_SECRET` and valid for five minutes, and the run must be in the matching state. `SYSTEM_TASK_SECRET` must therefore be set, and identical, on the API and worker for any agent that uses `propr_mcp` or acts. The worker reaches the API at `PROPR_INTERNAL_API_URL` (default `http://api:4000`). Agent containers reach MCP at `PROPR_AGENT_MCP_URL` (default `$PROPR_INTERNAL_API_URL/api/mcp`).
- **Spend and stalls.** Each step runs under the per-run spend cap and the activity watchdog like any task. Unattended runs are additionally [cost-gated](./agents.md#cost-control) on provider usage. A run whose worker died before storing its result is failed by the daemon 10 minutes after its task ended.

## Failure Handling And Recovery

Safe runs are also about what happens when something fails:

- Git and GitHub operations retry transient failures with exponential backoff (with jitter).
- Job state lives in Redis with correlation IDs, so every log line can be traced to a task.
- Task records capture where the failure happened; logs and streamed output remain available for inspection.
- Failed runs update the issue's state label (`<trigger>-failed-*`) instead of leaving it ambiguous.
- A hung or degenerate agent run is stopped by the activity watchdog and finishes with `terminalReason` `stalled` or `degenerate_output`. Its partial work is published like a timed-out run's, a comment on the issue or PR explains the stop, the Inbox notifies you, and the task timeline records which rule tripped. Tune or disable the thresholds in **Settings → Automation → Agent watchdog**; see [Worker architecture](../architecture/worker.md#stall-and-degenerate-output-watchdog).
- Revert operations run as signed system tasks: requests are authorized with `SYSTEM_TASK_SECRET`, so a revert cannot be injected through normal intake paths. The same secret signs the worker's requests for [agent run MCP grants](#agent-runs).

For operational details, see [Observability And Control](./observability.md) and the architecture pages.

## Goals and recovery

[Direct goals](./goals.md) use a long-lived workspace and draft PR with coherent
checkpoints. ProPR owns commits and pushes; checkpoint cadence is guidance, not a
forced timer. Orchestrated goals let the agent decompose work and submit it through
ProPR. Corrective input and pause/cancel acknowledgement follow the provider's
capabilities and execution boundaries.

Task reconciliation persists completion and recovery state. Follow-up cleanup
finishes before releasing its worktree lock, and interrupted CI cancellation
retains a restart obligation for a still-current PR head. See [CI cancellation](./pr-followup.md#cancelling-obsolete-checks-during-follow-up)
for opt-in workflow selection and recovery behavior.

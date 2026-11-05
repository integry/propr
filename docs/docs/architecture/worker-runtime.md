---
sidebar_position: 4
---

# Worker Runtime Reference

This reference covers worker concurrency, retries, state handling, configuration, and monitoring. For the main workflow, see [Worker Architecture](./worker.md).

## Concurrency And Scaling

Each main worker process handles up to `WORKER_CONCURRENCY` jobs at once (code default `5`; the shipped `.env.example` sets `2`). Only instances with `CONFIG_REPO` set use a valid persisted `worker_concurrency` override. Without `CONFIG_REPO`, including Hosted Fleet, the environment is authoritative: a stale UI setting cannot lower or raise it. Both sources accept positive safe integers, including numeric strings; invalid overrides fall back to the environment, and an invalid environment value falls back to `5`. Fractions and partially numeric strings are not truncated.

Worker startup and repository workflow scheduling share this resolution. An explicit `.propr/workflow.yml` `limits.max_parallel_tasks` is clamped to the resolved ceiling; a smaller repository limit is preserved. An absent workflow or absent repository limit adds no repository semaphore. Worker concurrency is fixed at startup, so restart workers after changing concurrency configuration.

Multiple workers can run as long as the host has enough CPU, memory, disk, and provider capacity. Their per-process limits add together; the main queue has no global BullMQ concurrency limit.

```bash
# Direct local runs
npm run worker
npm run worker:dev
```

For source-based Compose deployments, scale the worker service:

```bash
docker compose up -d --scale worker=3
```

Higher concurrency is not always better. Watch queue depth, model rate limits, repository size, and average task duration before increasing it.

The separate `indexing-worker` service processes repository indexing jobs independently of implementation work.

Hosted physical agent executions also share an instance-wide Redis admission boundary across workers, API and indexing. See [Physical agent-run admission](./agent-run-admission.md) for entitlement configuration, supported topology, the #2989 dependency and exact Fleet acceptance steps. Queue concurrency and physical execution capacity are separate limits.

### Queue and physical admission scope

The launcher defines one `worker` service per stack, alongside API and indexing services (`docker/launcher/orchestrator.mjs`). The following audit distinguishes queue slots from concurrent agent executions:

| Entry point | Admission boundary |
| --- | --- |
| Issues, PR comments/reviews, task imports, system tasks, merge conflicts, goals, agent runs/actions | All dispatch through `src/workerFactory.ts` on the main queue, sharing the worker's job limit. System tasks can use a slot without running an agent. Review assignments execute sequentially in `prReviewRunner.ts`; synthetic fallback attempts also execute sequentially. |
| Explicit repository workflow caps | Redis leases keyed by repository, shared across workers. These constrain that repository's covered executions, not total instance work across repositories. |
| Planner generation/refinement | API background handlers call `taskPlanning/planFileAgent.ts`, which calls `runner.executeTask` outside the main queue. |
| Agent chat | `packages/api/routes/agentRoutes.ts` calls `agent.analyze` outside the queue. Queries within one request are sequential, but requests can overlap. |
| Indexing/retrieval analysis | The indexing service and `services/relevance/*` call analysis agents independently; their local limits do not share main-worker capacity. |
| Usage tips | `src/usageTipsSelectionRunner.ts` calls analysis from a worker background timer. Its own singleton lease does not reserve a main-queue slot. |
| Image preparation/runtime builds | Separate workers build artifacts; their concurrency settings are not agent-run admission limits. |

Queue admission alone does not bound instance-wide agent executions: even with one main worker, N main-queue agent executions plus planner, chat, indexing or usage-tip work can exceed N physical runs. Codex `analyze`, for example, launches an agent container. The shared physical admission boundary covers these container-backed paths independently of queue slots, including fallback/retry attempts. A global BullMQ main-queue limit alone would leave those paths outside the limit.

The [physical agent-run admission guide](./agent-run-admission.md) describes cancellation-aware waiting, renewal/loss handling, crash recovery, release after container removal and avoidance of double acquisition for nested calls. Its regression and live acceptance checks cover contention from API, indexing, background work and multiple workers, proving no N+1 physical execution starts and one release admits one waiter.

### Fleet live acceptance of the exact core preview

Use normal ProPR orchestration to obtain the core preview for the resulting commit. In Fleet's authorized acceptance environment, record that commit SHA, the preview's immutable image digest and the running worker/API/indexing image identities. Verify they match the preview under test rather than a floating tag or an older release. No release, deployment or Fleet pin changes are part of this core patch.

For Solo/Team/Scale desired concurrency 2/6/12, verify `CONFIG_REPO` is absent and each process receives the entitled `WORKER_CONCURRENCY`. In disposable acceptance fixtures, exercise absent, lower (`1`), higher (`50`) and malformed stored settings. Queue N+1 independent, runnable tasks through ordinary ProPR submission, keeping N agent executions open long enough to observe the boundary. Verify worker startup logs resolve N; workflow metadata with an explicit cap above N resolves N; exactly N main-queue jobs become active; the extra job stays waiting with no agent container; and releasing one admits the extra job. Repeat across repositories and without a workflow. Separately set a repository cap of 1, verify its other tasks defer while another repository can run, then verify release wakes a waiter.

Self-hosted acceptance should additionally set `CONFIG_REPO` and verify valid lower/higher overrides and malformed-value fallback. Record queue states, task IDs, resolved workflow metadata, timestamps and agent container lifetimes, not just queue counts. Exercise the planner/chat/indexing/background paths while physical capacity is saturated and report those results against the physical admission guide; passing the queued-task checks alone is not proof of an instance-wide entitlement cap. Run the per-process queue checks with one main worker, then repeat physical admission acceptance with multiple workers sharing the instance ID, Redis database and Docker daemon required by that guide. These are validation instructions; no live Fleet acceptance was performed by this patch.

## Model-Specific Processing

Jobs carry model and agent metadata. Workers use that metadata to:

- Select the configured agent implementation
- Resolve the model ID
- Use the correct Docker image
- Mount the correct credential path
- Include model identifiers in branch and task metadata

This lets two models work on related tasks without sharing the same branch or worktree.

## Failure Handling

Worker failures generally fall into these categories:

- GitHub API failures
- Git clone, fetch, merge, or push failures
- Agent runtime failures
- Timeout or resource exhaustion
- Empty or invalid agent output
- Pull request creation or update failures

Transient git and GitHub operations are retried with exponential backoff. Retry counts and backoff are hard-coded in `retryHandler.ts`; they are not environment-configurable. Agent failures are recorded with logs and task state so you can inspect the run, retry it, or switch models. Issue runs lost with their worker, or ended by a transient provider error, are re-run automatically as linked replacement attempts; see [Reconciliation and automatic replacement runs](./worker.md#reconciliation-and-automatic-replacement-runs).

## Job States

Task state is persisted so the Web UI can show progress and outcomes (`packages/core/src/utils/workerStateManager.types.ts`):

- `pending`
- `processing`
- `claude_execution`
- `post_processing`
- `completed`
- `failed`
- `cancelled`

Despite its name, `claude_execution` covers the agent-implementation phase for every agent type. State records include enough metadata to connect the original trigger, selected agent, output, commits, and PR.

## Configuration

Common worker settings:

```bash
# Worker configuration
WORKER_CONCURRENCY=2

# Agent runtime timeouts (code defaults shown)
CLAUDE_TIMEOUT_MS=86400000
CODEX_TIMEOUT_MS=86400000
ANTIGRAVITY_TIMEOUT_MS=86400000
OPENCODE_TIMEOUT_MS=86400000
VIBE_TIMEOUT_MS=86400000

# Git paths (defaults shown; keep them for image-based installs)
GIT_CLONES_BASE_PATH=/tmp/git-processor/clones
GIT_WORKTREES_BASE_PATH=/tmp/git-processor/worktrees
```

Adjust agent defaults and routing in the Web UI. Environment variables are mainly for install-time paths, secrets, and service wiring. Retry behavior is hard-coded and has no environment variables.

Use `ANTIGRAVITY_TIMEOUT_MS` for Antigravity runs and configure Antigravity model labels such as `llm-antigravity-argon`, `llm-antigravity-flash38`, and `llm-antigravity-opus55` in AI Agents.

Antigravity uses one catalog entry and base label per model. Configure reasoning effort separately through a per-model override in AI Agents, a `level-low` / `level-medium` / `level-high` issue label, or the system reasoning preference. Explicit run / label selections take precedence over per-model overrides; without either, the closest supported effort to the system preference is used. Flash and Claude support low / medium / high, Pro supports low / high, and GPT-OSS uses medium.

## Monitoring

Important worker signals:

- Queue depth
- Task duration
- Agent runtime duration
- Success and failure rates
- Retry counts
- Cost and usage by model
- Disk usage for clones and worktrees

Worker logs include correlation IDs so related GitHub, git, and agent events can be traced together.

## Best Practices

1. Start with conservative concurrency.
2. Keep agent credentials mounted read/write only where required.
3. Monitor disk usage for clones and worktrees.
4. Use model-specific labels for comparative runs.
5. Prefer PR follow-up comments for direct human instructions.
6. Use `/review` and `/fix` for AI review feedback loops.

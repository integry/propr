---
sidebar_position: 5
---

# Physical agent-run admission

Hosted Fleet admits at most Solo **2**, Team **6**, or Scale **12** simultaneous container-backed agent executions per instance. Admission happens below logical tasks, at `executeDockerCommand` and the native-session `spawnWithNetworkPolicy` wrapper. Multiple worker processes, API requests and indexing workers share the same Redis capacity.

## Configuration and dependency on #2989

The existing server-side Hosted activation boundary is `PROPR_FLEET_CONTROL_SECRET` (see `packages/api/routes/hostedFleetRoutes.ts`). Its presence enables mandatory admission; a malformed secret does not bypass the limit. Every execution process must receive the same operator-provisioned `PROPR_INSTANCE_ID`, `WORKER_CONCURRENCY` (2/6/12), Fleet activation environment and Redis endpoint. Neither the persisted `worker_concurrency` UI setting nor `CONFIG_REPO` can raise this entitlement. Missing/invalid Hosted entitlement or instance identity refuses execution.

Self-hosted installations retain their execution behavior unless `PROPR_AGENT_RUN_LIMIT` is explicitly set to a positive integer, with `PROPR_INSTANCE_ID`. A Hosted instance ignores this optional self-hosted override.

PR [#2989](https://github.com/integry/propr/pull/2989), following #2987, merged at `9fbca5e587ad1fb94e41de8c89be3af31177d59b`, which this PR base already contains. Its resolver controls **per-worker job** and repository-workflow ceilings; this patch does not copy or replace it. The physical entitlement resolver intentionally has stricter semantics: it recognizes Hosted by the existing Fleet boundary and never accepts a config-repository override. Existing repository semaphores and lower repository limits remain in place.

## Per-agent ceilings

`PROPR_AGENT_RUN_ALIAS_LIMITS` adds optional ceilings keyed by **direct agent alias**, for example `local-llama=1,claude-prod=3` for a local inference server that runs one job at a time next to cloud agents. They are ceilings, not reserved shares: an alias below its ceiling still needs a free global slot, and capacity an alias does not use is available to every other agent.

- **Format and rules.** Comma-separated `alias=N` entries; each alias at most once; `N` is a positive integer **no greater than the global limit** (`PROPR_AGENT_RUN_LIMIT`, or the Hosted `WORKER_CONCURRENCY` entitlement). A larger ceiling could never bind, so it is rejected as a mistake. An unset or blank value means no per-agent policy.
- **Who is charged.** Every admitted launch carries the alias of the direct agent that actually runs: provider `executeTask`/`analyze` pass it to `executeDockerCommand`, and native goal sessions pass it to `spawnWithNetworkPolicy`. Models that run under one alias share its ceiling; different aliases are independent; an alias without an entry is limited only by the global limit. A synthetic agent is never charged: each physical attempt is charged to the direct agent it routed to, so naming a synthetic alias in the policy is an error.
- **Startup validation.** The worker (`startWorker`) and the API (`start()`) refuse to start when the value is malformed, a ceiling exceeds the global limit, an entry names a synthetic agent or an alias that is not a configured direct agent (disabled agents count as configured), or the policy is set while admission is off. With no direct agent configured, the implicit default agent's alias `default` is accepted. Aliases can change at runtime: on `agents_update` / `synthetic_agents_update` both re-validate and log an error rather than crash; a renamed agent is then limited only by the global limit until the policy is corrected.
- **Atomicity.** The ceiling is checked in the same Lua `acquire` as the global count, by counting the holders whose record carries the alias. The holder record stores the alias; every other operation (attach, renew, fence, expiry, release) keeps it. The reserve → attach → fence → recover lifecycle is unchanged, so alias capacity is never reused while an old execution can still run: a `recovering` holder keeps counting against its alias, and blocks every acquire, until removal is confirmed.
- **Not fenced.** Per-alias ceilings are not part of the stored configuration identity. Each acquire passes the caller's current ceiling, so raising or lowering one needs no generation bump and no drain. Raising is always safe; lowering stops new admissions for that alias until its running holders finish, and never stops running work. The global limit keeps its generation fencing. Processes of one instance should carry the same value; while they differ (for example mid-restart), each admits by its own value.
- **Why an acquire waits.** `acquire` distinguishes `global_limit`, `alias_limit` and `recovering`. The wait loop logs each change of reason with the alias and reports it through `AdmissionOptions.onWaiting`. Queue jobs check their direct agent's ceiling before they reach the boundary and are deferred when it is full (see [Deferring jobs on a saturated agent](#deferring-jobs-on-a-saturated-agent)); executions without a queue job wait in the acquire loop. `agentAdmissionAliasHolders(client, instanceId)` returns the holder count per alias.

### Launches without a registered alias

With a per-agent policy configured, an admitted launch that names no direct agent fails before acquiring with `Agent admission cannot identify the direct agent for this launch`; it never bypasses the policy. Without a policy, such a launch keeps today's global-only behaviour. The paths that previously launched without a registered alias:

| Path | Identity |
| --- | --- |
| Legacy Claude analysis (`executeClaudeCode`, used by `runLightweightLLMAnalysis` only when the requested alias is not registered) | **Exemption** `legacy-claude-analysis`: no registered agent runs (ENV-configured Claude), so it counts toward the global limit only. |
| Agent health checks (`POST /api/agents/:id/health`) | The saved agent's alias: the probe runs the saved configuration with only its execution image resolved. |
| Implicit default agent (no direct agents configured) | Alias `default`. |

### Upgrade and rolling restarts

Holder records written before this change carry no alias. They count toward the global limit only and never cause an error; they leave the hash through the normal release or recovery path. Records written by new processes add only the `alias` field, which the previous script ignores and preserves. During a rolling restart old and new processes share the keys safely for the global limit, but old processes neither send an alias nor check ceilings: their launches count toward the global limit only, and they may admit work on an alias that is already at its ceiling. Per-agent ceilings are enforced once every launching process (API and workers) runs the new version. With `PROPR_AGENT_RUN_ALIAS_LIMITS` unset, the script's decisions are unchanged.

## Deferring jobs on a saturated agent

With per-agent ceilings, one saturated agent must not tie up queue workers that other agents could use. Queue jobs therefore check their **direct** agent's ceiling as soon as that agent is known and, when it is full, are deferred the same way repository workflow capacity is: the job persists the deferral, unwinds its locks and claims, and the same BullMQ job is moved to delayed with exponential backoff and jitter (5–10 s doubling up to 2.5–5 min). The worker is released at once. The atomic acquire at container create stays the authoritative check; the pre-check is advisory (it reads the holder records and answers "has room" when Redis is unreachable, so the acquire decides). It counts only **live** holders of the alias: a holder whose deadline has passed, or that is already `recovering`, still occupies its slot, but only the recovery inside an admission attempt can free it (recovery is demand-driven). A job that sees such a holder therefore proceeds to the acquire, which removes the recorded container, releases the holder and then admits or waits, instead of being deferred behind a holder whose process may be gone. Likewise, while the stored admission configuration has an older generation than the caller's, the pre-check counts no holders: the caller's acquire performs the [generation reconciliation](#fleet-resizereconcile-integration) that fences and drains the older-generation holders, so deferring before it would keep the new generation blocked for as long as old processes renew. `agentAdmissionAliasOccupancy(client, instanceId, generation)` (in `agentCapacity.ts`) returns, in one Redis snapshot, the `live` and `recoverable` holder counts per alias (a `Map`, classified by Redis server time) and whether that reconciliation is pending.

- **No failure budget, no provider failure.** A deferral is `job.moveToDelayed` + `DelayedError`, so `attemptsMade` is unchanged. A capacity refusal (`AgentCapacityError`) is never tagged as an agent-execution failure, is excluded from transient-provider classification, and is non-retryable for synthetic failover: it triggers neither provider replacement nor fallback to another agent or model.
- **One timeline row per wait.** The task timeline shows **Waiting for Agent Capacity** (reason `Waiting for agent capacity: <alias> (limit N)`, metadata `agentCapacityDeferrals`, `agentCapacityRetryAt`, `agentCapacityAliases`), updated in place on every later deferral, like the repository waiting row. Repository and agent capacity share one implementation (`src/jobs/capacityDeferral.ts`) that differs only in job-data fields and reason text.
- **Wake-up.** A deferred job joins a per-alias waiting list (`propr:agent-admission:{sha256(instanceId)}:alias-waiters:<alias>`, ordered by when the wait began). When an admitted holder with a ceiling is released (`finish()`), in whichever process ran it, including the API process, the oldest delayed waiters are promoted, one per free slot under the ceiling (recoverable holders, and older-generation holders when the releasing process runs a newer generation, leave their slot free for a waiter that will recover or drain them, as in the pre-check). Waiters whose job no longer exists or has finished are dropped without using up a wakeup. The backoff timer still covers a missed wakeup.
- **Synthetic agents.** The charge always goes to the direct agent. With a ceiling configured, a synthetic request's selection treats a member whose direct alias is at its ceiling as temporarily unavailable and may choose another eligible member **of the same priority tier**; it never records a failed attempt and never moves to a lower tier because of capacity. When no member of the tier has room, the job is deferred. The selected member is stored on the job (`agentCapacitySelections`) and reused on re-entry, so a deferred job does not select twice or advance the round-robin cursor twice; if that member is full on re-entry, another same-tier member with room is taken deterministically, without a cursor step. Failover after a genuine provider failure prefers a member with room and otherwise waits at the acquire.
- **Cancellation and deadlines.** A deferred job holds no repository slot, PR lock or goal claim while it waits. Re-entry repeats the job's cancellation checks before anything else, so a task stopped during the wait is not resumed.
- **No policy, no change.** Without `PROPR_AGENT_RUN_ALIAS_LIMITS` (or for an alias without an entry) no job is ever deferred for agent capacity, nothing is resolved early, and synthetic routing stays lazy as before.

| Job type | Where the check runs | Lost race at the acquire |
| --- | --- | --- |
| Issue implementation | After the issue, label and cancellation checks, **before repository admission**, the start comment, worktree and branch push. A synthetic request selects its member here. | Waits at the acquire (the start comment and branch already exist). |
| PR follow-up, `/fix`, Ultrafix fix | After the (possibly escalated) model is resolved, before the starting comment, worktree and execution handoff. Deferred under the PR lock like a repository refusal; the claimed comments stay with the delayed job and the lock is released. | Waits at the acquire. |
| PR review (`/review`) | Every reviewer is routed capacity-aware before the starting comment; any saturated reviewer defers the whole job with one refusal naming each saturated alias. The context scout skips a saturated candidate (next candidate, then deterministic context) instead of waiting. Reviewers are routed again on re-entry. | A reviewer waits at the acquire. |
| Goal attempt | Before `claimGoalAttempt` (a claimed attempt cannot be handed back). Goal jobs run with `attempts: 1`; a deferral consumes none. | Waits at the acquire. |
| Automation report run | Before the `queued → running` claim; the run stays `queued`. An agent that cannot be resolved is left to the existing post-claim failure. | Waits at the acquire. |
| Automation action run | Before the action task is claimed on the `acting` run. | Waits at the acquire. |
| Merge-conflict resolution | After the PR lock and task row, before the starting comment; the lock is released while it waits. | Waits at the acquire. |
| Task import | Before cloning. | Nothing user-visible exists yet, so an alias-ceiling wait longer than 30 s (`JOB_AGENT_CAPACITY_RACE_WAIT_MS`) becomes a deferral; the throwaway worktree is removed. |

A pre-check that passes can still lose the race to another launch. The acquire loop distinguishes an alias-ceiling wait; inside a deferrable job's capacity context (`runWithAgentCapacityContext({ raceWaitMs })`) a wait longer than the bound throws `AgentCapacityError` so the job can defer. Job types that have already done user-visible work keep waiting there, which is the short race window between the pre-check and container create.

Executions without a queue job (agent chat, planner generation and refinement, dashboard summaries, health checks, indexing, MCP semantic search) keep waiting in the acquire loop, bounded by their existing caller timeout. When the execution deadline the launch was started with (`executeDockerCommand`'s timeout) expires during an alias-ceiling wait, the launch fails with `AgentCapacityWaitTimeoutError` (`Timed out waiting for agent capacity: '<alias>' (limit N) stayed at its ceiling`) rather than a provider timeout; provider adapters surface that message in the failed result, and it is not a provider failure either. A caller that enforces its own shorter timeout around the call (for example PR title generation) still reports its own timeout.

## Covered execution paths

| Entry point | Physical boundary |
| --- | --- |
| Main worker issues, reviews, comments, goals, agent runs/actions | Provider `executeTask` → `executeDockerCommand` |
| Planner generation and refinement | `planFileAgent` → provider `executeTask` → `executeDockerCommand` |
| API agent chat | provider `analyze` → `executeDockerCommand` |
| Indexing and relevance/retrieval analysis | provider `analyze` → `executeDockerCommand` |
| Usage-tip/background analysis | provider `analyze` → `executeDockerCommand` |
| Claude, Codex and Antigravity native goal sessions | `spawnWithNetworkPolicy` → admitted Docker start |
| Synthetic routing, fallback and retries | Each physical attempt independently crosses one of these boundaries |

There is no logical-wrapper lease to acquire twice: nested routing calls consume only the capacity for each physical execution. Sequential retries release their predecessor; parallel physical executions each need a slot. Queue jobs, waiting HTTP/UI requests and publication work are not running agents.

Excluded non-agent work: image pulls/builds/preparation, trusted runtime package metadata/catalog/simulation containers, Agent Tank usage probes, egress proxy containers, login/authentication containers and container inspection/cleanup. The package and usage probes use the existing internal `costCapExempt` classification; request/UI settings cannot supply it. Network restrictions, spend caps, task-generation labels, workflow deadlines and cancellation contexts remain applied to agent containers.

## Lifecycle and supported scope

The supported topology is multiple processes sharing **one instance ID, one Redis database and one Docker daemon**. The stored configuration includes the daemon identity, limit and admission generation; a process with different configuration cannot admit or reap work. Multiple Docker hosts for one instance are deliberately unsupported: safely reclaiming an unreachable host's live executions requires an external fencing mechanism. All execution processes must run this implementation; mixed old/new workers are not an enforcement boundary.

Redis holds unique owner tokens in a persistent hash. A 30-second renewable deadline uses Redis server time; it is **not** a key TTL. Expiry changes ownership to `recovering`, but does not free capacity. Recovery removes the recorded immutable container ID, then releases that token. Docker/Redis failures retain capacity and surface errors; they never silently skip an agent call or fall back to unrestricted execution.

Execution uses Docker **create → register immutable ID → start ID**. Create does not run the agent. If recovery races with creation, the old token cannot register its ID. If registration already happened, recovery removes that ID before reuse, so a suspended process cannot later start it. Release after execution also fences the token, confirms Docker removal, then deletes the token. A stale release cannot affect another owner. Renewal loss aborts the execution and attempts container removal even when Redis is unavailable. Another admission attempt recovers dead holders; recovery is demand-driven, not a separate daemon.

Use durable Redis with **no eviction** for these records. Do not flush/delete admission state while executions or suspended launchers survive. Missing configuration with surviving labelled containers refuses initialization. Redis data loss, restoration from an older snapshot, or deliberate state edits require stopping all execution processes and draining their containers before reinitialization; asynchronous Redis failover that loses acknowledged writes is outside the supported consistency guarantee. A crash during Docker create can leave a non-running `created` container before its ID is recorded; drain such labelled artifacts during recovery if they prevent reuse of a caller's fixed container name. They cannot start without a successful token registration.

### Fleet resize/reconcile integration

For an entitlement change, Fleet's environment reconciliation must provision `PROPR_AGENT_RUN_GENERATION` together with `WORKER_CONCURRENCY` to **every** execution process. Use a persisted, monotonically increasing nonnegative integer generation per instance; increment it for every resize, including rollback to a previous tier. An absent generation means legacy generation zero. Do not derive it from the tier or reuse it. This is an explicit rollout prerequisite for the Fleet controller that provisions the environment; changing only `WORKER_CONCURRENCY` intentionally fails closed.

The normal Docker admission lifecycle performs the transition on the first execution with the new generation. Redis atomically installs the new configuration and fences all existing reservations. Admission then removes their registered immutable Docker IDs and releases the fenced reservations before allowing any new start. This interrupts old-generation runs; stop intake and allow useful work to finish before reconciling if graceful completion is required. A failed removal retains capacity; another attempt with the same new configuration resumes draining. No Redis key deletion or operator Redis mutation is required, including when the previous tier has zero holders.

For example, reconcile Solo `WORKER_CONCURRENCY=2` / generation `0` to Team `WORKER_CONCURRENCY=6` / generation `1`; a later downgrade uses limit `2` / generation `2`. Old launchers cannot revert the configuration, reap newer work, renew fenced reservations, or register a late create. A launcher suspended after registration cannot start its removed immutable ID. Retrying the same reconciliation is idempotent. A different Docker daemon is rejected even with a higher generation; daemon migration still requires stopping all launchers and an infrastructure-managed drain/state migration.

All Docker lifecycle commands use PATH selection and the same captured caller environment and working directory, including `DOCKER_HOST`, `DOCKER_CONTEXT` and `DOCKER_CONFIG`. A caller targeting a different daemon is refused by the stored daemon identity before creation. This patch performs no Fleet rollout, secret mutation, release or preview-pin change.

## Observability

`agentAdmissionMetrics(client, instanceId)` returns `waiting`, `reserved`, `running` and `recovering` separately. Waiting entries expire from the metric after 30 seconds without refresh; they do not consume capacity. `reserved` covers acquisition/create before ID registration. `running` covers registered physical executions, including their short start/exit handshake; `recovering` remains occupied until removal is confirmed. Queue-active and HTTP-request counts are not physical-running metrics. Structured logs record admission waiting and admitted snapshots with instance and immutable container ID, without credentials.

Keys use `propr:agent-admission:{sha256(instanceId)}:{holders,config,waiting}`; the common hash tag keeps script keys together. Docker containers carry `propr.agent-admission.instance=<sha256(instanceId)>` and a unique `propr.agent-admission.token` label. For live acceptance, correlate these records with Docker start/die/destroy events, not only the conservative admission counts.

## Automated validation

Run with a local Redis server binary:

```bash
PROPR_TEST_REDIS_SERVER=/path/to/redis-server NODE_ENV=test \
  node --import tsx --test test/agentRunAdmission.test.ts
```

Agent-capacity deferral is covered by `test/agentCapacityDeferral.test.ts` (real BullMQ queue and worker over the same Redis setup: deferral with unchanged `attemptsMade`, another agent progressing on the freed worker, wake-up of the oldest waiter on release, the in-place timeline row and the race at the acquire), `packages/core/test/syntheticRoutingCapacity.test.ts` (same-tier skipping, deferral without lower-tier fallback, pinned selection without a second cursor step) and the job-type suites.

The per-agent ceiling suite `test/agentRunAliasAdmission.test.ts` spawns `redis-server` when available and otherwise uses the Redis at `REDIS_HOST` / `REDIS_PORT` (CI starts one with `scripts/ci-redis.sh`), with run-unique instance keys. With `PROPR_REQUIRE_REDIS_INTEGRATION=1`, as CI sets, an unavailable Redis fails the suite instead of skipping it.

The tests use real Redis scripts and separate Node processes through both production Docker wrappers, with a Docker lifecycle simulator. They saturate 2/6/12, prove N+1 cannot create/start, and prove one release admits one waiter. Additional cases cover renewal, waiting/running cancellation, nested logical calls, fallback, holder-process death, delayed creation, stale release, blocked physical removal, configuration/daemon conflicts, Redis loss, generation-based upgrades/downgrades, suspended old-generation creation, repeated-tier stale launchers, and Docker caller-environment isolation. The wrapper fixture simulates an installed absolute Docker binary and refuses non-PATH spawns before contacting a daemon. These are not live Docker/provider or end-to-end planner/chat acceptance tests; the following Fleet checks are still required.

## Exact live Fleet acceptance

Perform these steps only in the authorized disposable Fleet acceptance environment through its normal rollout procedure. Record the exact core commit, immutable preview image digest and running API, worker and indexing image identities. All identities must match the change under test. Do not substitute a floating release tag.

1. For each tier (2, 6, 12), verify every execution process has the matching instance ID, Fleet activation, entitled concurrency and Redis endpoint. Verify one Docker daemon and durable/no-eviction Redis. Repeat with two main workers. Persist UI `worker_concurrency` values 1 and 50 and confirm neither expands the physical entitlement. Verify the separately integrated #2989 resolution for job scheduling.
2. Submit long-running disposable main tasks across repositories until N labelled containers are running. While holding them open, trigger planner generation, planner refinement, API chat, indexing/relevance work and usage-tip analysis, one at a time and together. Record each operation/task ID, admission counters and Docker events. Every extra operation must remain waiting with no extra physical start.
3. Complete one holder. Exactly one waiting physical execution may start; all others remain waiting. Continue until every entrypoint has actually run. Repeat with native goal sessions and provider fallback/retry. Nested logical wrappers must not deadlock at N=2. Verify a repository limit of 1 still constrains that repository while another repository uses remaining capacity.
4. Cancel a waiting planner/task through its normal API, then cancel a running task and native session. Check durable cancellation state, no start for the waiting operation, removal of the running container, and capacity reuse only after its Docker exit/removal. Repeat cancellation during create/start.
5. Kill one holder's worker process without killing its container. Submit a waiter, observe the 30-second deadline, and verify the original immutable ID is removed before the replacement starts. Pause/resume a launcher around create/register/start to test stale-owner fencing. The resumed launcher must fail rather than start an old container or release a new owner's token.
6. Interrupt Redis connectivity for an active process. It must lose renewal, abort/remove its physical execution, and retain the reservation until coordination returns and recovery confirms removal. New requests must fail closed. Separately deny Docker removal: the holder stays `recovering` and no replacement starts until Docker is available. Do not simulate Redis failure by flushing its data.
7. Confirm image/runtime builds and usage probes can run while agent capacity is full without increasing physical-running counts. Verify network restrictions, task-generation cancellation and spend-cap stops still hold for standard and native paths. Record timestamps, identities, entrypoint results and Docker lifetimes for each tier. No live Fleet acceptance is claimed by the automated fixture tests.

## Caller deadline checkpoints

The caller budget includes admission and is sampled again immediately before physical Docker create, including the workflow validation budget. Cancellation and expiry are enforced at checkpoints around bounded operations, not by preempting them. An in-flight `docker info` can take up to 10 seconds, `docker create` up to 120 seconds, removal up to about 50 seconds, and each Redis command up to 5 seconds. These bounds and cleanup can therefore extend observed completion past the caller deadline. Create is deliberately never abandoned: its immutable ID must be collected and removed, with capacity retained until cleanup and fencing are confirmed. Create/registration/start still cross external API boundaries; the budget is checked again before start and is never reset.

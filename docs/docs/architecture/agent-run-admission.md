---
sidebar_position: 5
---

# Physical agent-run admission

Hosted Fleet admits at most Solo **2**, Team **6**, or Scale **12** simultaneous container-backed agent executions per instance. Admission happens below logical tasks, at `executeDockerCommand` and the native-session `spawnWithNetworkPolicy` wrapper. Multiple worker processes, API requests and indexing workers share the same Redis capacity.

## Configuration and dependency on #2989

The existing server-side Hosted activation boundary is `PROPR_FLEET_CONTROL_SECRET` (see `packages/api/routes/hostedFleetRoutes.ts`). Its presence enables mandatory admission; a malformed secret does not bypass the limit. Every execution process must receive the same operator-provisioned `PROPR_INSTANCE_ID`, `WORKER_CONCURRENCY` (2/6/12), Fleet activation environment and Redis endpoint. Neither the persisted `worker_concurrency` UI setting nor `CONFIG_REPO` can raise this entitlement. Missing/invalid Hosted entitlement or instance identity refuses execution.

Self-hosted installations retain their execution behavior unless `PROPR_AGENT_RUN_LIMIT` is explicitly set to a positive integer, with `PROPR_INSTANCE_ID`. A Hosted instance ignores this optional self-hosted override.

PR [#2989](https://github.com/integry/propr/pull/2989), following #2987, merged at `9fbca5e587ad1fb94e41de8c89be3af31177d59b`, which this PR base already contains. Its resolver controls **per-worker job** and repository-workflow ceilings; this patch does not copy or replace it. The physical entitlement resolver intentionally has stricter semantics: it recognizes Hosted by the existing Fleet boundary and never accepts a config-repository override. Existing repository semaphores and lower repository limits remain in place.

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

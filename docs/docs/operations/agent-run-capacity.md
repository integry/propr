---
sidebar_label: "Agent-run capacity"
title: "Read and change agent-run capacity"
description: "What the agent-run limit, per-agent ceilings, queue workers and repository slots each limit, how to read them through REST, MCP and the CLI, and how to change ceilings safely."
---
# Agent-run capacity

Several independent limits decide when an agent container may start. This page explains each one, how to read what they enforce right now, and how to change the per-agent ceilings without interrupting work. The mechanism itself is described in [Physical agent-run admission](../architecture/agent-run-admission.md).

## The limits and how they combine

| Limit | Configured by | What it bounds | Where a job waits |
| --- | --- | --- | --- |
| **Global agent-run limit** | `PROPR_AGENT_RUN_LIMIT` with `PROPR_INSTANCE_ID` (self-hosted opt-in); Hosted: the `WORKER_CONCURRENCY` entitlement | Agent containers running at once across every API and worker process of the instance. | At the admission boundary, just before the container is created. |
| **Per-agent ceiling** | `PROPR_AGENT_RUN_ALIAS_LIMITS` | Agent containers one direct agent alias may run at once, inside the global limit. | Queue jobs are **deferred** (delayed in the queue, worker released); other launches wait at the boundary. |
| **Nested executions per parent** | `PROPR_AGENT_RUN_NESTED_LIMIT` (default 4) | Executions charged under one running parent (tasks of an orchestrating goal, analyses for an automation run). | Refused, never queued. |
| **Queue worker concurrency** | `WORKER_CONCURRENCY` per worker (or the persisted `worker_concurrency` setting with `CONFIG_REPO`) | Jobs each worker process runs at once, agent or not. | In the queue's waiting state. |
| **Repository workflow slots** | `limits.max_parallel_tasks` in `.propr/workflow.yml` | Runs of one repository at once. | Deferred in the queue. |

A launch needs room in **every** limit that applies to it. The per-agent ceiling never reserves capacity: an agent below its ceiling still needs a free global slot, and slots an agent does not use are available to every other agent. A queue job holds its worker slot while it waits at the admission boundary for the global limit; it releases it while it is deferred for an agent ceiling or a repository limit.

**Subscription usage is a different thing.** Provider quota (Claude, Codex and other subscriptions, measured by [Agent Tank](./agent-tank.md)) is reported by `get_provider_usage`, `get_provider_status` and the automation routes `GET /api/automation-definitions/:id/capacity`. Those "capacity" routes answer "how much of the provider subscription is left", not "how many containers may run". The admission report below never includes subscription usage, and the usage routes never include admission.

## Reading what admission enforces

The same report is available three ways:

| Surface | How |
| --- | --- |
| REST | `GET /api/agent-run-admission` (any signed-in member; see the [API reference](./api-reference.md)) |
| MCP | `get_agent_run_admission` (read scope) |
| CLI | `propr admission` for a table, `propr admission --json` for the raw response |

The report contains:

- `admission.enabled`: whether admission is on. With admission off the report says so, `admission.global` is `null`, `agents` is empty, and the other limits are still returned. Nothing errors.
- `admission.global`: the limit and its source (`PROPR_AGENT_RUN_LIMIT` or `hosted_entitlement`), the admission generation, the nested limit and its source, and:
  - `inUse` and `holders` (`reserved`, `running`, `draining`, `recovering`): top-level executions, each taking one global slot. `recovering` includes holders whose lease expired: only the next admission attempt's recovery frees them, and nothing is admitted while one is being recovered.
  - `nested`: executions charged under a parent, shown apart from holders: `chargedUnderParent` (same agent as the parent, no second slot) and `countedAgainstOtherAgent` (another agent, which counts against that agent's ceiling).
  - `waiting`: launches waiting at the boundary, split into `globalLimit`, `agentCeiling`, `recovering` and `starting` (registered, first reply pending).
  - `deferred`: queue jobs delayed until an agent has capacity.
  - `unattributedHolders`: holders without an agent alias (records written before ceilings existed, or the documented global-only exemption).
- `agents[]`: one entry per direct agent with a ceiling or with current work (including jobs still deferred for an agent whose ceiling was removed): `ceiling` (`null` = global limit only), `inUse` (what the ceiling is compared with), `holders`, `nested`, `waiting`, `deferred`, and `tasks` (task ID, state, wait reason).
- `queueWorkers`: worker job slots in use and in total (summed from the concurrency each live worker reports; `null` when a worker has not reported).
- `repositoryWorkflowSlots`: per repository whose running work carries a limit, slots in use, the limit and jobs waiting for a slot. The list is complete (every such repository the caller may see). A repository with a limit but nothing running is not listed. When Redis could not be read, `repositoryWorkflowSlots.unavailable` says why and the empty list means unknown, not idle; `propr admission` then prints `unavailable` instead of `none in use`.

Each limit outside admission carries a `label` saying what it is. A waiting launch's reason comes from the same atomic decision that admits it, so the split matches what admission enforces.

### What the report never shows

No holder tokens, container IDs, Docker daemon identity, instance ID, Redis keys or environment values other than the limits themselves. Counts always cover all work. Task IDs and repository names are included only for callers allowed to see them: in REST, tasks that exist (members can read every task), none for the read-only demo viewer; in MCP, tasks and repositories inside the grant that the repository policy allows.

### Logs and the task timeline

The admission log lines `Physical agent admission waiting` and `Physical agent admitted` carry `agentAlias` (`null` for an unattributed launch), the ceiling (`aliasLimit`) when there is one, and the reason for the wait (`waitReason`: `global_limit`, `alias_limit` or `recovering`; on the admitted line, the last reason it waited for, `null` when it was admitted at once, and `waitedMs`). A deferred task's timeline row reads `Waiting for agent capacity: <alias> (limit N)` with metadata `agentCapacityAliases` and `agentCapacityCeilings`; when a later deferral waits for a different agent or ceiling, it starts a new row instead of rewording the old one.

### Hosted Fleet queue status

`GET /api/internal/hosted/queue` reports `waiting`, `active` and `deferred`. Jobs deferred for an agent ceiling or a repository limit sit in BullMQ's delayed state and come back by themselves, so they are pending work: a drain is not complete while `deferred` is above zero. Delayed jobs that are only waiting out a retry backoff are not counted. The count covers the whole delayed set, however large.

## Changing per-agent ceilings

Set `PROPR_AGENT_RUN_ALIAS_LIMITS` to comma-separated `alias=N` entries of **direct** agent aliases, for example `local-llama=1,claude-prod=3`. Each `N` is a positive integer no greater than the global limit; each alias appears once; synthetic aliases are rejected (the direct agent a synthetic agent routes to is charged). Set the **same value on the API and every worker** and restart them. An invalid value stops the process at startup, so a typo never leaves an agent uncapped.

- **No drain.** Ceilings are not part of the fenced admission identity: every acquire passes the current value. Raising or lowering a ceiling needs no generation bump and no drain.
- **Raising** takes effect for new admissions as soon as a restarted process runs. Jobs already deferred for that agent re-enter when one of its holders is released, and at the latest after their backoff (at most five minutes).
- **Lowering** never stops running work. Running executions finish normally; the agent admits nothing new until `inUse` falls below the new ceiling, and its queue jobs are deferred meanwhile. The report can briefly show `inUse` above `ceiling`.
- **Removing** an entry (or unsetting the variable) leaves that agent limited by the global limit only. Jobs already deferred for it re-enter after their backoff and then proceed without a ceiling check. Until then the report still lists that agent, with `ceiling: null`, and counts those jobs in `deferred`.
- **Rollback** is the same operation with the previous value: restore it on every process and restart. Nothing in Redis needs editing.

## Changing the global limit

The global limit is different: it is part of the stored admission configuration, fenced by a **generation**. Changing `PROPR_AGENT_RUN_LIMIT` (or the Hosted entitlement) without also raising `PROPR_AGENT_RUN_GENERATION` makes admission refuse with `configuration/daemon mismatch`. To change it:

1. Pick a new, never-used generation (increment the last one) and lower any ceiling that would exceed the new limit.
2. If running work should finish, stop intake and wait until the report shows no holders, waiting launches or deferred jobs.
3. Set the new limit and generation on every process together and restart them.

The first admission with the new generation fences every older reservation, removes their containers and releases them before anything new starts: work still running under the old generation is interrupted, which is why step 2 matters. **Rollback** is another change: the previous limit with a **new, higher** generation, never the old generation number. See [Fleet resize](../architecture/agent-run-admission.md#fleet-resizereconcile-integration).

## Rolling restarts with mixed versions

During a rolling restart old and new processes share the Redis records safely for the global limit. Expect:

- **Ceilings per process.** Each process admits by its own `PROPR_AGENT_RUN_ALIAS_LIMITS`. While values differ, the stricter process defers or waits and the other may admit up to its own value; the report shows the ceilings of the API process that answered.
- **Older processes in the report.** Processes from before this report existed record no wait details: their waiting launches count as `starting` and are not attributed to an agent, and their holders show no task ID. Processes from before per-agent ceilings send no alias: their holders count under `unattributedHolders`, and they neither check ceilings nor defer jobs.
- **Fleet.** An older API's queue status has no `deferred` field; treat its absence as unknown, not zero.
- **Logs.** Older processes log waits without `agentAlias` or `waitReason`.

Everything is exact once every API and worker process runs the same version and configuration.

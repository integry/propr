---
sidebar_label: "Repository Event Journal"
title: "Repository change-event journal"
description: "The durable, append-only journal of pull request, epic queue, plan issue and task changes: table, event types, payloads, idempotency and retention."
---

# Repository change-event journal

ProPR records pull request, epic queue, plan issue and task changes in a durable, append-only journal: the `repository_events` table. Each event is appended where the change is already persisted, so a coordinator can read one ordered stream per repository. It does not have to poll several endpoints and diff the results.

The journal is the source of truth. After each append ProPR also publishes a bare `activity:update` event over Socket.IO so the web UI can refresh. That event carries no payload, and a missed one loses nothing: the row is still in the journal.

This page covers the storage, the writer and the event catalog. Clients read and wait on the journal through `GET /api/repository-events` and `GET /api/repository-events/wait` and the MCP tools `list_repository_events` and `wait_repository_events` (see [Repository change events](../operations/api-reference.md#repository-change-events) in the API reference), or with `propr events list|wait` (see the [ProPR CLI](../features/propr-cli.md#settings-logs-and-system) command reference).

## Table

| Column | Meaning |
| --- | --- |
| `seq` | `INTEGER PRIMARY KEY AUTOINCREMENT`, used as the cursor. It only increases, and a position is never reused, even after retention deletes rows. |
| `repository` | `owner/repo`. Every read is scoped to one repository. |
| `domain` | `pull_request`, `epic_queue`, `plan_issue` or `task`. |
| `type` | The event type within the domain (see below). |
| `entity_id` | PR number, epic execution id, plan issue id, or task id, as text. |
| `pr_number`, `issue_number`, `plan_id`, `head_sha` | Optional identifiers to filter on. `plan_id` is the plan (draft) id. |
| `payload` | Small JSON object (at most 4 KiB). |
| `dedupe_key` | Optional key, unique per repository. |
| `occurred_at` | ISO-8601 time of the change. |

Indexes: `(repository, seq)`, `(repository, domain, entity_id, seq)`, and a unique index on `(repository, dedupe_key)`.

`repository_event_floors` stores, for each repository, one past the highest `seq` that retention has deleted (see [Retention](#retention)).

The `domain` column has a CHECK constraint listing the domains; the `task` domain was added by rebuilding the table, keeping every row, its `seq` and the AUTOINCREMENT high-water mark, so existing cursors stay valid.

Rows are written by explicit application appends, not SQLite triggers. A later migration that rebuilds a source table therefore has nothing to recreate. This is different from `goal_events`.

## Writer

`appendRepositoryEvent(db, event)` in `@propr/core` (`packages/core/src/services/repositoryEventJournal.ts`):

- **Idempotent.** An event with a `dedupe_key` that already exists for the repository appends nothing, so webhook redelivery and job retries do not create duplicates.
- **Never throws.** A failed append is logged and counted (`getRepositoryEventJournalStats()`), and the operation that triggered it continues. A review score is still saved, a merge is still handled, and a queue still advances.
- **Transactional where the trigger is a database write.** Pass the caller's transaction and the event commits or rolls back with the change. The activity event is published only after that transaction commits.

`listRepositoryEvents(db, { repository, afterSeq, domains?, entityId?, limit })` returns events in `seq` order after a cursor. `pruneRepositoryEvents(db)` and `getRepositoryEventFloor(db, repository)` implement retention. Shared types (domains, event types, payloads, `UltrafixOutcome`) live in `@propr/shared` (`packages/shared/src/repositoryEvents.ts`).

## Event types

Payloads carry identifiers and small scalars only. They never include PR bodies, comment text, diffs, prompts, agent or tool output, file contents or log excerpts. The free-text reasons below are short, system-generated explanations, capped at 300 characters.

### `pull_request`

`entity_id` is the PR number.

| Type | Written by | Payload | Dedupe key |
| --- | --- | --- | --- |
| `opened` | `pull_request` webhook, `opened` | `baseRef`, `draft` | `pr:{n}:opened` |
| `head_changed` | `pull_request` webhook, `synchronize` | `previousHeadSha` (`head_sha` holds the new head) | `pr:{n}:head_changed:delivery:{X-GitHub-Delivery}` (none without a delivery id) |
| `review_scored` | `recordReviewScores` | `score`, `goal`, `goalReached`, `source`, `cycle`, `reviewerModel` | `pr:{n}:review_scored:{review_scores.id}` |
| `ultrafix_started` | `startLoop` | `goal`, `maxCycles`, `workEpoch` | `pr:{n}:ultrafix_started:{epoch}:{command comment}` |
| `ultrafix_ended` | `completeLoop`, `stopLoop` | `outcome` (`goal_reached`, `cycles_exhausted`, `style_findings_only`, `stopped` or `failed`), `finalScore`, `reason`, `workEpoch` | `pr:{n}:ultrafix_ended:{epoch}:{command comment}` |
| `auto_merge_decision` | `recordAutoMergeDecisionEvent` | The `autoMergeDecision` metadata of the task timeline event | `pr:{n}:auto_merge:{head}:{opportunity}:{action}:{reason}` (only when the head is known) |
| `merged` | `recordPullRequestOutcome`, and the Inbox merge marker in `notificationService` | none | `pr:{n}:merged` |
| `closed` | `recordPullRequestOutcome` | none | `pr:{n}:closed:{closedAt}` |

Ultrafix loop state lives in Redis, so its events are appended right after the state is saved. The writer is installed by every process that runs loops (the daemon, the worker and the API server) through `createUltrafixDeps()`. When a loop completes without an explicit outcome, its free-text reason is mapped to the coded outcome that MCP command progress already reports.

### `epic_queue`

`entity_id` is the epic execution id and `plan_id` is the plan. Each event is appended in the same transaction as the guarded queue update. If concurrent observers race, only the winner appends.

| Type | Written by | Payload |
| --- | --- | --- |
| `started` | `createEpicExecutionQueue` | `issues`, `advanceOn`, `parallel` |
| `advanced` | `advanceEpicQueue` | `fromIssue`, `toIssue`, `cursor` |
| `blocked` | Every write of a new `blocked_reason`: a head that must be merged, a missing or undispatchable head, an agent-reported blocker (`markEpicQueueHeadBlocked`), and a human-merge wait (`markEpicQueueAwaitingHumanMerge`) | `headIssue`, `blockedReason` |
| `completed` | `advanceEpicQueue` on the last head, and parallel completion | `fromIssue` (sequential), `cursor` |

A `blocked` event is appended only when the explanation changes, so rewriting the same reason appends nothing.

### `plan_issue`

`entity_id` is the plan issue id.

| Type | Written by | Payload |
| --- | --- | --- |
| `status_changed` | `updatePlanIssue`, `updatePlanIssueStatus`, `updatePlanIssueByPR` | `from`, `to` |

Each writer reads the rows it changes, with their prior status, in the same transaction as its guarded update and the append. One event is written per changed row, and nothing for rows its filters excluded or rows already at the new status (a redelivered webhook). There is no dedupe key, so a transition that repeats within one clock tick is still its own event. These writers already publish a `plan` activity event, so the journal does not publish a second one.

### `task`

`entity_id` is the task id. `issue_number` holds the issue of an implementation task; `pr_number` holds the pull request of a follow-up, review or merge-conflict task. Events are appended by the task state manager (`WorkerStateManager`) right after it records the state change in `task_history`, so every job path journals the same way (`packages/core/src/services/taskJournalEvents.ts`).

| Type | Written when | Dedupe key |
| --- | --- | --- |
| `queued` | The task state is created (`pending`), or the task returns to `pending` | `task:{taskId}:queued:v{version}` |
| `started` | The task leaves `pending` for a running state, or a failed task is retried | `task:{taskId}:started:v{version}` |
| `completed`, `failed`, `cancelled` | The task reaches that terminal state | `task:{taskId}:{type}:v{version}` |

`version` is the task state's compare-and-set revision, so a republished transition appends nothing. A queue handoff (a `requeued` or `rescheduled` job recorded as `cancelled` without a terminal reason) is bookkeeping, not an end: it appends no `cancelled`, and resuming it appends no second `started`. A retry appends `started` and a new terminal event again.

Every `task` payload has:

| Field | Meaning |
| --- | --- |
| `taskId` | The task id. |
| `kind` | `implementation` (an issue task), `follow-up` (a pull request comment task), `review`, `merge-conflict` or `automation` (an automation run). Other task types, such as goals and task imports, are not journaled. |
| `issueNumber`, `prNumber` | The issue or pull request the task works on; the other is `null`. |
| `agent`, `model` | The agent alias and model the task was queued with, or `null`. |
| `attempts` | Retry attempts recorded so far. |

Terminal events (`completed`, `failed`, `cancelled`) add:

| Field | Meaning |
| --- | --- |
| `status` | The terminal state, the same as the event type. |
| `terminalReason` | The coded terminal reason, for example `timed_out`, `stalled`, `blocked`, `cancelled_by_user`, `cancelled_pr_closed`; `null` when none was recorded. |
| `durationMs` | Milliseconds from the latest start to the terminal state; `null` when the task never started. |
| `pullRequest` | `opened` (the task opened a pull request, including a continuation pull request), `updated` (it pushed a commit to an existing one) or `null`. |
| `failureCategory` | On `failed` only: the coded terminal reason, else the recorded error category (for example `claude_execution`, `git_operation`, `worker`), else `unknown`. Free-text categories are reported as `unknown`. `null` on other events. |

Payloads are built from identifiers and coded fields only. They never include the task's reason text, error message, prompt, agent or tool output, comment bodies, logs, notification recaps or file contents. A task event has no activity mapping: the task state update already publishes its own realtime event. Like every append, a failed task event is logged and the task carries on with the same outcome.

## Realtime

The activity envelope (`packages/shared/src/activityEvents.ts`) has a `pull_request` domain. Each event mapping is shown below:

| Journal event | Activity domain | Change |
| --- | --- | --- |
| `pull_request`/`opened` | `pull_request` | `created` |
| `pull_request`/`ultrafix_started` | `pull_request` | `started` |
| `pull_request`/`ultrafix_ended` | `pull_request` | `completed` (goal reached), `failed` (cycles exhausted or failed), or `cancelled` (stopped) |
| `pull_request`/`merged`, `closed` | `pull_request` | `completed`, `cancelled` |
| other `pull_request` events | `pull_request` | `progressed` |
| `epic_queue`/`started`, `blocked`, `completed` | `plan` (entity: the plan id) | `started`, `blocked`, `completed` |
| `epic_queue`/`advanced` | `plan` (entity: the plan id) | `progressed` |

## Retention

The daemon's hourly maintenance sweep (the same one that reclaims stale draft context) deletes events of every domain, `task` included, older than 30 days, and only those: an unexpired event survives even if an older-stamped event (a delayed delivery, or an outcome stamped with its merge time) was appended after it. For each pruned repository it stores `floor_seq` in `repository_event_floors`. That value is one past the highest deleted `seq`, and it never moves backwards.

A reader holding cursor `c` for a repository may have missed pruned events when `c < floor_seq - 1`. Unexpired events below the floor stay readable. A `fromStart` read pages through them with cursors that also carry the repository's retention generation (a digest of its `repository_event_floors` rows); such a cursor stays valid below the floor until retention next prunes the repository, which rewrites `pruned_at` even when the floor does not move. This tells an expired cursor apart from an empty result. A repository that has never been pruned has floor `1`.

Sequence numbers are assigned independently by every ProPR instance, so two instances that journal the same repository have overlapping `seq` ranges. Each database therefore has a durable journal identity (`repository_event_journal_identity`, created once by migration), and every cursor carries it. A cursor issued by another journal is rejected with `CURSOR_INVALID` before its position is checked, even when its repository and `seq` fall inside this journal's range, so resuming on the wrong instance never silently skips unread events.

---
sidebar_label: "Repository Event Journal"
title: "Repository change-event journal"
description: "The durable, append-only journal of pull request, epic queue and plan issue changes: table, event types, payloads, idempotency and retention."
---

# Repository change-event journal

ProPR records pull request, epic queue and plan issue changes in a durable, append-only journal: the `repository_events` table. Each event is appended where the change is already persisted, so a coordinator can read one ordered stream per repository. It does not have to poll several endpoints and diff the results.

The journal is the source of truth. After each append ProPR also publishes a bare `activity:update` event over Socket.IO so the web UI can refresh. That event carries no payload, and a missed one loses nothing: the row is still in the journal.

This page covers the storage, the writer and the event catalog. A read and wait interface for clients comes in a follow-up change.

## Table

| Column | Meaning |
| --- | --- |
| `seq` | `INTEGER PRIMARY KEY AUTOINCREMENT`, used as the cursor. It only increases, and a position is never reused, even after retention deletes rows. |
| `repository` | `owner/repo`. Every read is scoped to one repository. |
| `domain` | `pull_request`, `epic_queue` or `plan_issue`. |
| `type` | The event type within the domain (see below). |
| `entity_id` | PR number, epic execution id, or plan issue id, as text. |
| `pr_number`, `issue_number`, `plan_id`, `head_sha` | Optional identifiers to filter on. `plan_id` is the plan (draft) id. |
| `payload` | Small JSON object (at most 4 KiB). |
| `dedupe_key` | Optional key, unique per repository. |
| `occurred_at` | ISO-8601 time of the change. |

Indexes: `(repository, seq)`, `(repository, domain, entity_id, seq)`, and a unique index on `(repository, dedupe_key)`.

`repository_event_floors` stores, for each repository, the lowest `seq` that retention may still have kept (see [Retention](#retention)).

Rows are written by explicit application appends, not SQLite triggers. A later migration that rebuilds a source table therefore has nothing to recreate. This is different from `goal_events`.

## Writer

`appendRepositoryEvent(db, event)` in `@propr/core` (`packages/core/src/services/repositoryEventJournal.ts`):

- **Idempotent.** An event with a `dedupe_key` that already exists for the repository appends nothing, so webhook redelivery and job retries do not create duplicates.
- **Never throws.** A failed append is logged and counted (`getRepositoryEventJournalStats()`), and the operation that triggered it continues. A review score is still saved, a merge is still handled, and a queue still advances.
- **Transactional where the trigger is a database write.** Pass the caller's transaction and the event commits or rolls back with the change. The activity event is published only after that transaction commits.

`listRepositoryEvents(db, { repository, afterSeq, domains?, entityId?, limit })` returns events in `seq` order after a cursor. `pruneRepositoryEvents(db)` and `getRepositoryEventFloor(db, repository)` implement retention. Shared types (domains, event types, payloads, `UltrafixOutcome`) live in `@propr/shared` (`packages/shared/src/repositoryEvents.ts`).

## Event types

Payloads carry identifiers and small scalars only. They never include PR bodies, comment text, diffs or log excerpts. The free-text reasons below are short, system-generated explanations, capped at 300 characters.

### `pull_request`

`entity_id` is the PR number.

| Type | Written by | Payload | Dedupe key |
| --- | --- | --- | --- |
| `opened` | `pull_request` webhook, `opened` | `baseRef`, `draft` | `pr:{n}:opened` |
| `head_changed` | `pull_request` webhook, `synchronize` | `previousHeadSha` (`head_sha` holds the new head) | `pr:{n}:head:{sha}` |
| `review_scored` | `recordReviewScores` | `score`, `goal`, `goalReached`, `source`, `cycle`, `reviewerModel` | `pr:{n}:review_scored:{review_scores.id}` |
| `ultrafix_started` | `startLoop` | `goal`, `maxCycles`, `workEpoch` | `pr:{n}:ultrafix_started:{epoch}:{command comment}` |
| `ultrafix_ended` | `completeLoop`, `stopLoop` | `outcome` (`goal_reached`, `cycles_exhausted`, `stopped` or `failed`), `finalScore`, `reason`, `workEpoch` | `pr:{n}:ultrafix_ended:{epoch}:{command comment}` |
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

A write that leaves the status unchanged appends nothing. These writers already publish a `plan` activity event, so the journal does not publish a second one.

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

The daemon's hourly maintenance sweep (the same one that reclaims stale draft context) deletes events older than 30 days. For each pruned repository it stores `floor_seq` in `repository_event_floors`. That value is one past the highest deleted `seq`, and it never moves backwards.

A reader holding cursor `c` for a repository has missed pruned events when `c < floor_seq - 1`. This tells an expired cursor apart from an empty result. A repository that has never been pruned has floor `1`.

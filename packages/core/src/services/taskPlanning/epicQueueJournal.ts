import type { Knex } from 'knex';
import type { EpicQueueEventType } from '@propr/shared';
import { appendRepositoryEvent, capRepositoryEventReason, type RepositoryEventInput } from '../repositoryEventJournal.js';

/** The execution fields an epic queue journal event is derived from. */
export interface EpicQueueJournalRef {
  draftId: string;
  executionId: string;
  repository: string;
}

/**
 * One `epic_queue` event for an execution. The entity is the execution, so a
 * replacement execution of the same plan has its own history.
 */
export function epicQueueEvent(queue: EpicQueueJournalRef, type: EpicQueueEventType, details: {
  dedupeKey: string | null; issueNumber?: number | null; payload?: Record<string, unknown>; occurredAt?: number;
}): RepositoryEventInput {
  return {
    repository: queue.repository, domain: 'epic_queue', type, entityId: queue.executionId, planId: queue.draftId,
    issueNumber: details.issueNumber ?? null, payload: details.payload ?? {}, dedupeKey: details.dedupeKey,
    ...(details.occurredAt !== undefined ? { occurredAt: new Date(details.occurredAt) } : {}),
  };
}

export function epicQueueStartedEvent(queue: EpicQueueJournalRef & { issues: number[]; advanceOn: string; parallel: boolean },
  occurredAt: number): RepositoryEventInput {
  return epicQueueEvent(queue, 'started', { issueNumber: queue.issues[0], occurredAt,
    payload: { issues: queue.issues, advanceOn: queue.advanceOn, parallel: queue.parallel }, dedupeKey: `epic:${queue.executionId}:started` });
}

/**
 * A sequential head settled and the next issue becomes the head. Keyed by the settled
 * occurrence's position: a requeued issue gets a new position, so each occurrence advances once.
 */
export function epicQueueAdvancedEvent(queue: EpicQueueJournalRef, from: { issueNumber: number; position: number },
  to: { issueNumber: number; cursor: number }, occurredAt: number): RepositoryEventInput {
  return epicQueueEvent(queue, 'advanced', { issueNumber: to.issueNumber, occurredAt,
    payload: { fromIssue: from.issueNumber, toIssue: to.issueNumber, cursor: to.cursor },
    dedupeKey: `epic:${queue.executionId}:advanced:${from.position}` });
}

/** The execution completed; `fromIssue` names the sequential head whose settling completed it. */
export function epicQueueCompletedEvent(queue: EpicQueueJournalRef, cursor: number, occurredAt: number, fromIssue?: number): RepositoryEventInput {
  return epicQueueEvent(queue, 'completed', { issueNumber: fromIssue ?? null, occurredAt,
    payload: { ...(fromIssue !== undefined ? { fromIssue } : {}), cursor }, dedupeKey: `epic:${queue.executionId}:completed` });
}

/**
 * Journals a new blocked explanation of one issue. Called only from the transaction whose
 * guarded write made the transition (see epicQueueBlockedEvents), so the guard, not a
 * dedupe key, makes it unique: a repeated observation of the same blocker records nothing.
 */
export async function journalEpicQueueBlocked(trx: Knex, occurrence: { draftId: string; executionId: string; issueNumber: number },
  reason: string, occurredAt: number): Promise<void> {
  const row = await trx('epic_execution_queues').where({ draft_id: occurrence.draftId, execution_id: occurrence.executionId })
    .first<{ repository: string } | undefined>('repository');
  if (!row) return;
  await appendRepositoryEvent(trx, epicQueueEvent({ ...occurrence, repository: row.repository }, 'blocked', {
    issueNumber: occurrence.issueNumber, occurredAt, dedupeKey: null,
    payload: { headIssue: occurrence.issueNumber, blockedReason: capRepositoryEventReason(reason) },
  }));
}

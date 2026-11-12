import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import type { EpicQueueEventType } from '@propr/shared';
import { appendRepositoryEvent, capRepositoryEventReason, type RepositoryEventInput } from '../repositoryEventJournal.js';

/** The queue fields an epic queue journal event is derived from. */
export interface EpicQueueJournalRef {
  draftId: string;
  executionId: string;
  repository: string;
  issues: number[];
  cursor: number;
  blockedReason: string | null;
  updatedAt: number;
}

/**
 * One `epic_queue` event for an execution. The entity is the execution, so a
 * replacement execution of the same plan has its own history.
 */
export function epicQueueEvent(queue: EpicQueueJournalRef, type: EpicQueueEventType, details: {
  dedupeKey: string; issueNumber?: number | null; payload?: Record<string, unknown>; occurredAt?: number;
}): RepositoryEventInput {
  return {
    repository: queue.repository, domain: 'epic_queue', type, entityId: queue.executionId, planId: queue.draftId,
    issueNumber: details.issueNumber ?? null, payload: details.payload ?? {}, dedupeKey: details.dedupeKey,
    ...(details.occurredAt !== undefined ? { occurredAt: new Date(details.occurredAt) } : {}),
  };
}

/**
 * Apply one guarded queue update and journal it in the same transaction, so
 * the event exists exactly when the transition does. The guard decides the
 * single winner among concurrent observers; a losing update appends nothing.
 * Returns the number of rows changed.
 */
export async function updateEpicQueueWithEvent(database: Knex, guard: Record<string, unknown>,
  update: Record<string, unknown>, event: RepositoryEventInput | null): Promise<number> {
  return database.transaction(async trx => {
    const changed = await trx('epic_execution_queues').where(guard).update(update);
    if (changed && event) await appendRepositoryEvent(trx, event);
    return changed;
  });
}

/**
 * The event for a head that settled: `advanced` to the next issue, or
 * `completed` when it was the last one. Each cursor position advances once.
 */
export function epicQueueAdvanceEvent(queue: EpicQueueJournalRef, fromIssue: number, occurredAt: number): RepositoryEventInput {
  const cursor = queue.cursor + 1;
  if (cursor === queue.issues.length) {
    return epicQueueEvent(queue, 'completed', { issueNumber: fromIssue, occurredAt, payload: { fromIssue, cursor },
      dedupeKey: `epic:${queue.executionId}:completed` });
  }
  return epicQueueEvent(queue, 'advanced', { issueNumber: queue.issues[cursor], occurredAt,
    payload: { fromIssue, toIssue: queue.issues[cursor], cursor }, dedupeKey: `epic:${queue.executionId}:advanced:${cursor}` });
}

const reasonDigest = (reason: string) => createHash('sha256').update(reason).digest('hex').slice(0, 16);

/**
 * The `blocked` event for a new explanation, or null when the queue already
 * carries this one (a redelivered trigger re-writes the same reason). The key
 * includes the state the writer read, so concurrent writers of one transition
 * share it while a later re-block of the same head is a new event.
 */
export function epicQueueBlockedEvent(queue: EpicQueueJournalRef, reason: string, occurredAt?: number): RepositoryEventInput | null {
  if (reason === queue.blockedReason) return null;
  const headIssue = queue.issues[queue.cursor] ?? null;
  return epicQueueEvent(queue, 'blocked', {
    issueNumber: headIssue, occurredAt,
    payload: { headIssue, blockedReason: capRepositoryEventReason(reason) },
    dedupeKey: `epic:${queue.executionId}:blocked:${queue.cursor}:${queue.updatedAt}:${reasonDigest(reason)}`,
  });
}

/** Record a blocked explanation on the active head (guarded by its cursor) and journal it. */
export async function setEpicQueueBlocked(database: Knex, queue: EpicQueueJournalRef, reason: string,
  { timestamp, guard = {} }: { timestamp: number; guard?: Record<string, unknown> }): Promise<number> {
  return updateEpicQueueWithEvent(database,
    { draft_id: queue.draftId, execution_id: queue.executionId, status: 'active', cursor: queue.cursor, ...guard },
    { blocked_reason: reason, updated_at: timestamp }, epicQueueBlockedEvent(queue, reason, timestamp));
}

/** The journal ref of a raw `epic_execution_queues` row. */
export function epicQueueJournalRef(draftId: string, row: {
  execution_id: string; repository: string; issues: string; cursor: number; blocked_reason: string | null; updated_at: number;
}): EpicQueueJournalRef {
  return { draftId, executionId: row.execution_id, repository: row.repository, issues: JSON.parse(row.issues) as number[],
    cursor: row.cursor, blockedReason: row.blocked_reason, updatedAt: row.updated_at };
}

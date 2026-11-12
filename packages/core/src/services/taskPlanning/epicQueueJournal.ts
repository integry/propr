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

/** Attempts before a blocked write that keeps losing its compare-and-set gives up. */
const BLOCKED_WRITE_ATTEMPTS = 5;

/**
 * Record a blocked explanation on the active head (guarded by its cursor) and
 * journal it. Whether the write is a new explanation is decided from the
 * reason read inside the write's transaction, never from the caller's earlier
 * snapshot: another writer may have replaced the reason since, and returning
 * to an older explanation is still a transition. The update is also guarded on
 * the reason and timestamp that were read, and re-read on a mismatch.
 * Returns the number of rows changed.
 */
export async function setEpicQueueBlocked(database: Knex, queue: EpicQueueJournalRef, reason: string,
  { timestamp, guard = {}, dedupeSuffix = '' }: { timestamp: number; guard?: Record<string, unknown>; dedupeSuffix?: string }): Promise<number> {
  const where = { draft_id: queue.draftId, execution_id: queue.executionId, status: 'active', cursor: queue.cursor, ...guard };
  for (let attempt = 0; attempt < BLOCKED_WRITE_ATTEMPTS; attempt++) {
    const outcome = await database.transaction(async trx => {
      const current = await trx('epic_execution_queues').where(where)
        .first<{ blocked_reason: string | null; updated_at: number } | undefined>('blocked_reason', 'updated_at');
      if (!current) return 0;
      const event = epicQueueBlockedEvent({ ...queue, blockedReason: current.blocked_reason, updatedAt: current.updated_at }, reason, timestamp);
      const changed = await trx('epic_execution_queues')
        .where({ ...where, blocked_reason: current.blocked_reason, updated_at: current.updated_at })
        .update({ blocked_reason: reason, updated_at: timestamp });
      if (!changed) return null;
      if (event) await appendRepositoryEvent(trx, { ...event, dedupeKey: `${event.dedupeKey}${dedupeSuffix}` });
      return changed;
    });
    if (outcome !== null) return outcome;
  }
  return 0;
}

/** The journal ref of a raw `epic_execution_queues` row. */
export function epicQueueJournalRef(draftId: string, row: {
  execution_id: string; repository: string; issues: string; cursor: number; blocked_reason: string | null; updated_at: number;
}): EpicQueueJournalRef {
  return { draftId, executionId: row.execution_id, repository: row.repository, issues: JSON.parse(row.issues) as number[],
    cursor: row.cursor, blockedReason: row.blocked_reason, updatedAt: row.updated_at };
}

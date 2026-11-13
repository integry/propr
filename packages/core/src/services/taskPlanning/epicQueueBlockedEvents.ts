import type { Knex } from 'knex';
import { db } from '../../db/connection.js';
import logger from '../../utils/logger.js';
import { journalEpicQueueBlocked } from './epicQueueJournal.js';

/**
 * The durable log of blocked transitions in epic executions. Every queue write that can
 * block or unblock an issue records the transition here in its own transaction, right
 * after the guarded statement that changed the issue's row: that row stays locked until
 * commit, so concurrent writers in the API, webhook handling and the worker sweep are
 * serialized per occurrence, and each blocked state is recorded exactly once. A repeated
 * observation of the same blocked state (same kind and reason) records nothing; a
 * different blocker on the same issue resolves the old one (`replaced`) and records the new
 * one. Clearing records the resolution.
 *
 * Delivery (the realtime activity and the Inbox notification) runs after commit; the
 * `notified_at` outbox marker lets the recovery sweep deliver what a crash left behind.
 */
export const EPIC_QUEUE_BLOCKED_EVENTS = 'epic_queue_blocked_events';
const ISSUES = 'epic_execution_queue_issues';

export type EpicQueueBlockedEventType = 'blocked' | 'resolved';
/** How a blocker ended: cleared by the queue, replaced by another blocker, retried or skipped by a person, or settled with the issue. */
export type EpicQueueBlockedResolution = 'cleared' | 'replaced' | 'retried' | 'skipped' | 'settled';

export interface EpicQueueBlockedEvent {
  id: number;
  draftId: string;
  executionId: string;
  issueNumber: number;
  position: number;
  type: EpicQueueBlockedEventType;
  blockedKind: string;
  reason: string;
  /** For a resolved event: the blocked event it resolves and how. */
  blockedEventId: number | null;
  resolution: EpicQueueBlockedResolution | null;
  createdAt: number;
}

type EventRow = {
  id: number; draft_id: string; execution_id: string; issue_number: number; position: number; event: EpicQueueBlockedEventType;
  blocked_kind: string; blocked_reason: string; blocked_event_id: number | null; resolution: EpicQueueBlockedResolution | null;
  created_at: number | string; notified_at?: number | string | null;
};

export type BlockedOccurrence = { draftId: string; executionId: string; issueNumber: number; position: number };

export function toBlockedEvent(row: EventRow): EpicQueueBlockedEvent {
  return { id: Number(row.id), draftId: row.draft_id, executionId: row.execution_id, issueNumber: row.issue_number, position: row.position,
    type: row.event, blockedKind: row.blocked_kind, reason: row.blocked_reason,
    blockedEventId: row.blocked_event_id === null || row.blocked_event_id === undefined ? null : Number(row.blocked_event_id),
    resolution: row.resolution ?? null, createdAt: Number(row.created_at) };
}

const occurrenceWhere = (occurrence: BlockedOccurrence) => ({ draft_id: occurrence.draftId, execution_id: occurrence.executionId,
  issue_number: occurrence.issueNumber, position: occurrence.position });

/** The occurrence's latest event. */
export async function latestBlockedEvent(database: Knex, occurrence: BlockedOccurrence): Promise<EpicQueueBlockedEvent | null> {
  const row = await database(EPIC_QUEUE_BLOCKED_EVENTS).where(occurrenceWhere(occurrence)).orderBy('id', 'desc').first<EventRow | undefined>();
  return row ? toBlockedEvent(row) : null;
}

/**
 * Brings the log in line with the occurrence's row. Must run in the transaction whose guarded
 * statement just changed that row. Returns the ids it recorded.
 */
export async function syncBlockedEvents(trx: Knex, occurrence: BlockedOccurrence,
  { resolution, timestamp }: { resolution: EpicQueueBlockedResolution; timestamp: number }): Promise<number[]> {
  const row = await trx(ISSUES).where(occurrenceWhere(occurrence))
    .first<{ state: string; blocked_kind: string | null; blocked_reason: string | null } | undefined>('state', 'blocked_kind', 'blocked_reason');
  const latest = await latestBlockedEvent(trx, occurrence);
  const open = latest?.type === 'blocked' ? latest : null;
  const now = row?.state === 'blocked' && row.blocked_kind ? { kind: row.blocked_kind, reason: row.blocked_reason ?? '' } : null;
  if (open && now && open.blockedKind === now.kind && open.reason === now.reason) return [];
  const ids: number[] = [];
  const base = { ...occurrenceWhere(occurrence), created_at: timestamp, notified_at: null };
  if (open) {
    ids.push(await insertEvent(trx, { ...base, event: 'resolved', blocked_kind: open.blockedKind, blocked_reason: open.reason,
      blocked_event_id: open.id, resolution: now ? 'replaced' : resolution }));
  }
  if (now) {
    ids.push(await insertEvent(trx, { ...base, event: 'blocked', blocked_kind: now.kind, blocked_reason: now.reason,
      blocked_event_id: null, resolution: null }));
    // The repository event journal mirrors each new explanation in the same transaction.
    await journalEpicQueueBlocked(trx, occurrence, now.reason, timestamp);
  }
  return ids;
}

async function insertEvent(trx: Knex, row: Omit<EventRow, 'id'>): Promise<number> {
  const [inserted] = await trx(EPIC_QUEUE_BLOCKED_EVENTS).insert(row).returning('id');
  return Number(typeof inserted === 'object' ? (inserted as { id: number }).id : inserted);
}

type Deliver = (ids: number[], database: Knex) => Promise<void>;
const defaultDeliver: Deliver = async (ids, database) => {
  const { deliverEpicQueueBlockedEvents } = await import('./epicQueueBlockedNotify.js');
  await deliverEpicQueueBlockedEvents(ids, { database });
};
let deliver: Deliver = defaultDeliver;

/** Replaces delivery (tests); null restores the default. Returns the previous one. */
export function setEpicQueueBlockedEventDelivery(next: Deliver | null): Deliver {
  const previous = deliver;
  deliver = next ?? defaultDeliver;
  return previous;
}

async function deliverSafely(ids: number[], database: Knex): Promise<void> {
  if (!ids.length) return;
  try { await deliver(ids, database); }
  catch (error) { logger.warn?.({ ids, error: (error as Error).message }, 'Could not deliver epic queue blocked events; the sweep retries'); }
}

type Recorder = (occurrence: BlockedOccurrence, resolution: EpicQueueBlockedResolution, timestamp: number) => Promise<void>;

/**
 * Runs a queue write and the event log in one transaction (the caller's, when there is one),
 * then delivers the recorded events after commit. `record` syncs one occurrence the work just wrote.
 */
export async function withBlockedEvents<T>(database: Knex, work: (trx: Knex, record: Recorder) => Promise<T>): Promise<T> {
  const ids: number[] = [];
  const run = (trx: Knex) => work(trx, async (occurrence, resolution, timestamp) => {
    ids.push(...await syncBlockedEvents(trx, occurrence, { resolution, timestamp }));
  });
  const transaction = database as Knex.Transaction;
  if (transaction.isTransaction) {
    const result = await run(database);
    // Delivered once the caller's transaction commits; a rollback records nothing.
    // After commit the transaction can no longer be queried, so delivery reads through the connection.
    transaction.executionPromise?.then(() => deliverSafely(ids, db), () => undefined);
    return result;
  }
  const result = await database.transaction(trx => run(trx));
  await deliverSafely(ids, database);
  return result;
}

/** Lists an execution's blocked and resolved events after a cursor, oldest first. */
export async function listEpicQueueBlockedEvents(draftId: string, { executionId, cursor, limit = 50, database = db }:
  { executionId?: string; cursor?: string | null; limit?: number; database?: Knex } = {}): Promise<{
    executionId: string | null; events: EpicQueueBlockedEvent[]; nextCursor: string | null; hasMore: boolean;
  }> {
  const execution = executionId ?? (await database('epic_execution_queues').where({ draft_id: draftId }).first('execution_id'))?.execution_id ?? null;
  if (!execution) return { executionId: null, events: [], nextCursor: cursor ?? null, hasMore: false };
  const after = parseCursor(cursor);
  const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = await database(EPIC_QUEUE_BLOCKED_EVENTS).where({ draft_id: draftId, execution_id: execution })
    .where('id', '>', after).orderBy('id').limit(bounded + 1).select<EventRow[]>();
  const events = rows.slice(0, bounded).map(toBlockedEvent);
  return { executionId: execution, events, hasMore: rows.length > bounded,
    nextCursor: events.length ? String(events.at(-1)!.id) : cursor ?? null };
}

export class InvalidBlockedEventCursorError extends Error {
  constructor() { super('cursor must be a cursor returned by an earlier page.'); }
}

function parseCursor(cursor: string | null | undefined): number {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  if (!/^\d{1,15}$/.test(cursor)) throw new InvalidBlockedEventCursorError();
  return Number(cursor);
}

/** Events whose delivery a crash interrupted, for the recovery sweep. */
export async function undeliveredBlockedEventIds(database: Knex, { olderThan, limit = 100 }: { olderThan: number; limit?: number }): Promise<number[]> {
  return (await database(EPIC_QUEUE_BLOCKED_EVENTS).whereNull('notified_at').where('created_at', '<', olderThan)
    .orderBy('id').limit(limit).pluck('id')).map(Number);
}

/** Delivers the events a crash left undelivered. */
export async function deliverPendingEpicQueueBlockedEvents({ database = db, now = Date.now, graceMs = 60_000 }:
  { database?: Knex; now?: () => number; graceMs?: number } = {}): Promise<number> {
  const ids = await undeliveredBlockedEventIds(database, { olderThan: now() - graceMs });
  await deliverSafely(ids, database);
  return ids.length;
}

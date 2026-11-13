import type { Knex } from 'knex';
import { normalizeAutomationEventTriggers, type AutomationEventTrigger, type AutomationTriggerEventType } from '@propr/shared';
import { db } from '../../db/connection.js';
import { rowToAgentRun, type AgentRunRow, type StoredAgentRun } from './agentRunStore.js';

/**
 * Storage behind automation event triggers. Events are consumed from their durable record
 * (for `plan.issue_blocked`, `epic_queue_blocked_events`) by the worker, with one cursor per
 * definition and event; the queue write that records an event never calls automation code.
 *
 * A cursor is moved to the newest event whenever a definition subscribes to an event or is
 * enabled again, in the same transaction as that change, so events from before the
 * subscription or from while the definition was disabled are skipped rather than run late.
 */

const DEFINITIONS = 'agent_definitions';
const RUNS = 'agent_runs';
const CURSORS = 'agent_definition_event_cursors';
const BLOCKED_EVENTS = 'epic_queue_blocked_events';

type Subscriber = { enabled: boolean; eventTriggers: readonly AutomationEventTrigger[] };

/** One `plan.issue_blocked` record with the plan fields a run needs. */
export interface PlanIssueBlockedEventRecord {
  id: number;
  draftId: string;
  executionId: string;
  issueNumber: number;
  blockedKind: string;
  reason: string;
  createdAt: number;
  repository: string | null;
  planName: string | null;
}

/**
 * Whether a change starts a subscription afresh: the definition is enabled after it, and it
 * was disabled before or subscribes to an event it did not subscribe to before.
 */
export function eventCursorResetNeeded(before: Subscriber, after: Subscriber): boolean {
  if (!after.enabled || after.eventTriggers.length === 0) return false;
  if (!before.enabled) return true;
  const previous = new Set(before.eventTriggers.map(trigger => trigger.event));
  return after.eventTriggers.some(trigger => !previous.has(trigger.event));
}

/** The newest recorded event id of a type; 0 when there is none. */
export async function latestTriggerEventId(database: Knex, event: AutomationTriggerEventType): Promise<number> {
  if (event !== 'plan.issue_blocked') return 0;
  const row = await database(BLOCKED_EVENTS).max<{ id: number | string | null }>({ id: 'id' }).first();
  return Number(row?.id ?? 0);
}

/**
 * Points every subscription of the definition at the newest event and drops cursors of
 * events it no longer subscribes to. Run it in the transaction that made the change.
 */
export async function resetAgentDefinitionEventCursors(
  trx: Knex,
  definition: { id: string; eventTriggers: readonly AutomationEventTrigger[] },
  timestamp: number,
): Promise<void> {
  const events = [...new Set(definition.eventTriggers.map(trigger => trigger.event))];
  await trx(CURSORS).where({ definition_id: definition.id }).whereNotIn('event', events.length ? events : ['']).delete();
  for (const event of events) {
    const cursor = await latestTriggerEventId(trx, event);
    await trx(CURSORS).insert({ definition_id: definition.id, event, cursor, updated_at: timestamp })
      .onConflict(['definition_id', 'event']).merge({ cursor, updated_at: timestamp });
  }
}

/** The definition's cursor for an event, or null when none was recorded. */
export async function getAgentDefinitionEventCursor(
  definitionId: string,
  event: AutomationTriggerEventType,
  { database = db }: { database?: Knex } = {},
): Promise<number | null> {
  const row = await database(CURSORS).where({ definition_id: definitionId, event }).first<{ cursor: number | string } | undefined>('cursor');
  return row ? Number(row.cursor) : null;
}

/**
 * Records a cursor the first time a subscriber is seen without one (a definition written
 * before cursors existed): it starts at the newest event. Returns the stored cursor.
 */
export async function initializeAgentDefinitionEventCursor(
  definitionId: string,
  event: AutomationTriggerEventType,
  { database = db, now = Date.now }: { database?: Knex; now?: () => number } = {},
): Promise<number> {
  const cursor = await latestTriggerEventId(database, event);
  await database(CURSORS).insert({ definition_id: definitionId, event, cursor, updated_at: now() })
    .onConflict(['definition_id', 'event']).ignore();
  return (await getAgentDefinitionEventCursor(definitionId, event, { database })) ?? cursor;
}

/**
 * Moves a cursor from the value the caller read to `to`. Only one of two concurrent sweeps
 * succeeds; the other gets false and stops handling the definition.
 */
export async function advanceAgentDefinitionEventCursor(
  definitionId: string,
  event: AutomationTriggerEventType,
  { from, to }: { from: number; to: number },
  { database = db, now = Date.now }: { database?: Knex; now?: () => number } = {},
): Promise<boolean> {
  const updated = await database(CURSORS).where({ definition_id: definitionId, event, cursor: from })
    .update({ cursor: to, updated_at: now() });
  return Number(updated) > 0;
}

/**
 * The admission fence for one event run, called inside the transaction that records the
 * run's receipt. It holds the definition row and the definition's cursor row, and confirms
 * that the definition is still at the revision the caller matched the event against and
 * would run it with (so an edit that narrowed its repositories or the subscription's filters
 * meanwhile refuses the receipt), that it is still enabled and subscribed, and that the cursor
 * is still the one the caller read the event under. A subscribe or re-enable resets the
 * cursor in its own transaction, so a batch read before that reset is refused here instead of
 * starting an event from while the definition was disabled. False means no receipt may be
 * recorded; the caller retries the event with the definition as stored now.
 */
export async function holdAgentDefinitionEventCursor(
  trx: Knex,
  { definitionId, revision, event, cursor }: { definitionId: string; revision: number; event: AutomationTriggerEventType; cursor: number },
  { now = Date.now }: { now?: () => number } = {},
): Promise<boolean> {
  // The definition is locked first, as an edit locks it before resetting cursors, so the two
  // cannot deadlock. A shared lock: an edit waits for this receipt to commit (and then applies
  // to later events only), while other receipts of the definition are not held up.
  // better-sqlite3 has no row locks; its transactions are serialized by the database lock.
  const definition = trx(DEFINITIONS).where({ id: definitionId });
  const row = await (trx.client.config.client === 'better-sqlite3' ? definition : definition.forShare())
    .first<{ enabled: boolean | number; event_triggers: string | null; revision: number | string } | undefined>('enabled', 'event_triggers', 'revision');
  if (!row?.enabled || Number(row.revision) !== revision) return false;
  let triggers: unknown = [];
  try { triggers = JSON.parse(row.event_triggers ?? '[]'); } catch { return false; }
  if (!normalizeAutomationEventTriggers(triggers).some(trigger => trigger.event === event)) return false;
  // A write, not a read: it locks the row until the receipt commits, so a concurrent sweep
  // moving the cursor waits for this admission or this admission sees its cursor.
  const held = await trx(CURSORS).where({ definition_id: definitionId, event, cursor }).update({ updated_at: now() });
  return Number(held) > 0;
}

/**
 * Ids of enabled definitions that subscribe to at least one event, after `afterId`. A single
 * indexed read; an instance without subscribers does nothing else.
 */
export async function listEventSubscribedAgentDefinitionIds(
  limit: number,
  afterId: string | null,
  { database = db }: { database?: Knex } = {},
): Promise<string[]> {
  const query = database(DEFINITIONS).where({ enabled: true }).whereNot('event_triggers', '[]');
  if (afterId !== null) query.where('id', '>', afterId);
  return query.orderBy('id').limit(Math.max(1, Math.trunc(limit))).pluck('id');
}

/**
 * `plan.issue_blocked` events after a cursor and up to `through`, oldest first, with their
 * plan's repository and name. `through` must be a `committedBlockedEventWatermark`: an id
 * above it may belong to a write that is still in progress, behind which a lower id can
 * still commit, and a cursor moved past that lower id would never deliver it.
 */
export async function listPlanIssueBlockedEventsAfter(
  cursor: number,
  limit: number,
  { database = db, through }: { database?: Knex; through: number },
): Promise<PlanIssueBlockedEventRecord[]> {
  if (through <= cursor) return [];
  const rows = await database(`${BLOCKED_EVENTS} as e`).leftJoin('task_drafts as d', 'd.draft_id', 'e.draft_id')
    .where('e.event', 'blocked').where('e.id', '>', cursor).where('e.id', '<=', through).orderBy('e.id').limit(Math.max(1, Math.trunc(limit)))
    .select<Array<Record<string, unknown>>>('e.id', 'e.draft_id', 'e.execution_id', 'e.issue_number', 'e.blocked_kind', 'e.blocked_reason',
      'e.created_at', 'd.repository', 'd.name');
  return rows.map(row => ({
    id: Number(row.id), draftId: String(row.draft_id), executionId: String(row.execution_id), issueNumber: Number(row.issue_number),
    blockedKind: String(row.blocked_kind), reason: String(row.blocked_reason ?? ''), createdAt: Number(row.created_at),
    repository: typeof row.repository === 'string' && row.repository ? row.repository : null,
    planName: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null,
  }));
}

/** How many runs of a definition an event subject (one issue of one plan) started; skipped runs do not count. */
export async function countAgentRunsForTriggerSubject(
  definitionId: string,
  subject: string,
  { database = db }: { database?: Knex } = {},
): Promise<number> {
  const row = await database(RUNS).where({ definition_id: definitionId, trigger_subject: subject }).whereNot('state', 'skipped')
    .count<{ count: number | string }[]>({ count: '*' }).first();
  return Number(row?.count ?? 0);
}

/** Where a page of `listUndispatchedEventAgentRuns` ends; the next page starts after it. */
export interface UndispatchedEventAgentRunCursor {
  updatedAt: number;
  id: string;
}

/**
 * Accepted `event` runs still `queued` that have not changed since `before`: the dispatch
 * obligation of a receipt whose enqueue failed. It is kept by the run itself, not by the
 * event cursor, so a subscription reset (re-enable, resubscribe) that moves the cursor past
 * the event does not drop it. Runs a deferred retry admitted (`deferred_until` set) are
 * dispatched by that retry's consumer. Oldest first by `(updated_at, id)`, on the
 * `(state, deferred_until)` index; pass the last run of a page as `after` for the next page,
 * so runs the caller passes over (an offboarded owner's) never hide the ones after them.
 */
export async function listUndispatchedEventAgentRuns(
  before: number,
  limit: number,
  { database = db, after = null }: { database?: Knex; after?: UndispatchedEventAgentRunCursor | null } = {},
): Promise<StoredAgentRun[]> {
  const query = database(RUNS).where({ state: 'queued', trigger: 'event' }).whereNull('deferred_until')
    .where('updated_at', '<=', before);
  if (after) {
    query.where(next => next.where('updated_at', '>', after.updatedAt)
      .orWhere(same => same.where('updated_at', after.updatedAt).where('id', '>', after.id)));
  }
  const rows = await query.orderBy([{ column: 'updated_at', order: 'asc' }, { column: 'id', order: 'asc' }])
    .limit(Math.max(1, Math.trunc(limit))).select<AgentRunRow[]>();
  return rows.map(rowToAgentRun);
}

/**
 * Cursor reads and bounded waits on the repository change-event journal
 * (`repository_events`), shared by MCP `list_repository_events` /
 * `wait_repository_events` and `GET /api/repository-events[/wait]` (used by
 * `propr events list|wait`).
 *
 * Modelled on `goalWait.ts`. The journal's `seq` is AUTOINCREMENT and SQLite
 * serializes writers, so `seq` order is commit order: every decision is taken
 * against one snapshot bound (the repository's newest `seq`, read first), and
 * events at or below it never change. Wake-ups only make a waiter re-read
 * early; a waiter registers before its first read, so an append committed
 * between the read and the wait still wakes it, and a slow fallback poll
 * covers appends made by other processes.
 *
 * Delivery is at-least-once: the returned cursor is the position of the last
 * returned event (or the starting position when none is returned), so a client
 * that resumes from the last cursor it processed never misses an event.
 */
import { EventEmitter } from 'node:events';
import type { Knex } from 'knex';
import {
  REPOSITORY_EVENT_ERRORS,
  REPOSITORY_EVENT_LIST_DEFAULT_LIMIT,
  REPOSITORY_EVENT_LIST_MAX_LIMIT,
  decodeRepositoryEventCursor,
  encodeRepositoryEventCursor,
  type RepositoryEventDomain,
  type RepositoryEventErrorCode,
  type RepositoryEventListResult,
  type RepositoryEventView,
  type RepositoryEventWaitResult,
} from '@propr/shared';

/** Fallback re-read interval when no wake-up arrives. Not a busy poll. */
export const REPOSITORY_EVENT_WAIT_POLL_INTERVAL_MS = 2_500;
/**
 * Concurrent repository event waits one owner may hold open on this API
 * process, shared by REST (`propr events wait`) and MCP
 * `wait_repository_events`. Each API replica keeps its own count.
 */
export const REPOSITORY_EVENT_WAIT_MAX_CONCURRENT_PER_OWNER = 16;

export class RepositoryEventWaitError extends Error {
  readonly recovery: string;
  constructor(
    readonly code: RepositoryEventErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RepositoryEventWaitError';
    this.recovery = REPOSITORY_EVENT_ERRORS[code];
  }
}

// ---------------------------------------------------------------------------
// Wake-ups
// ---------------------------------------------------------------------------

const wakeHub = new EventEmitter();
wakeHub.setMaxListeners(0);
const wakeKey = (repository: string) => repository.toLowerCase();

/** Wake every waiter on this repository. Safe to call for repositories nobody waits on. */
export function notifyRepositoryEventWaiters(repository: unknown): void {
  if (typeof repository === 'string' && repository) wakeHub.emit(wakeKey(repository));
}

export type RepositoryEventWaitSubscribe = (repository: string, listener: () => void) => () => void;

const subscribeToHub: RepositoryEventWaitSubscribe = (repository, listener) => {
  const key = wakeKey(repository);
  wakeHub.on(key, listener);
  return () => { wakeHub.off(key, listener); };
};

/** Registered wake listeners, for leak checks. */
export function activeRepositoryEventWaiterCount(repository?: string): number {
  if (repository) return wakeHub.listenerCount(wakeKey(repository));
  return wakeHub.eventNames().reduce((total, name) => total + wakeHub.listenerCount(name), 0);
}

let appendHook: Promise<boolean> | null = null;
/**
 * Make appends committed in this process (for example a webhook the API
 * handles) wake waiters at once; appends of other processes arrive as
 * activity events through the socket relay, or on the next poll. Called once
 * at API startup. Core is loaded lazily so this module adds no static import
 * to `@propr/core`, and a core build without the hook is tolerated. Resolves
 * to whether the hook is installed.
 */
export function installRepositoryEventAppendHook(): Promise<boolean> {
  appendHook ??= import('@propr/core').then(core => {
    const subscribe = (core as { subscribeRepositoryEventAppends?: (listener: (repository: string) => void) => () => void })
      .subscribeRepositoryEventAppends;
    if (typeof subscribe !== 'function') return false;
    subscribe(notifyRepositoryEventWaiters);
    return true;
  }, () => { appendHook = null; return false; });
  return appendHook;
}

const activeByOwner = new Map<string, number>();

// ---------------------------------------------------------------------------
// Journal reads
// ---------------------------------------------------------------------------

export interface RepositoryEventFilters {
  domains?: readonly RepositoryEventDomain[];
  types?: readonly string[];
  pullRequest?: number;
  planId?: string;
}

export interface RepositoryEventListOptions extends RepositoryEventFilters {
  db: Knex;
  /** `owner/repo` as the journal records it. */
  repository: string;
  afterCursor?: string;
  /** Without a cursor, start at the oldest retained event instead of the current end. */
  fromStart?: boolean;
  limit?: number;
}

export interface RepositoryEventWaitOptions extends RepositoryEventListOptions {
  ownerId: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
  /** Extra authorization re-checked before every read after the first (for example grant revocation). */
  authorize?: () => Promise<void>;
  pollIntervalMs?: number;
  subscribe?: RepositoryEventWaitSubscribe;
  maxConcurrentPerOwner?: number;
}

interface RepositoryEventRow {
  seq: number; repository: string; domain: RepositoryEventDomain; type: string; entity_id: string;
  pr_number: number | null; issue_number: number | null; plan_id: string | null; head_sha: string | null;
  payload: string | null; occurred_at: string;
}

const EVENT_COLUMNS = ['seq', 'repository', 'domain', 'type', 'entity_id', 'pr_number', 'issue_number', 'plan_id', 'head_sha', 'payload', 'occurred_at'];

function eventView(row: RepositoryEventRow, repository: string): RepositoryEventView {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch { /* a malformed payload reads as empty */ }
  return {
    cursor: encodeRepositoryEventCursor(repository, Number(row.seq)),
    domain: row.domain,
    type: row.type,
    repository: row.repository,
    ...(row.pr_number === null || row.pr_number === undefined ? {} : { pullRequest: Number(row.pr_number) }),
    ...(row.issue_number === null || row.issue_number === undefined ? {} : { issueNumber: Number(row.issue_number) }),
    ...(row.plan_id ? { planId: row.plan_id } : {}),
    entityId: row.entity_id,
    ...(row.head_sha ? { head: row.head_sha } : {}),
    payload,
    occurredAt: row.occurred_at,
  };
}

function limitOf(value: number | undefined): number {
  const limit = Math.trunc(value ?? REPOSITORY_EVENT_LIST_DEFAULT_LIMIT);
  if (!Number.isFinite(limit) || limit < 1 || limit > REPOSITORY_EVENT_LIST_MAX_LIMIT) {
    throw new RepositoryEventWaitError('INVALID_INPUT', `limit must be an integer from 1 to ${REPOSITORY_EVENT_LIST_MAX_LIMIT}.`, 400);
  }
  return limit;
}

/** The repository's newest `seq` (0 when it has none): the snapshot bound of one read. */
async function journalBound(db: Knex, repository: string): Promise<number> {
  const newest = await db('repository_events').where({ repository }).max({ seq: 'seq' }).first();
  return Number(newest?.seq ?? 0);
}

/**
 * Highest position this instance has ever issued: the newest `seq` of the
 * whole journal, or the position retention last pruned past when that is
 * higher. A cursor beyond it was never issued here.
 */
async function issuedHigh(db: Knex): Promise<number> {
  const [events, floors] = await Promise.all([
    db('repository_events').max({ seq: 'seq' }).first(),
    db('repository_event_floors').max({ floor: 'floor_seq' }).first(),
  ]);
  return Math.max(Number(events?.seq ?? 0), Number(floors?.floor ?? 1) - 1);
}

/** Validate a cursor and return the `seq` to read after. */
async function resolveStart(db: Knex, repository: string, options: Pick<RepositoryEventListOptions, 'afterCursor' | 'fromStart'>): Promise<number> {
  if (options.afterCursor === undefined) return options.fromStart ? 0 : journalBound(db, repository);
  const decoded = decodeRepositoryEventCursor(options.afterCursor, repository);
  if (!decoded.ok) {
    const message = decoded.code === 'CURSOR_WRONG_REPOSITORY'
      ? 'afterCursor was issued for a different repository.' : 'afterCursor is not a repository event cursor.';
    throw new RepositoryEventWaitError(decoded.code, message, 400);
  }
  if (decoded.seq > await issuedHigh(db)) {
    throw new RepositoryEventWaitError('CURSOR_INVALID', 'afterCursor does not match this instance\'s journal.', 400);
  }
  // A cursor at or above floor - 1 has missed nothing; below it, retention may have pruned events after it.
  const floorRow = await db('repository_event_floors').where({ repository }).first<{ floor_seq: number } | undefined>('floor_seq');
  const floor = floorRow ? Number(floorRow.floor_seq) : 1;
  if (decoded.seq < floor - 1) {
    throw new RepositoryEventWaitError('CURSOR_EXPIRED', 'afterCursor refers to journal history that is no longer retained.', 410);
  }
  return decoded.seq;
}

/** Matching events in (after, bound], at most `limit + 1` so truncation is known without a second read. */
async function readPage(db: Knex, filters: RepositoryEventFilters & { repository: string; after: number; bound: number; limit: number }) {
  const { repository, after, bound, limit } = filters;
  const query = db('repository_events').where({ repository }).where('seq', '>', after).where('seq', '<=', bound);
  if (filters.domains?.length) query.whereIn('domain', [...filters.domains]);
  if (filters.types?.length) query.whereIn('type', [...filters.types]);
  if (filters.pullRequest !== undefined) query.where('pr_number', filters.pullRequest);
  if (filters.planId !== undefined) query.where('plan_id', filters.planId);
  const rows = await query.orderBy('seq', 'asc').limit(limit + 1).select<RepositoryEventRow[]>(EVENT_COLUMNS);
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

function pageResult(repository: string, start: number, page: { rows: RepositoryEventRow[]; truncated: boolean }): RepositoryEventListResult {
  const last = page.rows.at(-1);
  return {
    events: page.rows.map(row => eventView(row, repository)),
    cursor: encodeRepositoryEventCursor(repository, last ? Number(last.seq) : start),
    truncated: page.truncated,
  };
}

/**
 * Events of one repository after a cursor, in `seq` order. Without a cursor
 * the read starts at the current end of the journal (no history, just the
 * current cursor) unless `fromStart` is set.
 */
export async function listRepositoryEventsAfterCursor(options: RepositoryEventListOptions): Promise<RepositoryEventListResult> {
  const { db, repository } = options;
  const limit = limitOf(options.limit);
  const start = await resolveStart(db, repository, options);
  const bound = await journalBound(db, repository);
  return pageResult(repository, start, await readPage(db, { ...options, after: start, bound, limit }));
}

function acquireWaitSlot(ownerId: string, maxConcurrent: number): void {
  const active = activeByOwner.get(ownerId) ?? 0;
  if (active >= maxConcurrent) {
    throw new RepositoryEventWaitError('WAIT_LIMIT',
      `At most ${maxConcurrent} repository event waits may be open at once per owner on this server; ${active} are open across propr events wait and MCP wait_repository_events.`, 429);
  }
  activeByOwner.set(ownerId, active + 1);
}

function releaseWaitSlot(ownerId: string): void {
  const remaining = (activeByOwner.get(ownerId) ?? 1) - 1;
  if (remaining > 0) activeByOwner.set(ownerId, remaining);
  else activeByOwner.delete(ownerId);
}

function abortedError(): RepositoryEventWaitError {
  return new RepositoryEventWaitError('WAIT_ABORTED', 'The wait was cancelled. Nothing in the repository changed.', 499);
}

/**
 * Wait until a matching event exists after the cursor, or the timeout
 * elapses. Returns at once when matching events already exist. A timeout
 * returns the cursor the wait started from, unchanged.
 */
export async function waitForRepositoryEvents(options: RepositoryEventWaitOptions): Promise<RepositoryEventWaitResult> {
  const { db, ownerId, repository } = options;
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, options.timeoutSeconds) * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? REPOSITORY_EVENT_WAIT_POLL_INTERVAL_MS;
  const limit = limitOf(options.limit);
  if (options.signal?.aborted) throw abortedError();

  acquireWaitSlot(ownerId, options.maxConcurrentPerOwner ?? REPOSITORY_EVENT_WAIT_MAX_CONCURRENT_PER_OWNER);

  // Register before the first read: an append committed after this point always wakes us.
  let woken = false;
  let release: (() => void) | null = null;
  const wake = () => { woken = true; release?.(); };
  const unsubscribe = (options.subscribe ?? subscribeToHub)(repository, wake);
  options.signal?.addEventListener('abort', wake);

  const result = (start: number, page: { rows: RepositoryEventRow[]; truncated: boolean }): RepositoryEventWaitResult => ({
    outcome: page.rows.length ? 'events' : 'timeout',
    ...pageResult(repository, start, page),
    waitedMs: Date.now() - startedAt,
    timeoutSeconds: options.timeoutSeconds,
  });

  try {
    const start = await resolveStart(db, repository, options);
    for (;;) {
      woken = false;
      const bound = await journalBound(db, repository);
      const page = await readPage(db, { ...options, after: start, bound, limit });
      if (page.rows.length) return result(start, page);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return result(start, page);
      if (options.signal?.aborted) throw abortedError();
      if (!woken) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { release = null; resolve(); }, Math.min(pollIntervalMs, remaining));
          release = () => { clearTimeout(timer); release = null; resolve(); };
        });
      }
      if (options.signal?.aborted) throw abortedError();
      // Access is re-checked before any further event can be returned.
      await options.authorize?.();
    }
  } finally {
    release = null;
    unsubscribe();
    options.signal?.removeEventListener('abort', wake);
    releaseWaitSlot(ownerId);
  }
}

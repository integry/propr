/**
 * Cursor reads and bounded waits on the repository change-event journal
 * (`repository_events`), shared by MCP `list_repository_events` /
 * `wait_repository_events` and `GET /api/repository-events[/wait]` (used by
 * `propr events list|wait`).
 *
 * Modelled on `goalWait.ts`. The journal's `seq` is AUTOINCREMENT and SQLite
 * serializes writers, so `seq` order is commit order. Each read runs in one
 * transaction: the retention floor its start is checked against, its bound
 * (the repository's newest `seq`, or the floor when that is higher) and its
 * page come from a single database snapshot, so retention cannot delete
 * unread events between the check and the page. Repository names match
 * case-insensitively. Wake-ups only make a waiter re-read
 * early; a waiter registers before its first read, so an append committed
 * between the read and the wait still wakes it, and a slow fallback poll
 * covers appends made by other processes.
 *
 * Delivery is at-least-once: the returned cursor is the position of the last
 * returned event (or the starting position when none is returned), so a client
 * that resumes from the last cursor it processed never misses an event.
 *
 * Retention deletes by age, so unexpired events can remain below the floor. A
 * `fromStart` read pages through them with cursors that carry the retention
 * generation they were issued under; such a cursor stays valid below the floor
 * until retention next prunes the repository. A cursor without a generation
 * below `floor - 1` is expired, as before.
 */
import { createHash } from 'node:crypto';
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
  /** `owner/repo`, matched case-insensitively against the journal. */
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

function eventView(row: RepositoryEventRow, repository: string, cursorAt: (seq: number) => string): RepositoryEventView {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch { /* a malformed payload reads as empty */ }
  return {
    cursor: cursorAt(Number(row.seq)),
    domain: row.domain,
    type: row.type,
    // The requested spelling: identity is case-insensitive and rows may be stored under another.
    repository,
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

/**
 * Repository identity is case-insensitive (GitHub's is): a webhook can record
 * `Acme/App` while the configuration says `acme/app`, and retention keeps one
 * floor per stored spelling. Every journal lookup matches all spellings.
 */
function whereRepository(query: Knex.QueryBuilder, repository: string): Knex.QueryBuilder {
  return query.whereRaw('repository = ? COLLATE NOCASE', [repository]);
}

/**
 * The repository's retention floor (1 when nothing was ever pruned): the
 * highest floor recorded under any spelling of its name.
 */
async function retentionFloor(db: Knex, repository: string): Promise<number> {
  const row = await whereRepository(db('repository_event_floors'), repository).max({ floor: 'floor_seq' }).first();
  return Math.max(1, Number(row?.floor ?? 1));
}

/**
 * The snapshot bound of one read: the repository's newest `seq`, or the
 * position retention pruned past when that is higher (a completely pruned
 * repository has no rows but must still issue a cursor that is not expired).
 */
async function journalBound(db: Knex, repository: string, floor: number): Promise<number> {
  const newest = await whereRepository(db('repository_events'), repository).max({ seq: 'seq' }).first();
  return Math.max(Number(newest?.seq ?? 0), floor - 1);
}

/**
 * Retention generation of a repository: a digest of its floor rows (floor and
 * prune time under every stored spelling). Every prune that deletes any of the
 * repository's events rewrites `pruned_at`, even when the floor itself does not
 * move (only events below it expired), so an unchanged generation means
 * nothing of the repository was deleted since the generation was observed.
 */
async function retentionGeneration(db: Knex, repository: string): Promise<string> {
  const rows = await whereRepository(db('repository_event_floors'), repository)
    .orderBy('repository', 'asc').select<Array<{ repository: string; floor_seq: number; pruned_at: string | null }>>('repository', 'floor_seq', 'pruned_at');
  const text = JSON.stringify(rows.map(row => [row.repository, Number(row.floor_seq), row.pruned_at ?? null]));
  return createHash('sha256').update(text).digest('base64url').slice(0, 22);
}

/**
 * Highest position this instance has ever issued: the newest `seq` of the
 * whole journal, or the position retention last pruned past when that is
 * higher. A cursor beyond it was never issued here.
 */
async function issuedHigh(db: Knex): Promise<number> {
  const events = await db('repository_events').max({ seq: 'seq' }).first();
  const floors = await db('repository_event_floors').max({ floor: 'floor_seq' }).first();
  return Math.max(Number(events?.seq ?? 0), Number(floors?.floor ?? 1) - 1);
}

/** Where a read starts: after a validated cursor, at the current end, or (`fromStart`) at the beginning. */
type ReadStart = { kind: 'cursor'; seq: number; generation?: string } | { kind: 'end' } | { kind: 'beginning' };

/** Decode a cursor; its position is validated against the journal inside each read. */
function parseStart(repository: string, options: Pick<RepositoryEventListOptions, 'afterCursor' | 'fromStart'>): ReadStart {
  if (options.afterCursor === undefined) return options.fromStart ? { kind: 'beginning' } : { kind: 'end' };
  const decoded = decodeRepositoryEventCursor(options.afterCursor, repository);
  if (!decoded.ok) {
    const message = decoded.code === 'CURSOR_WRONG_REPOSITORY'
      ? 'afterCursor was issued for a different repository.' : 'afterCursor is not a repository event cursor.';
    throw new RepositoryEventWaitError(decoded.code, message, 400);
  }
  return { kind: 'cursor', seq: decoded.seq, ...(decoded.generation ? { generation: decoded.generation } : {}) };
}

const expiredError = () =>
  new RepositoryEventWaitError('CURSOR_EXPIRED', 'afterCursor refers to journal history that is no longer retained.', 410);

type Page = { rows: RepositoryEventRow[]; truncated: boolean };
interface Snapshot { after: number; page: Page; floor: number; generation: string }

/** Matching events in (after, bound], at most `limit + 1` so truncation is known without a second read. */
async function readPage(db: Knex, filters: RepositoryEventFilters & { repository: string; after: number; bound: number; limit: number }): Promise<Page> {
  const { repository, after, bound, limit } = filters;
  const query = whereRepository(db('repository_events'), repository).where('seq', '>', after).where('seq', '<=', bound);
  if (filters.domains?.length) query.whereIn('domain', [...filters.domains]);
  if (filters.types?.length) query.whereIn('type', [...filters.types]);
  if (filters.pullRequest !== undefined) query.where('pr_number', filters.pullRequest);
  if (filters.planId !== undefined) query.where('plan_id', filters.planId);
  const rows = await query.orderBy('seq', 'asc').limit(limit + 1).select<RepositoryEventRow[]>(EVENT_COLUMNS);
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

/**
 * One read, taken in a single transaction so the retention floor it checks
 * the start against, the bound and the page all come from one database
 * snapshot: retention committing in between cannot delete unread events after
 * the check and leave an empty or gapped page that reports success. A cursor
 * (or a position a wait already established) below `floor - 1` may have had
 * events after it pruned, so it is expired, unless it continues a `fromStart`
 * read of retained history and carries the repository's current retention
 * generation (nothing of the repository was pruned since it was issued).
 */
async function readSnapshot(db: Knex, options: RepositoryEventFilters & { repository: string; start: ReadStart; limit: number }): Promise<Snapshot> {
  return db.transaction(async trx => {
    const { start } = options;
    if (start.kind === 'cursor' && start.seq > await issuedHigh(trx)) {
      throw new RepositoryEventWaitError('CURSOR_INVALID', 'afterCursor does not match this instance\'s journal.', 400);
    }
    const floor = await retentionFloor(trx, options.repository);
    const generation = await retentionGeneration(trx, options.repository);
    if (start.kind === 'cursor' && start.seq < floor - 1 && start.generation !== generation) throw expiredError();
    const bound = await journalBound(trx, options.repository, floor);
    const after = start.kind === 'cursor' ? start.seq : start.kind === 'end' ? bound : 0;
    return { after, floor, generation, page: await readPage(trx, { ...options, after, bound, limit: options.limit }) };
  });
}

/**
 * The position to resume from: the last returned event, or the start when
 * none was returned. A complete page also covers every retained event up to
 * the floor, so its cursor is never left below `floor - 1` (a `fromStart`
 * read of a pruned repository). A truncated page keeps its position, even
 * below the floor, so retained history is not skipped; that cursor carries
 * the retention generation (see `cursorAt`).
 */
function resumeSeq(snapshot: Snapshot): number {
  const last = snapshot.page.rows.at(-1);
  const seq = last ? Number(last.seq) : snapshot.after;
  return snapshot.page.truncated ? seq : Math.max(seq, snapshot.floor - 1);
}

/**
 * Cursor for a position read in this snapshot. Below `floor - 1` only retained
 * history of a `fromStart` read is returned, so the cursor carries the
 * retention generation that keeps it resumable there.
 */
function cursorAt(repository: string, snapshot: Snapshot, seq: number): string {
  return encodeRepositoryEventCursor(repository, seq, seq < snapshot.floor - 1 ? snapshot.generation : undefined);
}

function pageResult(repository: string, snapshot: Snapshot): RepositoryEventListResult {
  const cursorOf = (seq: number) => cursorAt(repository, snapshot, seq);
  return {
    events: snapshot.page.rows.map(row => eventView(row, repository, cursorOf)),
    cursor: cursorOf(resumeSeq(snapshot)),
    truncated: snapshot.page.truncated,
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
  const start = parseStart(repository, options);
  return pageResult(repository, await readSnapshot(db, { ...options, start, limit }));
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

  const result = (snapshot: Snapshot): RepositoryEventWaitResult => ({
    outcome: snapshot.page.rows.length ? 'events' : 'timeout',
    ...pageResult(repository, snapshot),
    waitedMs: Date.now() - startedAt,
    timeoutSeconds: options.timeoutSeconds,
  });

  try {
    let start = parseStart(repository, options);
    for (;;) {
      woken = false;
      // Every iteration re-checks the floor in the read's own snapshot, so
      // retention pruning during the wait surfaces as CURSOR_EXPIRED.
      const snapshot = await readSnapshot(db, { ...options, start, limit });
      if (snapshot.page.rows.length) return result(snapshot);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return result(snapshot);
      // From here on the wait has an established position (for `fromStart`
      // or no cursor, the one it would return), checked like a cursor.
      start = { kind: 'cursor', seq: resumeSeq(snapshot), generation: snapshot.generation };
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

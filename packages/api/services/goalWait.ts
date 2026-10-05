/**
 * Bounded waits on a goal's durable event journal, shared by MCP `wait_goal`
 * and `GET /api/goals/:goalId/wait` (used by `propr goal wait`).
 *
 * The journal (`goal_events`) is appended by database triggers in the same
 * transaction as the goal or checkpoint write, so its sequence is a reliable,
 * monotonic cursor. Notifications only wake a waiter early; every decision is
 * taken from persisted rows. A waiter registers for wake-ups before its first
 * read, so a transition that commits between the read and the wait still wakes
 * it, and a slow fallback poll covers a notification that never arrives.
 *
 * Each decision is taken against one snapshot bound: the goal's newest journal
 * sequence read first. SQLite serializes writers and assigns sequences in
 * commit order, so every event at or below that bound is already visible and
 * the prefix never changes. Immediate matches, event matching and terminal
 * reachability are all evaluated within that prefix, so a transition committed
 * between two reads is never judged by one query and missed by another.
 */
import { EventEmitter } from 'node:events';
import type { Knex } from 'knex';
import {
  GOAL_WAIT_CURSOR_ERRORS,
  goalWaitConditionReachable,
  goalWaitLifecycleState,
  goalWaitStateMatches,
  type GoalWaitCondition,
  type GoalWaitCursorErrorCode,
  type GoalWaitEvent,
  type GoalWaitLifecycleState,
  type GoalWaitOutcome,
} from '@propr/shared';

/** Fallback re-read interval when no notification arrives. Not a busy poll. */
export const GOAL_WAIT_POLL_INTERVAL_MS = 2_500;
/**
 * Concurrent waits one owner may hold open on this API process. The count is
 * shared by REST (`propr goal wait`) and MCP `wait_goal`, and each API replica
 * keeps its own count.
 */
export const GOAL_WAIT_MAX_CONCURRENT_PER_OWNER = 16;
const EVENT_PAGE = 100;
const CURSOR_PREFIX = 'gwc1.';

export class GoalWaitError extends Error {
  constructor(
    readonly code: GoalWaitCursorErrorCode | 'NOT_FOUND' | 'WAIT_LIMIT' | 'WAIT_ABORTED' | 'INVALID_INPUT',
    message: string,
    readonly status: number,
    readonly recovery: string | null = null,
  ) {
    super(message);
    this.name = 'GoalWaitError';
  }
}

// ---------------------------------------------------------------------------
// Wake-ups
// ---------------------------------------------------------------------------

const wakeHub = new EventEmitter();
wakeHub.setMaxListeners(0);

/** Wake every waiter on this goal. Safe to call for goals nobody waits on. */
export function notifyGoalWaiters(goalId: unknown): void {
  if (typeof goalId === 'string' && goalId) wakeHub.emit(goalId);
}

export type GoalWaitSubscribe = (goalId: string, listener: () => void) => () => void;

const subscribeToHub: GoalWaitSubscribe = (goalId, listener) => {
  wakeHub.on(goalId, listener);
  return () => { wakeHub.off(goalId, listener); };
};

/** Registered wake listeners, for leak checks. */
export function activeGoalWaiterCount(goalId?: string): number {
  if (goalId) return wakeHub.listenerCount(goalId);
  return wakeHub.eventNames().reduce((total, name) => total + wakeHub.listenerCount(name), 0);
}

const activeByOwner = new Map<string, number>();

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

export function encodeGoalWaitCursor(goalId: string, sequence: number): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify({ g: goalId, s: sequence })).toString('base64url');
}

function cursorError(code: GoalWaitCursorErrorCode, message: string, status = 400): GoalWaitError {
  return new GoalWaitError(code, message, status, GOAL_WAIT_CURSOR_ERRORS[code]);
}

/** Parse a cursor's shape and goal binding; existence is checked against the journal. */
export function decodeGoalWaitCursor(cursor: string, goalId: string): number {
  if (typeof cursor !== 'string' || !cursor.startsWith(CURSOR_PREFIX) || cursor.length > 512) {
    throw cursorError('CURSOR_INVALID', 'afterCursor is not a goal wait cursor.');
  }
  let parsed: { g?: unknown; s?: unknown };
  try { parsed = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8')); }
  catch { throw cursorError('CURSOR_INVALID', 'afterCursor could not be decoded.'); }
  if (!parsed || typeof parsed.g !== 'string' || !Number.isSafeInteger(parsed.s) || Number(parsed.s) < 1) {
    throw cursorError('CURSOR_INVALID', 'afterCursor could not be decoded.');
  }
  if (parsed.g !== goalId) throw cursorError('CURSOR_WRONG_GOAL', 'afterCursor was issued for a different goal.');
  return Number(parsed.s);
}

// ---------------------------------------------------------------------------
// Journal reads
// ---------------------------------------------------------------------------

interface GoalEventRow {
  sequence: number;
  goal_id: string;
  kind: 'lifecycle' | 'checkpoint';
  state: string | null;
  previous_state: string | null;
  checkpoint_id: string | null;
  created_at: string;
  checkpoint_kind?: string | null;
  commit_sha?: string | null;
  pr_number?: number | null;
  pr_url?: string | null;
}

export interface GoalWaitGoalRow {
  goal_id: string;
  owner_id: string;
  repository: string;
  title?: string | null;
  desired_state: string;
  result_state: string | null;
  pause_confirmed_at?: string | null;
  resume_requested?: unknown;
  claimed_at?: string | null;
  started_at?: string | null;
  current_task_id?: string | null;
  checkpoint_count?: number | null;
  last_checkpoint_at?: string | null;
  final_pr_number?: number | null;
  final_pr_url?: string | null;
  failure_reason?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
}

const GOAL_COLUMNS = [
  'goal_id', 'owner_id', 'repository', 'title', 'desired_state', 'result_state', 'pause_confirmed_at', 'resume_requested',
  'claimed_at', 'started_at', 'current_task_id', 'checkpoint_count', 'last_checkpoint_at', 'final_pr_number',
  'final_pr_url', 'failure_reason', 'updated_at', 'completed_at',
];

function eventQuery(db: Knex, goalId: string): Knex.QueryBuilder {
  return db('goal_events')
    .leftJoin('goal_checkpoints', 'goal_checkpoints.checkpoint_id', 'goal_events.checkpoint_id')
    .where('goal_events.goal_id', goalId)
    .select(
      'goal_events.sequence', 'goal_events.goal_id', 'goal_events.kind', 'goal_events.state', 'goal_events.previous_state',
      'goal_events.checkpoint_id', 'goal_events.created_at', 'goal_checkpoints.kind as checkpoint_kind',
      'goal_checkpoints.commit_sha', 'goal_checkpoints.pr_number', 'goal_checkpoints.pr_url',
    );
}

function eventView(row: GoalEventRow): GoalWaitEvent {
  return {
    cursor: encodeGoalWaitCursor(row.goal_id, Number(row.sequence)),
    sequence: Number(row.sequence),
    kind: row.kind,
    state: (row.state as GoalWaitLifecycleState | null) ?? null,
    previousState: (row.previous_state as GoalWaitLifecycleState | null) ?? null,
    checkpoint: row.kind === 'checkpoint' && row.checkpoint_id ? {
      id: row.checkpoint_id,
      kind: row.checkpoint_kind ?? null,
      commitSha: row.commit_sha ?? null,
      prNumber: row.pr_number ?? null,
      prUrl: row.pr_url ?? null,
    } : null,
    occurredAt: row.created_at,
  };
}

/** Compact current projection; `get_goal` remains the detailed read. */
export function goalWaitProjection(goal: GoalWaitGoalRow, lifecycleState: GoalWaitLifecycleState) {
  return {
    id: goal.goal_id,
    repository: goal.repository,
    title: goal.title ?? null,
    lifecycleState,
    requestedState: goal.desired_state,
    resultState: goal.result_state,
    terminal: goal.result_state !== null,
    goalCompleted: goal.result_state === 'completed',
    pauseConfirmed: lifecycleState === 'paused',
    currentTaskId: goal.current_task_id ?? null,
    checkpoint: { count: Number(goal.checkpoint_count ?? 0), lastAt: goal.last_checkpoint_at ?? null },
    finalPr: goal.final_pr_number ? { number: goal.final_pr_number, url: goal.final_pr_url ?? null } : null,
    failureReason: goal.failure_reason ?? null,
    updatedAt: goal.updated_at ?? null,
    completedAt: goal.completed_at ?? null,
  };
}

export type GoalWaitProjection = ReturnType<typeof goalWaitProjection>;

export interface GoalWaitResult {
  outcome: GoalWaitOutcome;
  condition: GoalWaitCondition | null;
  /** Resume point: after the matched event, or after everything this wait examined. */
  cursor: string;
  /** The event that satisfied the wait; null on timeout or when unreachable. */
  event: GoalWaitEvent | null;
  /** True when a state condition already held and no cursor was supplied. */
  matchedImmediately: boolean;
  goal: GoalWaitProjection;
  waitedMs: number;
  timeoutSeconds: number;
}

export interface GoalWaitOptions {
  db: Knex;
  ownerId: string;
  goalId: string;
  /** When supplied, the goal must currently belong to this repository. */
  repository?: string;
  afterCursor?: string;
  until?: GoalWaitCondition;
  timeoutSeconds: number;
  signal?: AbortSignal;
  /** Extra authorization re-checked before every read (for example grant revocation). */
  authorize?: () => Promise<void>;
  pollIntervalMs?: number;
  subscribe?: GoalWaitSubscribe;
  maxConcurrentPerOwner?: number;
}

function eventQualifies(event: GoalEventRow, until: GoalWaitCondition | undefined): boolean {
  if (!until) return true;
  if (until === 'checkpoint') return event.kind === 'checkpoint';
  return event.kind === 'lifecycle' && goalWaitStateMatches(until, event.state);
}

function abortedError(): GoalWaitError {
  return new GoalWaitError('WAIT_ABORTED', 'The wait was cancelled. Goal execution is unaffected.', 499);
}

/**
 * Wait until the condition holds, a qualifying event is journaled, or the
 * timeout elapses. Never mutates the goal; aborting only releases this waiter.
 */
// eslint-disable-next-line complexity -- one bounded loop keeps registration, cursor validation, matching and cleanup auditable together
export async function waitForGoal(options: GoalWaitOptions): Promise<GoalWaitResult> {
  const { db, ownerId, goalId, until } = options;
  const startedAt = Date.now();
  const timeoutMs = Math.max(0, options.timeoutSeconds) * 1000;
  const deadline = startedAt + timeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? GOAL_WAIT_POLL_INTERVAL_MS;
  if (options.signal?.aborted) throw abortedError();

  const limit = options.maxConcurrentPerOwner ?? GOAL_WAIT_MAX_CONCURRENT_PER_OWNER;
  const active = activeByOwner.get(ownerId) ?? 0;
  if (active >= limit) {
    throw new GoalWaitError('WAIT_LIMIT',
      `At most ${limit} goal waits may be open at once per owner on this server; ${active} are open across propr goal wait and MCP wait_goal.`, 429,
      'Let an existing wait finish or cancel it before starting another. The limit counts CLI and MCP waits together.');
  }
  activeByOwner.set(ownerId, active + 1);

  // Register before the first read: a commit after this point always wakes us.
  let woken = false;
  let release: (() => void) | null = null;
  const wake = () => { woken = true; release?.(); };
  const unsubscribe = (options.subscribe ?? subscribeToHub)(goalId, wake);
  options.signal?.addEventListener('abort', wake);

  const loadAuthorizedGoal = async (): Promise<GoalWaitGoalRow> => {
    const query = db<GoalWaitGoalRow>('goals').where({ goal_id: goalId, owner_id: ownerId });
    if (options.repository) query.where({ repository: options.repository });
    const goal = await query.first(GOAL_COLUMNS) as GoalWaitGoalRow | undefined;
    // Ownership or repository changes end the wait exactly like a missing goal.
    if (!goal) throw new GoalWaitError('NOT_FOUND', 'Goal not found in your authorized repository.', 404);
    await options.authorize?.();
    return goal;
  };

  /** Newest journal position for this goal: the snapshot bound for one round of decisions. */
  const journalBound = async (): Promise<number> => {
    const newest = await db('goal_events').where({ goal_id: goalId }).max({ sequence: 'sequence' }).first();
    return Number(newest?.sequence ?? 0);
  };

  /** Newest lifecycle event, optionally at or below a snapshot bound. */
  const lifecycleEvent = async (bound?: number): Promise<GoalEventRow | undefined> => {
    const query = eventQuery(db, goalId).where('goal_events.kind', 'lifecycle');
    if (bound !== undefined) query.where('goal_events.sequence', '<=', bound);
    return await query.orderBy('goal_events.sequence', 'desc').first() as GoalEventRow | undefined;
  };

  const latestLifecycleState = async (goal: GoalWaitGoalRow, bound?: number): Promise<GoalWaitLifecycleState> => {
    const latest = await lifecycleEvent(bound);
    return (latest?.state as GoalWaitLifecycleState | undefined) ?? goalWaitLifecycleState(goal);
  };

  const finish = async (
    result: { outcome: GoalWaitOutcome; boundary: number; event?: GoalEventRow; matchedImmediately?: boolean },
  ): Promise<GoalWaitResult> => {
    // Re-read (and re-authorize) so the projection is never older than the event it reports.
    const goal = await loadAuthorizedGoal();
    return {
      outcome: result.outcome,
      condition: until ?? null,
      // An immediate match resumes from the captured boundary, which is at or after the event it reports.
      cursor: encodeGoalWaitCursor(goalId, result.event && !result.matchedImmediately ? Number(result.event.sequence) : result.boundary),
      event: result.event ? eventView(result.event) : null,
      matchedImmediately: result.matchedImmediately ?? false,
      goal: goalWaitProjection(goal, await latestLifecycleState(goal)),
      waitedMs: Date.now() - startedAt,
      timeoutSeconds: options.timeoutSeconds,
    };
  };

  try {
    let goal = await loadAuthorizedGoal();
    let boundary: number;
    if (options.afterCursor !== undefined) {
      boundary = decodeGoalWaitCursor(options.afterCursor, goalId);
      const issued = await db('goal_events').where({ sequence: boundary }).first('goal_id');
      if (!issued || issued.goal_id !== goalId) {
        // A position recorded for another goal was never issued for this one.
        if (issued || boundary > await journalBound()) {
          throw cursorError('CURSOR_INVALID', 'afterCursor does not match this goal\'s history.');
        }
        throw cursorError('CURSOR_EXPIRED', 'afterCursor refers to goal history that is no longer available.', 410);
      }
    } else {
      // Capture the current boundary; only events after it count as new. The
      // immediate check reads the state as of that boundary, so a transition
      // committed after it is reported later as an event, with its own cursor.
      boundary = await journalBound();
      if (until && until !== 'checkpoint') {
        const lifecycle = await lifecycleEvent(boundary);
        const state = lifecycle?.state ?? goalWaitLifecycleState(goal);
        if (goalWaitStateMatches(until, state)) {
          return await finish({ outcome: 'matched', boundary, event: lifecycle, matchedImmediately: true });
        }
      }
    }

    for (;;) {
      woken = false;
      // Fix the snapshot first: events and reachability are judged within it.
      const bound = await journalBound();
      const events = await eventQuery(db, goalId).where('goal_events.sequence', '>', boundary)
        .where('goal_events.sequence', '<=', bound)
        .orderBy('goal_events.sequence', 'asc').limit(EVENT_PAGE) as GoalEventRow[];
      for (const event of events) {
        if (eventQualifies(event, until)) return await finish({ outcome: 'matched', boundary, event });
        boundary = Number(event.sequence);
      }
      if (events.length === EVENT_PAGE) continue;
      // Every event through the bound has been examined and none qualified.
      boundary = Math.max(boundary, bound);
      if (!goalWaitConditionReachable(until, await latestLifecycleState(goal, bound))) {
        return await finish({ outcome: 'unreachable', boundary });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return await finish({ outcome: 'timed_out', boundary });
      if (options.signal?.aborted) throw abortedError();
      if (!woken) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { release = null; resolve(); }, Math.min(pollIntervalMs, remaining));
          release = () => { clearTimeout(timer); release = null; resolve(); };
        });
      }
      if (options.signal?.aborted) throw abortedError();
      // Access is re-checked before any further event can be returned.
      goal = await loadAuthorizedGoal();
    }
  } finally {
    release = null;
    unsubscribe();
    options.signal?.removeEventListener('abort', wake);
    const remaining = (activeByOwner.get(ownerId) ?? 1) - 1;
    if (remaining > 0) activeByOwner.set(ownerId, remaining);
    else activeByOwner.delete(ownerId);
  }
}

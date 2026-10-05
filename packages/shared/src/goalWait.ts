/**
 * Bounded goal wait contract shared by the REST API, MCP `wait_goal` and
 * `propr goal wait`.
 *
 * A wait observes the goal's durable event journal (`goal_events`), whose
 * monotonic sequence is the cursor position. Lifecycle events are derived from
 * persisted goal columns by the database itself, so a requested pause or
 * cancellation, a finished child task or an idle agent turn can never be
 * mistaken for a confirmed state.
 */

/** Seconds one wait request may block. A request never waits longer than the maximum. */
export const GOAL_WAIT_DEFAULT_TIMEOUT_SECONDS = 15;
export const GOAL_WAIT_MAX_TIMEOUT_SECONDS = 30;

/**
 * Lifecycle states recorded in the goal event journal.
 *
 * `pausing`, `cancelling` and `resuming` are requested-but-unconfirmed states;
 * only `paused` (the worker confirmed the pause and no resume is queued) and
 * `cancelled` (the goal's result is cancelled) are confirmed.
 */
export const GOAL_WAIT_LIFECYCLE_STATES = [
  'queued', 'running', 'pausing', 'paused', 'resuming', 'cancelling', 'completed', 'failed', 'cancelled',
] as const;
export type GoalWaitLifecycleState = typeof GOAL_WAIT_LIFECYCLE_STATES[number];

export const GOAL_WAIT_TERMINAL_STATES = ['completed', 'failed', 'cancelled'] as const satisfies readonly GoalWaitLifecycleState[];

/**
 * Conditions a wait can target.
 *
 * - `completed`, `failed`, `cancelled`, `paused`: the persisted, confirmed state.
 * - `terminal`: any of completed, failed or cancelled.
 * - `checkpoint`: a checkpoint published after the cursor (never an older one).
 *
 * Omitting the condition waits for any new durable event after the cursor.
 */
export const GOAL_WAIT_CONDITIONS = ['completed', 'failed', 'cancelled', 'paused', 'terminal', 'checkpoint'] as const;
export type GoalWaitCondition = typeof GOAL_WAIT_CONDITIONS[number];

/**
 * - `matched`: the condition (or, without one, a new event) was observed.
 * - `timed_out`: nothing qualifying happened before the deadline; this is not a goal failure.
 * - `unreachable`: the goal reached a terminal state that can never satisfy the condition.
 */
export const GOAL_WAIT_OUTCOMES = ['matched', 'timed_out', 'unreachable'] as const;
export type GoalWaitOutcome = typeof GOAL_WAIT_OUTCOMES[number];

export type GoalWaitEventKind = 'lifecycle' | 'checkpoint';

/** One durable journal entry. `cursor` resumes immediately after this event. */
export interface GoalWaitEvent {
  cursor: string;
  sequence: number;
  kind: GoalWaitEventKind;
  state: GoalWaitLifecycleState | null;
  previousState: GoalWaitLifecycleState | null;
  checkpoint: { id: string; kind: string | null; commitSha: string | null; prNumber: number | null; prUrl: string | null } | null;
  occurredAt: string;
}

/** Machine-readable cursor failures with their recovery instructions. */
export const GOAL_WAIT_CURSOR_ERRORS = {
  CURSOR_INVALID: 'The cursor is malformed or was not issued by this instance. Omit afterCursor to wait from the current boundary, then read the goal to see what changed.',
  CURSOR_WRONG_GOAL: 'The cursor belongs to a different goal. Use a cursor returned by a wait on this goal, or omit afterCursor.',
  CURSOR_EXPIRED: 'The cursor refers to goal history this instance no longer has. Read the goal for its current state, then wait again without afterCursor.',
} as const;
export type GoalWaitCursorErrorCode = keyof typeof GOAL_WAIT_CURSOR_ERRORS;

export function isGoalWaitCondition(value: unknown): value is GoalWaitCondition {
  return typeof value === 'string' && (GOAL_WAIT_CONDITIONS as readonly string[]).includes(value);
}

export function isTerminalGoalWaitState(state: string | null | undefined): boolean {
  return !!state && (GOAL_WAIT_TERMINAL_STATES as readonly string[]).includes(state);
}

/** Whether a lifecycle state satisfies a state condition. Checkpoint waits are event-only. */
export function goalWaitStateMatches(condition: GoalWaitCondition, state: string | null | undefined): boolean {
  if (!state || condition === 'checkpoint') return false;
  if (condition === 'terminal') return isTerminalGoalWaitState(state);
  return condition === state;
}

/**
 * Whether a goal in `state` can still produce an event that satisfies the
 * condition. Terminal goals never change again, so only the terminal state it
 * already holds can match.
 */
export function goalWaitConditionReachable(condition: GoalWaitCondition | undefined, state: string | null | undefined): boolean {
  if (!isTerminalGoalWaitState(state)) return true;
  return condition !== undefined && goalWaitStateMatches(condition, state);
}

/** Clamp a requested timeout into the per-request bounds; rejects non-numbers. */
export function normalizeGoalWaitTimeoutSeconds(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return GOAL_WAIT_DEFAULT_TIMEOUT_SECONDS;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > GOAL_WAIT_MAX_TIMEOUT_SECONDS) return null;
  return parsed;
}

/** The persisted goal columns that determine its journal lifecycle state. */
export interface GoalWaitLifecycleColumns {
  desired_state: string;
  result_state: string | null;
  pause_confirmed_at?: unknown;
  resume_requested?: unknown;
  claimed_at?: unknown;
  started_at?: unknown;
}

/**
 * The journal lifecycle state of a goal row. Mirrors the `goal_events` trigger
 * expression exactly; the journal remains authoritative for waits.
 *
 * After a resume re-enqueues an attempt, `claimed_at` is cleared but
 * `started_at` stays set, so the state goes from `resuming` straight to
 * `running` before a worker claims the attempt, and the later claim appends
 * no event. This matches `goalActivityState`. A `queued -> running`
 * distinction on resume would require changing this function and the trigger
 * expression in `20261004000000_create_goal_events.js` together.
 */
export function goalWaitLifecycleState(goal: GoalWaitLifecycleColumns): GoalWaitLifecycleState {
  if (goal.result_state === 'completed' || goal.result_state === 'failed' || goal.result_state === 'cancelled') return goal.result_state;
  if (goal.desired_state === 'cancelled') return 'cancelling';
  if (goal.desired_state === 'paused') {
    if (goal.resume_requested && goal.resume_requested !== '0') return 'resuming';
    return goal.pause_confirmed_at ? 'paused' : 'pausing';
  }
  if (!goal.claimed_at && !goal.started_at) return 'queued';
  return 'running';
}

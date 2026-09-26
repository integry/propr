import logger from '../utils/logger.js';
import { getEventPublisher } from '../utils/eventPublisher.js';
import type { GoalActivityState, GoalUpdatePayload } from '@propr/shared';

/**
 * Goal lifecycle push events.
 *
 * A goal's state is spread across three persisted columns and is written from
 * the HTTP control handlers, the goal worker and leased recovery. Deriving the
 * state from a row in one place - and publishing only when it actually differs
 * from the row we started with - is what stops one of those writers from
 * announcing a transition that did not happen, or staying silent about one that
 * did while the Goals console polls to find out.
 */

/** The subset of the `goals` row that determines the state a consumer sees. */
export interface GoalLifecycleSnapshot {
    goal_id: string;
    repository: string;
    desired_state: string;
    result_state: string | null;
    current_task_id?: string | null;
    claimed_at?: string | null;
    started_at?: string | null;
}

/** Publishes a goal transition. Injected in tests; failures are swallowed. */
export type GoalUpdatePublisher = (
    payload: Omit<GoalUpdatePayload, 'eventType'>
) => Promise<void>;

const defaultPublisher: GoalUpdatePublisher = payload =>
    getEventPublisher().publishGoalUpdate(payload);

/**
 * The lifecycle state a consumer sees for a goal row.
 *
 * A requested cancellation reports `cancelled` before the worker has finished
 * unwinding: from the outside the goal is over, and the later `result_state`
 * write is the same state, so the change detection below emits it once.
 */
export function goalActivityState(goal: GoalLifecycleSnapshot): GoalActivityState {
    if (goal.result_state === 'completed') return 'completed';
    if (goal.result_state === 'failed') return 'failed';
    if (goal.result_state === 'cancelled') return 'cancelled';
    if (goal.desired_state === 'cancelled') return 'cancelled';
    if (goal.desired_state === 'paused') return 'paused';
    // Accepted but never claimed by a worker: distinct from running, because a
    // queued goal is waiting on capacity rather than making progress.
    if (!goal.claimed_at && !goal.started_at) return 'queued';
    return 'running';
}

/**
 * Announce the state of a goal row.
 *
 * Called after the write has committed, so a client that reacts by re-reading
 * can never observe state older than the event that woke it.
 */
export async function publishGoalActivity(
    goal: GoalLifecycleSnapshot,
    publish: GoalUpdatePublisher = defaultPublisher,
): Promise<void> {
    try {
        await publish({
            goalId: goal.goal_id,
            repository: goal.repository,
            state: goalActivityState(goal),
            currentTaskId: goal.current_task_id ?? null,
            occurredAt: new Date().toISOString(),
        });
    } catch (error) {
        // A goal transition is durable work; losing its notification must never
        // fail it. Clients fall back to the polling they already do.
        logger.warn(
            { goalId: goal.goal_id, error: (error as Error).message },
            'Could not publish goal activity event',
        );
    }
}

/**
 * Announce a goal transition, but only when the observable state changed.
 *
 * Re-saving the same state (an idempotent retry, a control write that only
 * bumps a generation) must not wake every open console for nothing.
 */
export async function publishGoalTransition(
    options: {
        previous?: GoalLifecycleSnapshot | null;
        next?: GoalLifecycleSnapshot | null;
        publish?: GoalUpdatePublisher;
    },
): Promise<void> {
    const { previous, next, publish } = options;
    if (!next) return;
    if (previous && goalActivityState(previous) === goalActivityState(next)) return;
    await publishGoalActivity(next, publish);
}

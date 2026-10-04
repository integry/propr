import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { GoalUpdatePayload } from '@propr/shared';
import {
    goalActivityState,
    publishGoalActivity,
    publishGoalTransition,
    type GoalLifecycleSnapshot,
} from '../src/goals/goalActivityEvents.js';

const queued: GoalLifecycleSnapshot = {
    goal_id: 'goal-1',
    repository: 'integry/propr',
    desired_state: 'running',
    result_state: null,
    current_task_id: 'goal-task-1',
    claimed_at: null,
    started_at: null,
};

const running: GoalLifecycleSnapshot = {
    ...queued,
    claimed_at: '2026-09-26T10:00:00.000Z',
    started_at: '2026-09-26T10:00:00.000Z',
};

function collector() {
    const published: Array<Omit<GoalUpdatePayload, 'eventType'>> = [];
    return {
        published,
        publish: async (payload: Omit<GoalUpdatePayload, 'eventType'>) => {
            published.push(payload);
        },
    };
}

describe('goal activity events', () => {
    test('derives the state a consumer sees from the persisted columns', () => {
        assert.equal(goalActivityState(queued), 'queued');
        assert.equal(goalActivityState(running), 'running');
        assert.equal(goalActivityState({ ...running, desired_state: 'paused' }), 'paused');
        // A requested cancellation is already over from the outside; the later
        // result_state write is the same state and so publishes nothing again.
        assert.equal(goalActivityState({ ...running, desired_state: 'cancelled' }), 'cancelled');
        assert.equal(
            goalActivityState({ ...running, desired_state: 'cancelled', result_state: 'cancelled' }),
            'cancelled',
        );
        assert.equal(goalActivityState({ ...running, result_state: 'completed' }), 'completed');
        assert.equal(goalActivityState({ ...running, result_state: 'failed' }), 'failed');
        // A terminal result outranks a stale desired state, never the other way round.
        assert.equal(
            goalActivityState({ ...running, desired_state: 'paused', result_state: 'completed' }),
            'completed',
        );
    });

    test('publishes one event per transition with an ISO-8601 timestamp', async () => {
        const { published, publish } = collector();
        await publishGoalTransition({ previous: queued, next: running, publish });

        assert.equal(published.length, 1);
        assert.equal(published[0].goalId, 'goal-1');
        assert.equal(published[0].repository, 'integry/propr');
        assert.equal(published[0].state, 'running');
        assert.equal(published[0].currentTaskId, 'goal-task-1');
        assert.equal(new Date(published[0].occurredAt).toISOString(), published[0].occurredAt);
    });

    test('stays silent when a write did not move the observable state', async () => {
        const { published, publish } = collector();
        // Same state, bumped control generation: an idempotent retry must not
        // wake every open Goals console.
        await publishGoalTransition({ previous: running, next: { ...running }, publish });
        await publishGoalTransition({ previous: running, next: null, publish });
        await publishGoalTransition({ previous: running, next: undefined, publish });
        assert.deepEqual(published, []);
    });

    test('announces a goal that has no prior state to compare against', async () => {
        const { published, publish } = collector();
        await publishGoalTransition({ next: queued, publish });
        assert.deepEqual(published.map(payload => payload.state), ['queued']);
    });

    test('a failed publish is swallowed so the transition still stands', async () => {
        await assert.doesNotReject(publishGoalActivity(running, async () => {
            throw new Error('Redis is unreachable');
        }));
    });
});

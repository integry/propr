import assert from 'node:assert/strict';
import { after, describe, mock, test } from 'node:test';
import { closeConnection, TaskStates, type TaskStateData, type UpdateMetadata } from '@propr/core';
import { reconcileStaleTaskStates } from '../src/taskStateReconciler.js';

after(async () => { await closeConnection(); });

function task(taskId: string, state: TaskStateData['state']): TaskStateData {
    return {
        taskId,
        issueRef: { number: 1738, repoOwner: 'integry', repoName: 'propr' },
        correlationId: `correlation-${taskId}`,
        state,
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z',
        attempts: 0,
        history: [{ state, timestamp: '2026-08-04T00:00:00.000Z', reason: 'test' }],
    };
}

function stateManager(tasks: TaskStateData[]) {
    const states = new Map(tasks.map(value => [value.taskId, value]));
    const updates: Array<{ taskId: string; state: TaskStateData['state']; metadata: UpdateMetadata }> = [];
    return {
        states,
        updates,
        getNonTerminalTasks: async () => [...states.values()],
        getTaskState: async (taskId: string) => states.get(taskId) ?? null,
        updateTaskState: async (taskId: string, state: TaskStateData['state'], metadata: UpdateMetadata = {}) => {
            const current = states.get(taskId)!;
            const next = { ...current, state };
            states.set(taskId, next);
            updates.push({ taskId, state, metadata });
            return next;
        },
    };
}

function queue(states: Record<string, { state: string; returnvalue?: unknown; failedReason?: string }>) {
    return {
        getJob: async (taskId: string) => {
            const value = states[taskId];
            if (!value) return undefined;
            return {
                getState: async () => value.state,
                returnvalue: value.returnvalue,
                failedReason: value.failedReason,
            };
        },
        toKey: (type: string) => `bull:github-issue-processor:${type}`,
    };
}

describe('task state reconciliation', () => {
    test('repairs completed, superseded, interrupted, queued, and live tasks safely', async () => {
        const manager = stateManager([
            task('pr-comments-completed', TaskStates.PENDING),
            task('pr-comments-superseded', TaskStates.CLAUDE_EXECUTION),
            task('pr-comments-interrupted', TaskStates.CLAUDE_EXECUTION),
            task('pr-comments-queued', TaskStates.PROCESSING),
            task('pr-comments-live', TaskStates.PROCESSING),
        ]);
        const evalMock = mock.fn(async () => 1);
        const pttlMock = mock.fn(async (key: string) => key.includes('pr-comments-live') ? 20_000 : -2);
        const findRunningContainer = mock.fn(async () => null);

        const summary = await reconcileStaleTaskStates({
            stateManager: manager as never,
            queue: queue({
                'pr-comments-completed': {
                    state: 'completed',
                    returnvalue: { status: 'skipped', reason: 'already_processed' },
                },
                'pr-comments-superseded': {
                    state: 'completed',
                    returnvalue: { status: 'rescheduled', reason: 'pr_locked_by_other_job' },
                },
                'pr-comments-interrupted': { state: 'active' },
                'pr-comments-queued': { state: 'delayed' },
                'pr-comments-live': { state: 'active' },
            }),
            redis: { eval: evalMock, pttl: pttlMock },
            staleAfterMs: 1000,
            now: () => new Date('2026-08-04T00:10:00.000Z').getTime(),
            findRunningContainer,
        });

        assert.equal(manager.states.get('pr-comments-completed')?.state, TaskStates.COMPLETED);
        assert.equal(manager.states.get('pr-comments-superseded')?.state, TaskStates.CANCELLED);
        assert.equal(manager.states.get('pr-comments-interrupted')?.state, TaskStates.FAILED);
        assert.equal(manager.states.get('pr-comments-queued')?.state, TaskStates.PENDING);
        assert.equal(manager.states.get('pr-comments-live')?.state, TaskStates.PROCESSING);
        assert.deepEqual(summary, {
            scanned: 5,
            fresh: 0,
            live: 1,
            queued: 1,
            finalized: 2,
            interrupted: 1,
            locksCleared: 3,
            errors: 0,
        });
        assert.equal(pttlMock.mock.calls.length, 2);
    });

    test('leaves a task alone when its agent container is still running', async () => {
        const manager = stateManager([task('pr-comments-container-live', TaskStates.CLAUDE_EXECUTION)]);

        const summary = await reconcileStaleTaskStates({
            stateManager: manager as never,
            queue: queue({}),
            redis: { eval: async () => 0, pttl: async () => -2 },
            staleAfterMs: 1000,
            now: () => new Date('2026-08-04T00:10:00.000Z').getTime(),
            findRunningContainer: async () => ({ id: 'container-1', name: 'agent-task' }),
        });

        assert.equal(manager.updates.length, 0);
        assert.equal(summary.live, 1);
    });

    test('does not supersede a rescheduled task while its original agent is still alive', async () => {
        const manager = stateManager([task('pr-comments-rescheduled-live', TaskStates.CLAUDE_EXECUTION)]);

        const summary = await reconcileStaleTaskStates({
            stateManager: manager as never,
            queue: queue({
                'pr-comments-rescheduled-live': {
                    state: 'completed',
                    returnvalue: { status: 'rescheduled', reason: 'pr_locked_by_other_job' },
                },
            }),
            redis: { eval: async () => 0, pttl: async () => -2 },
            staleAfterMs: 1000,
            now: () => new Date('2026-08-04T00:10:00.000Z').getTime(),
            findRunningContainer: async () => ({ id: 'container-1', name: 'agent-task' }),
        });

        assert.equal(manager.updates.length, 0);
        assert.equal(summary.live, 1);
    });

    test('does not inspect fresh task state', async () => {
        const fresh = task('pr-comments-fresh', TaskStates.PENDING);
        fresh.updatedAt = '2026-08-04T00:09:59.500Z';
        const manager = stateManager([fresh]);
        const getJob = mock.fn(async () => undefined);

        const summary = await reconcileStaleTaskStates({
            stateManager: manager as never,
            queue: { getJob, toKey: (type: string) => type },
            redis: { eval: async () => 0, pttl: async () => -2 },
            staleAfterMs: 1000,
            now: () => new Date('2026-08-04T00:10:00.000Z').getTime(),
            findRunningContainer: async () => null,
        });

        assert.equal(summary.fresh, 1);
        assert.equal(getJob.mock.calls.length, 0);
    });
});

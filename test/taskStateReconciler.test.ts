import assert from 'node:assert/strict';
import { after, describe, mock, test } from 'node:test';
import { closeConnection, TaskStates, type TaskStateData, type TaskStateExpectation, type UpdateMetadata } from '@propr/core';
import { reconcileStaleTaskStates } from '../src/taskStateReconciler.js';

after(async () => { await closeConnection(); });

function task(taskId: string, state: TaskStateData['state']): TaskStateData {
    return {
        taskId,
        issueRef: { number: 1738, repoOwner: 'integry', repoName: 'propr', type: 'pr_comment' },
        correlationId: `correlation-${taskId}`,
        state,
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z',
        attempts: 0,
        history: [{ state, timestamp: '2026-08-04T00:00:00.000Z', reason: 'test' }],
        prProcessingLockToken: `correlation-${taskId}:attempt-token`,
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
        updateTaskStateIfCurrent: async (
            taskId: string,
            expectation: TaskStateExpectation,
            state: TaskStateData['state'],
            metadata: UpdateMetadata = {},
        ) => {
            const current = states.get(taskId)!;
            if (current.state !== expectation.state) return null;
            if (expectation.updatedAt && current.updatedAt !== expectation.updatedAt) return null;
            if (expectation.version !== undefined && current.version !== expectation.version) return null;
            if (expectation.prProcessingLockToken !== undefined
                && current.prProcessingLockToken !== expectation.prProcessingLockToken) return null;
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

    test('finalizes success when an active job completes while its lock is checked', async () => {
        const completing = task('pr-comments-completing-race', TaskStates.CLAUDE_EXECUTION);
        const manager = stateManager([completing]);
        const activeGetState = mock.fn(async () => 'active');
        const completedGetState = mock.fn(async () => 'completed');
        let jobReads = 0;
        const getJob = mock.fn(async () => {
            jobReads++;
            if (jobReads === 1) {
                return { getState: activeGetState };
            }
            return {
                getState: completedGetState,
                returnvalue: { status: 'complete', pullRequestNumber: 1738 },
            };
        });

        const summary = await reconcileStaleTaskStates({
            stateManager: manager as never,
            queue: {
                getJob,
                toKey: (type: string) => `bull:queue:${type}`,
            },
            redis: { eval: async () => 0, pttl: async () => -2 },
            staleAfterMs: 1000,
            now: () => new Date('2026-08-04T00:10:00.000Z').getTime(),
            findRunningContainer: async () => null,
        });

        assert.equal(getJob.mock.calls.length, 2);
        assert.equal(activeGetState.mock.calls.length, 1);
        assert.equal(completedGetState.mock.calls.length, 1);
        assert.equal(manager.states.get(completing.taskId)?.state, TaskStates.COMPLETED);
        assert.equal(summary.finalized, 1);
        assert.equal(summary.interrupted, 0);
    });

    test('reconciles a legacy PR-comment state without issueRef.type', async () => {
        const legacy = task('pr-comments-batch-integry-propr-1738-legacy', TaskStates.PROCESSING);
        delete legacy.issueRef.type;
        const manager = stateManager([legacy]);

        const summary = await reconcileStaleTaskStates({
            stateManager: manager as never,
            queue: queue({
                [legacy.taskId]: { state: 'completed', returnvalue: { status: 'skipped' } },
            }),
            redis: { eval: async () => 0, pttl: async () => -2 },
            staleAfterMs: 1000,
            now: () => new Date('2026-08-04T00:10:00.000Z').getTime(),
            findRunningContainer: async () => null,
        });

        assert.equal(summary.scanned, 1);
        assert.equal(manager.states.get(legacy.taskId)?.state, TaskStates.COMPLETED);
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

    test('does not reconcile a task owned by another queue subsystem', async () => {
        const unrelated = task('task-import-1', TaskStates.PROCESSING);
        unrelated.issueRef.type = 'task_import';
        const manager = stateManager([unrelated]);
        const getJob = mock.fn(async () => undefined);

        const summary = await reconcileStaleTaskStates({
            stateManager: manager as never,
            queue: { getJob, toKey: (type: string) => type },
            redis: { eval: async () => 0, pttl: async () => -2 },
            staleAfterMs: 1000,
            now: () => new Date('2026-08-04T00:10:00.000Z').getTime(),
            findRunningContainer: async () => null,
        });

        assert.equal(summary.scanned, 0);
        assert.equal(manager.updates.length, 0);
        assert.equal(getJob.mock.calls.length, 0);
    });

    test('does not overwrite cancellation while recovering a queued task', async () => {
        const queued = task('pr-comments-cancel-race', TaskStates.PROCESSING);
        const manager = stateManager([queued]);
        const queueWithCancellation = {
            getJob: async () => ({
                getState: async () => {
                    manager.states.set(queued.taskId, { ...queued, state: TaskStates.CANCELLED });
                    return 'delayed';
                },
            }),
            toKey: (type: string) => type,
        };

        const summary = await reconcileStaleTaskStates({
            stateManager: manager as never,
            queue: queueWithCancellation,
            redis: { eval: async () => 0, pttl: async () => -2 },
            staleAfterMs: 1000,
            now: () => new Date('2026-08-04T00:10:00.000Z').getTime(),
            findRunningContainer: async () => null,
        });

        assert.equal(manager.states.get(queued.taskId)?.state, TaskStates.CANCELLED);
        assert.equal(manager.updates.length, 0);
        assert.equal(summary.queued, 0);
    });

    test('does not rewrite a replacement attempt that reached the same state', async () => {
        const queued = task('pr-comments-replacement-race', TaskStates.PROCESSING);
        const manager = stateManager([queued]);
        const replacementUpdatedAt = '2026-08-04T00:09:00.000Z';
        const queueWithReplacement = {
            getJob: async () => ({
                getState: async () => {
                    manager.states.set(queued.taskId, {
                        ...queued,
                        updatedAt: replacementUpdatedAt,
                        prProcessingLockToken: 'replacement-attempt-token',
                    });
                    return 'delayed';
                },
            }),
            toKey: (type: string) => type,
        };

        const summary = await reconcileStaleTaskStates({
            stateManager: manager as never,
            queue: queueWithReplacement,
            redis: { eval: async () => 0, pttl: async () => -2 },
            staleAfterMs: 1000,
            now: () => new Date('2026-08-04T00:10:00.000Z').getTime(),
            findRunningContainer: async () => null,
        });

        assert.equal(manager.states.get(queued.taskId)?.state, TaskStates.PROCESSING);
        assert.equal(manager.states.get(queued.taskId)?.updatedAt, replacementUpdatedAt);
        assert.equal(manager.updates.length, 0);
        assert.equal(summary.queued, 0);
    });

    test('does not finalize a successor attempt that replaced the scanned token', async () => {
        const scanned = task('pr-comments-finalizer-generation-race', TaskStates.PROCESSING);
        const manager = stateManager([scanned]);
        const successorToken = 'replacement-attempt-token';
        const queueWithReplacement = {
            getJob: async () => ({
                getState: async () => {
                    manager.states.set(scanned.taskId, {
                        ...scanned,
                        prProcessingLockToken: successorToken,
                    });
                    return 'completed';
                },
                returnvalue: { status: 'complete' },
            }),
            toKey: (type: string) => type,
        };

        const summary = await reconcileStaleTaskStates({
            stateManager: manager as never,
            queue: queueWithReplacement,
            redis: { eval: async () => 0, pttl: async () => -2 },
            staleAfterMs: 1000,
            now: () => new Date('2026-08-04T00:10:00.000Z').getTime(),
            findRunningContainer: async () => null,
        });

        assert.equal(manager.states.get(scanned.taskId)?.state, TaskStates.PROCESSING);
        assert.equal(manager.states.get(scanned.taskId)?.prProcessingLockToken, successorToken);
        assert.equal(manager.updates.length, 0);
        assert.equal(summary.finalized, 0);
    });

    test('treats an implausible future timestamp as stale', async () => {
        const future = task('pr-comments-future-clock', TaskStates.PROCESSING);
        future.updatedAt = '2026-08-05T00:00:00.000Z';
        const manager = stateManager([future]);

        const summary = await reconcileStaleTaskStates({
            stateManager: manager as never,
            queue: queue({}),
            redis: { eval: async () => 0, pttl: async () => -2 },
            staleAfterMs: 1000,
            now: () => new Date('2026-08-04T00:10:00.000Z').getTime(),
            findRunningContainer: async () => null,
        });

        assert.equal(manager.states.get(future.taskId)?.state, TaskStates.FAILED);
        assert.equal(summary.fresh, 0);
        assert.equal(summary.interrupted, 1);
    });

    test('retries owned-lock cleanup before making the state terminal', async () => {
        const abandoned = task('pr-comments-lock-cleanup-retry', TaskStates.PROCESSING);
        const manager = stateManager([abandoned]);
        let attempts = 0;

        const summary = await reconcileStaleTaskStates({
            stateManager: manager as never,
            queue: queue({}),
            redis: {
                eval: async () => {
                    attempts++;
                    if (attempts === 1) throw new Error('temporary Redis failure');
                    return 1;
                },
                pttl: async () => -2,
            },
            staleAfterMs: 1000,
            now: () => new Date('2026-08-04T00:10:00.000Z').getTime(),
            findRunningContainer: async () => null,
        });

        assert.equal(attempts, 2);
        assert.equal(manager.states.get(abandoned.taskId)?.state, TaskStates.FAILED);
        assert.equal(summary.locksCleared, 1);
        assert.equal(summary.interrupted, 1);
    });

    test('terminalizes an invalid completed result as a diagnostic failure', async () => {
        const malformed = task('pr-comments-malformed-result', TaskStates.PROCESSING);
        const manager = stateManager([malformed]);

        const summary = await reconcileStaleTaskStates({
            stateManager: manager as never,
            queue: queue({
                [malformed.taskId]: { state: 'completed', returnvalue: { status: 'compelete' } },
            }),
            redis: { eval: async () => 0, pttl: async () => -2 },
            staleAfterMs: 1000,
            now: () => new Date('2026-08-04T00:10:00.000Z').getTime(),
            findRunningContainer: async () => null,
        });

        assert.equal(manager.states.get(malformed.taskId)?.state, TaskStates.FAILED);
        assert.match(manager.updates[0].metadata.error?.message ?? '', /invalid result status: compelete/);
        assert.equal(summary.interrupted, 1);
        assert.equal(summary.errors, 0);
    });

    test('allows only one of two concurrent reconcilers to terminalize a task', async () => {
        const interrupted = task('pr-comments-concurrent', TaskStates.PROCESSING);
        const manager = stateManager([interrupted]);
        const options = {
            stateManager: manager as never,
            queue: queue({}),
            redis: { eval: async () => 0, pttl: async () => -2 },
            staleAfterMs: 1000,
            now: () => new Date('2026-08-04T00:10:00.000Z').getTime(),
            findRunningContainer: async () => null,
        };

        const summaries = await Promise.all([
            reconcileStaleTaskStates(options),
            reconcileStaleTaskStates(options),
        ]);

        assert.equal(manager.updates.length, 1);
        assert.equal(manager.states.get(interrupted.taskId)?.state, TaskStates.FAILED);
        assert.equal(summaries.reduce((total, summary) => total + summary.interrupted, 0), 1);
    });

    test('releases only the exact lease token recorded for the abandoned attempt', async () => {
        const abandoned = task('pr-comments-old-attempt', TaskStates.PROCESSING);
        abandoned.correlationId = 'shared-correlation';
        abandoned.prProcessingLockToken = 'shared-correlation:old-attempt';
        const successorToken = 'shared-correlation:live-successor';
        const manager = stateManager([abandoned]);
        const evalMock = mock.fn(async (
            _script: string,
            _numberOfKeys: number,
            _lockKey: string,
            requestedToken: string,
        ) => requestedToken === successorToken ? 1 : 0);

        const summary = await reconcileStaleTaskStates({
            stateManager: manager as never,
            queue: queue({}),
            redis: { eval: evalMock, pttl: async () => -2 },
            staleAfterMs: 1000,
            now: () => new Date('2026-08-04T00:10:00.000Z').getTime(),
            findRunningContainer: async () => null,
        });

        assert.equal(evalMock.mock.calls[0].arguments[3], 'shared-correlation:old-attempt');
        assert.notEqual(evalMock.mock.calls[0].arguments[3], successorToken);
        assert.equal(summary.locksCleared, 0);
    });
});

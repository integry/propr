import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, describe, test } from 'node:test';
import { closeConnection, TaskStates, type TaskStateData, type UpdateMetadata } from '@propr/core';
import {
    attachPRCommentTaskStateFinalizers,
    finalizeTerminalPRCommentJobFailure,
    runWithTaskReconciliationLease,
} from '../src/workerTaskStateRecovery.js';

after(async () => { await closeConnection(); });

function stateManager() {
    let current: TaskStateData = {
        taskId: 'pr-comments-retry',
        issueRef: { number: 1748, repoOwner: 'integry', repoName: 'propr', type: 'pr_comment' },
        correlationId: 'correlation-1',
        state: TaskStates.PROCESSING,
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z',
        attempts: 0,
        history: [],
    };
    const updates: Array<{ state: TaskStateData['state']; metadata: UpdateMetadata }> = [];
    return {
        updates,
        getTaskState: async () => current,
        updateTaskStateIfCurrent: async (
            _taskId: string,
            expectation: Pick<TaskStateData, 'state' | 'updatedAt'>,
            state: TaskStateData['state'],
            metadata: UpdateMetadata,
        ) => {
            if (current.state !== expectation.state) return null;
            if (expectation.updatedAt && current.updatedAt !== expectation.updatedAt) return null;
            current = { ...current, state };
            updates.push({ state, metadata });
            return current;
        },
    };
}

describe('worker task state recovery hooks', () => {
    test('does not terminalize a retryable BullMQ failed event', async () => {
        const manager = stateManager();

        const changed = await finalizeTerminalPRCommentJobFailure({
            id: 'pr-comments-retry',
            name: 'processPullRequestComment',
            getState: async () => 'delayed',
        }, new Error('temporary failure'), manager as never);

        assert.equal(changed, false);
        assert.equal(manager.updates.length, 0);
    });

    test('terminalizes a job only after BullMQ places it in failed', async () => {
        const manager = stateManager();

        const changed = await finalizeTerminalPRCommentJobFailure({
            id: 'pr-comments-retry',
            name: 'processPullRequestComment',
            getState: async () => 'failed',
        }, new Error('attempts exhausted'), manager as never);

        assert.equal(changed, true);
        assert.equal(manager.updates[0].state, TaskStates.FAILED);
    });

    test('accepts a numeric BullMQ job ID of zero', async () => {
        const manager = stateManager();

        const changed = await finalizeTerminalPRCommentJobFailure({
            id: 0,
            name: 'processPullRequestComment',
            getState: async () => 'failed',
        }, new Error('attempts exhausted'), manager as never);

        assert.equal(changed, true);
        assert.equal(manager.updates[0].state, TaskStates.FAILED);
    });

    test('permits only one process to reconcile under the distributed lease', async () => {
        let leaseToken: string | null = null;
        const redis = {
            set: async (_key: string, token: string) => {
                if (leaseToken) return null;
                leaseToken = token;
                return 'OK';
            },
            eval: async (script: string, _numberOfKeys: number, _key: string, token: string) => {
                if (leaseToken !== token) return 0;
                if (script.includes("redis.call('del'")) leaseToken = null;
                return 1;
            },
        };
        let firstStarted!: () => void;
        const started = new Promise<void>(resolve => { firstStarted = resolve; });
        let finishFirst!: () => void;
        const finish = new Promise<void>(resolve => { finishFirst = resolve; });
        const first = runWithTaskReconciliationLease(redis, 120_000, async () => {
            firstStarted();
            await finish;
        });
        await started;

        const second = await runWithTaskReconciliationLease(redis, 120_000, async () => {
            assert.fail('second reconciler must not run while the lease is held');
        });
        finishFirst();

        assert.equal(second, false);
        assert.equal(await first, true);
        assert.equal(leaseToken, null);
    });

    test('aborts reconciliation mutations after lease renewal loses ownership', async () => {
        const redis = {
            set: async () => 'OK',
            eval: async (script: string) => script.includes("redis.call('pexpire'") ? 0 : 0,
        };
        let mutations = 0;
        let observedAbort = false;

        const ran = await runWithTaskReconciliationLease(redis, 30, async signal => {
            mutations++;
            while (!signal.aborted) {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            observedAbort = true;
            signal.throwIfAborted();
            mutations++;
        });

        assert.equal(ran, false);
        assert.equal(observedAbort, true);
        assert.equal(mutations, 1);
    });

    test('keeps completed hooks attached while graceful worker close drains a job', async () => {
        const manager = stateManager();
        const worker = new EventEmitter();
        const finalizers = attachPRCommentTaskStateFinalizers(
            worker as never,
            manager as never,
            async () => null,
        );

        const closeWorker = async (): Promise<void> => {
            worker.emit('completed', {
                id: 0,
                name: 'processPullRequestComment',
            }, { status: 'complete' });
            await Promise.resolve();
        };

        await closeWorker();
        await finalizers.close();

        assert.equal(manager.updates.length, 1);
        assert.equal(manager.updates[0].state, TaskStates.COMPLETED);
    });
});

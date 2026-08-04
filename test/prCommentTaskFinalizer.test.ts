import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection, TaskStates, type TaskStateData, type UpdateMetadata } from '@propr/core';
import {
    finalizePRCommentTaskFailure,
    finalizePRCommentTaskResult,
} from '../src/jobs/prCommentTaskFinalizer.js';

after(async () => { await closeConnection(); });

function task(state: TaskStateData['state']): TaskStateData {
    return {
        taskId: 'task-1',
        issueRef: { number: 42, repoOwner: 'integry', repoName: 'propr' },
        correlationId: 'correlation-1',
        state,
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z',
        attempts: 0,
        history: [{ state, timestamp: '2026-08-04T00:00:00.000Z', reason: 'test' }],
    };
}

function stateManager(initialState: TaskStateData) {
    let current = initialState;
    const updates: Array<{ state: TaskStateData['state']; metadata: UpdateMetadata }> = [];
    return {
        updates,
        getTaskState: async () => current,
        updateTaskStateIfCurrent: async (
            _taskId: string,
            expectation: Pick<TaskStateData, 'state' | 'updatedAt'>,
            state: TaskStateData['state'],
            metadata: UpdateMetadata = {},
        ) => {
            if (current.state !== expectation.state) return null;
            if (expectation.updatedAt && current.updatedAt !== expectation.updatedAt) return null;
            updates.push({ state, metadata });
            current = { ...current, state };
            return current;
        },
    };
}

describe('PR comment task finalization', () => {
    test('turns a skipped BullMQ result into a terminal completed state', async () => {
        const manager = stateManager(task(TaskStates.PENDING));

        const changed = await finalizePRCommentTaskResult('task-1', manager as never, {
            status: 'skipped',
            reason: 'already_processed',
            pullRequestNumber: 42,
        });

        assert.equal(changed, true);
        assert.equal(manager.updates.length, 1);
        assert.equal(manager.updates[0].state, TaskStates.COMPLETED);
        assert.equal(manager.updates[0].metadata.reason, 'Task skipped: already_processed');
        assert.deepEqual(manager.updates[0].metadata.historyMetadata, {
            outcome: 'skipped',
            resultReason: 'already_processed',
            pullRequestNumber: 42,
        });
    });

    test('marks a rescheduled attempt as superseded instead of leaving it running', async () => {
        const manager = stateManager(task(TaskStates.CLAUDE_EXECUTION));

        await finalizePRCommentTaskResult('task-1', manager as never, {
            status: 'rescheduled',
            reason: 'pr_locked_by_other_job',
        });

        assert.equal(manager.updates[0].state, TaskStates.CANCELLED);
        assert.equal(manager.updates[0].metadata.historyMetadata?.superseded, true);
    });

    test('is idempotent for terminal task states', async () => {
        const manager = stateManager(task(TaskStates.COMPLETED));
        const changed = await finalizePRCommentTaskResult('task-1', manager as never, { status: 'skipped' });

        assert.equal(changed, false);
        assert.equal(manager.updates.length, 0);
    });

    test('marks an unhandled worker failure terminal', async () => {
        const manager = stateManager(task(TaskStates.PROCESSING));
        const changed = await finalizePRCommentTaskFailure('task-1', manager as never, new Error('worker exited'));

        assert.equal(changed, true);
        assert.equal(manager.updates[0].state, TaskStates.FAILED);
        assert.equal(manager.updates[0].metadata.error?.message, 'worker exited');
    });

    test('maps an explicit failed result to failed instead of completed', async () => {
        const manager = stateManager(task(TaskStates.PROCESSING));

        const changed = await finalizePRCommentTaskResult('task-1', manager as never, {
            status: 'failed',
            reason: 'review generation failed',
        });

        assert.equal(changed, true);
        assert.equal(manager.updates[0].state, TaskStates.FAILED);
        assert.equal(manager.updates[0].metadata.error?.message, 'review generation failed');
    });

    test('turns an unknown completed-job outcome into a diagnostic failure', async () => {
        const manager = stateManager(task(TaskStates.PROCESSING));

        const changed = await finalizePRCommentTaskResult('task-1', manager as never, { status: 'compelete' });

        assert.equal(changed, true);
        assert.equal(manager.updates[0].state, TaskStates.FAILED);
        assert.match(manager.updates[0].metadata.error?.message ?? '', /unknown result status: compelete/);
        assert.deepEqual(manager.updates[0].metadata.historyMetadata, {
            outcome: 'invalid_completed_result',
            returnedStatus: 'compelete',
        });
    });

    test('turns a missing completed-job result into a diagnostic failure', async () => {
        const manager = stateManager(task(TaskStates.PROCESSING));

        await finalizePRCommentTaskResult('task-1', manager as never, undefined);

        assert.equal(manager.updates[0].state, TaskStates.FAILED);
        assert.match(manager.updates[0].metadata.error?.message ?? '', /missing result status/);
    });

    test('does not overwrite a cancellation that wins the finalization race', async () => {
        let current = task(TaskStates.PROCESSING);
        const manager = {
            getTaskState: async () => current,
            updateTaskStateIfCurrent: async (
                _taskId: string,
                expectation: Pick<TaskStateData, 'state' | 'updatedAt'>,
            ) => {
                current = { ...current, state: TaskStates.CANCELLED };
                return current.state === expectation.state ? current : null;
            },
        };

        const changed = await finalizePRCommentTaskResult('task-1', manager as never, { status: 'complete' });

        assert.equal(changed, false);
        assert.equal(current.state, TaskStates.CANCELLED);
    });
});

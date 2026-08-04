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
        updateTaskState: async (_taskId: string, state: TaskStateData['state'], metadata: UpdateMetadata = {}) => {
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
});

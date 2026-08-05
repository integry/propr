import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection, TaskStates, type TaskStateData, type TaskStateExpectation, type UpdateMetadata } from '@propr/core';
import {
    finalizePRCommentTaskFailure,
    finalizePRCommentTaskResult,
    finalizePRCommentTaskResultBestEffort,
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
            expectation: TaskStateExpectation,
            state: TaskStateData['state'],
            metadata: UpdateMetadata = {},
        ) => {
            if (current.state !== expectation.state) return null;
            if (expectation.updatedAt && current.updatedAt !== expectation.updatedAt) return null;
            if (expectation.prProcessingLockToken !== undefined
                && current.prProcessingLockToken !== expectation.prProcessingLockToken) return null;
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

    test('sanitizes recovery failures before persistence', async () => {
        const manager = stateManager(task(TaskStates.PROCESSING));
        await finalizePRCommentTaskFailure(
            'task-1',
            manager as never,
            new Error('failed at https://x-access-token:secret-token@github.com/integry/propr'),
        );

        assert.doesNotMatch(manager.updates[0].metadata.error?.message ?? '', /secret-token/);
        assert.match(manager.updates[0].metadata.error?.message ?? '', /REDACTED/);
        assert.doesNotMatch(manager.updates[0].metadata.reason ?? '', /secret-token/);
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

    test('requires the matching attempt token for generated task state', async () => {
        const generated = task(TaskStates.PROCESSING);
        generated.prProcessingLockToken = 'successor-token';
        const manager = stateManager(generated);

        const unfenced = await finalizePRCommentTaskResult('task-1', manager as never, {
            status: 'complete',
        });
        const stale = await finalizePRCommentTaskResult('task-1', manager as never, {
            status: 'complete',
            prProcessingLockToken: 'old-token',
        });
        const matching = await finalizePRCommentTaskResult('task-1', manager as never, {
            status: 'complete',
            prProcessingLockToken: 'successor-token',
        });

        assert.equal(unfenced, false);
        assert.equal(stale, false);
        assert.equal(matching, true);
        assert.equal(manager.updates.length, 1);
        assert.equal(manager.updates[0].state, TaskStates.COMPLETED);
    });

    test('validates a completed result token even when reconciliation supplies an expectation', async () => {
        const generated = task(TaskStates.PROCESSING);
        generated.prProcessingLockToken = 'successor-token';
        const manager = stateManager(generated);

        const changed = await finalizePRCommentTaskResult(
            'task-1',
            manager as never,
            { status: 'complete', prProcessingLockToken: 'stale-token' },
            {
                expectation: {
                    state: generated.state,
                    updatedAt: generated.updatedAt,
                    prProcessingLockToken: generated.prProcessingLockToken,
                },
            },
        );

        assert.equal(changed, false);
        assert.equal(manager.updates.length, 0);
    });

    test('defers a skipped result when Redis finalization fails', async () => {
        let reportedError: unknown;
        const changed = await finalizePRCommentTaskResultBestEffort(
            'task-1',
            {
                getTaskState: async () => { throw new Error('Redis unavailable'); },
                updateTaskStateIfCurrent: async () => null,
            } as never,
            { status: 'skipped' },
            { onError: error => { reportedError = error; } },
        );

        assert.equal(changed, false);
        assert.match((reportedError as Error).message, /Redis unavailable/);
    });
});

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
    getTerminalJobResultForAutomaticRetry,
    type AutomaticRetryAttempt,
} from '../src/utils/workerStateManagerHelpers.js';
import {
    TaskStates,
    type TaskState,
    type TaskStateData,
} from '../src/utils/workerStateManager.types.js';

const taskId = 'automatic-retry-task';
const timestamp = '2026-08-14T12:00:00.000Z';

function makeTaskState(state: TaskState, jobId: string | undefined = 'job-1899'): TaskStateData {
    return {
        taskId,
        issueRef: {
            type: 'pr_comment',
            number: 1899,
            repoOwner: 'integry',
            repoName: 'propr',
            jobId,
        },
        correlationId: 'correlation-1899',
        state,
        createdAt: timestamp,
        updatedAt: timestamp,
        attempts: 1,
        history: [],
    };
}

async function exercise(
    state: TaskStateData,
    attempt: AutomaticRetryAttempt,
) {
    const updateTaskState = mock.fn(async (_id: string, newState: TaskState) => ({
        ...state,
        state: newState,
    }));
    const result = await getTerminalJobResultForAutomaticRetry(
        taskId,
        state,
        attempt,
        updateTaskState,
    );
    return { result, updateTaskState };
}

test('returns the stable completed result without reopening the task', async () => {
    const { result, updateTaskState } = await exercise(makeTaskState(TaskStates.COMPLETED), {
        jobId: 'job-1899', attemptsMade: 1, totalAttempts: 2,
    });

    assert.deepEqual(result, { status: 'complete', reason: 'task_already_completed' });
    assert.equal(updateTaskState.mock.callCount(), 0);
});

test('returns the stable cancelled result without reopening the task', async () => {
    const { result, updateTaskState } = await exercise(makeTaskState(TaskStates.CANCELLED), {
        jobId: 'job-1899', attemptsMade: 1, totalAttempts: 2,
    });

    assert.deepEqual(result, { status: 'cancelled', reason: 'task_already_cancelled' });
    assert.equal(updateTaskState.mock.callCount(), 0);
});

test('keeps an exhausted matching failed job terminal', async () => {
    const { result, updateTaskState } = await exercise(makeTaskState(TaskStates.FAILED), {
        jobId: 'job-1899', attemptsMade: 2, totalAttempts: 2,
    });

    assert.deepEqual(result, { status: 'failed', reason: 'task_already_failed' });
    assert.equal(updateTaskState.mock.callCount(), 0);
});

test('keeps a failed task for a different BullMQ job ID terminal', async () => {
    const { result, updateTaskState } = await exercise(makeTaskState(TaskStates.FAILED), {
        jobId: 'different-job', attemptsMade: 1, totalAttempts: 2,
    });

    assert.deepEqual(result, { status: 'failed', reason: 'task_already_failed' });
    assert.equal(updateTaskState.mock.callCount(), 0);
});

test('defaults undefined total attempts to one and keeps the failed task terminal', async () => {
    const { result, updateTaskState } = await exercise(makeTaskState(TaskStates.FAILED), {
        jobId: 'job-1899', attemptsMade: 1, totalAttempts: undefined,
    });

    assert.deepEqual(result, { status: 'failed', reason: 'task_already_failed' });
    assert.equal(updateTaskState.mock.callCount(), 0);
});

test('reopens only the exact matching failed job when another attempt remains', async () => {
    const { result, updateTaskState } = await exercise(makeTaskState(TaskStates.FAILED), {
        jobId: 'job-1899', attemptsMade: 1, totalAttempts: 2,
    });

    assert.equal(result, undefined);
    assert.equal(updateTaskState.mock.callCount(), 1);
    assert.deepEqual(updateTaskState.mock.calls[0].arguments, [
        taskId,
        TaskStates.PROCESSING,
        { reason: 'Retrying task after a failed BullMQ attempt', isRetry: true },
    ]);
});

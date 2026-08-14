import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { TaskStates, type TaskStateData } from '../packages/core/src/utils/workerStateManager.types.js';

process.env.PROPR_DEMO_MODE = 'true';
await mock.module('@propr/core', {
    namedExports: {
        TaskStates,
        taskStateExpectation: (task: TaskStateData) => ({
            state: task.state,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            correlationId: task.correlationId,
            version: task.version,
        }),
    },
});
const { finalizeSkippedIssueTask } = await import('../src/jobs/issueTaskFinalizer.js');

function processingTask(): TaskStateData {
    return {
        taskId: 'issue-task',
        issueRef: { type: 'issue', number: 1898, repoOwner: 'integry', repoName: 'propr' },
        correlationId: 'correlation',
        state: TaskStates.PROCESSING,
        createdAt: '2026-08-14T12:00:00.000Z',
        updatedAt: '2026-08-14T12:01:00.000Z',
        version: 2,
        attempts: 0,
        history: [],
    };
}

test('label-based issue skip conditionally cancels through the publishing state path', async () => {
    const task = processingTask();
    const update = mock.fn(async (_id, _expectation, state, metadata) => ({
        state: { ...task, state },
        publication: { historyPersisted: true, eventPublished: true, errors: [] },
        metadata,
    }));
    const result = await finalizeSkippedIssueTask(task.taskId, 'Primary tag missing\nsecret', {
        getTaskState: mock.fn(async () => task),
        updateTaskStateIfCurrentDetailed: update as never,
    }, task);

    assert.equal(result, 'cancelled');
    assert.equal(update.mock.calls[0].arguments[2], TaskStates.CANCELLED);
    assert.match(String(update.mock.calls[0].arguments[3]?.reason), /Primary tag missing\s+secret/);
    assert.equal(update.mock.calls[0].arguments[1]?.version, task.version);
});

test('label-based issue skip never overwrites a concurrent newer or terminal state', async () => {
    const task = processingTask();
    const getTaskState = mock.fn(async () => ({ ...task, state: TaskStates.COMPLETED, version: 3 }));
    const result = await finalizeSkippedIssueTask(task.taskId, 'Already done', {
        getTaskState,
        updateTaskStateIfCurrentDetailed: mock.fn(async () => null),
    }, task);

    assert.equal(result, 'unchanged');
    assert.equal(getTaskState.mock.calls.length, 1);
});

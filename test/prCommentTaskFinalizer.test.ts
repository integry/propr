import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
    TaskStates,
    type TaskState,
    type TaskStateData,
    type TaskStateExpectation,
    type UpdateMetadata,
} from '../packages/core/src/utils/workerStateManager.types.js';

await mock.module('@propr/core', {
    namedExports: {
        TaskStates,
        taskStateExpectation: (task: TaskStateData): TaskStateExpectation => ({
            state: task.state,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            correlationId: task.correlationId,
        }),
    },
});

const {
    finalizeCompletedPRCommentTask,
    finalizeFailedPRCommentTask,
} = await import('../src/jobs/prCommentTaskFinalizer.js');

function makeTask(state: TaskState = TaskStates.PROCESSING): TaskStateData {
    const timestamp = '2026-08-05T12:00:00.000Z';
    return {
        taskId: 'task-123',
        issueRef: { number: 1748, repoOwner: 'integry', repoName: 'propr' },
        correlationId: 'correlation-123',
        state,
        createdAt: timestamp,
        updatedAt: timestamp,
        attempts: 0,
        history: [{ state, timestamp, reason: 'Test state' }],
    };
}

function createStore(
    initialState: TaskStateData,
    failedCasAttempts = 0,
    publication = { historyPersisted: true, eventPublished: true, errors: [] as string[] },
) {
    let current = structuredClone(initialState);
    let remainingFailedCasAttempts = failedCasAttempts;
    const getTaskState = mock.fn(async () => structuredClone(current));
    const updateTaskStateIfCurrentDetailed = mock.fn(async (
        _taskId: string,
        expectation: TaskStateExpectation,
        newState: TaskState,
        metadata: UpdateMetadata,
    ) => {
        if (remainingFailedCasAttempts > 0) {
            remainingFailedCasAttempts--;
            current.updatedAt = new Date(Date.parse(current.updatedAt) + 1).toISOString();
            return null;
        }
        if (expectation.updatedAt !== current.updatedAt || expectation.state !== current.state) return null;
        current.state = newState;
        current.updatedAt = new Date(Date.parse(current.updatedAt) + 1).toISOString();
        current.history.push({
            state: newState,
            timestamp: current.updatedAt,
            reason: metadata.reason ?? 'Finalized',
            metadata: metadata.historyMetadata,
        });
        if (metadata.error) {
            current.lastError = {
                message: metadata.error.message,
                category: metadata.error.category ?? 'unknown',
                timestamp: current.updatedAt,
            };
        }
        return {
            state: structuredClone(current),
            publication,
        };
    });
    return { getTaskState, updateTaskStateIfCurrentDetailed, current: () => current };
}

test('completed PR comment results close nonterminal task states', async (t) => {
    const cases = [
        { status: 'complete', expected: TaskStates.COMPLETED },
        { status: 'completed', expected: TaskStates.COMPLETED },
        { status: 'partial', expected: TaskStates.COMPLETED },
        { status: 'skipped', expected: TaskStates.COMPLETED },
        { status: 'cancelled', expected: TaskStates.CANCELLED },
        { status: 'requeued', expected: TaskStates.CANCELLED },
        { status: 'rescheduled', expected: TaskStates.CANCELLED },
        { status: 'failed', expected: TaskStates.FAILED },
    ] as const;

    for (const testCase of cases) {
        await t.test(testCase.status, async () => {
            const store = createStore(makeTask());
            const result = await finalizeCompletedPRCommentTask(
                'task-123',
                { status: testCase.status, reason: 'test reason' },
                store,
            );
            assert.equal(result.outcome, 'finalized');
            assert.equal(store.current().state, testCase.expected);
        });
    }
});

test('unknown completed results are recorded as failures', async () => {
    const store = createStore(makeTask());
    await finalizeCompletedPRCommentTask('task-123', { status: 'mystery' }, store);

    assert.equal(store.current().state, TaskStates.FAILED);
    assert.match(store.current().lastError?.message ?? '', /Unexpected.*mystery/);
});

test('missing completed results are recorded as failures', async () => {
    const store = createStore(makeTask());
    await finalizeCompletedPRCommentTask('task-123', undefined, store);

    assert.equal(store.current().state, TaskStates.FAILED);
    assert.match(store.current().lastError?.message ?? '', /without a result status/);
});

test('failure finalization sanitizes errors before persisting them', async () => {
    const store = createStore(makeTask());
    await finalizeFailedPRCommentTask(
        'task-123',
        new Error('clone https://x-access-token:ghp_secretValue@github.com/integry/propr'),
        store,
    );

    assert.equal(store.current().state, TaskStates.FAILED);
    assert.doesNotMatch(store.current().lastError?.message ?? '', /ghp_secretValue/);
});

test('finalization never overwrites an existing terminal state', async () => {
    const store = createStore(makeTask(TaskStates.CANCELLED));
    const result = await finalizeCompletedPRCommentTask('task-123', { status: 'complete' }, store);

    assert.equal(result.outcome, 'already_terminal');
    assert.equal(store.current().state, TaskStates.CANCELLED);
    assert.equal(store.updateTaskStateIfCurrentDetailed.mock.calls.length, 0);
});

test('finalization retries a compare-and-set conflict with fresh state', async () => {
    const store = createStore(makeTask(), 1);
    const result = await finalizeCompletedPRCommentTask('task-123', { status: 'skipped' }, store);

    assert.equal(result.outcome, 'finalized');
    assert.equal(store.current().state, TaskStates.COMPLETED);
    assert.equal(store.updateTaskStateIfCurrentDetailed.mock.calls.length, 2);
});

test('finalization reports persistent compare-and-set contention', async () => {
    const store = createStore(makeTask(), Number.POSITIVE_INFINITY);

    await assert.rejects(
        finalizeCompletedPRCommentTask('task-123', { status: 'complete' }, store),
        /finalization conflicted 5 times/,
    );
    assert.equal(store.updateTaskStateIfCurrentDetailed.mock.calls.length, 5);
    assert.equal(store.current().state, TaskStates.PROCESSING);
});

test('processor reasons are sanitized and bounded before persistence', async () => {
    const store = createStore(makeTask());
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn';
    await finalizeCompletedPRCommentTask(
        'task-123',
        { status: 'skipped', reason: `${secret}${'x'.repeat(1_000)}` },
        store,
    );

    const history = store.current().history.at(-1);
    assert.ok(history);
    assert.doesNotMatch(history.reason, /ghp_/);
    assert.ok(history.reason.length <= 516);
    assert.doesNotMatch(String(history.metadata?.jobResultReason), /ghp_/);
});

test('finalization explicitly reports incomplete durable publication', async () => {
    const store = createStore(makeTask(), 0, {
        historyPersisted: false,
        eventPublished: true,
        errors: ['history: unavailable'],
    });

    const result = await finalizeCompletedPRCommentTask('task-123', { status: 'complete' }, store);

    assert.equal(result.outcome, 'partial_publication');
    assert.equal(result.stateChanged, true);
    assert.equal(result.publication?.historyPersisted, false);
});

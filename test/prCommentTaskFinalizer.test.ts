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
            version: task.version,
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
        if (expectation.state !== current.state
            || expectation.createdAt !== current.createdAt
            || expectation.updatedAt !== current.updatedAt
            || expectation.correlationId !== current.correlationId
            || (expectation.version ?? 0) !== (current.version ?? 0)) return null;
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
            if (testCase.expected === TaskStates.COMPLETED) {
                assert.equal(
                    store.current().history.at(-1)?.metadata?.notificationRecap,
                    testCase.status === 'partial'
                        ? 'Published the partial pull request follow-up result.'
                        : testCase.status === 'skipped'
                            ? 'Skipped the pull request follow-up because no further work was needed.'
                            : 'Completed the pull request follow-up.',
                );
            }
        });
    }
});

test('completed PR comment recovery explains known continuation outcomes', async (t) => {
    const cases = [
        ['review_moved_to_continuation', 'Review processing moved to the continuation pull request.'],
        ['ultrafix_waiting_for_exact_head_checks', 'Review deferred until the continuation pull request passes its exact-head checks.'],
    ] as const;

    for (const [reason, expectedRecap] of cases) {
        await t.test(reason, async () => {
            const store = createStore(makeTask());
            await finalizeCompletedPRCommentTask('task-123', { status: 'skipped', reason }, store);
            assert.equal(store.current().history.at(-1)?.metadata?.notificationRecap, expectedRecap);
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

test('finalization keeps retrying after five compare-and-set conflicts', async () => {
    const store = createStore(makeTask(), 5);

    const result = await finalizeCompletedPRCommentTask('task-123', { status: 'complete' }, store);

    assert.equal(result.outcome, 'finalized');
    assert.equal(store.updateTaskStateIfCurrentDetailed.mock.calls.length, 6);
    assert.equal(store.current().state, TaskStates.COMPLETED);
});

test('recovery finalization rejects when the task changed after its stale scan', async () => {
    const scanned = makeTask();
    scanned.version = 4;
    const refreshed = structuredClone(scanned);
    refreshed.updatedAt = '2026-08-05T12:05:00.000Z';
    refreshed.version = 5;
    const store = createStore(refreshed);
    const expectation: TaskStateExpectation = {
        state: scanned.state,
        createdAt: scanned.createdAt,
        updatedAt: scanned.updatedAt,
        correlationId: scanned.correlationId,
        version: scanned.version,
    };

    const result = await finalizeFailedPRCommentTask(
        'task-123',
        new Error('orphaned'),
        store,
        { expectation },
    );

    assert.equal(result.outcome, 'state_changed');
    assert.equal(result.stateChanged, false);
    assert.equal(store.current().state, TaskStates.PROCESSING);
    assert.equal(store.updateTaskStateIfCurrentDetailed.mock.calls.length, 1);
    assert.deepEqual(
        store.updateTaskStateIfCurrentDetailed.mock.calls[0].arguments[1],
        expectation,
    );
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

test('both completion finalizers map the legacy user_cancelled result to a user cancellation', async () => {
    const { completedJobTransition } = await import('../src/taskReconciliationTransitions.js');
    const store = createStore(makeTask());
    await finalizeCompletedPRCommentTask('task-123', { status: 'cancelled', reason: 'user_cancelled' }, store);
    assert.equal(store.current().history.at(-1)!.reason, 'Cancelled by a user.');
    const recovered = completedJobTransition({ status: 'cancelled', reason: 'user_cancelled' });
    assert.equal(recovered.reason, 'Cancelled by a user.');
    assert.equal(recovered.metadata.terminalReason, 'cancelled_by_user');
});

test('both completion finalizers keep cancellation codes out of history reasons', async () => {
    const { completedJobTransition } = await import('../src/taskReconciliationTransitions.js');
    for (const [reason, explanation] of [
        ['cancelled_issue_closed', 'Cancelled because the issue was closed.'],
        ['cancelled_label_removed', 'Cancelled because the processing trigger label was removed.'],
        ['cancelled_pr_closed', 'Cancelled because the pull request was closed without merging.'],
        ['cancelled_by_user', 'Cancelled by a user.'],
    ]) {
        const store = createStore(makeTask());
        await finalizeCompletedPRCommentTask('task-123', { status: 'cancelled', reason }, store);
        const entry = store.current().history.at(-1)!;
        assert.equal(entry.reason, explanation);
        assert.equal(entry.metadata?.cancellationReason, reason);
        const recovered = completedJobTransition({ status: 'cancelled', reason });
        assert.equal(recovered.reason, explanation);
        assert.equal(recovered.metadata.terminalReason, reason);
    }
    for (const status of ['requeued', 'rescheduled']) {
        const store = createStore(makeTask());
        await finalizeCompletedPRCommentTask('task-123', { status, reason: 'lock_contention' }, store);
        assert.equal(store.current().history.at(-1)?.metadata?.cancellationReason, undefined);
        assert.equal(completedJobTransition({ status, reason: 'lock_contention' }).metadata.terminalReason, undefined);
    }
});

test('reconciliation preserves transport failures without inventing an overall timeout', async () => {
    const { failedTaskTransition, completedJobTransition, redisTerminalTransition } = await import('../src/taskReconciliationTransitions.js');
    for (const message of ['connect ETIMEDOUT 140.82.0.1:443', 'Redis command timeout', 'git push timed out']) {
        for (const transition of [failedTaskTransition(message, 'bullmq_failed_reconciliation'), completedJobTransition({ status: 'failed', reason: message })]) {
            assert.equal(transition.state, TaskStates.FAILED);
            assert.equal(transition.metadata.terminalReason, undefined);
            assert.equal((transition.metadata.error as { message: string }).message, message);
        }
    }
    const timeout = makeTask(TaskStates.FAILED);
    timeout.terminalReason = 'timed_out';
    timeout.history.at(-1)!.metadata = { terminalReason: 'timed_out' };
    assert.equal(redisTerminalTransition(timeout).metadata.terminalReason, 'timed_out');
});

import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert';

process.env.GH_APP_ID ??= '1';
process.env.GH_PRIVATE_KEY_PATH ??= '.propr/test-private-key.pem';
process.env.GH_INSTALLATION_ID ??= '1';
process.env.NODE_ENV ??= 'test';

const { stopTaskExecution, isBenignQueueRemovalRace } = await import('../packages/api/routes/stopTaskExecution.js');
const { cancelMergedPullRequestTasks } = await import('../packages/api/mergedPullRequestCancellation.js');

after(async () => {
    const { closeConnection: closePackageConnection } = await import('@propr/core');
    const { closeConnection } = await import('../packages/core/src/db/connection.ts');
    await closePackageConnection();
    await closeConnection();
});

const markTaskCancelled = mock.fn(async () => ({}));
const updateHistoryMetadata = mock.fn(async () => ({}));
const stopDockerContainer = mock.fn(async () => ({ success: true }));
const log = {
    info: mock.fn(),
    warn: mock.fn(),
};

function createRedisClient() {
    const messages: Array<Record<string, unknown>> = [];
    const conversationEntries = new Map<string, string[]>();
    const store = new Map<string, string>();

    return {
        messages,
        conversationEntries,
        store,
        get: mock.fn(async (key: string) => store.get(key) ?? null),
        set: mock.fn(async (key: string, value: string) => {
            store.set(key, value);
            return 'OK';
        }),
        del: mock.fn(async (key: string) => {
            store.delete(key);
            return 1;
        }),
        lRange: mock.fn(async (key: string, start: number, end: number) => {
            const entries = conversationEntries.get(key) ?? [];
            const normalizedStart = start < 0 ? Math.max(entries.length + start, 0) : start;
            const normalizedEnd = end < 0 ? entries.length + end : end;
            return entries.slice(normalizedStart, normalizedEnd + 1);
        }),
        rPush: mock.fn(async (key: string, value: string) => {
            const entries = conversationEntries.get(key) ?? [];
            entries.push(value);
            conversationEntries.set(key, entries);
            messages.push(JSON.parse(value) as Record<string, unknown>);
            return 1;
        }),
    };
}

beforeEach(() => {
    markTaskCancelled.mock.resetCalls();
    markTaskCancelled.mock.mockImplementation(async () => ({}));
    updateHistoryMetadata.mock.resetCalls();
    updateHistoryMetadata.mock.mockImplementation(async () => ({}));
    stopDockerContainer.mock.resetCalls();
    stopDockerContainer.mock.mockImplementation(async () => ({ success: true }));
    log.info.mock.resetCalls();
    log.warn.mock.resetCalls();
});

test('stopTaskExecution rejects pending non-terminal tasks without a queue-backed worker', async () => {
    const redisClient = createRedisClient();
    await assert.rejects(async () => {
        await stopTaskExecution(
            'task-1',
            {
                redisClient,
                requestedBy: 'system',
                cancellation: {
                    code: 'pull_request_merged',
                    message: 'Task cancelled because pull request #42 was merged.',
                },
            },
            {
                loadStopTaskContext: async () => ({
                    normalizedTaskId: 'task-1',
                    state: { history: [{ state: 'pending' }] },
                    currentState: 'pending',
                    queueJob: null,
                    queueState: null,
                    taskId: 'task-1',
                    abortTaskIds: ['task-1'],
                }),
                ensureTaskStateForCancellation: async () => {},
                getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
                stopDockerContainer,
            },
        );
    }, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.strictEqual(error.name, 'StopTaskExecutionError');
        assert.strictEqual((error as { status?: number }).status, 409);
        assert.match(error.message, /not in a stoppable worker or queue state/);
        return true;
    });

    assert.strictEqual(redisClient.set.mock.calls.length, 0);
    assert.strictEqual(markTaskCancelled.mock.calls.length, 0);
    assert.deepStrictEqual(redisClient.messages, []);
});

test('stopTaskExecution rejects queued cancellation when removal loses the race to a terminal state', async () => {
    const redisClient = createRedisClient();
    const queueJob = {
        id: 'queue-job-1',
        remove: mock.fn(async () => {
            throw new Error('job lock missing');
        }),
        getState: mock.fn(async () => 'completed'),
    };

    await assert.rejects(async () => {
        await stopTaskExecution(
            'queue-job-1',
            {
                redisClient,
                requestedBy: 'system',
                cancellation: {
                    code: 'pull_request_merged',
                    message: 'Task cancelled because pull request #42 was merged.',
                },
            },
            {
                loadStopTaskContext: async () => ({
                    normalizedTaskId: 'queue-job-1',
                    state: null,
                    currentState: null,
                    queueJob: queueJob as never,
                    queueState: 'waiting',
                    taskId: 'task-queue-1',
                    abortTaskIds: ['task-queue-1', 'queue-job-1'],
                }),
                ensureTaskStateForCancellation: async () => {},
                getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
                stopDockerContainer,
            },
        );
    }, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.strictEqual(error.name, 'StopTaskExecutionError');
        assert.strictEqual((error as { status?: number }).status, 409);
        assert.match(error.message, /reached a terminal state before cancellation was applied/);
        return true;
    });

    assert.strictEqual(markTaskCancelled.mock.calls.length, 0);
    assert.strictEqual(updateHistoryMetadata.mock.calls.length, 0);
    assert.deepStrictEqual(redisClient.set.mock.calls.map((call) => call.arguments[0]).sort(), []);
    assert.deepStrictEqual(redisClient.del.mock.calls.map((call) => call.arguments[0]).sort(), []);
});

test('stopTaskExecution arms abort signals only after a queued removal race turns active', async () => {
    const redisClient = createRedisClient();
    const queueJob = {
        id: 'queue-job-active-race-1',
        remove: mock.fn(async () => {
            throw new Error('job lock missing');
        }),
        getState: mock.fn(async () => 'active'),
    };

    const result = await stopTaskExecution(
        'queue-job-active-race-1',
        {
            redisClient,
            requestedBy: 'system',
            cancellation: {
                code: 'pull_request_merged',
                message: 'Task cancelled because pull request #42 was merged.',
            },
        },
        {
            loadStopTaskContext: async () => ({
                normalizedTaskId: 'queue-job-active-race-1',
                state: null,
                currentState: null,
                queueJob: queueJob as never,
                queueState: 'waiting',
                taskId: 'task-queue-active-race-1',
                abortTaskIds: ['task-queue-active-race-1', 'queue-job-active-race-1'],
            }),
            ensureTaskStateForCancellation: async () => {},
            getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
            stopDockerContainer,
        },
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stopVerified, false);
    assert.strictEqual(result.abortSignalArmed, true);
    assert.deepStrictEqual(redisClient.set.mock.calls
        .map((call) => call.arguments[0])
        .filter((key) => !key.startsWith('conversation:stop-message-dedupe:'))
        .sort(), [
        'worker:abort:queue-job-active-race-1',
        'worker:abort:task-queue-active-race-1',
        'worker:stop-requested:queue-job-active-race-1',
        'worker:stop-requested:task-queue-active-race-1',
    ]);
    assert.strictEqual(redisClient.store.has('worker:stop-outcome:queue-job-active-race-1'), false);
    assert.strictEqual(redisClient.store.has('worker:stop-outcome:task-queue-active-race-1'), false);
    assert.strictEqual(markTaskCancelled.mock.calls.length, 0);
    assert.strictEqual(updateHistoryMetadata.mock.calls.length, 0);
});

test('stopTaskExecution records pending cancellation when abort-armed container stop fails', async () => {
    const redisClient = createRedisClient();
    const result = await stopTaskExecution(
        'task-2',
        {
            redisClient,
            requestedBy: 'system',
            cancellation: {
                code: 'pull_request_merged',
                message: 'Task cancelled because pull request #42 was merged.',
            },
        },
        {
            loadStopTaskContext: async () => ({
                normalizedTaskId: 'task-2',
                state: { history: [{ state: 'claude_execution', metadata: { containerId: 'container-1' } }] },
                currentState: 'claude_execution',
                queueJob: null,
                queueState: null,
                taskId: 'task-2',
                abortTaskIds: ['task-2'],
            }),
            ensureTaskStateForCancellation: async () => {},
            getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
            stopDockerContainer: mock.fn(async () => ({ success: false, error: 'timeout' })),
        },
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.containerStopped, false);
    assert.strictEqual(result.jobRemoved, false);
    assert.strictEqual(result.message, 'Stop request sent to worker. The execution will be terminated shortly.');
    assert.deepStrictEqual(redisClient.set.mock.calls
        .map((call) => call.arguments[0])
        .filter((key) => !key.startsWith('conversation:stop-message-dedupe:'))
        .sort(), [
        'worker:abort:task-2',
        'worker:stop-requested:task-2',
    ]);
    assert.strictEqual(markTaskCancelled.mock.calls.length, 0);
    assert.strictEqual(updateHistoryMetadata.mock.calls.length, 1);
});

test('stopTaskExecution with requireVerifiedStop records but does not finalize pending aborts', async () => {
    const redisClient = createRedisClient();
    await assert.rejects(async () => {
        await stopTaskExecution(
            'task-require-verified-pending',
            {
                redisClient,
                requestedBy: 'system',
                requireVerifiedStop: true,
                cancellation: {
                    code: 'pull_request_merged',
                    message: 'Task cancelled because pull request #42 was merged.',
                },
            },
            {
                loadStopTaskContext: async () => ({
                    normalizedTaskId: 'task-require-verified-pending',
                    state: { history: [{ state: 'processing' }] },
                    currentState: 'processing',
                    queueJob: null,
                    queueState: null,
                    taskId: 'task-require-verified-pending',
                    abortTaskIds: ['task-require-verified-pending'],
                }),
                ensureTaskStateForCancellation: async () => {},
                getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
                stopDockerContainer,
            },
        );
    }, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.strictEqual(error.name, 'StopTaskExecutionError');
        assert.strictEqual((error as { status?: number }).status, 409);
        assert.match(error.message, /must be rechecked/);
        return true;
    });

    assert.strictEqual(markTaskCancelled.mock.calls.length, 0);
    assert.strictEqual(updateHistoryMetadata.mock.calls.length, 1);
    assert.deepStrictEqual(redisClient.messages.map((message) => message.content), [
        'Cancellation requested. Worker shutdown is still in progress.',
    ]);
    assert.deepStrictEqual(redisClient.set.mock.calls
        .map((call) => call.arguments[0])
        .filter((key) => !key.startsWith('conversation:stop-message-dedupe:'))
        .sort(), [
        'worker:abort:task-require-verified-pending',
        'worker:stop-requested:task-require-verified-pending',
    ]);
    assert.deepStrictEqual(redisClient.del.mock.calls.map((call) => call.arguments[0]), []);
    assert.strictEqual(redisClient.store.has('worker:abort:task-require-verified-pending'), true);
    assert.strictEqual(redisClient.store.has('worker:stop-requested:task-require-verified-pending'), true);
});

test('stopTaskExecution retries persisted cancellation after a queue removal persistence failure', async () => {
    const redisClient = createRedisClient();
    const queueJob = {
        id: 'queue-job-retry-1',
        data: {
            repository: 'owner/repo',
            prNumber: 42,
        },
        remove: mock.fn(async () => undefined),
        getState: mock.fn(async () => 'waiting'),
    };
    let callCount = 0;
    markTaskCancelled.mock.mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
            throw new Error('persist failed');
        }
        return {};
    });

    await assert.rejects(async () => {
        await stopTaskExecution(
            'queue-job-retry-1',
            {
                redisClient,
                requestedBy: 'system',
                cancellation: {
                    code: 'pull_request_merged',
                    message: 'Task cancelled because pull request #42 was merged.',
                },
            },
            {
                loadStopTaskContext: async () => ({
                    normalizedTaskId: 'queue-job-retry-1',
                    state: null,
                    currentState: null,
                    queueJob: queueJob as never,
                    queueState: 'waiting',
                    taskId: 'task-retry-1',
                    abortTaskIds: ['task-retry-1', 'queue-job-retry-1'],
                }),
                ensureTaskStateForCancellation: async () => {},
                getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
                getIssueQueue: async () => ({
                    client: Promise.resolve({
                        sRem: async () => 1,
                        expire: async () => 1,
                    }),
                }) as never,
                stopDockerContainer,
            },
        );
    }, /persist failed/);

    const retriedResult = await stopTaskExecution(
        'task-retry-1',
        {
            redisClient,
            requestedBy: 'system',
            cancellation: {
                code: 'pull_request_merged',
                message: 'Task cancelled because pull request #42 was merged.',
            },
        },
        {
            loadStopTaskContext: async () => ({
                normalizedTaskId: 'task-retry-1',
                state: null,
                currentState: null,
                queueJob: null,
                queueState: null,
                taskId: 'task-retry-1',
                abortTaskIds: ['task-retry-1', 'queue-job-retry-1'],
            }),
            ensureTaskStateForCancellation: async () => {},
            getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
            getIssueQueue: async () => ({
                client: Promise.resolve({
                    sRem: async () => 1,
                    expire: async () => 1,
                }),
            }) as never,
            stopDockerContainer,
        },
    );

    assert.strictEqual(retriedResult.success, true);
    assert.strictEqual(retriedResult.jobRemoved, true);
    assert.strictEqual(retriedResult.message, 'Queued task cancelled before execution started.');
    assert.strictEqual(queueJob.remove.mock.calls.length, 1);
    assert.strictEqual(markTaskCancelled.mock.calls.length, 2);
    assert.strictEqual(redisClient.get.mock.calls.length > 0, true);
    assert.deepStrictEqual(redisClient.del.mock.calls.map((call) => call.arguments[0]).sort(), [
        'worker:abort:queue-job-retry-1',
        'worker:abort:task-retry-1',
        'worker:stop-outcome:queue-job-retry-1',
        'worker:stop-outcome:task-retry-1',
        'worker:stop-requested:queue-job-retry-1',
        'worker:stop-requested:task-retry-1',
    ]);
    assert.strictEqual(redisClient.store.has('worker:stop-outcome:queue-job-retry-1'), false);
    assert.strictEqual(redisClient.store.has('worker:stop-outcome:task-retry-1'), false);
});

test('stopTaskExecution rejects queued cancellation for unknown queue-removal races', async () => {
    const redisClient = createRedisClient();
    const queueJob = {
        id: 'queue-job-unknown-1',
        remove: mock.fn(async () => {
            throw new Error('job lock missing');
        }),
        getState: mock.fn(async () => 'unknown'),
    };

    await assert.rejects(async () => {
        await stopTaskExecution(
            'queue-job-unknown-1',
            {
                redisClient,
                requestedBy: 'system',
                cancellation: {
                    code: 'pull_request_merged',
                    message: 'Task cancelled because pull request #42 was merged.',
                },
            },
            {
                loadStopTaskContext: async () => ({
                    normalizedTaskId: 'queue-job-unknown-1',
                    state: null,
                    currentState: null,
                    queueJob: queueJob as never,
                    queueState: 'waiting',
                    taskId: 'task-queue-unknown-1',
                    abortTaskIds: ['task-queue-unknown-1', 'queue-job-unknown-1'],
                }),
                ensureTaskStateForCancellation: async () => {},
                getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
                stopDockerContainer,
            },
        );
    }, /job lock missing/);

    assert.strictEqual(markTaskCancelled.mock.calls.length, 0);
    assert.strictEqual(updateHistoryMetadata.mock.calls.length, 0);
    assert.deepStrictEqual(redisClient.set.mock.calls.map((call) => call.arguments[0]).sort(), []);
    assert.deepStrictEqual(redisClient.del.mock.calls.map((call) => call.arguments[0]).sort(), []);
    assert.strictEqual(redisClient.store.has('worker:abort:task-queue-unknown-1'), false);
    assert.strictEqual(redisClient.store.has('worker:abort:queue-job-unknown-1'), false);
    assert.strictEqual(redisClient.store.has('worker:stop-outcome:task-queue-unknown-1'), false);
    assert.strictEqual(redisClient.store.has('worker:stop-outcome:queue-job-unknown-1'), false);
});

test('stopTaskExecution still marks queued cancellation when post-removal recovery state cannot be persisted', async () => {
    const redisClient = createRedisClient();
    redisClient.set.mock.mockImplementation(async (key: string, value: string) => {
        if (key.startsWith('worker:stop-outcome:')) {
            throw new Error('redis write failed');
        }

        redisClient.store.set(key, value);
        return 'OK';
    });
    const queueJob = {
        id: 'queue-job-outcome-fail-1',
        data: {
            repository: 'owner/repo',
            prNumber: 42,
        },
        remove: mock.fn(async () => undefined),
        getState: mock.fn(async () => 'waiting'),
    };

    const result = await stopTaskExecution(
        'queue-job-outcome-fail-1',
        {
            redisClient,
            requestedBy: 'system',
            cancellation: {
                code: 'pull_request_merged',
                message: 'Task cancelled because pull request #42 was merged.',
            },
        },
        {
            loadStopTaskContext: async () => ({
                normalizedTaskId: 'queue-job-outcome-fail-1',
                state: null,
                currentState: null,
                queueJob: queueJob as never,
                queueState: 'waiting',
                taskId: 'task-outcome-fail-1',
                abortTaskIds: ['task-outcome-fail-1', 'queue-job-outcome-fail-1'],
            }),
            ensureTaskStateForCancellation: async () => ({ history: [{ state: 'pending' }] }),
            getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
            stopDockerContainer,
        },
    );

    assert.strictEqual(result.jobRemoved, true);
    assert.strictEqual(queueJob.remove.mock.calls.length, 1);
    assert.strictEqual(markTaskCancelled.mock.calls.length, 1);
    assert.strictEqual(redisClient.store.has('worker:abort:task-outcome-fail-1'), false);
});

test('stopTaskExecution reports refreshed state after creating state for queue-only cancellations', async () => {
    const redisClient = createRedisClient();
    const queueJob = {
        id: 'queue-job-refresh-1',
        data: {
            repository: 'owner/repo',
            prNumber: 42,
        },
        remove: mock.fn(async () => undefined),
        getState: mock.fn(async () => 'waiting'),
    };

    const result = await stopTaskExecution(
        'queue-job-refresh-1',
        {
            redisClient,
            requestedBy: 'system',
            cancellation: {
                code: 'pull_request_merged',
                message: 'Task cancelled because pull request #42 was merged.',
            },
        },
        {
            loadStopTaskContext: async () => ({
                normalizedTaskId: 'queue-job-refresh-1',
                state: null,
                currentState: null,
                queueJob: queueJob as never,
                queueState: 'waiting',
                taskId: 'task-refresh-1',
                abortTaskIds: ['task-refresh-1', 'queue-job-refresh-1'],
            }),
            ensureTaskStateForCancellation: async () => ({ history: [{ state: 'pending' }] }),
            getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
            stopDockerContainer,
        },
    );

    assert.strictEqual(result.currentState, 'pending');
    assert.strictEqual(result.jobRemoved, true);
    assert.strictEqual(markTaskCancelled.mock.calls.length, 1);
});

test('stopTaskExecution still terminates the Claude container from post_processing state', async () => {
    const redisClient = createRedisClient();

    const result = await stopTaskExecution(
        'task-post-processing',
        {
            redisClient,
            requestedBy: 'system',
            cancellation: {
                code: 'pull_request_merged',
                message: 'Task cancelled because pull request #42 was merged.',
            },
        },
        {
            loadStopTaskContext: async () => ({
                normalizedTaskId: 'task-post-processing',
                state: {
                    history: [
                        { state: 'claude_execution', metadata: { containerId: 'container-post-1' } },
                        { state: 'post_processing' },
                    ],
                },
                currentState: 'post_processing',
                queueJob: null,
                queueState: null,
                taskId: 'task-post-processing',
                abortTaskIds: ['task-post-processing'],
            }),
            ensureTaskStateForCancellation: async () => {},
            getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
            stopDockerContainer,
        },
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.containerStopped, true);
    assert.strictEqual(stopDockerContainer.mock.calls.length, 1);
    assert.deepStrictEqual(stopDockerContainer.mock.calls[0]?.arguments, ['container-post-1', 10]);
    assert.strictEqual(markTaskCancelled.mock.calls.length, 1);
});

test('stopTaskExecution still stops the latest Claude container from processing state history', async () => {
    const redisClient = createRedisClient();

    const result = await stopTaskExecution(
        'task-processing-history-container',
        {
            redisClient,
            requestedBy: 'system',
            cancellation: {
                code: 'pull_request_merged',
                message: 'Task cancelled because pull request #42 was merged.',
            },
        },
        {
            loadStopTaskContext: async () => ({
                normalizedTaskId: 'task-processing-history-container',
                state: {
                    history: [
                        { state: 'claude_execution', metadata: { containerId: 'container-processing-1' } },
                        { state: 'processing' },
                    ],
                },
                currentState: 'processing',
                queueJob: null,
                queueState: null,
                taskId: 'task-processing-history-container',
                abortTaskIds: ['task-processing-history-container'],
            }),
            ensureTaskStateForCancellation: async () => {},
            getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
            stopDockerContainer,
        },
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.containerStopped, true);
    assert.strictEqual(stopDockerContainer.mock.calls.length, 1);
    assert.deepStrictEqual(stopDockerContainer.mock.calls[0]?.arguments, ['container-processing-1', 10]);
    assert.strictEqual(markTaskCancelled.mock.calls.length, 1);
    assert.deepStrictEqual(redisClient.del.mock.calls.map((call) => call.arguments[0]).sort(), [
        'worker:abort:task-processing-history-container',
        'worker:stop-requested:task-processing-history-container',
    ]);
});

test('stopTaskExecution uses cancellation-ensured state when choosing the container to stop', async () => {
    const redisClient = createRedisClient();

    const result = await stopTaskExecution(
        'task-ensured-container',
        {
            redisClient,
            requestedBy: 'system',
            cancellation: {
                code: 'pull_request_merged',
                message: 'Task cancelled because pull request #42 was merged.',
            },
        },
        {
            loadStopTaskContext: async () => ({
                normalizedTaskId: 'task-ensured-container',
                state: {
                    history: [{ state: 'processing' }],
                },
                currentState: 'processing',
                queueJob: null,
                queueState: null,
                taskId: 'task-ensured-container',
                abortTaskIds: ['task-ensured-container'],
            }),
            ensureTaskStateForCancellation: async () => ({
                history: [
                    { state: 'claude_execution', metadata: { containerId: 'container-ensured-1' } },
                    { state: 'processing' },
                ],
            }),
            getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
            stopDockerContainer,
        },
    );

    assert.strictEqual(result.containerStopped, true);
    assert.deepStrictEqual(stopDockerContainer.mock.calls[0]?.arguments, ['container-ensured-1', 10]);
    assert.strictEqual(markTaskCancelled.mock.calls.length, 1);
});

test('stopTaskExecution records the cancellation reason only after queued removal succeeds', async () => {
    const redisClient = createRedisClient();
    const sideEffects: string[] = [];
    const queueJob = {
        id: 'queue-job-success-1',
        data: {
            repository: 'owner/repo',
            prNumber: 42,
        },
        remove: mock.fn(async () => {
            sideEffects.push('queue.remove');
        }),
        getState: mock.fn(async () => 'waiting'),
    };

    const result = await stopTaskExecution(
        'queue-job-success-1',
        {
            redisClient,
            requestedBy: 'system',
            cancellation: {
                code: 'pull_request_merged',
                message: 'Task cancelled because pull request #42 was merged.',
            },
        },
        {
            loadStopTaskContext: async () => ({
                normalizedTaskId: 'queue-job-success-1',
                state: null,
                currentState: null,
                queueJob: queueJob as never,
                queueState: 'waiting',
                taskId: 'task-queue-success-1',
                abortTaskIds: ['task-queue-success-1', 'queue-job-success-1'],
            }),
            ensureTaskStateForCancellation: async () => {
                sideEffects.push('ensure.state');
            },
            getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
            stopDockerContainer,
        },
    );

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(redisClient.messages.map((message) => message.content), [
        'Task cancelled because pull request #42 was merged.',
        'Task cancelled successfully.',
    ]);
    assert.deepStrictEqual(sideEffects, ['queue.remove', 'ensure.state']);
});

test('stopTaskExecution removes queued jobs before cancellation state creation', async () => {
    const redisClient = createRedisClient();
    const queueJob = {
        id: 'queue-job-state-fail-1',
        data: {
            repository: 'owner/repo',
            prNumber: 42,
        },
        remove: mock.fn(async () => undefined),
        getState: mock.fn(async () => 'waiting'),
    };

    await assert.rejects(
        stopTaskExecution(
            'queue-job-state-fail-1',
            {
                redisClient,
                requestedBy: 'system',
                cancellation: {
                    code: 'pull_request_merged',
                    message: 'Task cancelled because pull request #42 was merged.',
                },
            },
            {
                loadStopTaskContext: async () => ({
                    normalizedTaskId: 'queue-job-state-fail-1',
                    state: null,
                    currentState: null,
                    queueJob: queueJob as never,
                    queueState: 'waiting',
                    taskId: 'task-state-fail-1',
                    abortTaskIds: ['task-state-fail-1', 'queue-job-state-fail-1'],
                }),
                ensureTaskStateForCancellation: async () => {
                    throw new Error('state creation failed');
                },
                getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
                stopDockerContainer,
            },
        ),
        /state creation failed/,
    );

    assert.strictEqual(queueJob.remove.mock.calls.length, 1);
    assert.strictEqual(redisClient.store.has('worker:stop-outcome:task-state-fail-1'), true);
    assert.strictEqual(redisClient.store.has('worker:stop-outcome:queue-job-state-fail-1'), true);
    assert.strictEqual(markTaskCancelled.mock.calls.length, 0);
});

test('isBenignQueueRemovalRace only accepts active removal races', () => {
    assert.strictEqual(isBenignQueueRemovalRace('active'), true);
    assert.strictEqual(isBenignQueueRemovalRace('completed'), false);
    assert.strictEqual(isBenignQueueRemovalRace('failed'), false);
    assert.strictEqual(isBenignQueueRemovalRace('unknown'), false);
    assert.strictEqual(isBenignQueueRemovalRace(null), false);
    assert.strictEqual(isBenignQueueRemovalRace('waiting'), false);
});

test('cancelMergedPullRequestTasks force-scans the initial merged-PR lookup and rechecks queued work', async () => {
    const redisClient = createRedisClient();
    let lookupCount = 0;
    const getActiveTasksForPR = mock.fn(async () => {
        lookupCount += 1;
        return lookupCount === 1
            ? [{ taskId: 'queue-task-1', state: 'waiting' }]
            : [];
    });
    const markPullRequestMerged = mock.fn(async () => {});
    const stopTaskExecutionForMerge = mock.fn(async () => ({
        success: true,
        taskId: 'queue-task-1',
    }));

    await cancelMergedPullRequestTasks(
        {
            action: 'closed',
            repository: { full_name: 'owner/repo' },
            pull_request: { number: 42, merged: true },
        },
        'cid-1',
        {
            redisClient,
            getActiveTasksForPR,
            markPullRequestMerged,
            stopTaskExecution: stopTaskExecutionForMerge,
            recheckDelayMs: 0,
            log,
        },
    );

    assert.strictEqual(getActiveTasksForPR.mock.calls.length, 2);
    assert.deepStrictEqual(getActiveTasksForPR.mock.calls[0]?.arguments, ['owner/repo', 42, {
        forceQueueScan: true,
        log,
        stoppableOnly: true,
    }]);
    assert.deepStrictEqual(getActiveTasksForPR.mock.calls[1]?.arguments, ['owner/repo', 42, {
        forceQueueScan: true,
        log,
        stoppableOnly: true,
    }]);
    assert.strictEqual(stopTaskExecutionForMerge.mock.calls[0]?.arguments[1].forceQueueScan, true);
    assert.strictEqual(stopTaskExecutionForMerge.mock.calls[0]?.arguments[1].requireVerifiedStop, true);
    assert.strictEqual(markPullRequestMerged.mock.calls.length, 1);
});

test('stopTaskExecution dedupes repeated merge-cancellation conversation messages for abort-only tasks', async () => {
    const redisClient = createRedisClient();
    const options = {
        redisClient,
        requestedBy: 'system',
        cancellation: {
            code: 'pull_request_merged',
            message: 'Task cancelled because pull request #42 was merged.',
            requestId: 'merge-cancel-42',
        },
    };
    const deps = {
        loadStopTaskContext: async () => ({
            normalizedTaskId: 'task-duplicate-messages',
            state: { history: [{ state: 'processing' }] },
            currentState: 'processing',
            queueJob: { id: 'job-duplicate-messages' } as never,
            queueState: 'active',
            taskId: 'task-duplicate-messages',
            abortTaskIds: ['task-duplicate-messages', 'job-duplicate-messages'],
        }),
        ensureTaskStateForCancellation: async () => {},
        getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
        stopDockerContainer,
    };

    await stopTaskExecution('task-duplicate-messages', options, deps);
    await stopTaskExecution('task-duplicate-messages', options, deps);

    assert.deepStrictEqual(redisClient.messages.map((message) => message.content), [
        'Cancellation requested. Worker shutdown is still in progress.',
    ]);
    assert.strictEqual(
        JSON.parse(redisClient.store.get('worker:abort:task-duplicate-messages') ?? '{}').requestId,
        'merge-cancel-42',
    );
});

test('stopTaskExecution still detects duplicate messages after malformed recent conversation entries', async () => {
    const redisClient = createRedisClient();
    redisClient.conversationEntries.set('conversation:task-malformed-message', [
        '{malformed-json',
        JSON.stringify({
            type: 'system',
            timestamp: new Date().toISOString(),
            content: 'Cancellation requested. Worker shutdown is still in progress.',
            level: 'info',
            metadata: { reasonCode: 'pull_request_merged', requestedBy: 'system', cancellationRequestId: 'malformed-cancel-42' },
        }),
    ]);

    await stopTaskExecution('task-malformed-message', {
        redisClient,
        requestedBy: 'system',
        cancellation: {
            code: 'pull_request_merged',
            message: 'Task cancelled because pull request #42 was merged.',
            requestId: 'malformed-cancel-42',
        },
    }, {
        loadStopTaskContext: async () => ({
            normalizedTaskId: 'task-malformed-message',
            state: { history: [{ state: 'processing' }] },
            currentState: 'processing',
            queueJob: { id: 'job-malformed-message' } as never,
            queueState: 'active',
            taskId: 'task-malformed-message',
            abortTaskIds: ['task-malformed-message', 'job-malformed-message'],
        }),
        ensureTaskStateForCancellation: async () => {},
        getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
        stopDockerContainer,
    });

    assert.deepStrictEqual(redisClient.messages.map((message) => message.content), []);
});

test('stopTaskExecution keeps separate merge-cancellation messages across webhook request ids', async () => {
    const redisClient = createRedisClient();
    const deps = {
        loadStopTaskContext: async () => ({
            normalizedTaskId: 'task-retried-webhook-message',
            state: { history: [{ state: 'processing' }] },
            currentState: 'processing',
            queueJob: { id: 'job-retried-webhook-message' } as never,
            queueState: 'active',
            taskId: 'task-retried-webhook-message',
            abortTaskIds: ['task-retried-webhook-message', 'job-retried-webhook-message'],
        }),
        ensureTaskStateForCancellation: async () => {},
        getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
        stopDockerContainer,
    };

    await stopTaskExecution('task-retried-webhook-message', {
        redisClient,
        requestedBy: 'system',
        cancellation: {
            code: 'pull_request_merged',
            message: 'Task cancelled because pull request #42 was merged.',
            requestId: 'corr-1:pull_request_merged:owner/repo#42:task-retried-webhook-message',
        },
    }, deps);
    await stopTaskExecution('task-retried-webhook-message', {
        redisClient,
        requestedBy: 'system',
        cancellation: {
            code: 'pull_request_merged',
            message: 'Task cancelled because pull request #42 was merged.',
            requestId: 'corr-2:pull_request_merged:owner/repo#42:task-retried-webhook-message',
        },
    }, deps);

    assert.deepStrictEqual(redisClient.messages.map((message) => message.content), [
        'Cancellation requested. Worker shutdown is still in progress.',
        'Cancellation requested. Worker shutdown is still in progress.',
    ]);
});

test('stopTaskExecution dedupes repeated merge-cancellation messages when lRange is unavailable', async () => {
    const redisClient = createRedisClient();
    const redisWithoutRange = {
        get: redisClient.get,
        set: redisClient.set,
        del: redisClient.del,
        rPush: redisClient.rPush,
    };
    const options = {
        redisClient: redisWithoutRange,
        requestedBy: 'system',
        cancellation: {
            code: 'pull_request_merged',
            message: 'Task cancelled because pull request #42 was merged.',
            requestId: 'merge-cancel-no-lrange-42',
        },
    };
    const deps = {
        loadStopTaskContext: async () => ({
            normalizedTaskId: 'task-no-lrange-messages',
            state: { history: [{ state: 'processing' }] },
            currentState: 'processing',
            queueJob: { id: 'job-no-lrange-messages' } as never,
            queueState: 'active',
            taskId: 'task-no-lrange-messages',
            abortTaskIds: ['task-no-lrange-messages', 'job-no-lrange-messages'],
        }),
        ensureTaskStateForCancellation: async () => {},
        getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
        stopDockerContainer,
    };

    await stopTaskExecution('task-no-lrange-messages', options, deps);
    redisClient.set.mock.mockImplementation(async (key: string, value: string, options?: Record<string, unknown>) => {
        if (options?.NX === true && key.startsWith('conversation:stop-message-dedupe:')) {
            return null;
        }

        redisClient.store.set(key, value);
        return 'OK';
    });
    await stopTaskExecution('task-no-lrange-messages', options, deps);

    assert.deepStrictEqual(redisClient.messages.map((message) => message.content), [
        'Cancellation requested. Worker shutdown is still in progress.',
    ]);
});

test('stopTaskExecution dedupes repeated messages without request identity by fingerprint', async () => {
    const redisClient = createRedisClient();
    redisClient.conversationEntries.set('conversation:task-future-message', [JSON.stringify({
        type: 'system',
        timestamp: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        content: 'Cancellation requested. Worker shutdown is still in progress.',
        level: 'info',
        metadata: { reasonCode: 'pull_request_merged', requestedBy: 'system' },
    })]);

    await stopTaskExecution('task-future-message', {
        redisClient,
        requestedBy: 'system',
        cancellation: {
            code: 'pull_request_merged',
            message: 'Task cancelled because pull request #42 was merged.',
        },
    }, {
        loadStopTaskContext: async () => ({
            normalizedTaskId: 'task-future-message',
            state: { history: [{ state: 'processing' }] },
            currentState: 'processing',
            queueJob: { id: 'job-future-message' } as never,
            queueState: 'active',
            taskId: 'task-future-message',
            abortTaskIds: ['task-future-message', 'job-future-message'],
        }),
        ensureTaskStateForCancellation: async () => {},
        getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
        stopDockerContainer,
    });

    assert.deepStrictEqual(redisClient.messages.map((message) => message.content), []);
});

test('stopTaskExecution dedupes repeated messages with matching request identity', async () => {
    const redisClient = createRedisClient();
    redisClient.conversationEntries.set('conversation:task-clock-skew-message', [JSON.stringify({
        type: 'system',
        timestamp: new Date(Date.now() + 60 * 1000).toISOString(),
        content: 'Cancellation requested. Worker shutdown is still in progress.',
        level: 'info',
        metadata: { reasonCode: 'pull_request_merged', requestedBy: 'system', cancellationRequestId: 'clock-skew-cancel-42' },
    })]);

    await stopTaskExecution('task-clock-skew-message', {
        redisClient,
        requestedBy: 'system',
        cancellation: {
            code: 'pull_request_merged',
            message: 'Task cancelled because pull request #42 was merged.',
            requestId: 'clock-skew-cancel-42',
        },
    }, {
        loadStopTaskContext: async () => ({
            normalizedTaskId: 'task-clock-skew-message',
            state: { history: [{ state: 'processing' }] },
            currentState: 'processing',
            queueJob: { id: 'job-clock-skew-message' } as never,
            queueState: 'active',
            taskId: 'task-clock-skew-message',
            abortTaskIds: ['task-clock-skew-message', 'job-clock-skew-message'],
        }),
        ensureTaskStateForCancellation: async () => {},
        getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
        stopDockerContainer,
    });

    assert.deepStrictEqual(redisClient.messages.map((message) => message.content), []);
});

test('stopTaskExecution rejects queued cancellation when queue state cannot be reloaded after removal failure', async () => {
    const redisClient = createRedisClient();
    const queueJob = {
        id: 'queue-job-2',
        remove: mock.fn(async () => {
            throw new Error('job lock missing');
        }),
        getState: mock.fn(async () => {
            throw new Error('redis unavailable');
        }),
    };

    await assert.rejects(async () => {
        await stopTaskExecution(
            'queue-job-2',
            {
                redisClient,
                requestedBy: 'system',
                cancellation: {
                    code: 'pull_request_merged',
                    message: 'Task cancelled because pull request #42 was merged.',
                },
            },
            {
                loadStopTaskContext: async () => ({
                    normalizedTaskId: 'queue-job-2',
                    state: null,
                    currentState: null,
                    queueJob: queueJob as never,
                    queueState: 'waiting',
                    taskId: 'task-queue-2',
                    abortTaskIds: ['task-queue-2', 'queue-job-2'],
                }),
                ensureTaskStateForCancellation: async () => {},
                getStateManager: () => ({ markTaskCancelled, updateHistoryMetadata }) as never,
                stopDockerContainer,
            },
        );
    }, /job lock missing/);

    assert.strictEqual(markTaskCancelled.mock.calls.length, 0);
    assert.strictEqual(updateHistoryMetadata.mock.calls.length, 0);
    assert.deepStrictEqual(redisClient.set.mock.calls.map((call) => call.arguments[0]).sort(), []);
    assert.deepStrictEqual(redisClient.del.mock.calls.map((call) => call.arguments[0]).sort(), []);
});

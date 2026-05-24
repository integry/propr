import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert';

process.env.GH_APP_ID ??= '1';
process.env.GH_PRIVATE_KEY_PATH ??= '.propr/test-private-key.pem';
process.env.GH_INSTALLATION_ID ??= '1';
process.env.NODE_ENV ??= 'test';

const { stopTaskExecution, isBenignQueueRemovalRace } = await import('../packages/api/routes/stopTaskExecution.js');
const { cancelMergedPullRequestTasks } = await import('../packages/api/mergedPullRequestCancellation.js');

const markTaskCancelled = mock.fn(async () => ({}));
const stopDockerContainer = mock.fn(async () => ({ success: true }));
const log = {
    info: mock.fn(),
    warn: mock.fn(),
};

function createRedisClient() {
    const messages: Array<Record<string, unknown>> = [];

    return {
        messages,
        set: mock.fn(async () => 'OK'),
        del: mock.fn(async () => 1),
        rPush: mock.fn(async (_key: string, value: string) => {
            messages.push(JSON.parse(value) as Record<string, unknown>);
            return 1;
        }),
    };
}

beforeEach(() => {
    markTaskCancelled.mock.resetCalls();
    stopDockerContainer.mock.resetCalls();
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
                getStateManager: () => ({ markTaskCancelled }) as never,
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

test('stopTaskExecution treats queue removal races into terminal states as benign', async () => {
    const redisClient = createRedisClient();
    const queueJob = {
        id: 'queue-job-1',
        remove: mock.fn(async () => {
            throw new Error('job lock missing');
        }),
        getState: mock.fn(async () => 'completed'),
    };

    const result = await stopTaskExecution(
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
            getStateManager: () => ({ markTaskCancelled }) as never,
            stopDockerContainer,
        },
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.jobRemoved, false);
    assert.strictEqual(markTaskCancelled.mock.calls.length, 0);
    assert.strictEqual(redisClient.set.mock.calls.length, 2);
    assert.deepStrictEqual(redisClient.del.mock.calls.map(call => call.arguments[0]).sort(), [
        'worker:abort:queue-job-1',
        'worker:abort:task-queue-1',
    ]);
});

test('stopTaskExecution keeps abort-armed container-backed tasks cancellable when the container stop fails', async () => {
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
            getStateManager: () => ({ markTaskCancelled }) as never,
            stopDockerContainer: mock.fn(async () => ({ success: false, error: 'timeout' })),
        },
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.containerStopped, false);
    assert.strictEqual(result.jobRemoved, false);
    assert.strictEqual(result.message, 'Stop request sent to worker. The execution will be terminated shortly.');
    assert.strictEqual(redisClient.set.mock.calls.length, 1);
    assert.strictEqual(markTaskCancelled.mock.calls.length, 0);
});

test('isBenignQueueRemovalRace accepts active, terminal, unknown, and missing queue states', () => {
    assert.strictEqual(isBenignQueueRemovalRace('active'), true);
    assert.strictEqual(isBenignQueueRemovalRace('completed'), true);
    assert.strictEqual(isBenignQueueRemovalRace('failed'), true);
    assert.strictEqual(isBenignQueueRemovalRace('unknown'), true);
    assert.strictEqual(isBenignQueueRemovalRace(null), true);
    assert.strictEqual(isBenignQueueRemovalRace('waiting'), false);
});

test('cancelMergedPullRequestTasks uses indexed lookup before falling back to a full queue scan', async () => {
    const redisClient = createRedisClient();
    const getActiveTasksForPR = mock.fn(async () => []);
    const markPullRequestMerged = mock.fn(async () => {});
    const stopTaskExecutionForMerge = mock.fn(async () => ({}));

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
            log,
        },
    );

    assert.strictEqual(getActiveTasksForPR.mock.calls.length, 1);
    assert.deepStrictEqual(getActiveTasksForPR.mock.calls[0]?.arguments, ['owner/repo', 42, {
        log,
        forceQueueScan: true,
    }]);
});

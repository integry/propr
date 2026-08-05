import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const abortSpawnedExecution = mock.fn(async () => {});

await mock.module('../src/claude/docker/dockerExecutionOwnership.js', {
    namedExports: { abortSpawnedExecution },
});

await mock.module('../src/utils/logger.js', {
    defaultExport: {
        info: mock.fn(),
        warn: mock.fn(),
        error: mock.fn(),
        debug: mock.fn(),
    },
});

const { setupAbortChecker } = await import('../src/claude/docker/dockerAbortController.js');

test('close waits for an in-flight poll and suppresses its late abort result', async () => {
    let resolveGet!: (value: string | null) => void;
    const getStarted = Promise.withResolvers<void>();
    const pendingGet = new Promise<string | null>(resolve => { resolveGet = resolve; });
    const quit = mock.fn(async () => {});
    const redis = {
        get: mock.fn(async () => {
            getStarted.resolve();
            return await pendingGet;
        }),
        del: mock.fn(async () => 1),
        quit,
        disconnect: mock.fn(),
    };
    const handle = setupAbortChecker({
        taskId: 'task-1748',
        plannerAbortKey: 'planner:abort:task-1748',
        child: { kill: mock.fn(), exitCode: null, signalCode: null } as never,
        state: {
            aborted: { value: false },
            containerId: { value: null },
            teardownPromise: null,
        },
        namedContainer: 'propr-agent-task-1748',
        redisFactory: () => redis,
        pollIntervalMs: 1,
    });

    await getStarted.promise;
    const closePromise = handle.close();
    await Promise.resolve();
    assert.equal(quit.mock.calls.length, 0);

    resolveGet('abort');
    await closePromise;

    assert.equal(abortSpawnedExecution.mock.calls.length, 0);
    assert.equal(quit.mock.calls.length, 1);
});

test('close disconnects after a bounded wait for an unresponsive Redis poll', async () => {
    const getStarted = Promise.withResolvers<void>();
    const pendingGet = new Promise<string | null>(() => {});
    const disconnect = mock.fn();
    const redis = {
        get: mock.fn(async () => {
            getStarted.resolve();
            return await pendingGet;
        }),
        del: mock.fn(async () => 1),
        quit: mock.fn(async () => {}),
        disconnect,
    };
    const handle = setupAbortChecker({
        taskId: 'task-unresponsive-redis',
        plannerAbortKey: 'planner:abort:task-unresponsive-redis',
        child: { kill: mock.fn(), exitCode: null, signalCode: null } as never,
        state: {
            aborted: { value: false },
            containerId: { value: null },
            teardownPromise: null,
        },
        namedContainer: 'propr-agent-task-unresponsive-redis',
        redisFactory: () => redis,
        pollIntervalMs: 1,
        closeTimeoutMs: 10,
    });

    await getStarted.promise;
    await handle.close();

    assert.equal(disconnect.mock.calls.length, 1);
    assert.equal(redis.quit.mock.calls.length, 0);
});

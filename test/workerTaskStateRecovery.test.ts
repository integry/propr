import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const logInfo = mock.fn();
const logError = mock.fn();
const logWarn = mock.fn();
const reconcileStalePRCommentTasks = mock.fn(async () => ({
    nextCursor: '0',
    summary: {
        scanned: 0,
        stale: 0,
        live: 0,
        recovered: 0,
        skipped: 0,
        errors: 0,
    },
}));

await mock.module('@propr/core', {
    namedExports: {
        getIssueQueue: mock.fn(),
        getStateManager: mock.fn(),
        logger: { info: logInfo, error: logError, warn: logWarn },
    },
});
await mock.module('../src/taskStateReconciler.js', {
    namedExports: {
        DEFAULT_RECONCILIATION_STALE_MS: 15 * 60 * 1000,
        DEFAULT_RECONCILIATION_TIME_BUDGET_MS: 30 * 1000,
        reconcileStalePRCommentTasks,
    },
});

const { startWorkerTaskStateRecovery } = await import('../src/workerTaskStateRecovery.js');

function dependencies() {
    return {
        queue: { getJob: mock.fn() },
        stateManager: {
            scanNonTerminalTasks: mock.fn(),
            getTaskState: mock.fn(),
            updateTaskStateIfCurrentDetailed: mock.fn(),
        },
    };
}

test('coalesces overlapping runs and releases the distributed lease', async () => {
    reconcileStalePRCommentTasks.mock.resetCalls();
    let releaseReconciliation: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    reconcileStalePRCommentTasks.mock.mockImplementationOnce(async () => {
        signalStarted?.();
        await new Promise<void>(resolve => { releaseReconciliation = resolve; });
        return {
            nextCursor: '23',
            summary: {
                scanned: 1,
                stale: 1,
                live: 0,
                recovered: 1,
                skipped: 0,
                errors: 0,
            },
        };
    });
    const redis = {
        set: mock.fn(async () => 'OK'),
        eval: mock.fn(async () => 1),
    };
    const runner = await startWorkerTaskStateRecovery({
        ...dependencies(),
        redis,
        intervalMs: 60_000,
    });
    await started;

    const first = runner.runOnce();
    const second = runner.runOnce();
    assert.equal(first, second);
    assert.equal(reconcileStalePRCommentTasks.mock.calls.length, 1);

    releaseReconciliation?.();
    assert.equal(await first, true);
    await runner.close();
    assert.equal(redis.eval.mock.calls.length, 1);
    assert.equal(redis.eval.mock.calls[0].arguments[3], redis.set.mock.calls[0].arguments[1]);
});

test('does not reconcile when another worker owns the lease', async () => {
    reconcileStalePRCommentTasks.mock.resetCalls();
    const redis = {
        set: mock.fn(async () => null),
        eval: mock.fn(async () => 0),
    };
    const runner = await startWorkerTaskStateRecovery({
        ...dependencies(),
        redis,
        intervalMs: 60_000,
    });
    await new Promise(resolve => setImmediate(resolve));
    await runner.close();

    assert.equal(reconcileStalePRCommentTasks.mock.calls.length, 0);
    assert.equal(redis.eval.mock.calls.length, 0);
});

test('contains lease acquisition failures instead of creating an unhandled rejection', async () => {
    reconcileStalePRCommentTasks.mock.resetCalls();
    const runner = await startWorkerTaskStateRecovery({
        ...dependencies(),
        redis: {
            set: mock.fn(async () => { throw new Error('Redis unavailable'); }),
            eval: mock.fn(async () => 0),
        },
        intervalMs: 60_000,
    });

    assert.equal(await runner.runOnce(), false);
    await runner.close();
    assert.equal(logError.mock.calls.length > 0, true);
    assert.equal(reconcileStalePRCommentTasks.mock.calls.length, 0);
});

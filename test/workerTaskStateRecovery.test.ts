import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const logInfo = mock.fn();
const logError = mock.fn();
const logWarn = mock.fn();
const reconcileStaleTaskStates = mock.fn(async (_options?: { backlog?: unknown[] }) => ({
    nextCursor: '0',
    backlog: [] as unknown[],
    summary: {
        scanned: 0,
        stale: 0,
        live: 0,
        suspected: 0,
        recovered: 0,
        skipped: 0,
        errors: 0,
    },
}));

await mock.module('@propr/core', {
    namedExports: {
        db: {},
        getEventPublisher: mock.fn(() => ({ publishTaskUpdate: mock.fn() })),
        getIssueQueue: mock.fn(),
        getStateManager: mock.fn(),
        logger: { info: logInfo, error: logError, warn: logWarn },
    },
});
await mock.module('../src/taskStateReconciler.js', {
    namedExports: {
        DEFAULT_RECONCILIATION_STALE_MS: 15 * 60 * 1000,
        DEFAULT_RECONCILIATION_ORPHAN_GRACE_MS: 60 * 1000,
        DEFAULT_RECONCILIATION_TIME_BUDGET_MS: 30 * 1000,
        reconcileStaleTaskStates,
    },
});

const { startWorkerTaskStateRecovery } = await import('../src/workerTaskStateRecovery.js');

function dependencies() {
    return {
        queue: { getJob: mock.fn() },
        stateManager: {
            getTaskState: mock.fn(),
            updateTaskStateIfCurrentDetailed: mock.fn(),
        },
        store: {
            scanNonTerminalTasks: mock.fn(),
            recordMissing: mock.fn(),
            clearMissing: mock.fn(),
            ownsJobAssignment: mock.fn(),
            finalizeIfCurrent: mock.fn(),
        },
    };
}

test('coalesces overlapping runs and releases the distributed lease', async () => {
    reconcileStaleTaskStates.mock.resetCalls();
    let releaseReconciliation: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    reconcileStaleTaskStates.mock.mockImplementationOnce(async () => {
        signalStarted?.();
        await new Promise<void>(resolve => { releaseReconciliation = resolve; });
        return {
            nextCursor: '23',
            backlog: [],
            summary: {
                scanned: 1,
                stale: 1,
                live: 0,
                suspected: 0,
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
    assert.equal(reconcileStaleTaskStates.mock.calls.length, 1);

    releaseReconciliation?.();
    assert.equal(await first, true);
    await runner.close();
    assert.equal(redis.eval.mock.calls.length, 1);
    assert.equal(redis.eval.mock.calls[0].arguments[3], redis.set.mock.calls[0].arguments[1]);
});

test('does not reconcile when another worker owns the lease', async () => {
    reconcileStaleTaskStates.mock.resetCalls();
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

    assert.equal(reconcileStaleTaskStates.mock.calls.length, 0);
    assert.equal(redis.eval.mock.calls.length, 0);
});

test('contains lease acquisition failures instead of creating an unhandled rejection', async () => {
    reconcileStaleTaskStates.mock.resetCalls();
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
    assert.equal(reconcileStaleTaskStates.mock.calls.length, 0);
});

test('retains an unfinished page backlog across recovery runs', async () => {
    reconcileStaleTaskStates.mock.resetCalls();
    const pendingTask = { taskId: 'pr-comments-pending' };
    reconcileStaleTaskStates.mock.mockImplementationOnce(async () => ({
        nextCursor: '41',
        backlog: [pendingTask],
        summary: {
            scanned: 2,
            stale: 1,
            live: 0,
            suspected: 1,
            recovered: 0,
            skipped: 0,
            errors: 0,
        },
    }));
    const redis = {
        set: mock.fn(async () => 'OK'),
        eval: mock.fn(async () => 1),
    };
    const runner = await startWorkerTaskStateRecovery({
        ...dependencies(),
        redis,
        intervalMs: 60_000,
    });

    await runner.runOnce();
    if (reconcileStaleTaskStates.mock.calls.length === 1) {
        await runner.runOnce();
    }
    await runner.close();

    assert.equal(reconcileStaleTaskStates.mock.calls.length, 2);
    assert.deepEqual(
        reconcileStaleTaskStates.mock.calls[1].arguments[0]?.backlog,
        [pendingTask],
    );
    assert.equal(reconcileStaleTaskStates.mock.calls[1].arguments[0]?.cursor, '41');
});

test('bounds a stalled lease acquisition by the recovery budget', async () => {
    reconcileStaleTaskStates.mock.resetCalls();
    const runner = await startWorkerTaskStateRecovery({
        ...dependencies(),
        redis: {
            set: mock.fn(async () => new Promise<never>(() => {})),
            eval: mock.fn(async () => 0),
        },
        intervalMs: 60_000,
        timeBudgetMs: 10,
    });

    const settled = await Promise.race([
        runner.runOnce().then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 250)),
    ]);
    await runner.close();

    assert.equal(settled, true);
    assert.equal(reconcileStaleTaskStates.mock.calls.length, 0);
});

test('close aborts a stalled active recovery run', async () => {
    reconcileStaleTaskStates.mock.resetCalls();
    const redis = {
        set: mock.fn(async () => 'OK'),
        eval: mock.fn(async () => 1),
    };
    reconcileStaleTaskStates.mock.mockImplementationOnce(
        async () => new Promise<never>(() => {}),
    );
    const runner = await startWorkerTaskStateRecovery({
        ...dependencies(),
        redis,
        intervalMs: 60_000,
        timeBudgetMs: 5_000,
    });
    await new Promise(resolve => setImmediate(resolve));

    const settled = await Promise.race([
        runner.close().then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 250)),
    ]);

    assert.equal(settled, true);
});

test('runs once at startup and continues on the configured interval', async () => {
    reconcileStaleTaskStates.mock.resetCalls();
    let secondRun: (() => void) | undefined;
    const observedSecondRun = new Promise<void>(resolve => { secondRun = resolve; });
    reconcileStaleTaskStates.mock.mockImplementation(async () => {
        if (reconcileStaleTaskStates.mock.calls.length >= 2) secondRun?.();
        return {
            nextCursor: '0',
            backlog: [],
            summary: {
                scanned: 0,
                stale: 0,
                live: 0,
                suspected: 0,
                recovered: 0,
                skipped: 0,
                errors: 0,
            },
        };
    });
    const runner = await startWorkerTaskStateRecovery({
        ...dependencies(),
        redis: {
            set: mock.fn(async () => 'OK'),
            eval: mock.fn(async () => 1),
        },
        intervalMs: 10,
    });

    const ranTwice = await Promise.race([
        observedSecondRun.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 250)),
    ]);
    await runner.close();

    assert.equal(ranTwice, true);
    assert.equal(reconcileStaleTaskStates.mock.calls.length >= 2, true);
});

test('reconciles follow-up CI suspensions under the same lease', async () => {
    reconcileStaleTaskStates.mock.resetCalls();
    const reconcileCiSuspensions = mock.fn(async () => ({ scanned: 1, swept: 0, restored: 1, released: 1, errors: 0 }));
    const redis = {
        set: mock.fn(async () => 'OK'),
        eval: mock.fn(async () => 1),
    };
    const runner = await startWorkerTaskStateRecovery({
        ...dependencies(),
        redis,
        intervalMs: 60_000,
        reconcileCiSuspensions,
    });

    assert.equal(await runner.runOnce(), true);
    await runner.close();

    assert.equal(reconcileCiSuspensions.mock.calls.length > 0, true);
    // The lease is released once per run, after the suspension pass.
    assert.equal(redis.eval.mock.calls.length > 0, true);
});

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { TaskStates, type TaskStateData } from '../packages/core/src/utils/workerStateManager.types.js';

const redisValues = new Map<string, string>();
const protocolOwners = new Set<number>();
let nextProtocolOwner = 0;
let signalWriterIntent!: () => void;
const writerIntentStarted = new Promise<void>(resolve => { signalWriterIntent = resolve; });
let loseNextTaskStateCas = false;
let signalTaskStateCasLost: (() => void) | undefined;
let pauseTerminalPublication = false;
let signalTerminalHistoryCommitted: (() => void) | undefined;
let releaseTerminalPublication: (() => void) | undefined;
let taskLeaseReleaseHook: (() => Promise<void>) | undefined;

function setIfMissing(key: string, value: string): number {
    if (redisValues.has(key)) return 0;
    redisValues.set(key, value);
    return 1;
}

class IsolatedRedisOwner {
    private readonly owner = ++nextProtocolOwner;

    constructor() {
        protocolOwners.add(this.owner);
    }

    on(): void {}
    disconnect(): void {}

    async get(key: string): Promise<string | null> {
        return redisValues.get(key) ?? null;
    }

    async set(key: string, value: string, ...args: string[]): Promise<'OK' | null> {
        if (args.includes('NX') && !setIfMissing(key, value)) return null;
        redisValues.set(key, value);
        return 'OK';
    }

    async eval(script: string, _keyCount: number, ...args: Array<string | number>): Promise<number> {
        const key = String(args[0]);
        if (script.includes('acquire-reader')) {
            const writerKey = String(args[1]);
            return redisValues.has(writerKey) ? 0 : setIfMissing(key, String(args[2]));
        }
        if (script.includes('acquire-writer-intent')) {
            const acquired = setIfMissing(key, String(args[2]));
            if (acquired) signalWriterIntent();
            return acquired;
        }
        if (script.includes('acquire-writer')) return setIfMissing(key, String(args[2]));
        if (script.includes('finish-reader')) {
            if (redisValues.get(key) !== String(args[2])) return 0;
            return redisValues.has(String(args[1])) ? 2 : 1;
        }
        if (script.includes('worker-state-recovery:renew')) {
            return redisValues.get(key) === String(args[1]) ? 1 : 0;
        }
        if (script.includes('worker-state-recovery:release')) {
            if (redisValues.get(key) !== String(args[1])) return 0;
            redisValues.delete(key);
            const releaseHook = taskLeaseReleaseHook;
            taskLeaseReleaseHook = undefined;
            if (releaseHook) await releaseHook();
            return 1;
        }
        const currentJson = String(args[1]);
        if (redisValues.get(key) !== currentJson) return 0;
        if (loseNextTaskStateCas) {
            loseNextTaskStateCas = false;
            const racedState = JSON.parse(currentJson) as TaskStateData;
            racedState.version += 1;
            racedState.updatedAt = '2026-08-14T12:05:01.000Z';
            redisValues.set(key, JSON.stringify(racedState));
            signalTaskStateCasLost?.();
            return 0;
        }
        redisValues.set(key, String(args[3]));
        return 1;
    }
}

await mock.module('ioredis', {
    namedExports: { Redis: IsolatedRedisOwner },
});

const taskId = 'distributed-restoration-contender';
const taskRow = {
    task_id: taskId,
    job_id: 'job-distributed-restoration',
    correlation_id: 'correlation-distributed-restoration',
    repository: 'integry/propr',
    issue_number: 1899,
    task_type: 'issue',
    created_at: '2026-08-14T12:00:00.000Z',
    initial_job_data: JSON.stringify({
        number: 1899,
        repoOwner: 'integry',
        repoName: 'propr',
        type: 'issue',
    }),
};
const historyRows = [{
    history_id: 1,
    task_id: taskId,
    state: TaskStates.PROCESSING,
    timestamp: '2026-08-14T12:05:00.000Z',
    reason: 'Processing',
    metadata: '{}',
}];
let historyReadCount = 0;
let signalRestorationPaused!: () => void;
let releaseRestoration!: () => void;
const restorationPaused = new Promise<void>(resolve => { signalRestorationPaused = resolve; });
const restorationReleased = new Promise<void>(resolve => { releaseRestoration = resolve; });

function historyQuery() {
    return {
        orderBy: () => ({
            first: async () => {
                historyReadCount += 1;
                if (historyReadCount === 2) {
                    signalRestorationPaused();
                    await restorationReleased;
                }
                return historyRows.at(-1);
            },
        }),
    };
}

function tableQuery(tableName: string) {
    if (tableName === 'tasks') {
        return { where: () => ({ first: async () => taskRow }) };
    }
    if (tableName === 'task_history') {
        return {
            where: () => historyQuery(),
            insert: async (row: Record<string, unknown>) => {
                const historyId = historyRows.length + 1;
                historyRows.push({
                    history_id: historyId,
                    task_id: taskId,
                    state: row.state as typeof TaskStates.PROCESSING,
                    timestamp: String(row.timestamp),
                    reason: String(row.reason),
                    metadata: String(row.metadata),
                });
                return [historyId];
            },
        };
    }
    throw new Error(`Unexpected table: ${tableName}`);
}

const database = Object.assign(tableQuery, {
    transaction: async <T>(operation: (trx: typeof tableQuery) => Promise<T>) => operation(tableQuery),
});

await mock.module('../packages/core/src/db/connection.js', {
    namedExports: { db: database },
});
await mock.module('../packages/core/src/utils/eventPublisher.js', {
    namedExports: {
        getEventPublisher: () => ({
            publishTaskUpdate: mock.fn(async (update: { state: string }) => {
                if (pauseTerminalPublication && update.state === TaskStates.COMPLETED) {
                    signalTerminalHistoryCommitted?.();
                    await new Promise<void>(resolve => { releaseTerminalPublication = resolve; });
                }
                return true;
            }),
        }),
    },
});
const logger = {
    debug: mock.fn(), info: mock.fn(), warn: mock.fn(), error: mock.fn(),
    withCorrelation: () => logger,
};
await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: logger,
    namedExports: { generateCorrelationId: () => 'generated-correlation' },
});

const { WorkerStateManager } = await import('../packages/core/src/utils/workerStateManager.js');

test('distributed recovery owners serialize restoration, terminal fallback, and later observers', async () => {
    const keyPrefix = 'test:distributed-recovery:';
    const issueRef = { number: 1899, repoOwner: 'integry', repoName: 'propr' };
    const restoreOwner = new WorkerStateManager({ keyPrefix });
    const fallbackOwner = new WorkerStateManager({ keyPrefix });
    const observerOwner = new WorkerStateManager({ keyPrefix });
    const firstRestore = restoreOwner.createTaskState(taskId, issueRef);
    await restorationPaused;

    const h1 = historyRows[0];
    loseNextTaskStateCas = true;
    const taskStateCasLost = new Promise<void>(resolve => { signalTaskStateCasLost = resolve; });
    const terminalFallback = fallbackOwner.updateTaskStateIfCurrentDetailed(
        taskId,
        {
            state: TaskStates.PROCESSING,
            createdAt: taskRow.created_at,
            updatedAt: h1.timestamp,
            correlationId: taskRow.correlation_id,
            version: h1.history_id,
            historyId: h1.history_id,
        },
        TaskStates.COMPLETED,
        { reason: 'Fallback committed h2' },
    );
    releaseRestoration();
    await taskStateCasLost;
    const thirdRestore = observerOwner.getTaskState(taskId);
    let thirdResult: TaskStateData | undefined;
    void thirdRestore.then(state => { thirdResult = state; });
    await writerIntentStarted;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(thirdResult, undefined);

    const [firstResult, fallbackResult, observedResult] = await Promise.all([
        firstRestore,
        terminalFallback,
        thirdRestore,
    ]);
    assert.equal(protocolOwners.size, 3);
    assert.equal(firstResult.state, TaskStates.PROCESSING);
    assert.equal(fallbackResult?.state.state, TaskStates.COMPLETED);
    assert.equal(observedResult?.state, TaskStates.COMPLETED);
    assert.equal(historyRows.at(-1)?.state, TaskStates.COMPLETED);
    assert.equal(historyRows.length, 2);

    const staleRetry = await observerOwner.updateTaskStateIfCurrentDetailed(
        taskId,
        {
            state: TaskStates.PROCESSING,
            createdAt: taskRow.created_at,
            updatedAt: h1.timestamp,
            correlationId: taskRow.correlation_id,
            version: h1.history_id,
            historyId: h1.history_id,
        },
        TaskStates.FAILED,
        { reason: 'Must not regress h2' },
    );
    assert.equal(staleRetry, null);
    assert.equal(historyRows.at(-1)?.state, TaskStates.COMPLETED);
    assert.equal(historyRows.length, 2);
    await Promise.all([restoreOwner.close(), fallbackOwner.close(), observerOwner.close()]);
});

test('terminal DB fallback blocks an ordinary cross-owner writer until h2 is installed', async () => {
    redisValues.clear();
    protocolOwners.clear();
    historyRows.splice(0, historyRows.length, {
        history_id: 1,
        task_id: taskId,
        state: TaskStates.PROCESSING,
        timestamp: '2026-08-14T12:05:00.000Z',
        reason: 'Processing',
        metadata: '{}',
    });
    const keyPrefix = 'test:ordinary-writer-recovery:';
    const key = `${keyPrefix}${taskId}`;
    const restoredH1: TaskStateData = {
        taskId,
        issueRef: { number: 1899, repoOwner: 'integry', repoName: 'propr', type: 'issue' },
        correlationId: taskRow.correlation_id,
        state: TaskStates.PROCESSING,
        createdAt: taskRow.created_at,
        updatedAt: historyRows[0].timestamp,
        version: historyRows[0].history_id,
        historyId: historyRows[0].history_id,
        attempts: 0,
        history: [],
    };
    pauseTerminalPublication = true;
    const terminalHistoryCommitted = new Promise<void>(resolve => {
        signalTerminalHistoryCommitted = resolve;
    });
    const fallbackOwner = new WorkerStateManager({ keyPrefix });
    const restoreOwner = new WorkerStateManager({ keyPrefix });
    const ordinaryOwner = new WorkerStateManager({ keyPrefix });
    taskLeaseReleaseHook = async () => {
        const restored = await restoreOwner.createTaskState(taskId, restoredH1.issueRef);
        assert.equal(restored.state, TaskStates.PROCESSING);
    };
    const fallback = fallbackOwner.updateTaskStateIfCurrentDetailed(
        taskId,
        {
            state: restoredH1.state,
            createdAt: restoredH1.createdAt,
            updatedAt: restoredH1.updatedAt,
            correlationId: restoredH1.correlationId,
            version: restoredH1.version,
            historyId: restoredH1.historyId,
        },
        TaskStates.COMPLETED,
        { reason: 'Fallback committed terminal h2' },
    );

    try {
        await terminalHistoryCommitted;
        let ordinarySettled = false;
        const ordinaryWriter = ordinaryOwner.updateTaskState(
            taskId,
            TaskStates.CLAUDE_EXECUTION,
            { reason: 'Stale ordinary writer must not persist h3' },
        );
        void ordinaryWriter.then(
            () => { ordinarySettled = true; },
            () => { ordinarySettled = true; },
        );
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(ordinarySettled, false);
        assert.equal((JSON.parse(redisValues.get(key) ?? '') as TaskStateData).state, TaskStates.PROCESSING);
        assert.equal(historyRows.at(-1)?.state, TaskStates.COMPLETED);
        assert.equal(historyRows.length, 2);

        releaseTerminalPublication?.();
        const [fallbackResult, ordinaryResult] = await Promise.all([fallback, ordinaryWriter]);
        assert.equal(fallbackResult?.state.state, TaskStates.COMPLETED);
        assert.equal(ordinaryResult.state, TaskStates.COMPLETED);
        assert.equal((JSON.parse(redisValues.get(key) ?? '') as TaskStateData).state, TaskStates.COMPLETED);
        assert.equal(historyRows.at(-1)?.state, TaskStates.COMPLETED);
        assert.equal(historyRows.length, 2);
        assert.equal(protocolOwners.size, 3);
    } finally {
        pauseTerminalPublication = false;
        releaseTerminalPublication?.();
        await fallback.catch(() => undefined);
        await Promise.all([fallbackOwner.close(), restoreOwner.close(), ordinaryOwner.close()]);
    }
});

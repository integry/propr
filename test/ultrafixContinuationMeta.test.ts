import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

class SupersededTaskAttemptError extends Error {}

const database = mock.fn((_tableName: string) => undefined as never);

await mock.module('@propr/core', {
    namedExports: {
        db: database,
        hashTaskAttemptToken: (token: string) => `hash:${token}`,
        SupersededTaskAttemptError,
        TaskStates: { COMPLETED: 'completed' },
    },
});

const { patchUltrafixContinuationMeta } = await import('../src/jobs/ultrafixContinuationMeta.js');

beforeEach(() => {
    database.mock.resetCalls();
    database.mock.mockImplementation(() => {
        throw new Error('SQL persistence must not run after supersession');
    });
});

test('reports task ownership mismatch as a superseded attempt', async () => {
    await assert.rejects(
        patchUltrafixContinuationMeta(
            {
                getTaskState: async () => ({ prProcessingLockToken: 'replacement-token' }),
                updateHistoryMetadata: mock.fn(),
            } as never,
            'task-1748',
            { ultrafixCycleCount: 2 },
            {
                correlatedLogger: { warn: mock.fn() } as never,
                prProcessingLockToken: 'attempt-token',
            },
        ),
        SupersededTaskAttemptError,
    );

    assert.equal(database.mock.calls.length, 0);
});

test('stops ultrafix persistence when the fenced Redis update is superseded', async () => {
    const updateHistoryMetadata = mock.fn(async () => {
        throw new SupersededTaskAttemptError('replacement attempt owns task');
    });
    const stateManager = {
        getTaskState: async () => ({ prProcessingLockToken: 'attempt-token' }),
        updateHistoryMetadata,
    };

    await assert.rejects(
        patchUltrafixContinuationMeta(
            stateManager as never,
            'task-1748',
            { ultrafixCycleCount: 2 },
            {
                correlatedLogger: { warn: mock.fn() } as never,
                prProcessingLockToken: 'attempt-token',
            },
        ),
        SupersededTaskAttemptError,
    );

    assert.equal(updateHistoryMetadata.mock.calls.length, 1);
    assert.equal(database.mock.calls.length, 0);
});

test('fences the SQL metadata patch against the current durable generation', async () => {
    const historyQuery = {
        where: mock.fn(() => historyQuery),
        andWhere: mock.fn(() => historyQuery),
        orderBy: mock.fn(() => historyQuery),
        first: mock.fn(async () => ({ history_id: 42, metadata: '{"existing":true}' })),
        whereExists: mock.fn(() => historyQuery),
        update: mock.fn(async () => 0),
    };
    const tasksQuery = {
        select: mock.fn(() => tasksQuery),
        whereRaw: mock.fn(() => tasksQuery),
        andWhere: mock.fn(() => tasksQuery),
    };
    database.mock.mockImplementation((tableName: string) => (
        tableName === 'tasks' ? tasksQuery : historyQuery
    ) as never);
    const updateHistoryMetadata = mock.fn(async () => ({}));

    await assert.rejects(
        patchUltrafixContinuationMeta(
            {
                getTaskState: async () => ({ prProcessingLockToken: 'attempt-token' }),
                updateHistoryMetadata,
            } as never,
            'task-1748',
            { ultrafixCycleCount: 2 },
            {
                correlatedLogger: { warn: mock.fn() } as never,
                prProcessingLockToken: 'attempt-token',
            },
        ),
        SupersededTaskAttemptError,
    );

    assert.deepEqual(historyQuery.andWhere.mock.calls[0].arguments, [
        'attempt_generation',
        'hash:attempt-token',
    ]);
    assert.deepEqual(tasksQuery.andWhere.mock.calls[0].arguments, [
        'attempt_generation',
        'hash:attempt-token',
    ]);
    assert.equal(historyQuery.whereExists.mock.calls.length, 1);
    assert.equal(historyQuery.update.mock.calls.length, 1);
});

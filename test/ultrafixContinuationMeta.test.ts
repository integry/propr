import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

class SupersededTaskAttemptError extends Error {}

const database = mock.fn(() => {
    throw new Error('SQL persistence must not run after supersession');
});

await mock.module('@propr/core', {
    namedExports: {
        db: database,
        SupersededTaskAttemptError,
        TaskStates: { COMPLETED: 'completed' },
    },
});

const { patchUltrafixContinuationMeta } = await import('../src/jobs/ultrafixContinuationMeta.js');

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

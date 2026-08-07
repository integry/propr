import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

class SupersededTaskAttemptError extends Error {}
const continuationFailure = new Error('queue unavailable');
const continueUltrafixLoop = mock.fn(async () => { throw continuationFailure; });

await mock.module('@propr/core', {
    namedExports: {
        areAllChecksPassing: mock.fn(),
        getCurrentPRHead: mock.fn(),
        SupersededTaskAttemptError,
    },
});
await mock.module('../src/jobs/ultrafixLoopContinuation.js', {
    namedExports: { continueUltrafixLoop },
});
await mock.module('../src/jobs/ultrafixContinuationMeta.js', {
    namedExports: {
        buildUltrafixHistoryMeta: mock.fn(),
        buildContinuationMeta: mock.fn(),
        patchUltrafixContinuationMeta: mock.fn(),
    },
});
await mock.module('../src/jobs/ultrafixOrchestrationService.js', {
    namedExports: {
        loadState: mock.fn(),
        saveDeferredContinuation: mock.fn(),
    },
});

const { handleUltrafixContinuation } = await import('../src/jobs/ultrafixJobHelpers.js');

test('Ultrafix continuation failures propagate so publication remains retryable', async () => {
    const assertLease = mock.fn(async () => {});
    await assert.rejects(
        handleUltrafixContinuation('fix', {
            job: { id: 'task-1748', data: { ultrafixMeta: { mode: 'ultrafix' } } },
            stateManager: {},
            taskId: 'task-1748',
            redisClient: {},
            repoOwner: 'integry',
            repoName: 'propr',
            pullRequestNumber: 1748,
            correlatedLogger: { error: mock.fn(), info: mock.fn() },
            correlationId: 'correlation',
            prProcessingLockToken: 'attempt-token',
            assertLease,
        } as never),
        error => error === continuationFailure,
    );

    assert.equal(assertLease.mock.calls.length, 2);
    const params = continueUltrafixLoop.mock.calls[0].arguments[0];
    assert.equal(params.continuationId, 'task-1748');
    assert.equal(params.mutationLease.lockKey, 'lock:pr:integry:propr:1748');
    assert.equal(params.mutationLease.lockToken, 'attempt-token');
});

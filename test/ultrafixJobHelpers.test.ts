import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const getCurrentPRHead = mock.fn(async () => 'head-sha' as string | null);
const areAllChecksPassing = mock.fn(async () => true);
const saveDeferredContinuation = mock.fn(async () => {});

await mock.module('@propr/core', {
    namedExports: { getCurrentPRHead, areAllChecksPassing },
});
await mock.module('../src/jobs/ultrafixLoopContinuation.js', {
    namedExports: { continueUltrafixLoop: mock.fn() },
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
        saveDeferredContinuation,
    },
});

const { checkUltrafixReadiness } = await import('../src/jobs/ultrafixJobHelpers.js');

const logger = {
    debug: mock.fn(),
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
};
const redisClient = {};
const params = {
    repoOwner: 'owner',
    repoName: 'repo',
    pullRequestNumber: 42,
    correlatedLogger: logger,
    redisClient,
};

function job(commandMode: 'fix' | 'review') {
    return {
        data: {
            commandMode,
            ultrafixMeta: { cycle: 2, goal: 8 },
        },
    };
}

beforeEach(() => {
    getCurrentPRHead.mock.resetCalls();
    getCurrentPRHead.mock.mockImplementation(async () => 'head-sha');
    areAllChecksPassing.mock.resetCalls();
    areAllChecksPassing.mock.mockImplementation(async () => true);
    saveDeferredContinuation.mock.resetCalls();
});

test('allows an Ultrafix fix without consulting CI', async () => {
    assert.equal(await checkUltrafixReadiness(job('fix') as never, params as never), true);
    assert.equal(getCurrentPRHead.mock.callCount(), 0);
    assert.equal(saveDeferredContinuation.mock.callCount(), 0);
});

test('defers an Ultrafix review when the PR head is unavailable', async () => {
    getCurrentPRHead.mock.mockImplementationOnce(async () => null);

    assert.equal(await checkUltrafixReadiness(job('review') as never, params as never), false);
    assert.equal(saveDeferredContinuation.mock.callCount(), 1);
    assert.equal(saveDeferredContinuation.mock.calls[0].arguments[1].reason, 'pre_execution_ci_head_unavailable');
});

test('defers an Ultrafix review when CI lookup fails', async () => {
    areAllChecksPassing.mock.mockImplementationOnce(async () => { throw new Error('GitHub unavailable'); });

    assert.equal(await checkUltrafixReadiness(job('review') as never, params as never), false);
    assert.equal(saveDeferredContinuation.mock.callCount(), 1);
    assert.equal(saveDeferredContinuation.mock.calls[0].arguments[1].reason, 'pre_execution_ci_check_error');
});

test('only allows an Ultrafix review when CI is passing', async () => {
    areAllChecksPassing.mock.mockImplementationOnce(async () => false);
    assert.equal(await checkUltrafixReadiness(job('review') as never, params as never), false);
    assert.equal(saveDeferredContinuation.mock.calls[0].arguments[1].reason, 'pre_execution_ci_check_failed');

    assert.equal(await checkUltrafixReadiness(job('review') as never, params as never), true);
});

import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const getCurrentPRHead = mock.fn(async () => 'head-sha' as string | null);
const areAllChecksPassing = mock.fn(async () => true);
const saveDeferredContinuation = mock.fn(async () => {});
const isUltrafixGenerationCurrent = mock.fn(async () => true);
const getActiveUltrafixTakeoverSequence = mock.fn(async () => null as number | null);
const adoptLegacyUltrafixGeneration = mock.fn(async () => true);
const isFreshUltrafixTransitionReserved = mock.fn(async () => false);
const queueAdd = mock.fn(async () => {});
const queueGetJobs = mock.fn(async () => [] as Array<{ id?: string; data: Record<string, unknown> }>);
const getIssueQueue = mock.fn(async () => ({ add: queueAdd, getJobs: queueGetJobs }));
const getPendingPrCommentsKey = mock.fn(() => 'pending-comments-key');
const hasFollowUpJobsForPR = mock.fn(async (
    _owner: string,
    _repo: string,
    _pr: number,
    getJobs: () => Promise<unknown[]>,
) => (await getJobs()).length > 0);
const hasPendingBatchedComments = mock.fn(async () => false);

await mock.module('@propr/core', {
    namedExports: { getCurrentPRHead, areAllChecksPassing, getIssueQueue, getPendingPrCommentsKey },
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
        isUltrafixGenerationCurrent,
        getActiveUltrafixTakeoverSequence,
        adoptLegacyUltrafixGeneration,
        isFreshUltrafixTransitionReserved,
        hasFollowUpJobsForPR,
        hasPendingBatchedComments,
    },
});

const { checkUltrafixGeneration, checkUltrafixReadiness, guardUltrafixJobExecution } = await import('../src/jobs/ultrafixJobHelpers.js');

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
        name: 'processPullRequestComment',
        data: {
            commandMode,
            ultrafixMeta: { mode: 'ultrafix', instructions: '', generation: 3, goal: 8 },
        },
    };
}

beforeEach(() => {
    getCurrentPRHead.mock.resetCalls();
    getCurrentPRHead.mock.mockImplementation(async () => 'head-sha');
    areAllChecksPassing.mock.resetCalls();
    areAllChecksPassing.mock.mockImplementation(async () => true);
    saveDeferredContinuation.mock.resetCalls();
    isUltrafixGenerationCurrent.mock.resetCalls();
    isUltrafixGenerationCurrent.mock.mockImplementation(async () => true);
    getActiveUltrafixTakeoverSequence.mock.resetCalls();
    getActiveUltrafixTakeoverSequence.mock.mockImplementation(async () => null);
    adoptLegacyUltrafixGeneration.mock.resetCalls();
    adoptLegacyUltrafixGeneration.mock.mockImplementation(async () => true);
    isFreshUltrafixTransitionReserved.mock.resetCalls();
    isFreshUltrafixTransitionReserved.mock.mockImplementation(async () => false);
    queueAdd.mock.resetCalls();
    queueGetJobs.mock.resetCalls();
    queueGetJobs.mock.mockImplementation(async () => []);
    hasFollowUpJobsForPR.mock.resetCalls();
    hasFollowUpJobsForPR.mock.mockImplementation(async (
        _owner,
        _repo,
        _pr,
        getJobs,
    ) => (await getJobs()).length > 0);
    hasPendingBatchedComments.mock.resetCalls();
    hasPendingBatchedComments.mock.mockImplementation(async () => false);
});

test('allows a queued Ultrafix job only while its generation is current', async () => {
    assert.equal(await checkUltrafixGeneration(job('review') as never, params as never), true);
    assert.deepEqual(isUltrafixGenerationCurrent.mock.calls[0].arguments.slice(1), [
        { owner: 'owner', repo: 'repo', pr: 42 }, 3,
    ]);
});

test('rejects both queued review and fix work from a superseded generation', async () => {
    isUltrafixGenerationCurrent.mock.mockImplementation(async () => false);
    assert.equal(await checkUltrafixGeneration(job('review') as never, params as never), false);
    assert.equal(await checkUltrafixGeneration(job('fix') as never, params as never), false);
});

test('adopts a generation-less queued job as legacy generation zero', async () => {
    const legacyJob = job('review');
    delete (legacyJob.data.ultrafixMeta as { generation?: number }).generation;

    assert.equal(await checkUltrafixGeneration(legacyJob as never, params as never), true);
    assert.equal(legacyJob.data.ultrafixMeta.generation, 0);
    assert.equal(adoptLegacyUltrafixGeneration.mock.callCount(), 1);
    assert.equal(isUltrafixGenerationCurrent.mock.calls[0].arguments[2], 0);
});

test('reschedules when the startup delay elapses before its reserved generation is published', async () => {
    isUltrafixGenerationCurrent.mock.mockImplementationOnce(async () => false);
    isFreshUltrafixTransitionReserved.mock.mockImplementationOnce(async () => true);

    assert.deepEqual(await guardUltrafixJobExecution(job('fix') as never, params as never), {
        status: 'rescheduled',
        reason: 'ultrafix_startup_pending',
    });
    assert.equal(queueAdd.mock.callCount(), 1);
    assert.equal(queueAdd.mock.calls[0].arguments[2].delay, 5_000);
    assert.equal(queueAdd.mock.calls[0].arguments[2].jobId, 'pr-comments-ultrafix-wait-owner-repo-42-3-1');
    assert.equal(queueAdd.mock.calls[0].arguments[1].ultrafixStartupWaitCount, 1);
});

test('treats a readiness save rejected by a concurrent takeover as cancelled', async () => {
    getCurrentPRHead.mock.mockImplementationOnce(async () => null);
    isUltrafixGenerationCurrent.mock.mockImplementationOnce(async () => true);
    isUltrafixGenerationCurrent.mock.mockImplementationOnce(async () => false);

    assert.deepEqual(await guardUltrafixJobExecution(job('review') as never, params as never), {
        status: 'cancelled',
        reason: 'ultrafix_superseded',
    });
});

test('allows an Ultrafix fix without consulting CI', async () => {
    assert.equal(await checkUltrafixReadiness(job('fix') as never, params as never), true);
    assert.equal(getCurrentPRHead.mock.callCount(), 0);
    assert.equal(saveDeferredContinuation.mock.callCount(), 0);
});

test('defers an Ultrafix fix when another follow-up job is still queued', async () => {
    queueGetJobs.mock.mockImplementationOnce(async () => [{
        id: 'other-job',
        data: { repoOwner: 'owner', repoName: 'repo', pullRequestNumber: 42, ultrafixMeta: {} },
    }]);

    assert.equal(await checkUltrafixReadiness(job('fix') as never, params as never), false);
    assert.equal(saveDeferredContinuation.mock.calls[0].arguments[1].reason, 'pre_execution_followup_job');
    assert.equal(getCurrentPRHead.mock.callCount(), 0);
});

test('defers an Ultrafix fix while pending batched comments remain', async () => {
    hasPendingBatchedComments.mock.mockImplementationOnce(async () => true);

    assert.equal(await checkUltrafixReadiness(job('fix') as never, params as never), false);
    assert.equal(saveDeferredContinuation.mock.calls[0].arguments[1].reason, 'pre_execution_pending_comments');
    assert.equal(getCurrentPRHead.mock.callCount(), 0);
});

test('defers stale Ultrafix work while a manual takeover is being scheduled', async () => {
    getActiveUltrafixTakeoverSequence.mock.mockImplementationOnce(async () => 17);

    assert.equal(await checkUltrafixReadiness(job('fix') as never, params as never), false);
    assert.equal(saveDeferredContinuation.mock.callCount(), 1);
    assert.equal(saveDeferredContinuation.mock.calls[0].arguments[1].reason, 'manual_takeover_in_progress');
});

test('defers an Ultrafix review when the PR head is unavailable', async () => {
    getCurrentPRHead.mock.mockImplementationOnce(async () => null);

    assert.equal(await checkUltrafixReadiness(job('review') as never, params as never), false);
    assert.equal(saveDeferredContinuation.mock.callCount(), 1);
    assert.equal(saveDeferredContinuation.mock.calls[0].arguments[1].reason, 'pre_execution_ci_head_unavailable');
    assert.equal(saveDeferredContinuation.mock.calls[0].arguments[1].generation, 3);
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

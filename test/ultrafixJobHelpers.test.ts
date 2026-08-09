import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const getCurrentPRHead = mock.fn(async () => 'head-sha' as string | null);
const areAllChecksPassing = mock.fn(async () => true);
const saveDeferredContinuation = mock.fn(async () => {});
const isUltrafixGenerationActive = mock.fn(async () => true);
const isManualUltrafixCommandSequenceCurrent = mock.fn(async () => true);
const getActiveUltrafixTakeoverSequence = mock.fn(async () => null as number | null);
const adoptLegacyUltrafixGeneration = mock.fn(async () => true);
const isFreshUltrafixTransitionReserved = mock.fn(async () => false);
const commitFreshUltrafixLoop = mock.fn(async () => ({ state: {}, initialAction: 'review' as const }));
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
        isUltrafixGenerationActive,
        isManualUltrafixCommandSequenceCurrent,
        getActiveUltrafixTakeoverSequence,
        adoptLegacyUltrafixGeneration,
        isFreshUltrafixTransitionReserved,
        commitFreshUltrafixLoop,
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

function manualJob(commandMode: 'fix' | 'review', commandSequence: number) {
    return {
        name: 'processPullRequestComment',
        data: { commandMode, commandSequence },
    };
}

beforeEach(() => {
    getCurrentPRHead.mock.resetCalls();
    getCurrentPRHead.mock.mockImplementation(async () => 'head-sha');
    areAllChecksPassing.mock.resetCalls();
    areAllChecksPassing.mock.mockImplementation(async () => true);
    saveDeferredContinuation.mock.resetCalls();
    isUltrafixGenerationActive.mock.resetCalls();
    isUltrafixGenerationActive.mock.mockImplementation(async () => true);
    isManualUltrafixCommandSequenceCurrent.mock.resetCalls();
    isManualUltrafixCommandSequenceCurrent.mock.mockImplementation(async () => true);
    getActiveUltrafixTakeoverSequence.mock.resetCalls();
    getActiveUltrafixTakeoverSequence.mock.mockImplementation(async () => null);
    adoptLegacyUltrafixGeneration.mock.resetCalls();
    adoptLegacyUltrafixGeneration.mock.mockImplementation(async () => true);
    isFreshUltrafixTransitionReserved.mock.resetCalls();
    isFreshUltrafixTransitionReserved.mock.mockImplementation(async () => false);
    commitFreshUltrafixLoop.mock.resetCalls();
    commitFreshUltrafixLoop.mock.mockImplementation(async () => ({ state: {}, initialAction: 'review' }));
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
    assert.deepEqual(isUltrafixGenerationActive.mock.calls[0].arguments.slice(1), [
        { owner: 'owner', repo: 'repo', pr: 42 }, 3,
    ]);
});

test('rejects both queued review and fix work from a superseded generation', async () => {
    isUltrafixGenerationActive.mock.mockImplementation(async () => false);
    assert.equal(await checkUltrafixGeneration(job('review') as never, params as never), false);
    assert.equal(await checkUltrafixGeneration(job('fix') as never, params as never), false);
});

test('rejects queued Ultrafix work after its current generation becomes inactive', async () => {
    isUltrafixGenerationActive.mock.mockImplementationOnce(async () => false);

    assert.deepEqual(await guardUltrafixJobExecution(job('fix') as never, params as never), {
        status: 'cancelled',
        reason: 'ultrafix_superseded',
    });
});

test('cancels an older edited manual command before execution', async () => {
    isManualUltrafixCommandSequenceCurrent.mock.mockImplementationOnce(async () => false);

    assert.deepEqual(await guardUltrafixJobExecution(manualJob('fix', 14) as never, params as never), {
        status: 'cancelled',
        reason: 'manual_command_superseded',
    });
    assert.deepEqual(isManualUltrafixCommandSequenceCurrent.mock.calls[0].arguments.slice(1), [
        { owner: 'owner', repo: 'repo', pr: 42 }, 14,
    ]);
});

test('allows the authoritative manual command revision', async () => {
    assert.equal(await guardUltrafixJobExecution(manualJob('review', 15) as never, params as never), null);
    assert.equal(isManualUltrafixCommandSequenceCurrent.mock.callCount(), 1);
});

test('adopts a generation-less queued job as legacy generation zero', async () => {
    const legacyJob = job('review');
    delete (legacyJob.data.ultrafixMeta as { generation?: number }).generation;

    assert.equal(await checkUltrafixGeneration(legacyJob as never, params as never), true);
    assert.equal(legacyJob.data.ultrafixMeta.generation, 0);
    assert.equal(adoptLegacyUltrafixGeneration.mock.callCount(), 1);
    assert.equal(isUltrafixGenerationActive.mock.calls[0].arguments[2], 0);
});

test('publishes a reserved generation from the durable startup job after intake exits', async () => {
    let generationChecks = 0;
    isUltrafixGenerationActive.mock.mockImplementation(async () => ++generationChecks > 1);
    isFreshUltrafixTransitionReserved.mock.mockImplementationOnce(async () => true);
    const startupJob = job('fix');
    startupJob.data.ultrafixStartupRecovery = {
        commandSequence: 9,
        generation: 3,
        baseGeneration: 2,
        goal: 8,
        maxCycles: 5,
        pauseSeconds: 60,
        reviewModel: 'codex:gpt-5.6-sol',
        initialAction: 'fix',
    };

    assert.equal(await guardUltrafixJobExecution(startupJob as never, params as never), null);
    assert.deepEqual(commitFreshUltrafixLoop.mock.calls[0].arguments.slice(1), [{
        owner: 'owner',
        repo: 'repo',
        pr: 42,
        commandSequence: 9,
        generation: 3,
        baseGeneration: 2,
        goal: 8,
        maxCycles: 5,
        pauseSeconds: 60,
        reviewModel: 'codex:gpt-5.6-sol',
    }, true]);
    assert.equal(queueAdd.mock.callCount(), 0);
});

test('cancels a reserved startup job without matching recovery data instead of retrying forever', async () => {
    isUltrafixGenerationActive.mock.mockImplementationOnce(async () => false);
    isFreshUltrafixTransitionReserved.mock.mockImplementationOnce(async () => true);

    assert.deepEqual(await guardUltrafixJobExecution(job('review') as never, params as never), {
        status: 'cancelled',
        reason: 'ultrafix_startup_unrecoverable',
    });
    assert.equal(queueAdd.mock.callCount(), 0);
});

test('treats a readiness save rejected by a concurrent takeover as cancelled', async () => {
    getCurrentPRHead.mock.mockImplementationOnce(async () => null);
    isUltrafixGenerationActive.mock.mockImplementationOnce(async () => true);
    isUltrafixGenerationActive.mock.mockImplementationOnce(async () => false);

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

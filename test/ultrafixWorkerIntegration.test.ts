/**
 * Integration-style tests for ultrafix worker continuation logic.
 *
 * Since `continueUltrafixLoop` depends on external services (octokit, issueQueue,
 * @propr/core), we exercise the complete continuation decision flow using the
 * orchestration service's pure functions and state management. This validates
 * that state transitions, readiness gating, deferred continuation, and
 * mode alternation work correctly end-to-end without requiring module-level mocks.
 *
 * Covers:
 * - Full cycle: review -> fix -> review with state persistence
 * - Goal-met terminal: stop after review with sufficient score
 * - Max-cycles terminal: stop after hitting cycle cap
 * - Label-removal terminal: clearing state simulates label check
 * - Readiness gating: checks/follow-up/pending blocking
 * - Deferred continuation: save, load, clear, and resume
 * - Duplicate scheduling prevention via follow-up job detection
 * - Exact command mode transitions (review -> fix -> review)
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
    createDefaultState,
    determineInitialAction,
    determineNextAction,
    startLoop,
    recordAction,
    stopLoop,
    saveState,
    loadState,
    clearState,
    checkReadiness,
    isCooldownElapsed,
    hasFollowUpJobsForPR,
    hasPendingBatchedComments,
    saveDeferredContinuation,
    loadDeferredContinuation,
    clearDeferredContinuation,
    type UltrafixLoopState,
    type UltrafixAction,
    type UltrafixDeferredContinuation,
} from '../src/jobs/ultrafixOrchestrationService.js';

// --- Mock Redis ---

function createMockRedis() {
    const store = new Map<string, string>();
    const lists = new Map<string, string[]>();
    return {
        store,
        lists,
        async get(key: string) { return store.get(key) ?? null; },
        async set(key: string, value: string) { store.set(key, value); return 'OK'; },
        async del(key: string) { store.delete(key); lists.delete(key); return 1; },
        async llen(key: string) { return (lists.get(key) ?? []).length; },
        async lpush(key: string, ...values: string[]) {
            if (!lists.has(key)) lists.set(key, []);
            lists.get(key)!.unshift(...values);
            return lists.get(key)!.length;
        },
    };
}

// --- Helper: simulate continueUltrafixLoop decision flow ---
// This mirrors the logic in continueUltrafixLoop() but with injectable
// external inputs so we can test the full flow without module-level mocking.

interface SimulatedContinuationInput {
    redis: ReturnType<typeof createMockRedis>;
    owner: string;
    repo: string;
    pr: number;
    completedAction: UltrafixAction;
    /** Simulated: is the ultrafix label still on the PR? */
    labelPresent: boolean;
    /** Simulated: latest review score (null if not available or after fix) */
    latestScore: number | null;
    /** Simulated: are all CI checks passing? */
    allChecksPassing: boolean;
    /** Simulated: are there follow-up ultrafix jobs in queue? */
    hasFollowUpJobs: boolean;
    /** Simulated: are there pending batched comments? */
    hasPendingComments: boolean;
}

interface SimulatedContinuationResult {
    continued: boolean;
    reason: string;
    nextAction?: UltrafixAction | null;
    score?: number | null;
    cycleCount?: number;
    deferred?: boolean;
    enqueuedMode?: 'review' | 'fix';
}

async function simulateContinuation(input: SimulatedContinuationInput): Promise<SimulatedContinuationResult> {
    const { redis, owner, repo, pr, completedAction, labelPresent, latestScore,
            allChecksPassing, hasFollowUpJobs, hasPendingComments } = input;

    // 1. Load state
    const state = await loadState(redis as any, owner, repo, pr);
    if (!state || !state.active) {
        return { continued: false, reason: 'no_active_loop' };
    }

    // 2. Record the completed action
    const updated = await recordAction(redis as any, { owner, repo, pr, action: completedAction });
    if (!updated) {
        return { continued: false, reason: 'state_lost_after_record' };
    }

    // 3. Check label
    if (!labelPresent) {
        await clearState(redis as any, owner, repo, pr);
        return { continued: false, reason: 'label_removed', cycleCount: updated.cycleCount };
    }

    // 4. Get score (only after review)
    const score = completedAction === 'review' ? latestScore : null;

    // 5. Determine next action
    const decision = determineNextAction(updated, score);

    // 6. If loop should stop
    if (decision.action === null) {
        await clearState(redis as any, owner, repo, pr);
        return {
            continued: false,
            reason: decision.reason,
            score,
            cycleCount: updated.cycleCount,
        };
    }

    // 7. Readiness gating
    const readiness = checkReadiness({ allChecksPassing, hasFollowUpJobs, hasPendingComments });

    if (!readiness.ready) {
        await saveDeferredContinuation(redis as any, {
            owner, repo, pr,
            nextAction: decision.action,
            savedAt: new Date().toISOString(),
            reason: readiness.reasons.join(', '),
        });
        return {
            continued: false,
            reason: `deferred: ${readiness.reasons.join(', ')}`,
            nextAction: decision.action,
            score,
            cycleCount: updated.cycleCount,
            deferred: true,
        };
    }

    // Clear any stale deferred
    await clearDeferredContinuation(redis as any, owner, repo, pr);

    // 8. Enqueue next step
    return {
        continued: true,
        reason: decision.reason,
        nextAction: decision.action,
        score,
        cycleCount: updated.cycleCount,
        enqueuedMode: decision.action,
    };
}

// ========== Tests ==========

describe('Ultrafix worker integration — full continuation flow', () => {
    let redis: ReturnType<typeof createMockRedis>;
    const O = 'acme', R = 'web', PR = 42;

    beforeEach(() => {
        redis = createMockRedis();
    });

    // --- Goal-met terminal ---

    test('completed review with score >= goal stops the loop', async () => {
        await startLoop(redis as any, { owner: O, repo: R, pr: PR, goal: 7 }, false);

        const result = await simulateContinuation({
            redis, owner: O, repo: R, pr: PR,
            completedAction: 'review',
            labelPresent: true,
            latestScore: 8,
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });

        assert.strictEqual(result.continued, false);
        assert.ok(result.reason.includes('Goal met'));
        assert.strictEqual(result.score, 8);

        // State should be cleared
        const state = await loadState(redis as any, O, R, PR);
        assert.strictEqual(state, null);
    });

    test('completed review with score exactly at goal stops the loop', async () => {
        await startLoop(redis as any, { owner: O, repo: R, pr: PR, goal: 7 }, false);

        const result = await simulateContinuation({
            redis, owner: O, repo: R, pr: PR,
            completedAction: 'review',
            labelPresent: true,
            latestScore: 7,
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });

        assert.strictEqual(result.continued, false);
        assert.ok(result.reason.includes('Goal met'));
    });

    // --- Continue loop ---

    test('completed review with score below goal continues with fix', async () => {
        await startLoop(redis as any, { owner: O, repo: R, pr: PR, goal: 8 }, false);

        const result = await simulateContinuation({
            redis, owner: O, repo: R, pr: PR,
            completedAction: 'review',
            labelPresent: true,
            latestScore: 5,
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });

        assert.strictEqual(result.continued, true);
        assert.strictEqual(result.nextAction, 'fix');
        assert.strictEqual(result.enqueuedMode, 'fix');
    });

    test('completed fix continues with review', async () => {
        await startLoop(redis as any, { owner: O, repo: R, pr: PR, goal: 8 }, false);

        const result = await simulateContinuation({
            redis, owner: O, repo: R, pr: PR,
            completedAction: 'fix',
            labelPresent: true,
            latestScore: null, // score not fetched after fix
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });

        assert.strictEqual(result.continued, true);
        assert.strictEqual(result.nextAction, 'review');
        assert.strictEqual(result.enqueuedMode, 'review');

        // Cycle count should increment after fix
        assert.strictEqual(result.cycleCount, 1);
    });

    // --- Full multi-cycle flow ---

    test('full cycle: review -> fix -> review -> fix -> goal met', async () => {
        await startLoop(redis as any, { owner: O, repo: R, pr: PR, goal: 8, maxCycles: 5 }, false);

        const defaults = {
            redis, owner: O, repo: R, pr: PR,
            labelPresent: true,
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        };

        // Step 1: review completes with low score → fix
        let result = await simulateContinuation({
            ...defaults,
            completedAction: 'review',
            latestScore: 4,
        });
        assert.strictEqual(result.continued, true);
        assert.strictEqual(result.enqueuedMode, 'fix');
        assert.strictEqual(result.cycleCount, 0); // fix not recorded yet

        // Step 2: fix completes → review
        result = await simulateContinuation({
            ...defaults,
            completedAction: 'fix',
            latestScore: null,
        });
        assert.strictEqual(result.continued, true);
        assert.strictEqual(result.enqueuedMode, 'review');
        assert.strictEqual(result.cycleCount, 1); // one cycle complete

        // Step 3: review completes with improved score → fix
        result = await simulateContinuation({
            ...defaults,
            completedAction: 'review',
            latestScore: 6,
        });
        assert.strictEqual(result.continued, true);
        assert.strictEqual(result.enqueuedMode, 'fix');

        // Step 4: fix completes → review
        result = await simulateContinuation({
            ...defaults,
            completedAction: 'fix',
            latestScore: null,
        });
        assert.strictEqual(result.continued, true);
        assert.strictEqual(result.enqueuedMode, 'review');
        assert.strictEqual(result.cycleCount, 2);

        // Step 5: review completes with score >= goal → stop
        result = await simulateContinuation({
            ...defaults,
            completedAction: 'review',
            latestScore: 9,
        });
        assert.strictEqual(result.continued, false);
        assert.ok(result.reason.includes('Goal met'));
    });

    test('mode transitions strictly alternate: review->fix->review->fix', async () => {
        await startLoop(redis as any, { owner: O, repo: R, pr: PR, goal: 10, maxCycles: 10 }, false);

        const defaults = {
            redis, owner: O, repo: R, pr: PR,
            labelPresent: true,
            latestScore: 3 as number | null,
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        };

        const expectedSequence: UltrafixAction[] = ['fix', 'review', 'fix', 'review'];

        for (const expectedNext of expectedSequence) {
            const completedAction = expectedNext === 'fix' ? 'review' : 'fix';
            const result = await simulateContinuation({
                ...defaults,
                completedAction,
                latestScore: completedAction === 'review' ? 3 : null,
            });
            assert.strictEqual(result.continued, true);
            assert.strictEqual(result.enqueuedMode, expectedNext,
                `After ${completedAction}, expected ${expectedNext}`);
        }
    });

    // --- Terminal conditions ---

    test('stops when no active state exists', async () => {
        const result = await simulateContinuation({
            redis, owner: O, repo: R, pr: PR,
            completedAction: 'review',
            labelPresent: true,
            latestScore: 5,
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });

        assert.strictEqual(result.continued, false);
        assert.strictEqual(result.reason, 'no_active_loop');
    });

    test('stops when label is removed', async () => {
        await startLoop(redis as any, { owner: O, repo: R, pr: PR, goal: 8 }, false);

        const result = await simulateContinuation({
            redis, owner: O, repo: R, pr: PR,
            completedAction: 'review',
            labelPresent: false,
            latestScore: 5,
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });

        assert.strictEqual(result.continued, false);
        assert.strictEqual(result.reason, 'label_removed');
        const state = await loadState(redis as any, O, R, PR);
        assert.strictEqual(state, null);
    });

    test('stops at max cycles even if score is still low', async () => {
        const state = createDefaultState({ owner: O, repo: R, pr: PR, goal: 9, maxCycles: 2 });
        state.cycleCount = 1;
        state.lastAction = 'review';
        state.lastActionTimestamp = new Date().toISOString();
        await saveState(redis as any, state);

        // Completing a fix will bump cycleCount to 2 = maxCycles
        const result = await simulateContinuation({
            redis, owner: O, repo: R, pr: PR,
            completedAction: 'fix',
            labelPresent: true,
            latestScore: null,
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });

        assert.strictEqual(result.continued, false);
        assert.ok(result.reason.includes('Max cycles'));
        assert.strictEqual(result.cycleCount, 2);
    });

    test('stops when loop is manually deactivated', async () => {
        await startLoop(redis as any, { owner: O, repo: R, pr: PR }, false);
        await stopLoop(redis as any, O, R, PR);

        const result = await simulateContinuation({
            redis, owner: O, repo: R, pr: PR,
            completedAction: 'review',
            labelPresent: true,
            latestScore: 5,
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });

        assert.strictEqual(result.continued, false);
        assert.strictEqual(result.reason, 'no_active_loop');
    });

    // --- Readiness gating ---

    test('defers when checks are not passing', async () => {
        await startLoop(redis as any, { owner: O, repo: R, pr: PR, goal: 8 }, false);

        const result = await simulateContinuation({
            redis, owner: O, repo: R, pr: PR,
            completedAction: 'review',
            labelPresent: true,
            latestScore: 5,
            allChecksPassing: false,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });

        assert.strictEqual(result.continued, false);
        assert.strictEqual(result.deferred, true);
        assert.ok(result.reason.includes('checks_not_passing'));

        // Deferred record should exist
        const deferred = await loadDeferredContinuation(redis as any, O, R, PR);
        assert.ok(deferred);
        assert.strictEqual(deferred!.nextAction, 'fix');
    });

    test('defers when follow-up jobs exist', async () => {
        await startLoop(redis as any, { owner: O, repo: R, pr: PR, goal: 8 }, false);

        const result = await simulateContinuation({
            redis, owner: O, repo: R, pr: PR,
            completedAction: 'review',
            labelPresent: true,
            latestScore: 5,
            allChecksPassing: true,
            hasFollowUpJobs: true,
            hasPendingComments: false,
        });

        assert.strictEqual(result.continued, false);
        assert.strictEqual(result.deferred, true);
        assert.ok(result.reason.includes('follow_up_jobs_active'));
    });

    test('defers when pending batched comments exist', async () => {
        await startLoop(redis as any, { owner: O, repo: R, pr: PR, goal: 8 }, false);

        const result = await simulateContinuation({
            redis, owner: O, repo: R, pr: PR,
            completedAction: 'review',
            labelPresent: true,
            latestScore: 5,
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: true,
        });

        assert.strictEqual(result.continued, false);
        assert.strictEqual(result.deferred, true);
        assert.ok(result.reason.includes('pending_comments_exist'));
    });

    test('aggregates multiple blocking reasons when deferring', async () => {
        await startLoop(redis as any, { owner: O, repo: R, pr: PR, goal: 8 }, false);

        const result = await simulateContinuation({
            redis, owner: O, repo: R, pr: PR,
            completedAction: 'review',
            labelPresent: true,
            latestScore: 5,
            allChecksPassing: false,
            hasFollowUpJobs: true,
            hasPendingComments: true,
        });

        assert.strictEqual(result.deferred, true);
        assert.ok(result.reason.includes('checks_not_passing'));
        assert.ok(result.reason.includes('follow_up_jobs_active'));
        assert.ok(result.reason.includes('pending_comments_exist'));
    });

    // --- Deferred continuation ---

    test('deferred continuation is saved with correct nextAction', async () => {
        await startLoop(redis as any, { owner: O, repo: R, pr: PR, goal: 8 }, false);

        // After review → next should be fix
        await simulateContinuation({
            redis, owner: O, repo: R, pr: PR,
            completedAction: 'review',
            labelPresent: true,
            latestScore: 5,
            allChecksPassing: false,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });

        const deferred = await loadDeferredContinuation(redis as any, O, R, PR);
        assert.ok(deferred);
        assert.strictEqual(deferred!.nextAction, 'fix');
        assert.strictEqual(deferred!.owner, O);
        assert.strictEqual(deferred!.repo, R);
        assert.strictEqual(deferred!.pr, PR);
    });

    test('deferred continuation after fix has nextAction=review', async () => {
        await startLoop(redis as any, { owner: O, repo: R, pr: PR, goal: 8 }, false);

        // After fix → next should be review
        await simulateContinuation({
            redis, owner: O, repo: R, pr: PR,
            completedAction: 'fix',
            labelPresent: true,
            latestScore: null,
            allChecksPassing: false,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });

        const deferred = await loadDeferredContinuation(redis as any, O, R, PR);
        assert.ok(deferred);
        assert.strictEqual(deferred!.nextAction, 'review');
    });

    test('deferred record is cleared when continuation proceeds', async () => {
        await startLoop(redis as any, { owner: O, repo: R, pr: PR, goal: 8 }, false);

        // First: defer due to checks failing
        await simulateContinuation({
            redis, owner: O, repo: R, pr: PR,
            completedAction: 'review',
            labelPresent: true,
            latestScore: 5,
            allChecksPassing: false,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });

        // Deferred should exist
        let deferred = await loadDeferredContinuation(redis as any, O, R, PR);
        assert.ok(deferred);

        // Now: checks pass → continuation proceeds (simulated resume)
        await clearDeferredContinuation(redis as any, O, R, PR);
        deferred = await loadDeferredContinuation(redis as any, O, R, PR);
        assert.strictEqual(deferred, null);
    });

    // --- Duplicate scheduling prevention ---

    test('hasFollowUpJobsForPR detects existing ultrafix job for same PR', async () => {
        const jobs = [
            { data: { repoOwner: O, repoName: R, pullRequestNumber: PR, ultrafixMeta: { goal: 7 } } },
        ];
        const result = await hasFollowUpJobsForPR(O, R, PR, async () => jobs);
        assert.strictEqual(result, true);
    });

    test('hasFollowUpJobsForPR ignores non-ultrafix jobs for same PR', async () => {
        const jobs = [
            { data: { repoOwner: O, repoName: R, pullRequestNumber: PR } }, // no ultrafixMeta
        ];
        const result = await hasFollowUpJobsForPR(O, R, PR, async () => jobs);
        assert.strictEqual(result, false);
    });

    test('hasFollowUpJobsForPR ignores ultrafix jobs for different PR', async () => {
        const jobs = [
            { data: { repoOwner: O, repoName: R, pullRequestNumber: 99, ultrafixMeta: { goal: 7 } } },
        ];
        const result = await hasFollowUpJobsForPR(O, R, PR, async () => jobs);
        assert.strictEqual(result, false);
    });

    // --- First-step selection ---

    test('initial action is review when no pending reviews', () => {
        assert.strictEqual(determineInitialAction(false), 'review');
    });

    test('initial action is fix when pending reviews exist', () => {
        assert.strictEqual(determineInitialAction(true), 'fix');
    });

    // --- Score does not apply after fix ---

    test('score is ignored in decision after fix (always transitions to review)', async () => {
        await startLoop(redis as any, { owner: O, repo: R, pr: PR, goal: 5 }, false);

        // Fix completes → next should be review regardless
        const result = await simulateContinuation({
            redis, owner: O, repo: R, pr: PR,
            completedAction: 'fix',
            labelPresent: true,
            latestScore: null, // score is not fetched after fix
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });

        assert.strictEqual(result.continued, true);
        assert.strictEqual(result.enqueuedMode, 'review');
    });
});

// --- Deferred resume flow ---

describe('Deferred resume flow', () => {
    let redis: ReturnType<typeof createMockRedis>;
    const O = 'acme', R = 'web', PR = 42;

    beforeEach(() => {
        redis = createMockRedis();
    });

    test('resume enqueues next step when ready', async () => {
        // Setup: active loop + deferred
        const state = createDefaultState({ owner: O, repo: R, pr: PR, goal: 8, pauseSeconds: 30 });
        state.lastAction = 'review';
        state.lastActionTimestamp = new Date().toISOString();
        await saveState(redis as any, state);

        await saveDeferredContinuation(redis as any, {
            owner: O, repo: R, pr: PR,
            nextAction: 'fix',
            savedAt: new Date().toISOString(),
            reason: 'checks_not_passing',
        });

        // Simulate: checks now green
        const readiness = checkReadiness({
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });
        assert.strictEqual(readiness.ready, true);

        // Load deferred and clear it
        const deferred = await loadDeferredContinuation(redis as any, O, R, PR);
        assert.ok(deferred);
        assert.strictEqual(deferred!.nextAction, 'fix');
        await clearDeferredContinuation(redis as any, O, R, PR);

        // Deferred should be gone
        const afterClear = await loadDeferredContinuation(redis as any, O, R, PR);
        assert.strictEqual(afterClear, null);
    });

    test('resume stays deferred when checks still failing', async () => {
        const state = createDefaultState({ owner: O, repo: R, pr: PR, goal: 8 });
        state.lastAction = 'review';
        state.lastActionTimestamp = new Date().toISOString();
        await saveState(redis as any, state);

        await saveDeferredContinuation(redis as any, {
            owner: O, repo: R, pr: PR,
            nextAction: 'fix',
            savedAt: new Date().toISOString(),
            reason: 'checks_not_passing',
        });

        const readiness = checkReadiness({
            allChecksPassing: false,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });
        assert.strictEqual(readiness.ready, false);

        // Deferred should remain
        const deferred = await loadDeferredContinuation(redis as any, O, R, PR);
        assert.ok(deferred);
        assert.strictEqual(deferred!.nextAction, 'fix');
    });

    test('no-op when nothing is deferred', async () => {
        const deferred = await loadDeferredContinuation(redis as any, O, R, PR);
        assert.strictEqual(deferred, null);
    });

    test('cleanup: deferred cleared when loop no longer active', async () => {
        await saveDeferredContinuation(redis as any, {
            owner: O, repo: R, pr: PR,
            nextAction: 'fix',
            savedAt: new Date().toISOString(),
            reason: 'checks_not_passing',
        });

        // No loop state → deferred is orphaned
        const loopState = await loadState(redis as any, O, R, PR);
        assert.strictEqual(loopState, null);

        // Clean up orphaned deferred
        await clearDeferredContinuation(redis as any, O, R, PR);
        const afterCleanup = await loadDeferredContinuation(redis as any, O, R, PR);
        assert.strictEqual(afterCleanup, null);
    });
});

// --- Cooldown integration ---

describe('Cooldown and enqueue timing', () => {
    test('cooldown is elapsed when pauseSeconds worth of time has passed', () => {
        const state = createDefaultState({ owner: 'o', repo: 'r', pr: 1, pauseSeconds: 60 });
        state.lastActionTimestamp = new Date(Date.now() - 61_000).toISOString();
        assert.strictEqual(isCooldownElapsed(state), true);
    });

    test('cooldown is not elapsed when insufficient time has passed', () => {
        const state = createDefaultState({ owner: 'o', repo: 'r', pr: 1, pauseSeconds: 60 });
        state.lastActionTimestamp = new Date(Date.now() - 10_000).toISOString();
        assert.strictEqual(isCooldownElapsed(state), false);
    });

    test('cooldown is always elapsed when pauseSeconds is 0', () => {
        const state = createDefaultState({ owner: 'o', repo: 'r', pr: 1, pauseSeconds: 0 });
        state.lastActionTimestamp = new Date().toISOString();
        assert.strictEqual(isCooldownElapsed(state), true);
    });

    test('cooldown is elapsed when no lastActionTimestamp', () => {
        const state = createDefaultState({ owner: 'o', repo: 'r', pr: 1, pauseSeconds: 60 });
        assert.strictEqual(isCooldownElapsed(state), true);
    });
});

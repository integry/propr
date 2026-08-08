import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

import {
    createDefaultState,
    saveState,
    loadState,
    clearState,
    completeLoop,
    determineNextAction,
    hasReviewReachedGoal,
    startLoop,
    saveDeferredContinuation,
    loadDeferredContinuation,
    clearDeferredContinuation,
    type UltrafixLoopState,
} from '../src/jobs/ultrafixOrchestrationService.js';

const enqueueNextStep = mock.fn(async () => {});
const evaluateReadiness = mock.fn(async () => ({ ready: true, reasons: [] as string[] }));

await mock.module('@propr/core', {
    namedExports: {
        generateCorrelationId: mock.fn(() => 'resume-correlation-id'),
        getAuthenticatedOctokit: mock.fn(),
        withRetry: mock.fn(async (fn: () => Promise<unknown>) => fn()),
        retryConfigs: { githubApi: {} },
    },
});

await mock.module('../src/jobs/ultrafixLoopContinuationHelpers.js', {
    namedExports: {
        enqueueNextStep,
        evaluateReadiness,
        hasUltrafixLabel: mock.fn(async () => true),
        maybeEnableAutoMerge: mock.fn(async () => {}),
        postPrComment: mock.fn(async () => {}),
        removeUltrafixLabel: mock.fn(async () => {}),
    },
});

await mock.module('../src/jobs/prCommentJobUtils.js', {
    namedExports: { fetchAllComments: mock.fn(async () => []) },
});

await mock.module('../src/jobs/reviewCommentGatherer.js', {
    namedExports: { getPendingReviewState: mock.fn() },
});

const { resumeDeferredContinuation } = await import('../src/jobs/ultrafixLoopContinuation.js');

// --- Mock Redis ---

function createMockRedis() {
    const store = new Map<string, string>();
    const sets = new Map<string, Set<string>>();
    return {
        store,
        sets,
        async get(key: string) { return store.get(key) ?? null; },
        async set(key: string, value: string) { store.set(key, value); return 'OK'; },
        async del(key: string) { store.delete(key); return 1; },
        async eval(script: string, _keyCount: number, ...args: string[]) {
            const [generationKey, deferredKey] = args;
            if (script.includes('return { deferred, generation }')) {
                const deferred = store.get(deferredKey);
                if (!deferred) return null;
                store.delete(deferredKey);
                return [deferred, store.get(generationKey) ?? '0'];
            }
            if (script.includes("redis.call('INCR'")) {
                store.set(generationKey, String(Number(store.get(generationKey) ?? '0') + 1));
                store.delete(deferredKey);
                return 1;
            }
            if ((store.get(generationKey) ?? '0') !== args[2]) return 0;
            store.set(deferredKey, args[3]);
            return 1;
        },
        async smembers(key: string) { return [...(sets.get(key) ?? [])]; },
        async sadd(key: string, ...members: string[]) {
            if (!sets.has(key)) sets.set(key, new Set());
            for (const m of members) sets.get(key)!.add(m);
            return members.length;
        },
        async expire(_key: string, _seconds: number) { return 1; },
    };
}

// --- Mock logger ---

function createMockLogger() {
    const logs: Array<{ level: string; data: unknown; msg?: string }> = [];
    const logFn = (data: unknown, msg?: string) => { logs.push({ level: 'info', data, msg }); };
    return {
        logs,
        info: logFn,
        warn: logFn,
        error: logFn,
        debug: logFn,
    };
}

// --- Helper to build loop state ---

function makeState(overrides: Partial<UltrafixLoopState> = {}): UltrafixLoopState {
    return {
        ...createDefaultState({
            owner: 'acme',
            repo: 'web',
            pr: 42,
            goal: 7,
            maxCycles: 5,
        }),
        ...overrides,
    };
}

// --- Import the module under test ---
// Since continueUltrafixLoop depends on external services (octokit, issueQueue),
// we test the orchestration logic directly using the service functions.

describe('Ultrafix loop continuation logic', () => {
    let redis: ReturnType<typeof createMockRedis>;

    beforeEach(() => {
        redis = createMockRedis();
    });

    describe('review-success-stop: explicitly clean review', () => {
        test('determineNextAction returns null when the review is valid and clean', async () => {
            const { determineNextAction } = await import('../src/jobs/ultrafixOrchestrationService.js');
            const state = makeState({ lastAction: 'review', goal: 7 });
            const decision = determineNextAction(state, 7, 'valid_clean');
            assert.strictEqual(decision.action, null);
            assert.ok(decision.reason.includes('no actionable findings'));
        });

        test('determineNextAction returns fix when a passing review still has blockers', async () => {
            const { determineNextAction } = await import('../src/jobs/ultrafixOrchestrationService.js');
            const state = makeState({ lastAction: 'review', goal: 7 });
            const decision = determineNextAction(state, 9, 'valid_with_blockers');
            assert.strictEqual(decision.action, 'fix');
        });

        test('goal completion is persisted as a successful terminal state', async () => {
            const state = makeState({ lastAction: 'review', goal: 7 });
            await saveState(redis as any, state);

            const { determineNextAction } = await import('../src/jobs/ultrafixOrchestrationService.js');
            const decision = determineNextAction(state, 8, 'valid_clean');
            assert.strictEqual(decision.action, null);

            await completeLoop(redis as any, {
                owner: 'acme',
                repo: 'web',
                pr: 42,
                completionStatus: 'succeeded',
                completionReason: decision.reason,
                finalScore: 8,
            });
            const loaded = await loadState(redis as any, 'acme', 'web', 42);
            assert.ok(loaded);
            assert.strictEqual(loaded!.active, false);
            assert.strictEqual(loaded!.completionStatus, 'succeeded');
            assert.strictEqual(loaded!.finalScore, 8);
        });
    });

    describe('review-success-continue: score below goal', () => {
        test('clean review below goal stops without a fix and persists an unsuccessful completion', async () => {
            const state = makeState({ lastAction: 'review', goal: 10 });
            await saveState(redis as any, state);

            const decision = determineNextAction(state, 8, 'valid_clean');
            assert.strictEqual(decision.action, null);

            const goalReached = hasReviewReachedGoal('valid_clean', 8, state.goal);
            await completeLoop(redis as any, {
                owner: 'acme',
                repo: 'web',
                pr: 42,
                completionStatus: goalReached ? 'succeeded' : 'failed',
                completionReason: decision.reason,
                finalScore: 8,
            });

            const loaded = await loadState(redis as any, 'acme', 'web', 42);
            assert.ok(loaded);
            assert.strictEqual(loaded.active, false);
            assert.strictEqual(loaded.completionStatus, 'failed');
            assert.strictEqual(loaded.finalScore, 8);
            assert.match(loaded.completionReason!, /manual review/i);
        });

        test('determineNextAction returns fix when score is below goal', async () => {
            const { determineNextAction } = await import('../src/jobs/ultrafixOrchestrationService.js');
            const state = makeState({ lastAction: 'review', goal: 8 });
            const decision = determineNextAction(state, 5, 'valid_with_blockers');
            assert.strictEqual(decision.action, 'fix');
            assert.ok(decision.reason.includes('fix'));
        });

        test('determineNextAction returns fix when score is null', async () => {
            const { determineNextAction } = await import('../src/jobs/ultrafixOrchestrationService.js');
            const state = makeState({ lastAction: 'review', goal: 7 });
            const decision = determineNextAction(state, null, 'valid_with_blockers');
            assert.strictEqual(decision.action, 'fix');
        });
    });

    describe('fix-completion: schedules review', () => {
        test('determineNextAction returns review after fix', async () => {
            const { determineNextAction } = await import('../src/jobs/ultrafixOrchestrationService.js');
            const state = makeState({ lastAction: 'fix', cycleCount: 1 });
            const decision = determineNextAction(state, null);
            assert.strictEqual(decision.action, 'review');
            assert.ok(decision.reason.includes('review'));
        });

        test('recordAction increments cycleCount after fix', async () => {
            const { recordAction, startLoop } = await import('../src/jobs/ultrafixOrchestrationService.js');
            await startLoop(redis as any, { owner: 'acme', repo: 'web', pr: 42 }, false);
            await recordAction(redis as any, { owner: 'acme', repo: 'web', pr: 42, action: 'review' });

            const updated = await recordAction(redis as any, { owner: 'acme', repo: 'web', pr: 42, action: 'fix' });
            assert.ok(updated);
            assert.strictEqual(updated!.cycleCount, 1);
            assert.strictEqual(updated!.lastAction, 'fix');
        });

        test('recordAction does not increment cycleCount after review', async () => {
            const { recordAction, startLoop } = await import('../src/jobs/ultrafixOrchestrationService.js');
            await startLoop(redis as any, { owner: 'acme', repo: 'web', pr: 42 }, false);

            const updated = await recordAction(redis as any, { owner: 'acme', repo: 'web', pr: 42, action: 'review' });
            assert.ok(updated);
            assert.strictEqual(updated!.cycleCount, 0);
        });
    });

    describe('terminal conditions: state persisted', () => {
        test('failed terminal state is persisted when max cycles are reached', async () => {
            const { determineNextAction } = await import('../src/jobs/ultrafixOrchestrationService.js');
            const state = makeState({ lastAction: 'fix', cycleCount: 5, reviewCount: 5, fixCount: 5, maxCycles: 5 });
            await saveState(redis as any, state);

            const decision = determineNextAction(state, 4);
            assert.strictEqual(decision.action, null);
            assert.ok(decision.reason.includes('Max cycles'));

            await completeLoop(redis as any, {
                owner: 'acme',
                repo: 'web',
                pr: 42,
                completionStatus: 'failed',
                completionReason: decision.reason,
                finalScore: 4,
            });
            const loaded = await loadState(redis as any, 'acme', 'web', 42);
            assert.ok(loaded);
            assert.strictEqual(loaded!.active, false);
            assert.strictEqual(loaded!.completionStatus, 'failed');
            assert.strictEqual(loaded!.finalScore, 4);
        });

        test('inactive loop returns null action', async () => {
            const { determineNextAction } = await import('../src/jobs/ultrafixOrchestrationService.js');
            const state = makeState({ active: false });
            const decision = determineNextAction(state, 5);
            assert.strictEqual(decision.action, null);
            assert.ok(decision.reason.includes('inactive'));
        });
    });

    describe('label-based loop control', () => {
        test('loop stops when no active state exists', async () => {
            // No state in Redis means no continuation
            const loaded = await loadState(redis as any, 'acme', 'web', 42);
            assert.strictEqual(loaded, null);
        });

        test('clearState removes loop state completely', async () => {
            const state = makeState();
            await saveState(redis as any, state);

            // Simulate label removal → clear state
            await clearState(redis as any, 'acme', 'web', 42);
            const loaded = await loadState(redis as any, 'acme', 'web', 42);
            assert.strictEqual(loaded, null);
        });
    });

    describe('multi-cycle progression', () => {
        test('full cycle: review → fix → review with incrementing cycle count', async () => {
            const { recordAction, startLoop, determineNextAction } = await import('../src/jobs/ultrafixOrchestrationService.js');

            // Start with review
            const { state } = await startLoop(redis as any, { owner: 'acme', repo: 'web', pr: 42, goal: 8, maxCycles: 3 }, false);
            assert.strictEqual(state.lastAction, 'review');
            assert.strictEqual(state.cycleCount, 0);

            // After review completes, score is 5 → next is fix
            let decision = determineNextAction(state, 5, 'valid_with_blockers');
            assert.strictEqual(decision.action, 'fix');

            // Record fix
            await recordAction(redis as any, { owner: 'acme', repo: 'web', pr: 42, action: 'review' });
            let updated = await recordAction(redis as any, { owner: 'acme', repo: 'web', pr: 42, action: 'fix' });
            assert.strictEqual(updated!.cycleCount, 1);

            // After fix → next is review
            decision = determineNextAction(updated!, null);
            assert.strictEqual(decision.action, 'review');

            // Record review
            updated = await recordAction(redis as any, { owner: 'acme', repo: 'web', pr: 42, action: 'review' });
            assert.strictEqual(updated!.cycleCount, 1); // review doesn't increment

            // The next review is explicitly clean → success
            decision = determineNextAction(updated!, 8, 'valid_clean');
            assert.strictEqual(decision.action, null);
            assert.ok(decision.reason.includes('no actionable findings'));
        });

        test('stops at max cycles even if goal not met', async () => {
            const { recordAction, startLoop, determineNextAction } = await import('../src/jobs/ultrafixOrchestrationService.js');

            await startLoop(redis as any, { owner: 'acme', repo: 'web', pr: 42, goal: 9, maxCycles: 2 }, false);

            await recordAction(redis as any, { owner: 'acme', repo: 'web', pr: 42, action: 'review' });
            await recordAction(redis as any, { owner: 'acme', repo: 'web', pr: 42, action: 'fix' });
            await recordAction(redis as any, { owner: 'acme', repo: 'web', pr: 42, action: 'review' });
            const afterCycle2 = await recordAction(redis as any, { owner: 'acme', repo: 'web', pr: 42, action: 'fix' });
            assert.strictEqual(afterCycle2!.cycleCount, 2);

            const decision = determineNextAction(afterCycle2!, 5);
            assert.strictEqual(decision.action, null);
            assert.ok(decision.reason.includes('Max cycles'));
        });

        test('max cycle limit allows five review and five fix steps', async () => {
            const { recordAction, startLoop, determineNextAction } = await import('../src/jobs/ultrafixOrchestrationService.js');

            await startLoop(redis as any, { owner: 'acme', repo: 'web', pr: 42, goal: 10, maxCycles: 5 }, false);

            let stepCount = 1; // initial review is enqueued by startLoop
            let action: 'review' | 'fix' = 'review';
            let updated = await loadState(redis as any, 'acme', 'web', 42);

            while (updated && stepCount < 10) {
                updated = await recordAction(redis as any, { owner: 'acme', repo: 'web', pr: 42, action });
                const decision = determineNextAction(
                    updated!,
                    action === 'review' ? 1 : null,
                    action === 'review' ? 'valid_with_blockers' : 'invalid',
                );
                assert.notStrictEqual(decision.action, null, `loop stopped early after ${stepCount} steps`);
                action = decision.action!;
                stepCount += 1;
            }

            updated = await recordAction(redis as any, { owner: 'acme', repo: 'web', pr: 42, action });
            const finalDecision = determineNextAction(
                updated!,
                action === 'review' ? 1 : null,
                action === 'review' ? 'valid_with_blockers' : 'invalid',
            );
            assert.strictEqual(stepCount, 10);
            assert.strictEqual(updated!.reviewCount, 5);
            assert.strictEqual(updated!.fixCount, 5);
            assert.strictEqual(updated!.cycleCount, 5);
            assert.strictEqual(finalDecision.action, null);
            assert.ok(finalDecision.reason.includes('Max cycles'));
        });
    });
});

describe('claimed deferred continuation cancellation', () => {
    let redis: ReturnType<typeof createMockRedis>;
    const logger = {
        info: mock.fn(),
        warn: mock.fn(),
        error: mock.fn(),
        debug: mock.fn(),
    };

    beforeEach(() => {
        redis = createMockRedis();
        enqueueNextStep.mock.resetCalls();
        evaluateReadiness.mock.resetCalls();
    });

    function pauseReadiness() {
        let markClaimed!: () => void;
        let release!: (readiness: { ready: boolean; reasons: string[] }) => void;
        const claimed = new Promise<void>((resolve) => { markClaimed = resolve; });
        const readiness = new Promise<{ ready: boolean; reasons: string[] }>((resolve) => { release = resolve; });
        evaluateReadiness.mock.mockImplementationOnce(async () => {
            markClaimed();
            return readiness;
        });
        return { claimed, release };
    }

    async function seedDeferredLoop() {
        await startLoop(redis as never, {
            owner: 'acme', repo: 'web', pr: 42, pauseSeconds: 1,
        }, false);
        await saveDeferredContinuation(redis as never, {
            owner: 'acme', repo: 'web', pr: 42,
            nextAction: 'review',
            savedAt: new Date().toISOString(),
            reason: 'checks_not_passing',
        });
    }

    test('manual takeover prevents a claimed continuation from enqueueing', async () => {
        await seedDeferredLoop();
        const gate = pauseReadiness();
        const resumed = resumeDeferredContinuation(
            { owner: 'acme', repo: 'web', pr: 42 },
            redis as never,
            logger as never,
        );

        await gate.claimed;
        await clearDeferredContinuation(redis as never, 'acme', 'web', 42);
        gate.release({ ready: true, reasons: [] });

        const result = await resumed;
        assert.strictEqual(result.reason, 'deferred_cancelled');
        assert.strictEqual(enqueueNextStep.mock.callCount(), 0);
        assert.strictEqual(await loadDeferredContinuation(redis as never, 'acme', 'web', 42), null);
    });

    test('fresh loop startup prevents a claimed continuation from being re-saved', async () => {
        await seedDeferredLoop();
        const gate = pauseReadiness();
        const resumed = resumeDeferredContinuation(
            { owner: 'acme', repo: 'web', pr: 42 },
            redis as never,
            logger as never,
        );

        await gate.claimed;
        await startLoop(redis as never, {
            owner: 'acme', repo: 'web', pr: 42, goal: 9,
        }, false);
        gate.release({ ready: false, reasons: ['checks_not_passing'] });

        const result = await resumed;
        assert.strictEqual(result.reason, 'deferred_cancelled');
        assert.strictEqual(enqueueNextStep.mock.callCount(), 0);
        assert.strictEqual(await loadDeferredContinuation(redis as never, 'acme', 'web', 42), null);
        assert.strictEqual((await loadState(redis as never, 'acme', 'web', 42))?.goal, 9);
    });
});

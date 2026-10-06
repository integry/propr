import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
    isCooldownElapsed,
    hasFollowUpJobsForPR,
    hasPendingBatchedComments,
    checkReadiness,
    saveDeferredContinuation,
    loadDeferredContinuation,
    claimDeferredContinuation,
    clearDeferredContinuation,
    clearDeferredContinuationIfCurrent,
    getUltrafixDeferredKey,
    getUltrafixAutomaticWorkEpoch,
    getUltrafixStateKey,
    hasUltrafixAutomaticWork,
    invalidateUltrafixAutomaticWork,
    invalidateUltrafixAutomaticWorkForComment,
    isUltrafixAutomaticWorkCurrent,
    parseDeferredKey,
    createDefaultState,
    areChecksReadyForUltrafix,
    getActionCounts,
    loadState,
    saveState,
    type UltrafixLoopState,
    type UltrafixDeferredContinuation,
} from '../src/jobs/ultrafixOrchestrationService.js';
import {
    acquireResumeClaim,
    releaseResumeClaim,
    getUltrafixResumeClaimKey,
    evaluateStrandedLoopRearm,
    loadStateSnapshot,
    syncStateWorkEpoch,
} from '../src/jobs/ultrafixStrandedLoopRearm.js';
import { requiresPassingChecks } from '../src/jobs/ultrafixReadinessPolicy.js';

// --- Mock Redis ---

function createMockRedis() {
    const store = new Map<string, string>();
    const lists = new Map<string, string[]>();
    const expiresAt = new Map<string, number>();
    const expire = (key: string) => {
        const deadline = expiresAt.get(key);
        if (deadline !== undefined && deadline <= Date.now()) {
            store.delete(key);
            expiresAt.delete(key);
        }
    };
    return {
        store,
        lists,
        expiresAt,
        async get(key: string) { expire(key); return store.get(key) ?? null; },
        // Supports plain SET and `SET key value PX <ms> NX`.
        async set(key: string, value: string, ...options: Array<string | number>) {
            expire(key);
            if (options.includes('NX') && store.has(key)) return null;
            store.set(key, value);
            const pxIndex = options.indexOf('PX');
            if (pxIndex >= 0) expiresAt.set(key, Date.now() + Number(options[pxIndex + 1]));
            else expiresAt.delete(key);
            return 'OK';
        },
        async del(key: string) { store.delete(key); lists.delete(key); expiresAt.delete(key); return 1; },
        async getdel(key: string) {
            const value = store.get(key) ?? null;
            store.delete(key);
            return value;
        },
        async eval(script: string, _keyCount: number, ...args: string[]) {
            const [epochKey, deferredKey] = args;
            if (script.includes("redis.call('DEL', KEYS[1])")) {
                // Compare-and-delete release of a token-owned claim.
                const [claimKey, token] = args;
                expire(claimKey);
                if (store.get(claimKey) !== token) return 0;
                store.delete(claimKey);
                expiresAt.delete(claimKey);
                return 1;
            }
            if (script.includes('local current_state')) {
                // Epoch- and snapshot-conditional state replace/clear.
                const [, stateKey, expectedEpoch, expectedState, value] = args;
                if ((store.get(epochKey) ?? '0') !== expectedEpoch) return 0;
                if (store.get(stateKey) !== expectedState) return 0;
                if (script.includes("redis.call('DEL', KEYS[2])")) store.delete(stateKey);
                else store.set(stateKey, value);
                return 1;
            }
            if (script.includes("local existing = redis.call('GET', KEYS[4])")) {
                const [, , stateKey, takeoverKey, ttl] = args;
                const existing = store.get(takeoverKey);
                if (existing) return existing.split(':').map(Number);

                const currentEpoch = Number(store.get(epochKey) ?? '0');
                const rawState = store.get(stateKey);
                let hadAutomaticWork = store.has(deferredKey);
                if (!hadAutomaticWork && rawState) {
                    try {
                        const state = JSON.parse(rawState) as { active?: unknown; workEpoch?: unknown };
                        const stateEpoch = typeof state.workEpoch === 'number' ? state.workEpoch : 0;
                        hadAutomaticWork = state.active === true && stateEpoch === currentEpoch;
                    } catch {
                        hadAutomaticWork = currentEpoch === 0;
                    }
                }

                const nextEpoch = currentEpoch + 1;
                store.set(epochKey, String(nextEpoch));
                store.delete(deferredKey);
                store.set(takeoverKey, `${nextEpoch}:${hadAutomaticWork ? 1 : 0}`);
                assert.strictEqual(ttl, String(24 * 60 * 60));
                return [nextEpoch, hadAutomaticWork ? 1 : 0];
            }
            if (script.includes("redis.call('INCR'")) {
                const nextEpoch = Number(store.get(epochKey) ?? '0') + 1;
                store.set(epochKey, String(nextEpoch));
                store.delete(deferredKey);
                return nextEpoch;
            }
            if ((store.get(epochKey) ?? '0') !== args[2]) return 0;
            if (script.includes("redis.call('DEL', KEYS[2])")) {
                store.delete(deferredKey);
                return 1;
            }
            store.set(deferredKey, args[3]);
            return 1;
        },
        async llen(key: string) { return (lists.get(key) ?? []).length; },
        async lpush(key: string, ...values: string[]) {
            if (!lists.has(key)) lists.set(key, []);
            lists.get(key)!.unshift(...values);
            return lists.get(key)!.length;
        },
        async lrange(key: string, start: number, stop: number) {
            const list = lists.get(key) ?? [];
            return list.slice(start, stop === -1 ? undefined : stop + 1);
        },
    };
}

function makeState(overrides: Partial<UltrafixLoopState> = {}): UltrafixLoopState {
    return {
        ...createDefaultState({ owner: 'acme', repo: 'web', pr: 42, goal: 7, maxCycles: 5 }),
        ...overrides,
    };
}

// --- isCooldownElapsed ---

describe('isCooldownElapsed', () => {
    test('returns true when no lastActionTimestamp', () => {
        const state = makeState({ lastActionTimestamp: null, pauseSeconds: 60 });
        assert.strictEqual(isCooldownElapsed(state), true);
    });

    test('returns true when enough time has passed', () => {
        const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
        const state = makeState({ lastActionTimestamp: twoMinAgo, pauseSeconds: 60 });
        assert.strictEqual(isCooldownElapsed(state), true);
    });

    test('returns false when cooldown has not elapsed', () => {
        const tenSecsAgo = new Date(Date.now() - 10_000).toISOString();
        const state = makeState({ lastActionTimestamp: tenSecsAgo, pauseSeconds: 60 });
        assert.strictEqual(isCooldownElapsed(state), false);
    });

    test('respects custom nowMs parameter', () => {
        const timestamp = '2026-04-28T12:00:00Z';
        const state = makeState({ lastActionTimestamp: timestamp, pauseSeconds: 60 });
        const nowMs = new Date('2026-04-28T12:00:30Z').getTime(); // 30s later
        assert.strictEqual(isCooldownElapsed(state, nowMs), false);

        const laterMs = new Date('2026-04-28T12:01:01Z').getTime(); // 61s later
        assert.strictEqual(isCooldownElapsed(state, laterMs), true);
    });
});

// --- areChecksReadyForUltrafix ---

describe('areChecksReadyForUltrafix', () => {
    test('treats zero configured checks as ready instead of waiting forever', () => {
        const result = areChecksReadyForUltrafix({
            count: 0,
            allPassing: true,
            anyPending: false,
            anyFailed: false,
        });

        assert.strictEqual(result, true);
    });
});

describe('action-aware CI readiness', () => {
    test('requires passing checks only for the concrete review action', () => {
        assert.strictEqual(requiresPassingChecks('fix'), false);
        assert.strictEqual(requiresPassingChecks('review'), true);
    });
});

// --- hasFollowUpJobsForPR ---

describe('hasFollowUpJobsForPR', () => {
    test('returns false when queue is empty', async () => {
        const result = await hasFollowUpJobsForPR('acme', 'web', 42, async () => []);
        assert.strictEqual(result, false);
    });

    test('returns true when matching ultrafix job exists', async () => {
        const jobs = [
            { data: { repoOwner: 'acme', repoName: 'web', pullRequestNumber: 42, ultrafixMeta: { goal: 7 } } },
        ];
        const result = await hasFollowUpJobsForPR('acme', 'web', 42, async () => jobs);
        assert.strictEqual(result, true);
    });

    test('returns false when matching job exists but is not ultrafix', async () => {
        const jobs = [
            { data: { repoOwner: 'acme', repoName: 'web', pullRequestNumber: 42 } },
        ];
        const result = await hasFollowUpJobsForPR('acme', 'web', 42, async () => jobs);
        assert.strictEqual(result, false);
    });

    test('returns false when ultrafix jobs are for different PR', async () => {
        const jobs = [
            { data: { repoOwner: 'acme', repoName: 'web', pullRequestNumber: 99, ultrafixMeta: { goal: 7 } } },
        ];
        const result = await hasFollowUpJobsForPR('acme', 'web', 42, async () => jobs);
        assert.strictEqual(result, false);
    });

    test('returns false when ultrafix jobs are for different repo', async () => {
        const jobs = [
            { data: { repoOwner: 'other', repoName: 'web', pullRequestNumber: 42, ultrafixMeta: { goal: 7 } } },
        ];
        const result = await hasFollowUpJobsForPR('acme', 'web', 42, async () => jobs);
        assert.strictEqual(result, false);
    });
});

// --- hasPendingBatchedComments ---

describe('hasPendingBatchedComments', () => {
    test('returns false when no pending comments', async () => {
        const redis = createMockRedis();
        const result = await hasPendingBatchedComments(redis as any, 'pending-pr-comments:acme:web:42');
        assert.strictEqual(result, false);
    });

    test('returns true when pending comments exist', async () => {
        const redis = createMockRedis();
        await redis.lpush('pending-pr-comments:acme:web:42', '{"id":1}');
        const result = await hasPendingBatchedComments(redis as any, 'pending-pr-comments:acme:web:42');
        assert.strictEqual(result, true);
    });
});

// --- checkReadiness ---

describe('checkReadiness', () => {
    test('returns ready when all conditions pass', () => {
        const result = checkReadiness({
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });
        assert.strictEqual(result.ready, true);
        assert.strictEqual(result.reasons.length, 0);
    });

    test('returns not ready when checks not passing', () => {
        const result = checkReadiness({
            allChecksPassing: false,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });
        assert.strictEqual(result.ready, false);
        assert.ok(result.reasons.includes('checks_not_passing'));
    });

    test('returns not ready when follow-up jobs exist', () => {
        const result = checkReadiness({
            allChecksPassing: true,
            hasFollowUpJobs: true,
            hasPendingComments: false,
        });
        assert.strictEqual(result.ready, false);
        assert.ok(result.reasons.includes('follow_up_jobs_active'));
    });

    test('returns not ready when pending comments exist', () => {
        const result = checkReadiness({
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: true,
        });
        assert.strictEqual(result.ready, false);
        assert.ok(result.reasons.includes('pending_comments_exist'));
    });

    test('aggregates multiple blocking reasons', () => {
        const result = checkReadiness({
            allChecksPassing: false,
            hasFollowUpJobs: true,
            hasPendingComments: true,
        });
        assert.strictEqual(result.ready, false);
        assert.strictEqual(result.reasons.length, 3);
    });
});

// --- Deferred continuation persistence ---

describe('deferred continuation persistence', () => {
    let redis: ReturnType<typeof createMockRedis>;

    beforeEach(() => {
        redis = createMockRedis();
    });

    test('getUltrafixDeferredKey produces expected format', () => {
        assert.strictEqual(
            getUltrafixDeferredKey('acme', 'web', 42),
            'ultrafix:deferred:acme:web:42',
        );
    });

    test('save and load round-trips deferred continuation', async () => {
        const deferred: UltrafixDeferredContinuation = {
            owner: 'acme',
            repo: 'web',
            pr: 42,
            nextAction: 'review',
            savedAt: '2026-04-28T20:00:00Z',
            reason: 'checks_not_passing',
        };
        await saveDeferredContinuation(redis as any, deferred);
        const loaded = await loadDeferredContinuation(redis as any, 'acme', 'web', 42);
        assert.deepStrictEqual(loaded, deferred);
    });

    test('loadDeferredContinuation returns null when not present', async () => {
        const loaded = await loadDeferredContinuation(redis as any, 'no', 'exist', 1);
        assert.strictEqual(loaded, null);
    });

    test('clearDeferredContinuation removes the record', async () => {
        const deferred: UltrafixDeferredContinuation = {
            owner: 'acme',
            repo: 'web',
            pr: 42,
            nextAction: 'fix',
            savedAt: '2026-04-28T20:00:00Z',
            reason: 'cooldown_not_elapsed',
        };
        await saveDeferredContinuation(redis as any, deferred);
        await clearDeferredContinuation(redis as any, 'acme', 'web', 42);
        const loaded = await loadDeferredContinuation(redis as any, 'acme', 'web', 42);
        assert.strictEqual(loaded, null);
    });

    test('manual invalidation atomically advances the epoch and removes deferred work', async () => {
        await saveDeferredContinuation(redis as any, {
            owner: 'acme', repo: 'web', pr: 42,
            nextAction: 'fix', savedAt: new Date().toISOString(), reason: 'checks_not_passing',
            workEpoch: 0,
        });

        const epoch = await invalidateUltrafixAutomaticWork(redis as any, 'acme', 'web', 42);

        assert.strictEqual(epoch, 1);
        assert.strictEqual(await getUltrafixAutomaticWorkEpoch(redis as any, 'acme', 'web', 42), 1);
        assert.strictEqual(await loadDeferredContinuation(redis as any, 'acme', 'web', 42), null);
        assert.strictEqual(
            await isUltrafixAutomaticWorkCurrent(redis as any, { owner: 'acme', repo: 'web', pr: 42 }, 0),
            false,
        );
    });

    test('manual invalidation is idempotent per comment revision and a later edit fences newer automatic work', async () => {
        const stateKey = getUltrafixStateKey('acme', 'web', 42);
        await redis.set(stateKey, JSON.stringify({ active: true, workEpoch: 0 }));

        const identity = { owner: 'acme', repo: 'web', pr: 42, sourceCommentId: 9876, sourceCommentRevision: '2026-08-09T10:00:00Z' };
        const first = await invalidateUltrafixAutomaticWorkForComment(redis as any, identity);
        // Simulate the old worker persisting stale state before webhook redelivery.
        await redis.set(stateKey, JSON.stringify({ active: true, workEpoch: 0 }));
        const redelivery = await invalidateUltrafixAutomaticWorkForComment(redis as any, identity);

        assert.deepStrictEqual(first, { workEpoch: 1, hadAutomaticWork: true });
        assert.deepStrictEqual(redelivery, first);
        assert.strictEqual(await getUltrafixAutomaticWorkEpoch(redis as any, 'acme', 'web', 42), 1);

        // A new loop can start after the original command. Editing that same
        // GitHub comment is a new accepted command revision and must fence it.
        await redis.set(stateKey, JSON.stringify({ active: true, workEpoch: 1 }));
        const editedIdentity = { ...identity, sourceCommentRevision: '2026-08-09T10:05:00Z' };
        const edited = await invalidateUltrafixAutomaticWorkForComment(redis as any, editedIdentity);
        const editedRedelivery = await invalidateUltrafixAutomaticWorkForComment(redis as any, editedIdentity);

        assert.deepStrictEqual(edited, { workEpoch: 2, hadAutomaticWork: true });
        assert.deepStrictEqual(editedRedelivery, edited);
        assert.strictEqual(await getUltrafixAutomaticWorkEpoch(redis as any, 'acme', 'web', 42), 2);
    });

    test('automatic work detection covers active state and deferred transitions', async () => {
        assert.strictEqual(await hasUltrafixAutomaticWork(redis as any, 'acme', 'web', 42), false);

        await redis.set(getUltrafixStateKey('acme', 'web', 42), JSON.stringify({ active: true, workEpoch: 0 }));
        assert.strictEqual(await hasUltrafixAutomaticWork(redis as any, 'acme', 'web', 42), true);

        await redis.set(getUltrafixStateKey('acme', 'web', 42), JSON.stringify({ active: false }));
        await saveDeferredContinuation(redis as any, {
            owner: 'acme', repo: 'web', pr: 42,
            nextAction: 'review', savedAt: new Date().toISOString(), reason: 'checks_not_passing',
            workEpoch: 0,
        });
        assert.strictEqual(await hasUltrafixAutomaticWork(redis as any, 'acme', 'web', 42), true);
    });

    test('manual takeover makes stale active state invisible to later commands', async () => {
        const stateKey = getUltrafixStateKey('acme', 'web', 42);
        await redis.set(stateKey, JSON.stringify({ active: true, workEpoch: 0 }));
        assert.strictEqual(await hasUltrafixAutomaticWork(redis as any, 'acme', 'web', 42), true);

        await invalidateUltrafixAutomaticWork(redis as any, 'acme', 'web', 42);
        // A superseded worker may persist its old state again after takeover.
        await redis.set(stateKey, JSON.stringify({ active: true, workEpoch: 0 }));

        assert.strictEqual(await hasUltrafixAutomaticWork(redis as any, 'acme', 'web', 42), false);
    });

    test('a superseded action cannot restore its deferred record', async () => {
        await invalidateUltrafixAutomaticWork(redis as any, 'acme', 'web', 42);

        const staleSaved = await saveDeferredContinuation(redis as any, {
            owner: 'acme', repo: 'web', pr: 42,
            nextAction: 'fix', savedAt: new Date().toISOString(), reason: 'stale_action',
            workEpoch: 0,
        });
        const currentSaved = await saveDeferredContinuation(redis as any, {
            owner: 'acme', repo: 'web', pr: 42,
            nextAction: 'review', savedAt: new Date().toISOString(), reason: 'current_action',
            workEpoch: 1,
        });

        assert.strictEqual(staleSaved, false);
        assert.strictEqual(currentSaved, true);
        assert.strictEqual(
            (await loadDeferredContinuation(redis as any, 'acme', 'web', 42))?.nextAction,
            'review',
        );
    });

    test('a stale continuation cannot delete deferred work from a newer epoch', async () => {
        assert.strictEqual(
            await isUltrafixAutomaticWorkCurrent(
                redis as any,
                { owner: 'acme', repo: 'web', pr: 42 },
                0,
            ),
            true,
        );
        await invalidateUltrafixAutomaticWork(redis as any, 'acme', 'web', 42);
        await saveDeferredContinuation(redis as any, {
            owner: 'acme', repo: 'web', pr: 42,
            nextAction: 'review', savedAt: new Date().toISOString(), reason: 'new_epoch',
            workEpoch: 1,
        });

        const cleared = await clearDeferredContinuationIfCurrent(
            redis as any,
            { owner: 'acme', repo: 'web', pr: 42 },
            0,
        );

        assert.strictEqual(cleared, false);
        assert.strictEqual(
            (await loadDeferredContinuation(redis as any, 'acme', 'web', 42))?.reason,
            'new_epoch',
        );
    });

    test('manual takeover fences a continuation that already claimed deferred work', async () => {
        await saveDeferredContinuation(redis as any, {
            owner: 'acme', repo: 'web', pr: 42,
            nextAction: 'fix', savedAt: new Date().toISOString(), reason: 'checks_not_passing',
            workEpoch: 0,
        });
        const claimed = await claimDeferredContinuation(redis as any, 'acme', 'web', 42);
        assert.ok(claimed);

        await invalidateUltrafixAutomaticWork(redis as any, 'acme', 'web', 42);

        assert.strictEqual(
            await isUltrafixAutomaticWorkCurrent(redis as any, { owner: 'acme', repo: 'web', pr: 42 }, claimed.workEpoch),
            false,
        );
        assert.strictEqual(await saveDeferredContinuation(redis as any, claimed), false);
        assert.strictEqual(await loadDeferredContinuation(redis as any, 'acme', 'web', 42), null);
    });
});

// --- Behavioral: defer when checks red, resume when green ---

describe('defer and resume behavior', () => {
    let redis: ReturnType<typeof createMockRedis>;

    beforeEach(() => {
        redis = createMockRedis();
    });

    test('checkReadiness blocks when checks are not passing', () => {
        const result = checkReadiness({
            allChecksPassing: false,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });
        assert.strictEqual(result.ready, false);
        assert.ok(result.reasons.includes('checks_not_passing'));
    });

    test('checkReadiness allows progression when checks turn green', () => {
        const result = checkReadiness({
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });
        assert.strictEqual(result.ready, true);
        assert.strictEqual(result.reasons.length, 0);
    });

    test('deferred continuation is saved and can be loaded for resume', async () => {
        // Simulate: checks red → defer
        const deferred: UltrafixDeferredContinuation = {
            owner: 'acme',
            repo: 'web',
            pr: 42,
            nextAction: 'fix',
            savedAt: new Date().toISOString(),
            reason: 'checks_not_passing',
        };
        await saveDeferredContinuation(redis as any, deferred);

        // Later: check_run fires → load deferred
        const loaded = await loadDeferredContinuation(redis as any, 'acme', 'web', 42);
        assert.ok(loaded);
        assert.strictEqual(loaded!.nextAction, 'fix');
        assert.strictEqual(loaded!.reason, 'checks_not_passing');
    });

    test('resume clears deferred record after successful wake', async () => {
        const deferred: UltrafixDeferredContinuation = {
            owner: 'acme',
            repo: 'web',
            pr: 42,
            nextAction: 'review',
            savedAt: new Date().toISOString(),
            reason: 'checks_not_passing',
        };
        await saveDeferredContinuation(redis as any, deferred);

        // Simulate: checks now green → readiness passes → clear deferred
        const readiness = checkReadiness({
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });
        assert.strictEqual(readiness.ready, true);

        await clearDeferredContinuation(redis as any, 'acme', 'web', 42);
        const afterClear = await loadDeferredContinuation(redis as any, 'acme', 'web', 42);
        assert.strictEqual(afterClear, null);
    });

    test('resume keeps deferred record when still not ready', async () => {
        const deferred: UltrafixDeferredContinuation = {
            owner: 'acme',
            repo: 'web',
            pr: 42,
            nextAction: 'fix',
            savedAt: new Date().toISOString(),
            reason: 'checks_not_passing, follow_up_jobs_active',
        };
        await saveDeferredContinuation(redis as any, deferred);

        // checks_run fires but follow-up jobs still active
        const readiness = checkReadiness({
            allChecksPassing: true,
            hasFollowUpJobs: true,
            hasPendingComments: false,
        });
        assert.strictEqual(readiness.ready, false);

        // Deferred record should stay
        const loaded = await loadDeferredContinuation(redis as any, 'acme', 'web', 42);
        assert.ok(loaded);
        assert.strictEqual(loaded!.nextAction, 'fix');
    });

    test('no overlap: blocks when competing ultrafix job exists', () => {
        const result = checkReadiness({
            allChecksPassing: true,
            hasFollowUpJobs: true,
            hasPendingComments: false,
        });
        assert.strictEqual(result.ready, false);
        assert.ok(result.reasons.includes('follow_up_jobs_active'));
    });

    test('cooldown is not a readiness condition (handled by enqueue delay)', () => {
        // checkReadiness does not accept cooldownElapsed — verify the API
        const result = checkReadiness({
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });
        assert.strictEqual(result.ready, true);
        // No 'cooldown_not_elapsed' reason possible
        assert.ok(!result.reasons.includes('cooldown_not_elapsed'));
    });
});

// --- parseDeferredKey ---

describe('parseDeferredKey', () => {
    test('parses a valid key', () => {
        const result = parseDeferredKey('ultrafix:deferred:acme:web:42');
        assert.deepStrictEqual(result, { owner: 'acme', repo: 'web', pr: 42 });
    });

    test('returns null for invalid key format', () => {
        assert.strictEqual(parseDeferredKey('other:key:format'), null);
    });

    test('returns null for key with too few parts', () => {
        assert.strictEqual(parseDeferredKey('ultrafix:deferred:acme'), null);
    });

    test('returns null for key with non-numeric PR', () => {
        assert.strictEqual(parseDeferredKey('ultrafix:deferred:acme:web:notanumber'), null);
    });
});

// --- Resume claim ---

describe('resume claim', () => {
    let redis: ReturnType<typeof createMockRedis>;

    beforeEach(() => {
        redis = createMockRedis();
    });

    test('only one concurrent trigger acquires the claim', async () => {
        const results = await Promise.all([
            acquireResumeClaim(redis as any, { owner: 'acme', repo: 'web', pr: 42 }, 'token-a', 60_000),
            acquireResumeClaim(redis as any, { owner: 'acme', repo: 'web', pr: 42 }, 'token-b', 60_000),
        ]);

        assert.deepStrictEqual(results, [true, false]);
        assert.strictEqual(redis.store.get(getUltrafixResumeClaimKey('acme', 'web', 42)), 'token-a');
        assert.ok(redis.expiresAt.has(getUltrafixResumeClaimKey('acme', 'web', 42)), 'claim carries a TTL');
    });

    test('claims are scoped per pull request', async () => {
        assert.strictEqual(await acquireResumeClaim(redis as any, { owner: 'acme', repo: 'web', pr: 42 }, 'token-a', 60_000), true);
        assert.strictEqual(await acquireResumeClaim(redis as any, { owner: 'acme', repo: 'web', pr: 43 }, 'token-b', 60_000), true);
    });

    test('release only removes a claim held by the same token', async () => {
        await acquireResumeClaim(redis as any, { owner: 'acme', repo: 'web', pr: 42 }, 'token-a', 60_000);

        assert.strictEqual(await releaseResumeClaim(redis as any, { owner: 'acme', repo: 'web', pr: 42 }, 'token-b'), false);
        assert.strictEqual(await acquireResumeClaim(redis as any, { owner: 'acme', repo: 'web', pr: 42 }, 'token-b', 60_000), false);

        assert.strictEqual(await releaseResumeClaim(redis as any, { owner: 'acme', repo: 'web', pr: 42 }, 'token-a'), true);
        assert.strictEqual(await acquireResumeClaim(redis as any, { owner: 'acme', repo: 'web', pr: 42 }, 'token-b', 60_000), true);
    });

    test('an expired claim from a crashed holder can be re-acquired', async () => {
        await acquireResumeClaim(redis as any, { owner: 'acme', repo: 'web', pr: 42 }, 'token-a', 60_000);
        redis.expiresAt.set(getUltrafixResumeClaimKey('acme', 'web', 42), Date.now() - 1);

        assert.strictEqual(await acquireResumeClaim(redis as any, { owner: 'acme', repo: 'web', pr: 42 }, 'token-b', 60_000), true);
        // The crashed holder can no longer release the new owner's claim.
        assert.strictEqual(await releaseResumeClaim(redis as any, { owner: 'acme', repo: 'web', pr: 42 }, 'token-a'), false);
    });
});

// --- Stranded loop re-arming gate ---

describe('stranded loop re-arming gate', () => {
    test('does not resume a missing or inactive loop', () => {
        assert.deepStrictEqual(evaluateStrandedLoopRearm(null), { action: 'skip', reason: 'no_active_loop' });
        assert.deepStrictEqual(
            evaluateStrandedLoopRearm(makeState({ active: false })),
            { action: 'skip', reason: 'no_active_loop' },
        );
    });

    test('re-arms an active loop within its cycle budget', () => {
        const state = makeState({ lastAction: 'fix', reviewCount: 2, fixCount: 2, cycleCount: 2 });
        assert.deepStrictEqual(evaluateStrandedLoopRearm(state), { action: 'rearm' });
    });

    test('completes as failed once reviews reach maxCycles', () => {
        const decision = evaluateStrandedLoopRearm(makeState({ lastAction: 'fix', reviewCount: 5, fixCount: 4 }));
        assert.strictEqual(decision.action, 'complete');
        assert.strictEqual(decision.action === 'complete' && decision.completionStatus, 'failed');
    });

    test('completes as failed once fixes reach maxCycles', () => {
        const decision = evaluateStrandedLoopRearm(makeState({ lastAction: 'fix', reviewCount: 4, fixCount: 5 }));
        assert.strictEqual(decision.action === 'complete' && decision.completionStatus, 'failed');
    });

    test('derives legacy action counts when enforcing maxCycles', () => {
        const legacy = makeState({ lastAction: 'review', cycleCount: 4 }) as Partial<UltrafixLoopState>;
        delete legacy.reviewCount;
        delete legacy.fixCount;
        assert.deepStrictEqual(getActionCounts(legacy as UltrafixLoopState), { reviewCount: 5, fixCount: 4 });
        const decision = evaluateStrandedLoopRearm(legacy as UltrafixLoopState);
        assert.strictEqual(decision.action === 'complete' && decision.completionStatus, 'failed');
    });

    test('completes as succeeded when the goal was already reached', () => {
        const decision = evaluateStrandedLoopRearm(makeState({ finalScore: 8, goal: 7, reviewCount: 1 }));
        assert.strictEqual(decision.action === 'complete' && decision.completionStatus, 'succeeded');
    });

    test('a reached goal takes precedence over an exhausted cycle budget', () => {
        const decision = evaluateStrandedLoopRearm(makeState({ finalScore: 7, goal: 7, reviewCount: 5, fixCount: 5 }));
        assert.strictEqual(decision.action === 'complete' && decision.completionStatus, 'succeeded');
    });

    test('a score below the goal does not stop the loop', () => {
        assert.deepStrictEqual(evaluateStrandedLoopRearm(makeState({ finalScore: 6, goal: 7 })), { action: 'rearm' });
    });
});

describe('stranded loop work epoch sync', () => {
    let redis: ReturnType<typeof createMockRedis>;

    beforeEach(() => {
        redis = createMockRedis();
    });

    test('hands a loop fenced by a follow-up to the current epoch', async () => {
        await saveState(redis as any, makeState({ workEpoch: 0 }));
        const epoch = await invalidateUltrafixAutomaticWork(redis as any, 'acme', 'web', 42);
        const stale = await loadStateSnapshot(redis as any, 'acme', 'web', 42);

        const synced = await syncStateWorkEpoch(redis as any, stale!, epoch);

        assert.strictEqual(synced?.workEpoch, 1);
        assert.strictEqual((await loadState(redis as any, 'acme', 'web', 42))?.workEpoch, 1);
        assert.strictEqual(await hasUltrafixAutomaticWork(redis as any, 'acme', 'web', 42), true);
    });

    test('cannot claim an epoch that was superseded in the meantime', async () => {
        await saveState(redis as any, makeState({ workEpoch: 0 }));
        await invalidateUltrafixAutomaticWork(redis as any, 'acme', 'web', 42);
        const stale = await loadStateSnapshot(redis as any, 'acme', 'web', 42);
        await invalidateUltrafixAutomaticWork(redis as any, 'acme', 'web', 42);

        assert.strictEqual(await syncStateWorkEpoch(redis as any, stale!, 1), null);
        assert.strictEqual((await loadState(redis as any, 'acme', 'web', 42))?.workEpoch, 0);
    });

    test('an older snapshot cannot replace a newer loop that took the current epoch', async () => {
        await saveState(redis as any, makeState({ workEpoch: 0, reviewCount: 5, fixCount: 5, cycleCount: 5 }));
        const stale = await loadStateSnapshot(redis as any, 'acme', 'web', 42);
        // A new loop starts after the snapshot was read: it reserves the next
        // epoch and commits fresh state before the stale caller reads the epoch.
        const epoch = await invalidateUltrafixAutomaticWork(redis as any, 'acme', 'web', 42);
        await saveState(redis as any, makeState({ workEpoch: epoch, reviewCount: 0, fixCount: 0, goal: 9 }));

        assert.strictEqual(await syncStateWorkEpoch(redis as any, stale!, epoch), null);
        const current = await loadState(redis as any, 'acme', 'web', 42);
        assert.strictEqual(current?.reviewCount, 0);
        assert.strictEqual(current?.goal, 9);
    });

    test('rejects a same-epoch update or deletion made after the snapshot was read', async () => {
        await saveState(redis as any, makeState({ workEpoch: 0 }));
        const epoch = await invalidateUltrafixAutomaticWork(redis as any, 'acme', 'web', 42);
        const stale = await loadStateSnapshot(redis as any, 'acme', 'web', 42);
        await saveState(redis as any, makeState({ workEpoch: 0, active: false }));

        assert.strictEqual(await syncStateWorkEpoch(redis as any, stale!, epoch), null);
        assert.strictEqual((await loadState(redis as any, 'acme', 'web', 42))?.active, false);

        await redis.del(getUltrafixStateKey('acme', 'web', 42));
        assert.strictEqual(await syncStateWorkEpoch(redis as any, stale!, epoch), null);
        assert.strictEqual(await loadState(redis as any, 'acme', 'web', 42), null);
    });
});

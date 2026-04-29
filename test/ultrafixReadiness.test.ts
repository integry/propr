import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
    isCooldownElapsed,
    hasFollowUpJobsForPR,
    hasPendingBatchedComments,
    checkReadiness,
    saveDeferredContinuation,
    loadDeferredContinuation,
    clearDeferredContinuation,
    getUltrafixDeferredKey,
    parseDeferredKey,
    createDefaultState,
    type UltrafixLoopState,
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

// --- hasFollowUpJobsForPR ---

describe('hasFollowUpJobsForPR', () => {
    test('returns false when queue is empty', async () => {
        const result = await hasFollowUpJobsForPR('acme', 'web', 42, async () => []);
        assert.strictEqual(result, false);
    });

    test('returns true when matching job exists', async () => {
        const jobs = [
            { data: { repoOwner: 'acme', repoName: 'web', pullRequestNumber: 42 } },
        ];
        const result = await hasFollowUpJobsForPR('acme', 'web', 42, async () => jobs);
        assert.strictEqual(result, true);
    });

    test('returns false when jobs are for different PR', async () => {
        const jobs = [
            { data: { repoOwner: 'acme', repoName: 'web', pullRequestNumber: 99 } },
        ];
        const result = await hasFollowUpJobsForPR('acme', 'web', 42, async () => jobs);
        assert.strictEqual(result, false);
    });

    test('returns false when jobs are for different repo', async () => {
        const jobs = [
            { data: { repoOwner: 'other', repoName: 'web', pullRequestNumber: 42 } },
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
            cooldownElapsed: true,
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });
        assert.strictEqual(result.ready, true);
        assert.strictEqual(result.reasons.length, 0);
    });

    test('returns not ready when cooldown not elapsed', () => {
        const result = checkReadiness({
            cooldownElapsed: false,
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });
        assert.strictEqual(result.ready, false);
        assert.ok(result.reasons.includes('cooldown_not_elapsed'));
    });

    test('returns not ready when checks not passing', () => {
        const result = checkReadiness({
            cooldownElapsed: true,
            allChecksPassing: false,
            hasFollowUpJobs: false,
            hasPendingComments: false,
        });
        assert.strictEqual(result.ready, false);
        assert.ok(result.reasons.includes('checks_not_passing'));
    });

    test('returns not ready when follow-up jobs exist', () => {
        const result = checkReadiness({
            cooldownElapsed: true,
            allChecksPassing: true,
            hasFollowUpJobs: true,
            hasPendingComments: false,
        });
        assert.strictEqual(result.ready, false);
        assert.ok(result.reasons.includes('follow_up_jobs_active'));
    });

    test('returns not ready when pending comments exist', () => {
        const result = checkReadiness({
            cooldownElapsed: true,
            allChecksPassing: true,
            hasFollowUpJobs: false,
            hasPendingComments: true,
        });
        assert.strictEqual(result.ready, false);
        assert.ok(result.reasons.includes('pending_comments_exist'));
    });

    test('aggregates multiple blocking reasons', () => {
        const result = checkReadiness({
            cooldownElapsed: false,
            allChecksPassing: false,
            hasFollowUpJobs: true,
            hasPendingComments: true,
        });
        assert.strictEqual(result.ready, false);
        assert.strictEqual(result.reasons.length, 4);
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

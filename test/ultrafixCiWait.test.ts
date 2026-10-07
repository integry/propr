import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { UltrafixCiWaitDeps } from '../src/jobs/ultrafixCiWait.js';

await mock.module('@propr/core', {
    namedExports: {
        DEFAULT_ULTRAFIX_CI_WAIT_TIMEOUT_MS: 2 * 60 * 60 * 1000,
        loadUltrafixCiWaitTimeoutMs: async () => 2 * 60 * 60 * 1000,
        withUltrafixLabelTransition: async (_redis: unknown, _identity: unknown, operation: () => Promise<unknown>) => operation(),
        recoverCiFailureFollowups: async () => undefined,
    },
});

await mock.module('../src/jobs/ultrafixLoopContinuationHelpers.js', {
    namedExports: { postPrComment: mock.fn(async () => undefined) },
});

const {
    buildCiTimeoutComment,
    formatWaitDuration,
    getUltrafixCiWaitKey,
    handleUltrafixCiDeferral,
    loadUltrafixCiWait,
} = await import('../src/jobs/ultrafixCiWait.js');

function createMockRedis() {
    const store = new Map<string, string>();
    return {
        store,
        async get(key: string) { return store.get(key) ?? null; },
        async set(key: string, value: string) { store.set(key, value); return 'OK'; },
        async del(key: string) { store.delete(key); return 1; },
    };
}

const logger = { info: mock.fn(), warn: mock.fn(), debug: mock.fn() } as never;
const TIMEOUT_MS = 2 * 60 * 60 * 1000;

function makeDeps(start = Date.parse('2026-10-06T00:00:00Z')) {
    let now = start;
    const postComment = mock.fn(async () => undefined);
    const stopLoop = mock.fn(async () => true);
    const deps: UltrafixCiWaitDeps = {
        now: () => now,
        loadTimeoutMs: async () => TIMEOUT_MS,
        postComment,
        stopLoop,
    };
    return { deps, postComment, stopLoop, advance: (ms: number) => { now += ms; } };
}

function deferral(redis: ReturnType<typeof createMockRedis>, headSha = 'abc1234def', overrides: Record<string, unknown> = {}) {
    return {
        redis: redis as never,
        owner: 'integry',
        repo: 'propr',
        pr: 2755,
        workEpoch: 3,
        ci: {
            headSha,
            status: {
                count: 6, allPassing: false, anyPending: true, anyFailed: true,
                blockingFailed: ['Run Full Test Suite'], blockingPending: ['Build & Lint Check'],
            },
        },
        goal: 8,
        lastScore: 6,
        correlatedLogger: logger,
        ...overrides,
    };
}

describe('Ultrafix CI deferral notice', () => {
    test('retries missed failure recovery without repeating the wait notice', async () => {
        const redis = createMockRedis();
        const { deps, postComment } = makeDeps();
        const calls: unknown[][] = [];
        deps.recoverFailures = async (...args) => {
            calls.push(args);
            if (calls.length === 1) throw new Error('GitHub temporarily unavailable');
        };
        await handleUltrafixCiDeferral(deferral(redis), deps);
        await handleUltrafixCiDeferral(deferral(redis), deps);
        assert.deepEqual(calls, Array(2).fill(['integry', 'propr', 2755, 'abc1234def']));
        assert.equal(postComment.mock.callCount(), 1);
    });

    test('posts one comment per deferral, not per poll', async () => {
        const redis = createMockRedis();
        const { deps, postComment, stopLoop, advance } = makeDeps();

        const first = await handleUltrafixCiDeferral(deferral(redis), deps);
        assert.equal(first.stopped, false);
        assert.deepEqual(first.blockingChecks, ['Run Full Test Suite', 'Build & Lint Check']);
        assert.equal(postComment.mock.callCount(), 1);
        const body = (postComment.mock.calls[0].arguments as unknown as [{ body: string; pullRequestNumber: number }])[0];
        assert.equal(body.pullRequestNumber, 2755);
        assert.match(body.body, /Ultrafix is waiting for CI/);
        assert.match(body.body, /`Run Full Test Suite` — failed/);
        assert.match(body.body, /`Build & Lint Check` — not finished/);
        assert.match(body.body, /non-blocking checks never gate Ultrafix/);
        assert.match(body.body, /2 hours/);

        // Later polls (sweep / check_run events) of the same deferral stay quiet.
        advance(10 * 60 * 1000);
        await handleUltrafixCiDeferral(deferral(redis), deps);
        advance(10 * 60 * 1000);
        await handleUltrafixCiDeferral(deferral(redis), deps);
        assert.equal(postComment.mock.callCount(), 1);
        assert.equal(stopLoop.mock.callCount(), 0);

        const record = await loadUltrafixCiWait(redis as never, 'integry', 'propr', 2755);
        assert.equal(record?.since, '2026-10-06T00:00:00.000Z');
        assert.ok(redis.store.has(getUltrafixCiWaitKey('integry', 'propr', 2755)));
    });

    test('a new head or a new loop epoch is a new deferral', async () => {
        const redis = createMockRedis();
        const { deps, postComment } = makeDeps();

        await handleUltrafixCiDeferral(deferral(redis, 'head-one'), deps);
        await handleUltrafixCiDeferral(deferral(redis, 'head-two'), deps);
        assert.equal(postComment.mock.callCount(), 2);
        await handleUltrafixCiDeferral(deferral(redis, 'head-two', { workEpoch: 4 }), deps);
        assert.equal(postComment.mock.callCount(), 3);
    });

    test('stops the loop with "CI did not settle" once the wait exceeds the timeout', async () => {
        const redis = createMockRedis();
        const { deps, postComment, stopLoop, advance } = makeDeps();

        await handleUltrafixCiDeferral(deferral(redis), deps);
        advance(TIMEOUT_MS - 1);
        assert.equal((await handleUltrafixCiDeferral(deferral(redis), deps)).stopped, false);
        assert.equal(stopLoop.mock.callCount(), 0);

        advance(1);
        const result = await handleUltrafixCiDeferral(deferral(redis, undefined, { lastScore: undefined }), deps);
        assert.equal(result.stopped, true);
        assert.equal(result.waitedMs, TIMEOUT_MS);
        assert.equal(stopLoop.mock.callCount(), 1);
        const input = (stopLoop.mock.calls[0].arguments as unknown as [Record<string, unknown>])[0];
        assert.equal(input.workEpoch, 3);
        assert.equal(input.goal, 8);
        // The last score recorded at the original deferral is kept for the stop comment.
        assert.equal(input.lastScore, 6);
        assert.deepEqual(input.blockingChecks, ['Run Full Test Suite', 'Build & Lint Check']);
        // No second "waiting" notice is posted on the way out.
        assert.equal(postComment.mock.callCount(), 1);
    });

    test('the timeout comment reuses the "Ultrafix stopped" wording with the CI reason', () => {
        const body = buildCiTimeoutComment({ goal: 8, lastScore: 6, waitedMs: TIMEOUT_MS, blockingChecks: ['Run Full Test Suite'] });
        assert.match(body, /^⚠️ \*\*Ultrafix stopped before reaching its goal\.\*\* Requested goal: 8\/10\. Last score: 6\./);
        assert.match(body, /CI did not settle: blocking checks were still not passing after 2 hours\./);
        assert.match(body, /`Run Full Test Suite`/);
    });

    test('formats wait durations for comments', () => {
        assert.equal(formatWaitDuration(TIMEOUT_MS), '2 hours');
        assert.equal(formatWaitDuration(60 * 60 * 1000), '1 hour');
        assert.equal(formatWaitDuration(90 * 60 * 1000), '90 minutes');
        assert.equal(formatWaitDuration(1000), '1 minute');
    });
});

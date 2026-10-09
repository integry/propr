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

await mock.module('../src/jobs/ultrafixOrchestrationService.js', {
    namedExports: {
        isUltrafixAutomaticWorkCurrent: async () => true,
        completeLoop: async () => ({ goal: 8 }),
        clearDeferredContinuationIfCurrent: async () => undefined,
    },
});

const postPrComment = mock.fn(async () => 9001 as number | null);
const updatePrComment = mock.fn(async () => true);
await mock.module('../src/jobs/ultrafixLoopContinuationHelpers.js', {
    namedExports: { postPrComment, updatePrComment },
});

const {
    getUltrafixCiWaitKey,
    handleUltrafixCiDeferral,
    loadUltrafixCiWait,
    settleUltrafixCiWait,
    stopUltrafixLoopForCiTimeout,
} = await import('../src/jobs/ultrafixCiWait.js');
const { adoptUltrafixCiWaitNotice, getUltrafixCiWaitNoticeKey, postReviewStartingComment } = await import('../src/jobs/ultrafixCiWaitNotice.js');

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
const OWNER = 'integry';
const REPO = 'propr';
const PR = 2918;

function makeDeps(commentId: number | null = 4242) {
    let now = Date.parse('2026-10-09T00:00:00Z');
    const stopLoop = mock.fn(async () => true);
    const deps: UltrafixCiWaitDeps = {
        now: () => now,
        loadTimeoutMs: async () => TIMEOUT_MS,
        postComment: mock.fn(async () => commentId),
        stopLoop,
    };
    return { deps, stopLoop, advance: (ms: number) => { now += ms; } };
}

function deferral(redis: ReturnType<typeof createMockRedis>) {
    return {
        redis: redis as never,
        owner: OWNER,
        repo: REPO,
        pr: PR,
        workEpoch: 3,
        ci: {
            headSha: 'abc1234def',
            status: { count: 2, allPassing: false, anyPending: true, anyFailed: false, blockingFailed: [], blockingPending: ['Build & Lint Check'] },
        },
        goal: 8,
        lastScore: 6,
        correlatedLogger: logger,
    };
}

function makeOctokit() {
    const request = mock.fn(async (_route: string, params: Record<string, unknown>) => ({
        data: { id: params.comment_id as number, html_url: `https://github.com/${OWNER}/${REPO}/pull/${PR}#issuecomment-${params.comment_id}` },
    }));
    return { request };
}

describe('Ultrafix CI wait comment is replaced by its outcome', () => {
    test('records the id of the waiting comment', async () => {
        const redis = createMockRedis();
        const { deps } = makeDeps();
        await handleUltrafixCiDeferral(deferral(redis), deps);
        const record = await loadUltrafixCiWait(redis as never, OWNER, REPO, PR);
        assert.equal(record?.noticeCommentId, 4242);
    });

    test('wait -> review complete: the next review edits the waiting comment instead of posting a new one', async () => {
        const redis = createMockRedis();
        const { deps } = makeDeps();
        await handleUltrafixCiDeferral(deferral(redis), deps);

        // Blocking checks pass: the gate settles the wait before the review runs.
        await settleUltrafixCiWait(redis as never, OWNER, REPO, PR);
        assert.equal(redis.store.has(getUltrafixCiWaitKey(OWNER, REPO, PR)), false);
        assert.ok(redis.store.has(getUltrafixCiWaitNoticeKey(OWNER, REPO, PR)));

        const octokit = makeOctokit();
        const adopted = await adoptUltrafixCiWaitNotice({
            octokit, redis: redis as never, owner: OWNER, repo: REPO, pr: PR, body: '🔍 **Starting AI Code Review**', correlatedLogger: logger,
        });
        assert.equal(adopted?.data.id, 4242);
        assert.equal(octokit.request.mock.callCount(), 1);
        const [route, params] = octokit.request.mock.calls[0].arguments;
        assert.equal(route, 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}');
        assert.equal(params.comment_id, 4242);
        assert.match(params.body as string, /Starting AI Code Review/);

        // The review's later "AI Code Review Complete" update targets the same comment; nothing is left to adopt.
        assert.equal(redis.store.has(getUltrafixCiWaitNoticeKey(OWNER, REPO, PR)), false);
        assert.equal(await adoptUltrafixCiWaitNotice({
            octokit, redis: redis as never, owner: OWNER, repo: REPO, pr: PR, body: 'again', correlatedLogger: logger,
        }), null);
    });

    test('the review starting comment reuses the waiting comment only for Ultrafix reviews', async () => {
        const redis = createMockRedis();
        const { deps } = makeDeps();
        await handleUltrafixCiDeferral(deferral(redis), deps);
        await settleUltrafixCiWait(redis as never, OWNER, REPO, PR);

        const manual = makeOctokit();
        await postReviewStartingComment({
            octokit: manual, redis: redis as never, owner: OWNER, repo: REPO, pr: PR, body: 'starting', adoptWaitNotice: false, correlatedLogger: logger,
        });
        assert.equal(manual.request.mock.calls[0].arguments[0], 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments');

        const ultrafix = makeOctokit();
        const comment = await postReviewStartingComment({
            octokit: ultrafix, redis: redis as never, owner: OWNER, repo: REPO, pr: PR, body: 'starting', adoptWaitNotice: true, correlatedLogger: logger,
        });
        assert.equal(ultrafix.request.mock.calls[0].arguments[0], 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}');
        assert.equal(comment.data.id, 4242);
    });

    test('falls back to a new comment when the waiting comment cannot be edited', async () => {
        const redis = createMockRedis();
        const { deps } = makeDeps();
        await handleUltrafixCiDeferral(deferral(redis), deps);
        await settleUltrafixCiWait(redis as never, OWNER, REPO, PR);

        const octokit = { request: mock.fn(async () => { throw new Error('Not Found'); }) };
        assert.equal(await adoptUltrafixCiWaitNotice({
            octokit, redis: redis as never, owner: OWNER, repo: REPO, pr: PR, body: 'starting', correlatedLogger: logger,
        }), null);
    });

    test('a review without a preceding wait posts its own comment', async () => {
        const redis = createMockRedis();
        await settleUltrafixCiWait(redis as never, OWNER, REPO, PR);
        const octokit = makeOctokit();
        assert.equal(await adoptUltrafixCiWaitNotice({
            octokit, redis: redis as never, owner: OWNER, repo: REPO, pr: PR, body: 'starting', correlatedLogger: logger,
        }), null);
        assert.equal(octokit.request.mock.callCount(), 0);
    });

    test('wait -> timeout: the stop hands the waiting comment to the stop comment', async () => {
        const redis = createMockRedis();
        const { deps, stopLoop, advance } = makeDeps();
        await handleUltrafixCiDeferral(deferral(redis), deps);
        advance(TIMEOUT_MS);
        const result = await handleUltrafixCiDeferral(deferral(redis), deps);
        assert.equal(result.stopped, true);
        const input = (stopLoop.mock.calls[0].arguments as unknown as [{ noticeCommentId?: number }])[0];
        assert.equal(input.noticeCommentId, 4242);
    });

    test('wait -> timeout: the waiting comment is rewritten with "CI did not settle"', async () => {
        postPrComment.mock.resetCalls();
        updatePrComment.mock.resetCalls();
        const redis = createMockRedis();
        const stopped = await stopUltrafixLoopForCiTimeout({
            redis: redis as never, owner: OWNER, repo: REPO, pr: PR, workEpoch: 3, goal: 8, lastScore: 6,
            waitedMs: TIMEOUT_MS, blockingChecks: ['Build & Lint Check'], noticeCommentId: 4242, correlatedLogger: logger,
        });
        assert.equal(stopped, true);
        assert.equal(postPrComment.mock.callCount(), 0, 'no second comment beside the waiting one');
        assert.equal(updatePrComment.mock.callCount(), 1);
        const update = (updatePrComment.mock.calls[0].arguments as unknown as [{ commentId: number; body: string }])[0];
        assert.equal(update.commentId, 4242);
        assert.match(update.body, /Ultrafix stopped before reaching its goal/);
        assert.match(update.body, /CI did not settle/);
    });

    test('wait -> timeout: posts the stop comment when the waiting comment cannot be edited', async () => {
        postPrComment.mock.resetCalls();
        updatePrComment.mock.resetCalls();
        updatePrComment.mock.mockImplementationOnce(async () => false);
        const redis = createMockRedis();
        await stopUltrafixLoopForCiTimeout({
            redis: redis as never, owner: OWNER, repo: REPO, pr: PR, workEpoch: 3, goal: 8, lastScore: 6,
            waitedMs: TIMEOUT_MS, blockingChecks: [], noticeCommentId: 4242, correlatedLogger: logger,
        });
        assert.equal(updatePrComment.mock.callCount(), 1);
        assert.equal(postPrComment.mock.callCount(), 1);
        const post = (postPrComment.mock.calls[0].arguments as unknown as [{ body: string }])[0];
        assert.match(post.body, /CI did not settle/);
    });
});

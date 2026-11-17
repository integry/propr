import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    failureCommentKey, FAILURE_COMMENT_WINDOW_MS, postNoticeOnce, publishFailureComment, renderFailureCommentBody,
} from '../src/jobs/failureCommentDedupe.js';
import { buildFollowupFailureBody } from '../src/jobs/prCommentFailureComment.js';
import { setIssueCommentLockTimingForTests } from '../src/jobs/issueCommentLock.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

after(async () => {
    await closeConnection();
});

interface FakeComment { id: number; body: string; html_url: string; updated_at: string; user: { login: string } }

const BOT = 'propr-dev[bot]';

/**
 * A GitHub issue's comment list: list (with `since`), post, patch and delete.
 * `listLatencyMs` returns the list a while after it was read, as a slow
 * GitHub response does, so concurrent callers can hold stale snapshots.
 */
function fakeGitHub(now: () => Date, listLatencyMs = 0) {
    const comments: FakeComment[] = [];
    let nextId = 100;
    const calls: string[] = [];
    const octokit = {
        request: async (route: string, params: Record<string, unknown> = {}) => {
            calls.push(route.split(' ')[0]);
            if (route.startsWith('GET ') && route.endsWith('/comments')) {
                const since = Date.parse(String(params.since));
                const snapshot = comments.filter(comment => Date.parse(comment.updated_at) >= since).map(comment => ({ ...comment }));
                if (listLatencyMs > 0) await new Promise(resolve => setTimeout(resolve, listLatencyMs));
                return { data: snapshot };
            }
            if (route.startsWith('POST ')) {
                // ProPR posts as its bot account; `author` stands in for a person's own comment.
                const comment = { id: nextId++, body: String(params.body), html_url: `https://github.com/c/${nextId}`, updated_at: now().toISOString(), user: { login: String(params.author ?? BOT) } };
                comments.push(comment);
                return { data: comment };
            }
            const target = comments.find(comment => comment.id === params.comment_id);
            if ((route.startsWith('PATCH ') || route.startsWith('DELETE ')) && target && target.user.login !== BOT) {
                // GitHub refuses to edit or delete another author's comment.
                throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
            }
            if (route.startsWith('PATCH ') && target) {
                target.body = String(params.body);
                target.updated_at = now().toISOString();
            }
            if (route.startsWith('DELETE ') && target) comments.splice(comments.indexOf(target), 1);
            return { data: target ?? {} };
        },
    };
    return {
        octokit, comments, calls,
        post: (body: string, author?: string) => octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { body, author }),
    };
}

describe('identical failure comments (#3622 point 2)', () => {
    const target = { owner: 'integry', repo: 'propr', issueNumber: 3495 };
    const key = failureCommentKey({ kind: 'merge-conflict:main', headSha: 'abc', cause: 'The agent run timed out.' });

    test('a repeat within the hour updates the first comment with a count and removes the new starting comment', async () => {
        let clock = new Date('2026-11-16T10:00:00Z');
        const gh = fakeGitHub(() => clock);
        const first = await gh.post('Working on it');
        await publishFailureComment(gh.octokit, { ...target, key, body: '❌ Failed to resolve merge conflicts', startingCommentId: (first.data as FakeComment).id, now: clock });

        for (let attempt = 2; attempt <= 4; attempt++) {
            clock = new Date(clock.getTime() + 4 * 60_000);
            const starting = await gh.post('Working on it');
            const result = await publishFailureComment(gh.octokit, { ...target, key, body: '❌ Failed to resolve merge conflicts', startingCommentId: (starting.data as FakeComment).id, now: clock });
            assert.equal(result.action, 'updated');
            assert.equal(result.count, attempt);
        }

        assert.equal(gh.comments.length, 1, 'four identical failures leave one comment');
        assert.match(gh.comments[0].body, /This failure has occurred 4 times on this head/);
        assert.equal((gh.comments[0].body.match(/propr:failure-comment/g) ?? []).length, 1);
    });

    test('a different head, a different cause, or a repeat after an hour posts its own comment', async () => {
        let clock = new Date('2026-11-16T10:00:00Z');
        const gh = fakeGitHub(() => clock);
        await publishFailureComment(gh.octokit, { ...target, key, body: 'A', now: clock });
        await publishFailureComment(gh.octokit, { ...target, key: failureCommentKey({ kind: 'merge-conflict:main', headSha: 'def', cause: 'The agent run timed out.' }), body: 'A', now: clock });
        await publishFailureComment(gh.octokit, { ...target, key: failureCommentKey({ kind: 'merge-conflict:main', headSha: 'abc', cause: 'Provider authentication failed.' }), body: 'B', now: clock });
        clock = new Date(clock.getTime() + FAILURE_COMMENT_WINDOW_MS + 60_000);
        await publishFailureComment(gh.octokit, { ...target, key, body: 'A', now: clock });
        assert.equal(gh.comments.length, 4);
    });

    test('a follow-up repeat keeps its receipt on the starting comment and leaves the earlier receipts alone', async () => {
        const clock = new Date('2026-11-16T10:00:00Z');
        const gh = fakeGitHub(() => clock);
        const one = await gh.post('Working on 11');
        await publishFailureComment(gh.octokit, { ...target, key, body: 'Failed\n\nComment ID: 11✓', startingCommentId: (one.data as FakeComment).id, startingCommentReceipt: '\n\nComment ID: 11✓', now: clock });
        const two = await gh.post('Working on 12');
        await publishFailureComment(gh.octokit, { ...target, key, body: 'Failed\n\nComment ID: 12✓', startingCommentId: (two.data as FakeComment).id, startingCommentReceipt: '\n\n---\nComment ID: 12✓', now: clock });

        assert.equal(gh.comments.length, 2);
        assert.match(gh.comments[0].body, /Comment ID: 11✓/);
        assert.match(gh.comments[0].body, /occurred 2 times/);
        assert.match(gh.comments[1].body, /^❌ Failed again with the same error; see \[the earlier comment\]/);
        assert.match(gh.comments[1].body, /Comment ID: 12✓/);
    });

    test('a copy of the failure comment by a person neither absorbs nor blocks the repeat (F4)', async () => {
        let clock = new Date('2026-11-16T10:00:00Z');
        const gh = fakeGitHub(() => clock);
        const first = await gh.post('Working on it');
        await publishFailureComment(gh.octokit, { ...target, key, body: '❌ Failed to resolve merge conflicts', startingCommentId: (first.data as FakeComment).id, now: clock });
        // Someone quotes the failure comment, hidden marker included, to report it.
        clock = new Date(clock.getTime() + 60_000);
        await gh.post(`Same again:\n\n${gh.comments[0].body}`, 'octocat');

        clock = new Date(clock.getTime() + 60_000);
        const starting = await gh.post('Working on it');
        const result = await publishFailureComment(gh.octokit, { ...target, key, body: '❌ Failed to resolve merge conflicts', startingCommentId: (starting.data as FakeComment).id, now: clock });

        assert.deepEqual({ action: result.action, commentId: result.commentId, count: result.count }, { action: 'updated', commentId: gh.comments[0].id, count: 2 });
        assert.match(gh.comments[0].body, /occurred 2 times/);
        assert.doesNotMatch(gh.comments[1].body, /occurred 2 times/, "the person's comment is left as written");
    });

    test('a copied marker in a person\'s comment alone does not count as an earlier failure (F4)', async () => {
        const clock = new Date('2026-11-16T10:00:00Z');
        const gh = fakeGitHub(() => clock);
        await gh.post(renderFailureCommentBody('❌ Failed', key, 1, clock), 'octocat');
        const result = await publishFailureComment(gh.octokit, { ...target, key, body: '❌ Failed', now: clock });
        assert.equal(result.action, 'posted');
        assert.equal(result.count, 1);
        assert.equal(gh.comments.length, 2);
        assert.equal(gh.comments[1].user.login, BOT);
    });

    test('a follow-up failure notice names the cause, links the task and never lists the synthetic comment id 0', () => {
        const { body } = buildFollowupFailureBody({
            repoOwner: 'integry', repoName: 'propr', pullRequestNumber: 3523, authorsText: '@propr-ultrafix', taskId: 'pr-comments-batch-1',
            comments: [{ id: 0, author: 'propr-ultrafix' }],
            error: new Error('Agent execution failed: Failed to authenticate. API Error: 403 Attention Required! | Cloudflare'),
            pushFailure: undefined,
        });
        assert.match(body, /\*\*Cause:\*\* Provider authentication failed\./);
        assert.match(body, /\[View task details\]\(.+\/tasks\/pr-comments-batch-1\)/);
        assert.doesNotMatch(body, /Comment ID|0✓|check the logs|Cloudflare|Attention Required/);
    });

    test('the same start or cancel notice of one event is posted once', async () => {
        const clock = new Date('2026-11-16T18:25:34Z');
        const gh = fakeGitHub(() => clock);
        const results = [];
        for (let index = 0; index < 3; index++) {
            results.push(await postNoticeOnce(gh.octokit, { ...target, kind: 'issue-cancelled', body: '🛑 **Execution Cancelled**', now: clock }));
        }
        assert.deepEqual(results, [true, false, false]);
        assert.equal(gh.comments.length, 1);
        // Another agent/model/branch is another notice.
        assert.equal(await postNoticeOnce(gh.octokit, { ...target, kind: 'issue-start', identity: 'claude\nopus\nb1', body: 'started', now: clock }), true);
        assert.equal(await postNoticeOnce(gh.octokit, { ...target, kind: 'issue-start', identity: 'claude\nopus\nb1', body: 'started', now: clock }), false);
        assert.equal(await postNoticeOnce(gh.octokit, { ...target, kind: 'issue-start', identity: 'codex\ngpt\nb2', body: 'started', now: clock }), true);
    });

    test('a notice marker copied into a person\'s comment does not suppress the notice (F4)', async () => {
        const clock = new Date('2026-11-16T18:25:34Z');
        const gh = fakeGitHub(() => clock);
        assert.equal(await postNoticeOnce(gh.octokit, { ...target, kind: 'issue-cancelled', body: '🛑 **Execution Cancelled**', now: clock }), true);
        const copy = gh.comments[0].body;
        gh.comments.splice(0, 1);
        await gh.post(`> ${copy}`, 'octocat');
        assert.equal(await postNoticeOnce(gh.octokit, { ...target, kind: 'issue-cancelled', body: '🛑 **Execution Cancelled**', now: clock }), true);
        assert.equal(gh.comments.filter(comment => comment.user.login === BOT).length, 1);
    });

    test('a failed lookup still posts the notice', async () => {
        const posted: string[] = [];
        const octokit = {
            request: async (route: string, params: Record<string, unknown> = {}) => {
                if (route.startsWith('GET ')) throw new Error('HTTP 502');
                posted.push(String(params.body));
                return { data: { id: 1 } };
            },
        };
        assert.equal(await postNoticeOnce(octokit, { ...target, kind: 'issue-cancelled', body: 'cancelled' }), true);
        assert.equal(posted.length, 1);
    });
});

/** Redis as the issue comment lock uses it: SET PX NX plus the renew and release scripts. */
function lockRedis() {
    const values = new Map<string, string>();
    return {
        values,
        set: async (key: string, value: string, ..._args: Array<string | number>) => {
            if (values.has(key)) return null;
            values.set(key, value);
            return 'OK';
        },
        eval: async (script: string, _keys: number, key: string, token: string) => {
            if (values.get(key) !== token) return 0;
            if (script.includes('"del"')) values.delete(key);
            return 1;
        },
    };
}

describe('concurrent failure comments and notices (F2)', () => {
    const target = { owner: 'integry', repo: 'propr', issueNumber: 3495 };
    const key = failureCommentKey({ kind: 'merge-conflict:main', headSha: 'abc', cause: 'The agent run timed out.' });
    const clock = new Date('2026-11-16T10:00:00Z');
    after(() => setIssueCommentLockTimingForTests(null));

    test('identical failures published at once leave one comment counting each of them', async () => {
        const gh = fakeGitHub(() => clock, 20);
        const results = await Promise.all([1, 2, 3].map(() => publishFailureComment(gh.octokit, { ...target, key, body: '❌ Failed', now: clock })));
        assert.equal(gh.comments.length, 1);
        assert.deepEqual(results.map(result => result.count).sort(), [1, 2, 3]);
        assert.match(gh.comments[0].body, /occurred 3 times/);
    });

    test('concurrent repeats of an existing failure each add to its count', async () => {
        const gh = fakeGitHub(() => clock, 20);
        await publishFailureComment(gh.octokit, { ...target, key, body: '❌ Failed', now: clock });
        await Promise.all([1, 2, 3].map(() => publishFailureComment(gh.octokit, { ...target, key, body: '❌ Failed', now: clock })));
        assert.equal(gh.comments.length, 1);
        assert.match(gh.comments[0].body, /occurred 4 times/);
    });

    test('a cancel notice raised by several tasks at once is posted once', async () => {
        const gh = fakeGitHub(() => clock, 20);
        const results = await Promise.all([1, 2, 3].map(() => postNoticeOnce(gh.octokit, { ...target, kind: 'issue-cancelled', body: '🛑 **Execution Cancelled**', now: clock })));
        assert.deepEqual(results.sort(), [false, false, true]);
        assert.equal(gh.comments.length, 1);
    });

    test('a failure on another worker holding the lock is waited for, then counted on', async () => {
        setIssueCommentLockTimingForTests({ pollMs: 5 });
        const redis = lockRedis();
        const { setIssueCommentLockRedis, issueCommentLockKey } = await import('../src/jobs/issueCommentLock.js');
        setIssueCommentLockRedis(redis);
        try {
            const gh = fakeGitHub(() => clock);
            const lockKey = `propr:issue-comment-lock:${issueCommentLockKey(target, `failure:${key}`)}`;
            redis.values.set(lockKey, 'other-worker');
            const pending = publishFailureComment(gh.octokit, { ...target, key, body: '❌ Failed', now: clock });
            await new Promise(resolve => setTimeout(resolve, 30));
            assert.equal(gh.calls.length, 0, 'no lookup while the other worker holds the lock');
            // The other worker publishes the first occurrence, then releases.
            await gh.post(renderFailureCommentBody('❌ Failed', key, 1, clock));
            redis.values.delete(lockKey);
            const result = await pending;
            assert.equal(result.count, 2);
            assert.equal(gh.comments.length, 1);
            assert.equal(redis.values.size, 0, 'released after the work');
        } finally {
            setIssueCommentLockRedis(null);
        }
    });

    test('a lock held by another worker for the whole wait fails instead of posting unlocked', async () => {
        setIssueCommentLockTimingForTests({ pollMs: 5, waitMs: 30 });
        const redis = lockRedis();
        const { setIssueCommentLockRedis, issueCommentLockKey } = await import('../src/jobs/issueCommentLock.js');
        setIssueCommentLockRedis(redis);
        try {
            const gh = fakeGitHub(() => clock);
            redis.values.set(`propr:issue-comment-lock:${issueCommentLockKey(target, `failure:${key}`)}`, 'other-worker');
            await assert.rejects(publishFailureComment(gh.octokit, { ...target, key, body: '❌ Failed', now: clock }), { name: 'IssueCommentLockTimeoutError' });
            assert.equal(gh.comments.length, 0);
        } finally {
            setIssueCommentLockRedis(null);
        }
    });

    test('a notice whose lock was taken over during the lookup is not posted', async () => {
        const redis = lockRedis();
        const { setIssueCommentLockRedis } = await import('../src/jobs/issueCommentLock.js');
        setIssueCommentLockRedis(redis);
        try {
            const gh = fakeGitHub(() => clock);
            const request = gh.octokit.request;
            gh.octokit.request = async (route, params) => {
                // The lease lapses mid-lookup and another worker takes the lock.
                if (route.startsWith('GET ')) for (const lockKey of redis.values.keys()) redis.values.set(lockKey, 'other-worker');
                return request(route, params);
            };
            await assert.rejects(postNoticeOnce(gh.octokit, { ...target, kind: 'issue-cancelled', body: 'cancelled', now: clock }), { name: 'IssueCommentLockLostError' });
            assert.equal(gh.comments.length, 0);
        } finally {
            setIssueCommentLockRedis(null);
        }
    });
});


import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    failureCommentKey, FAILURE_COMMENT_WINDOW_MS, postNoticeOnce, publishFailureComment,
} from '../src/jobs/failureCommentDedupe.js';
import { buildFollowupFailureBody } from '../src/jobs/prCommentFailureComment.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

after(async () => {
    await closeConnection();
});

interface FakeComment { id: number; body: string; html_url: string; updated_at: string }

/** A GitHub issue's comment list: list (with `since`), post, patch and delete. */
function fakeGitHub(now: () => Date) {
    const comments: FakeComment[] = [];
    let nextId = 100;
    const calls: string[] = [];
    const octokit = {
        request: async (route: string, params: Record<string, unknown> = {}) => {
            calls.push(route.split(' ')[0]);
            if (route.startsWith('GET ') && route.endsWith('/comments')) {
                const since = Date.parse(String(params.since));
                return { data: comments.filter(comment => Date.parse(comment.updated_at) >= since) };
            }
            if (route.startsWith('POST ')) {
                const comment = { id: nextId++, body: String(params.body), html_url: `https://github.com/c/${nextId}`, updated_at: now().toISOString() };
                comments.push(comment);
                return { data: comment };
            }
            const target = comments.find(comment => comment.id === params.comment_id);
            if (route.startsWith('PATCH ') && target) {
                target.body = String(params.body);
                target.updated_at = now().toISOString();
            }
            if (route.startsWith('DELETE ') && target) comments.splice(comments.indexOf(target), 1);
            return { data: target ?? {} };
        },
    };
    return { octokit, comments, calls, post: (body: string) => octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { body }) };
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

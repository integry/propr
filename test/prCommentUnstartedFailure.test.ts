import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { WorktreeDiskPressureError, isWorktreeDiskPressureError } from '../packages/core/src/storage/lifecycle.js';

const logInfo = mock.fn();
const logError = mock.fn();
const defaultRequest = mock.fn(async () => ({}));
const getAuthenticatedOctokit = mock.fn(async () => ({ request: defaultRequest }));
const log = { info: logInfo, error: logError, withCorrelation: () => log };

await mock.module('@propr/core', {
    namedExports: { logger: log, getAuthenticatedOctokit, isWorktreeDiskPressureError },
});

const { postUnstartedPRCommentFailure, unstartedPRCommentFailureBody } = await import('../src/jobs/prCommentUnstartedFailure.js');

const baseData = { repoOwner: 'integry', repoName: 'propr', pullRequestNumber: 3423, correlationId: 'corr-1' };

test('disk pressure refusal is explained and the comments are marked processed', () => {
    const body = unstartedPRCommentFailureBody({
        id: 'job-1', attemptsMade: 3,
        data: { ...baseData, commandMode: 'fix', comments: [
            { id: 11, body: '/fix all', author: 'rinalds', type: 'issue' },
            { id: 0, body: 'synthetic', author: 'propr-ultrafix', type: 'issue' },
            { id: 12, body: 'also this', author: 'rinalds', type: 'review' },
        ] },
    }, new WorktreeDiskPressureError());

    assert.match(body, /^❌ \*\*ProPR could not start on `\/fix`\*\* requested by @rinalds\n/);
    assert.match(body, /disk that holds its working copies is nearly full/);
    assert.match(body, /post the command again/i);
    assert.match(body, /Comment IDs: 11✓, 12✓/);
    assert.match(body, /<!-- propr:work-evidence phase=failed trigger-comment-ids=11,12 -->/);
    assert.doesNotMatch(body, /propr-ultrafix|0✓/);
});

test('another pre-start failure quotes the sanitized error and the attempt count', () => {
    const body = unstartedPRCommentFailureBody({
        id: 'job-2', attemptsMade: 3,
        data: { ...baseData, commandMode: 'review', commentId: 21, commentAuthor: 'alice', commentBody: '/review' },
    }, new Error('Redis connection lost at /usr/src/app/secret/path.js'));

    assert.match(body, /could not start on `\/review`\*\* requested by @alice/);
    assert.match(body, /failed 3 times before processing began:\n\n```\n[^`]*Redis connection lost/);
    assert.match(body, /Comment ID: 21✓/);
    assert.doesNotMatch(body, /nearly full/);
});

test('a follow-up without known comments still gets a comment, without processed markers', () => {
    const body = unstartedPRCommentFailureBody({ id: 'job-3', data: { ...baseData, comments: [] } }, new WorktreeDiskPressureError());

    assert.match(body, /^❌ \*\*ProPR could not start on the follow-up\*\*\n/);
    assert.doesNotMatch(body, /Comment ID|requested by|work-evidence/);
});

test('posts the explanation on the pull request with the authenticated client', async () => {
    defaultRequest.mock.resetCalls();
    const posted = await postUnstartedPRCommentFailure({
        id: 'job-4', attemptsMade: 3,
        data: { ...baseData, commandMode: 'fix', comments: [{ id: 11, body: '/fix all', author: 'rinalds', type: 'issue' }] },
    }, new WorktreeDiskPressureError());

    assert.equal(posted, true);
    assert.equal(defaultRequest.mock.calls.length, 1);
    const [route, params] = defaultRequest.mock.calls[0].arguments as unknown as [string, Record<string, unknown>];
    assert.equal(route, 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments');
    assert.equal(params.owner, 'integry');
    assert.equal(params.repo, 'propr');
    assert.equal(params.issue_number, 3423);
    assert.match(String(params.body), /could not start on `\/fix`/);
    assert.equal((logInfo.mock.calls.at(-1)!.arguments[0] as { diskPressure: boolean }).diskPressure, true);
});

test('a failure to post is logged and never thrown', async () => {
    logError.mock.resetCalls();
    const octokit = { request: mock.fn(async () => { throw new Error('GitHub 502'); }) };
    const posted = await postUnstartedPRCommentFailure({ id: 'job-5', data: { ...baseData, comments: [] } }, new Error('boom'), octokit);

    assert.equal(posted, false);
    assert.equal(logError.mock.calls.length, 1);
    const [context] = logError.mock.calls[0].arguments as unknown as [{ error: string; cause: string }];
    assert.equal(context.error, 'GitHub 502');
    assert.equal(context.cause, 'boom');
});

test('isWorktreeDiskPressureError recognises the error by name and by message after a queue round-trip', () => {
    assert.equal(isWorktreeDiskPressureError(new WorktreeDiskPressureError()), true);
    assert.equal(isWorktreeDiskPressureError(new Error('Worktree disk pressure: admission reserve unavailable; data retained')), true);
    assert.equal(isWorktreeDiskPressureError(new Error('Disk full')), false);
    assert.equal(isWorktreeDiskPressureError('Worktree disk pressure'), false);
});

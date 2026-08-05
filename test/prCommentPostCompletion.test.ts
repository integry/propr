import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const events: string[] = [];
const markReviewCommentsProcessed = mock.fn(async () => {});
const schedulePRCommentCleanupRecovery = mock.fn(async () => {
    events.push('cleanup-recovery');
});
const recoveredCommentRequest = mock.fn(async () => ({
    data: { html_url: 'https://example.test/recovered-comment', body: 'complete' },
}));
const andWhere = mock.fn(() => ({
    update: async () => {
        events.push('commit-hash');
        return 1;
    },
}));

await mock.module('@propr/core', {
    namedExports: {
        commitChanges: async () => ({ commitHash: 'commit-abc', filesChanged: [] }),
        AI_COMMIT_AUTHOR: { name: 'ProPR', email: 'propr@example.test' },
        db: () => ({ where: () => ({ andWhere }) }),
        getAuthenticatedOctokit: async () => ({ request: recoveredCommentRequest }),
        getRepoUrl: () => 'https://example.test/repo.git',
        hashTaskAttemptToken: (token: string) => `hash:${token}`,
        pushBranch: async () => ({ rebased: false }),
        resolveAgentTerminationReason: () => undefined,
        SupersededTaskAttemptError: class SupersededTaskAttemptError extends Error {},
        TaskStates: { COMPLETED: 'completed' },
    },
});

await mock.module('../src/jobs/prCompletionComment.js', {
    namedExports: { buildCompletionComment: async () => 'complete' },
});

await mock.module('../src/jobs/prCommentJobUtils.js', {
    namedExports: {
        buildCommitMessage: () => 'commit message',
        schedulePRCommentCleanupRecovery,
    },
});

await mock.module('../src/jobs/reviewCommentGatherer.js', {
    namedExports: { markReviewCommentsProcessed },
});

await mock.module('../src/jobs/ultrafixJobHelpers.js', {
    namedExports: { resolveUltrafixHistoryMeta: async () => undefined },
});

const { handlePostExecution } = await import('../src/jobs/prCommentPostExecution.js');
const { resumePRCommentPublication } = await import('../src/jobs/prCommentPublicationRecovery.js');

test('terminal completion is the final fenced operation after continuation work', async () => {
    let completed = false;
    const remoteStages: string[] = [];
    const assertLease = async () => {
        if (completed) throw new Error('lease was checked after committed success');
        events.push('assert');
    };
    const stateManager = {
        updateTaskState: async () => {
            events.push('complete');
            completed = true;
        },
    };
    const octokit = {
        auth: async () => ({ token: 'token' }),
        request: async () => {
            events.push('comment');
            return { data: { html_url: 'https://example.test/comment', body: 'complete' } };
        },
    };

    const result = await handlePostExecution({
        state: {
            octokit,
            worktreeInfo: { worktreePath: '/attempt-worktree', branchName: 'branch' },
            claudeResult: { success: true, summary: 'done' },
            authorsText: '@owner',
            unprocessedComments: [{ id: 1, body: '/fix', author: 'owner', type: 'issue' }],
            startingWorkComment: { data: { id: 2, html_url: 'https://example.test/start' } },
        },
        job: { data: { commandMode: 'fix' } },
        taskId: 'task-1748',
        stateManager,
        context: {
            pullRequestNumber: 1748,
            repoOwner: 'integry',
            repoName: 'propr',
            correlatedLogger: {
                info: () => {},
                warn: () => {},
            },
        },
        unprocessedReviewComments: [{ id: 5192431716 }],
        llm: null,
        redisClient: {
            eval: async (...args: unknown[]) => {
                const value = JSON.parse(args[6] as string) as { stage?: string };
                remoteStages.push(value.stage ?? 'terminal');
                return 1;
            },
        },
        prProcessingLockToken: 'attempt-token',
        assertLease,
        beforeCompletion: async () => {
            events.push('continuation');
        },
    } as never, 'https://example.test/task');

    assert.equal(result.partial, false);
    assert.equal(completed, true);
    assert.deepEqual(andWhere.mock.calls[0].arguments, ['attempt_generation', 'hash:attempt-token']);
    assert.ok(events.indexOf('assert') < events.indexOf('commit-hash'));
    assert.ok(events.indexOf('continuation') < events.indexOf('complete'));
    assert.equal(events.at(-1), 'complete');
    assert.ok(events.indexOf('cleanup-recovery') < events.indexOf('complete'));
    assert.equal(markReviewCommentsProcessed.mock.calls.length, 1);
    assert.equal(markReviewCommentsProcessed.mock.calls[0].arguments[1].prProcessingLockToken, 'attempt-token');
    assert.equal(
        markReviewCommentsProcessed.mock.calls[0].arguments[1].prProcessingLockKey,
        'lock:pr:integry:propr:1748',
    );
    assert.deepEqual(remoteStages, [
        'branch_pushed',
        'completion_comment_published',
        'review_comments_processed',
        'continuation_handled',
        'commit_hash_persisted',
        'terminal',
    ]);
});

test('preserves the published result when the final task-state transition fails', async () => {
    const terminalFailure = new Error('Redis transition unavailable');
    const warn = mock.fn();
    const result = await handlePostExecution({
        state: {
            octokit: {
                auth: async () => ({ token: 'token' }),
                request: async () => ({
                    data: { html_url: 'https://example.test/comment', body: 'complete' },
                }),
            },
            worktreeInfo: { worktreePath: '/attempt-worktree', branchName: 'branch' },
            claudeResult: { success: true, summary: 'done' },
            authorsText: '@owner',
            unprocessedComments: [{ id: 1, body: '/fix', author: 'owner', type: 'issue' }],
            startingWorkComment: { data: { id: 2, html_url: 'https://example.test/start' } },
        },
        job: { data: { commandMode: 'fix' } },
        taskId: 'task-remote-published',
        stateManager: {
            updateTaskState: async () => { throw terminalFailure; },
        },
        context: {
            pullRequestNumber: 1748,
            repoOwner: 'integry',
            repoName: 'propr',
            correlatedLogger: { info: () => {}, warn },
        },
        unprocessedReviewComments: [],
        llm: null,
        redisClient: { eval: async () => 1 },
        prProcessingLockToken: 'attempt-token',
        assertLease: async () => {},
        beforeCompletion: async () => {},
    } as never, 'https://example.test/task');

    assert.equal(result.partial, false);
    assert.equal(result.commitHash, 'commit-abc');
    assert.equal(warn.mock.calls[0].arguments[0].error, terminalFailure.message);
});

test('resumes after a pushed branch without rerunning publication work', async () => {
    const remoteStages: string[] = [];
    let completionTransitions = 0;
    let continuations = 0;
    const requestCountBefore = recoveredCommentRequest.mock.calls.length;

    const result = await resumePRCommentPublication({
        kind: 'implementation-publication',
        stage: 'branch_pushed',
        prProcessingAttemptGeneration: 'hash:old-attempt',
        result: {
            status: 'complete',
            commit: 'commit-abc',
            prProcessingAttemptGeneration: 'hash:old-attempt',
            claudeResult: { success: true },
        },
        branchName: 'branch',
        completionComment: { id: 2, body: 'complete' },
        reviewCommentIds: [],
    }, {
        job: { data: { commandMode: 'fix' } },
        taskId: 'task-resumed-publication',
        stateManager: {
            updateTaskState: async () => { completionTransitions += 1; },
        },
        context: {
            pullRequestNumber: 1748,
            repoOwner: 'integry',
            repoName: 'propr',
            correlatedLogger: { info: () => {}, warn: () => {} },
        },
        llm: null,
        redisClient: {
            eval: async (...args: unknown[]) => {
                const value = JSON.parse(args[6] as string) as { stage?: string };
                remoteStages.push(value.stage ?? 'terminal');
                return 1;
            },
        },
        prProcessingLockToken: 'new-attempt',
        assertLease: async () => {},
        beforeCompletion: async () => { continuations += 1; },
        signal: new AbortController().signal,
    } as never);

    assert.deepEqual(result, { commitHash: 'commit-abc', partial: false });
    assert.equal(recoveredCommentRequest.mock.calls.length, requestCountBefore + 1);
    assert.equal(recoveredCommentRequest.mock.calls.at(-1)?.arguments[0], 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}');
    assert.equal(continuations, 1);
    assert.equal(completionTransitions, 1);
    assert.deepEqual(remoteStages, [
        'branch_pushed',
        'completion_comment_published',
        'review_comments_processed',
        'continuation_handled',
        'commit_hash_persisted',
        'terminal',
    ]);
});

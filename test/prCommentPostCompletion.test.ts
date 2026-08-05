import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const events: string[] = [];

await mock.module('@propr/core', {
    namedExports: {
        commitChanges: async () => null,
        AI_COMMIT_AUTHOR: { name: 'ProPR', email: 'propr@example.test' },
        db: () => ({ where: () => ({ update: async () => 1 }) }),
        getAuthenticatedOctokit: async () => ({}),
        getRepoUrl: () => 'https://example.test/repo.git',
        pushBranch: async () => ({ rebased: false }),
        resolveAgentTerminationReason: () => undefined,
        TaskStates: { COMPLETED: 'completed' },
    },
});

await mock.module('../src/jobs/prCompletionComment.js', {
    namedExports: { buildCompletionComment: async () => 'complete' },
});

await mock.module('../src/jobs/prCommentJobUtils.js', {
    namedExports: { buildCommitMessage: () => 'commit message' },
});

await mock.module('../src/jobs/reviewCommentGatherer.js', {
    namedExports: { markReviewCommentsProcessed: async () => {} },
});

await mock.module('../src/jobs/ultrafixJobHelpers.js', {
    namedExports: { resolveUltrafixHistoryMeta: async () => undefined },
});

const { handlePostExecution } = await import('../src/jobs/prCommentPostExecution.js');

test('terminal completion is the final fenced operation after continuation work', async () => {
    let completed = false;
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
        unprocessedReviewComments: [],
        llm: null,
        redisClient: {},
        prProcessingLockToken: 'attempt-token',
        assertLease,
        beforeCompletion: async () => {
            events.push('continuation');
        },
    } as never, 'https://example.test/task');

    assert.equal(result.partial, false);
    assert.equal(completed, true);
    assert.ok(events.indexOf('continuation') < events.indexOf('complete'));
    assert.equal(events.at(-1), 'complete');
});

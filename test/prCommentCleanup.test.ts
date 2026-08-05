import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const cleanupWorktree = mock.fn(async () => {});
const assertLease = mock.fn(async () => {});
const releaseLease = mock.fn(async () => true);

await mock.module('@propr/core', {
    namedExports: {
        cleanupWorktree,
        describeAgentTermination: () => '',
        formatResetTime: () => '',
        generateCorrelationId: () => 'correlation',
        getAuthenticatedOctokit: async () => ({}),
        getDefaultModel: () => null,
        getPendingPrCommentsKey: () => 'pending-comments',
        handleError: () => {},
        issueQueue: { add: async () => {} },
        recordLLMMetrics: async () => {},
        resolveModelAlias: (value: string) => value,
        resolveAgentTerminationReason: () => undefined,
        TaskStates: {
            COMPLETED: 'completed',
            FAILED: 'failed',
            CANCELLED: 'cancelled',
        },
    },
});

await mock.module('../src/jobs/prProcessingLock.js', {
    namedExports: {
        assertPRProcessingLock: assertLease,
        releasePRProcessingLock: releaseLease,
    },
});

await mock.module('../src/jobs/prCommentMetrics.js', {
    namedExports: { buildMetricsSection: () => '' },
});

await mock.module('../src/jobs/prCompletionComment.js', {
    namedExports: { buildCompletionComment: () => '' },
});

await mock.module('../src/jobs/prFileUtils.js', {
    namedExports: {
        fetchPRFiles: async () => [],
        fetchPRFileContents: async () => [],
        formatPRDiff: () => '',
        formatPRDiffWithMetadata: () => '',
        formatFileContents: () => '',
        agentResultToClaudeResponse: (value: unknown) => value,
    },
});

await mock.module('../src/jobs/prCommentCommandContext.js', {
    namedExports: { applyPendingCommentCommandContext: () => {} },
});

const { cleanupJob } = await import('../src/jobs/prCommentJobUtils.js');

function cleanupOptions() {
    return {
        stateManager: {} as never,
        lockKey: 'lock:pr:owner:repo:1748',
        lockToken: 'attempt-token',
        localRepoPath: '/repo',
        worktreeInfo: { worktreePath: '/repo-attempt', branchName: 'branch' },
        repoOwner: 'owner',
        repoName: 'repo',
        pullRequestNumber: 1748,
        jobBranchName: 'branch',
        jobLlm: null,
        correlatedLogger: {
            debug: mock.fn(),
            info: mock.fn(),
            warn: mock.fn(),
        } as never,
        redisClient: { llen: async () => 0 } as never,
    };
}

beforeEach(() => {
    cleanupWorktree.mock.resetCalls();
    assertLease.mock.resetCalls();
    assertLease.mock.mockImplementation(async () => {});
    releaseLease.mock.resetCalls();
    releaseLease.mock.mockImplementation(async () => true);
});

test('never removes a worktree after lease ownership has already been lost', async () => {
    assertLease.mock.mockImplementationOnce(async () => {
        throw new Error('lease lost');
    });

    await cleanupJob(cleanupOptions());

    assert.equal(cleanupWorktree.mock.calls.length, 0);
    assert.equal(releaseLease.mock.calls.length, 0);
});

test('finishes attempt worktree cleanup before releasing the PR lease', async () => {
    let finishCleanup: (() => void) | undefined;
    cleanupWorktree.mock.mockImplementationOnce(() => new Promise<void>(resolve => {
        finishCleanup = resolve;
    }));

    const cleaning = cleanupJob(cleanupOptions());
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(cleanupWorktree.mock.calls.length, 1);
    assert.equal(releaseLease.mock.calls.length, 0);

    finishCleanup?.();
    await cleaning;

    assert.equal(releaseLease.mock.calls.length, 1);
});

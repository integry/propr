import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const cleanupWorktree = mock.fn(async () => {});
const assertLease = mock.fn(async () => {});
const releaseLease = mock.fn(async () => true);
const findRunningDockerContainerForTask = mock.fn(async () => null as { id: string; name: string } | null);
const stopDockerContainer = mock.fn(async () => ({ success: true }));

class PRProcessingLeaseLostError extends Error {}

await mock.module('@propr/core', {
    namedExports: {
        cleanupWorktree,
        describeAgentTermination: () => '',
        formatResetTime: () => '',
        findRunningDockerContainerForTask,
        generateCorrelationId: () => 'correlation',
        getAuthenticatedOctokit: async () => ({}),
        getDefaultModel: () => null,
        getPendingPrCommentsKey: () => 'pending-comments',
        handleError: () => {},
        issueQueue: { add: async () => {} },
        recordLLMMetrics: async () => {},
        resolveModelAlias: (value: string) => value,
        resolveAgentTerminationReason: () => undefined,
        stopDockerContainer,
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
        PRProcessingLeaseLostError,
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

const {
    cleanupJob,
    cleanupJobBeforeStoppingHeartbeat,
    handleJobError,
    stopAbandonedPRTaskContainer,
} = await import('../src/jobs/prCommentJobUtils.js');

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
    findRunningDockerContainerForTask.mock.resetCalls();
    findRunningDockerContainerForTask.mock.mockImplementation(async () => null);
    stopDockerContainer.mock.resetCalls();
    stopDockerContainer.mock.mockImplementation(async () => ({ success: true }));
});

test('stops an abandoned task container before allowing a successor attempt', async () => {
    findRunningDockerContainerForTask.mock.mockImplementationOnce(async () => ({
        id: 'container-1748',
        name: 'propr-task-1748',
    }));

    const canProceed = await stopAbandonedPRTaskContainer(
        'task-1748',
        cleanupOptions().correlatedLogger,
        assertLease,
    );

    assert.equal(canProceed, true);
    assert.equal(assertLease.mock.calls.length, 1);
    assert.deepEqual(stopDockerContainer.mock.calls[0].arguments, ['container-1748', 10]);
});

test('does not stop an abandoned container after startup lease ownership is lost', async () => {
    findRunningDockerContainerForTask.mock.mockImplementationOnce(async () => ({
        id: 'container-1748',
        name: 'propr-task-1748',
    }));
    assertLease.mock.mockImplementationOnce(async () => {
        throw new PRProcessingLeaseLostError('lease expired before stop');
    });

    await assert.rejects(
        stopAbandonedPRTaskContainer('task-1748', cleanupOptions().correlatedLogger, assertLease),
        /lease expired before stop/,
    );

    assert.equal(stopDockerContainer.mock.calls.length, 0);
});

test('removes its generation-specific worktree after lease ownership has been lost', async () => {
    assertLease.mock.mockImplementationOnce(async () => {
        throw new PRProcessingLeaseLostError('lease lost');
    });

    await cleanupJob(cleanupOptions());

    assert.equal(cleanupWorktree.mock.calls.length, 1);
    assert.equal(releaseLease.mock.calls.length, 0);
});

test('retries a transient Redis ownership check before releasing and queuing pending work', async () => {
    assertLease.mock.mockImplementationOnce(async () => {
        throw new Error('Redis temporarily unavailable');
    });

    await cleanupJob(cleanupOptions());

    assert.equal(assertLease.mock.calls.length, 2);
    assert.equal(releaseLease.mock.calls.length, 1);
});

test('fails cleanup durably after repeated Redis ownership-check errors', async () => {
    assertLease.mock.mockImplementation(async () => {
        throw new Error('Redis unavailable');
    });

    await assert.rejects(cleanupJob(cleanupOptions()), /Redis unavailable/);

    assert.equal(assertLease.mock.calls.length, 3);
    assert.equal(cleanupWorktree.mock.calls.length, 1);
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

test('stops the heartbeat immediately before intentionally releasing the PR lease', async () => {
    const order: string[] = [];
    cleanupWorktree.mock.mockImplementationOnce(async () => { order.push('worktree'); });
    releaseLease.mock.mockImplementationOnce(async () => {
        order.push('release');
        return true;
    });
    const stopHeartbeat = mock.fn(async () => { order.push('heartbeat'); });

    await cleanupJobBeforeStoppingHeartbeat(cleanupOptions(), stopHeartbeat);

    assert.deepEqual(order, ['worktree', 'heartbeat', 'release']);
    assert.equal(stopHeartbeat.mock.calls.length, 1);
});

test('performs no generic error side effects after the live lease is lost', async () => {
    const updateTaskState = mock.fn(async () => {});
    const request = mock.fn(async () => ({}));

    await assert.rejects(
        handleJobError(new Error('agent failed'), { name: 'processPullRequestComment', data: {} } as never, {
            pullRequestNumber: 1748,
            repoOwner: 'owner',
            repoName: 'repo',
            authorsText: '@owner',
            unprocessedComments: [],
            octokit: { request } as never,
            startingWorkComment: { data: { id: 1 } },
            claudeResult: null,
            correlationId: 'correlation',
            correlatedLogger: cleanupOptions().correlatedLogger,
            stateManager: {
                getTaskState: async () => ({
                    state: 'processing',
                    prProcessingLockToken: 'attempt-token',
                }),
                updateTaskState,
            } as never,
            taskId: 'task-1748',
            prProcessingLockToken: 'attempt-token',
            assertLease: async () => { throw new Error('lease lost'); },
        }),
        /lease lost/,
    );

    assert.equal(updateTaskState.mock.calls.length, 0);
    assert.equal(request.mock.calls.length, 0);
});

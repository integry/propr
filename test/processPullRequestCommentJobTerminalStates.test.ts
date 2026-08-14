import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';
import { getTerminalJobResultForAutomaticRetry } from '../packages/core/src/utils/workerStateManagerHelpers.js';
import type { TaskStateData } from '../packages/core/src/utils/workerStateManager.types.js';

const mockOctokit = {
    request: mock.fn(async () => ({ data: {} })),
    auth: mock.fn(async () => ({ token: 'github-token' })),
};
const mockGetAuthenticatedOctokit = mock.fn(async () => mockOctokit);
const mockEnsureRepoCloned = mock.fn(async () => '/tmp/repo');
const mockCreateWorktreeFromExistingBranch = mock.fn(async () => ({
    worktreePath: '/tmp/worktree', branchName: 'feature-branch',
}));
const mockEnsureGitRepository = mock.fn(async () => undefined);
const mockResolveAndExecuteAgent = mock.fn(async () => ({
    claudeResult: { success: true }, agentType: 'codex',
}));
const mockExecuteReviewProcessing = mock.fn(async () => ({ status: 'complete' }));
const mockHandlePostExecution = mock.fn(async () => ({ partial: false, commitHash: 'commit' }));
const mockCleanupJob = mock.fn(async () => undefined);

let createdState: TaskStateData;
const mockStateManager = {
    createTaskState: mock.fn(async () => createdState),
    getTerminalJobResultForAutomaticRetry: mock.fn(async (
        taskId: string,
        state: TaskStateData,
        attempt: Parameters<typeof getTerminalJobResultForAutomaticRetry>[2],
    ) => getTerminalJobResultForAutomaticRetry(
        taskId,
        state,
        attempt,
        async (updatedTaskId, newState, metadata) => {
            await mockStateManager.updateTaskState(updatedTaskId, newState, metadata);
            return { ...state, state: newState };
        },
    )),
    updateTaskState: mock.fn(async () => undefined),
    updateHistoryMetadata: mock.fn(async () => undefined),
    getTaskState: mock.fn(async () => null),
};

const mockLogger = {
    debug: mock.fn(),
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
};

await mock.module('ioredis', {
    namedExports: {
        Redis: function Redis() {
            return { on: mock.fn() };
        },
    },
});

await mock.module('bullmq', {
    namedExports: { Job: class Job {} },
});

await mock.module('@propr/core', {
    namedExports: {
        findRunningDockerContainerForTask: mock.fn(async () => null),
        getAuthenticatedOctokit: mockGetAuthenticatedOctokit,
        hashTaskAttemptToken: mock.fn(() => 'attempt-token'),
        inspectLegacyDockerContainerLivenessForTask: mock.fn(async () => 'not_found'),
        logger: { ...mockLogger, withCorrelation: mock.fn(() => mockLogger) },
        retryConfigs: { githubApi: {} },
        runWithExecutionAbortSignal: mock.fn(async (_signal, operation) => operation()),
        withRetry: mock.fn(async (operation) => operation()),
        getStateManager: mock.fn(() => mockStateManager),
        TaskStates: {
            PROCESSING: 'processing',
            CLAUDE_EXECUTION: 'claude_execution',
            COMPLETED: 'completed',
            FAILED: 'failed',
            CANCELLED: 'cancelled',
        },
        ensureRepoCloned: mockEnsureRepoCloned,
        createWorktreeFromExistingBranch: mockCreateWorktreeFromExistingBranch,
        getRepoUrl: mock.fn(() => 'https://github.com/test-owner/test-repo.git'),
        ensureGitRepository: mockEnsureGitRepository,
        createLogFiles: mock.fn(async () => undefined),
        UsageLimitError: class UsageLimitError extends Error {},
        recordLLMMetrics: mock.fn(async () => undefined),
        issueQueue: { add: mock.fn(async () => undefined) },
        loadPrimaryProcessingLabels: mock.fn(async () => ['AI']),
    },
});

await mock.module('../src/jobs/prCommentJobHelpers.js', {
    namedExports: {
        validateAndFilterComments: mock.fn(async (comments) => comments),
        filterUnprocessedComments: mock.fn((comments) => comments),
        fetchLinkedIssueContext: mock.fn(async () => ({ linkedIssueNumber: null })),
        buildCommentHistory: mock.fn(() => ''),
        updateTaskTitleForPR: mock.fn(async () => undefined),
        resolvePrReasoningLevelOverride: mock.fn(() => undefined),
    },
});

await mock.module('../src/jobs/issueJobHelpers.js', {
    namedExports: { localizeContentImages: mock.fn(async (body) => body) },
});

await mock.module('../src/jobs/prCommentJobUtils.js', {
    namedExports: {
        buildCombinedComment: mock.fn(() => ({ combinedCommentBody: '', combinedBodyHtml: '', commentAuthors: [] })),
        extractModelFromLabels: mock.fn((_labels, llm) => llm),
        fetchAllComments: mock.fn(async () => []),
        buildPrompt: mock.fn(() => ''),
        handleJobError: mock.fn(async () => undefined),
        cleanupJob: mockCleanupJob,
        toClaudeResult: mock.fn((result) => result),
    },
});

await mock.module('../src/jobs/prPendingComments.js', {
    namedExports: {
        pickUpPendingCommentsWithClaim: mock.fn(async (commentsToProcess) => ({
            commentsToProcess, pickedUpComments: [],
        })),
        applyPendingCommentCommandContext: mock.fn(),
    },
});

await mock.module('../src/jobs/prCommentReviewJob.js', {
    namedExports: { executeReviewProcessing: mockExecuteReviewProcessing },
});

await mock.module('../src/jobs/prCommentAgentUtils.js', {
    namedExports: {
        generateSummaryTitle: mock.fn(async () => 'Summary'),
        resolveAndExecuteAgent: mockResolveAndExecuteAgent,
        resolvePRCommentModelName: mock.fn(async () => 'gpt-5.6'),
    },
});

await mock.module('../src/jobs/reviewCommentFormatter.js', {
    namedExports: { isReviewComment: mock.fn(() => false) },
});

await mock.module('../src/jobs/reviewFindingSelector.js', {
    namedExports: {
        hasAuthorizedFixFeedback: mock.fn(() => true),
        prepareFixReviewFeedback: mock.fn(async () => ({
            isFixMode: false,
            fixSelection: {},
            selectedReviewComments: [],
            reviewCommentsSection: '',
        })),
    },
});

await mock.module('../src/jobs/ultrafixOrchestrationService.js', {
    namedExports: { retainOriginalScope: mock.fn(async (_redis, options) => options.scope) },
});

await mock.module('../src/jobs/ultrafixJobHelpers.js', {
    namedExports: {
        handleUltrafixContinuation: mock.fn(async () => undefined),
        markSelectedUltrafixFindings: mock.fn(async () => undefined),
        restorePendingCommentsIfUltrafixJobSuperseded: mock.fn(async () => false),
    },
});

await mock.module('../src/jobs/ultrafixReviewExecutionGate.js', {
    namedExports: { shouldDeferUltrafixReview: mock.fn(async () => false) },
});

await mock.module('../src/jobs/prCommentNoAuthorizedFindings.js', {
    namedExports: { handleNoAuthorizedFindings: mock.fn(async () => undefined) },
});

await mock.module('../src/jobs/prCommentPostExecution.js', {
    namedExports: { handlePostExecution: mockHandlePostExecution },
});

await mock.module('../src/jobs/prTaskTitleHelpers.js', {
    namedExports: {
        buildDeterministicPrTaskSubtitle: mock.fn(() => 'Follow-up changes'),
        buildPrTaskTitle: mock.fn(() => 'PR #1899'),
        buildPrTaskTitleContext: mock.fn(() => ({ context: '', sources: [] })),
        buildPrTaskTitleContextHistoryMetadata: mock.fn(() => ({})),
        getPrTaskWorkflowLabel: mock.fn(() => 'Follow-up'),
        resolvePrTaskWorkflow: mock.fn(() => 'followup'),
    },
});

await mock.module('../src/jobs/prProcessingLock.js', {
    namedExports: {
        acquirePRProcessingLock: mock.fn(async () => true),
        ensurePRProcessingLockToken: mock.fn(async () => 'lock-token'),
        releasePRProcessingLock: mock.fn(async () => true),
        startPRProcessingLockHeartbeat: mock.fn(() => async () => undefined),
    },
});

await mock.module('../src/shared/workEvidenceMarker.js', {
    namedExports: {
        buildWorkEvidenceMarker: mock.fn(() => ''),
        filterRealComments: mock.fn((comments) => comments),
    },
});

const { processPullRequestCommentJob } = await import('../src/jobs/processPullRequestCommentJob.js');

function makeTaskState(state: 'completed' | 'failed'): TaskStateData {
    const timestamp = '2026-08-14T12:00:00.000Z';
    return {
        taskId: 'pr-comment-job-1899',
        issueRef: {
            type: 'pr_comment',
            number: 1899,
            repoOwner: 'integry',
            repoName: 'propr',
            jobId: 'pr-comment-job-1899',
        },
        correlationId: 'correlation-1899',
        state,
        createdAt: timestamp,
        updatedAt: timestamp,
        attempts: 1,
        history: [],
    };
}

function createJob(attemptsMade = 0, attempts = 2) {
    const data = {
        pullRequestNumber: 1899,
        repoOwner: 'integry',
        repoName: 'propr',
        correlationId: 'correlation-1899',
        commentId: 100,
        commentBody: 'Apply the release-gate regressions',
        commentAuthor: 'integry',
        branchName: 'feature-branch',
        commandMode: 'default' as const,
    };
    return {
        id: 'pr-comment-job-1899',
        attemptsMade,
        opts: { attempts },
        name: 'processPullRequestComment',
        data,
        updateData: mock.fn(async (nextData: typeof data) => Object.assign(data, nextData)),
    } as never;
}

function resetExternalWorkMocks(): void {
    for (const fn of [
        mockOctokit.request,
        mockOctokit.auth,
        mockGetAuthenticatedOctokit,
        mockEnsureRepoCloned,
        mockCreateWorktreeFromExistingBranch,
        mockEnsureGitRepository,
        mockResolveAndExecuteAgent,
        mockExecuteReviewProcessing,
        mockHandlePostExecution,
        mockStateManager.updateTaskState,
        mockCleanupJob,
    ]) fn.mock.resetCalls();
    mockStateManager.createTaskState.mock.resetCalls();
    mockStateManager.getTerminalJobResultForAutomaticRetry.mock.resetCalls();
}

function assertNoExternalWork(): void {
    assert.equal(mockGetAuthenticatedOctokit.mock.callCount(), 0);
    assert.equal(mockOctokit.auth.mock.callCount(), 0);
    assert.equal(mockOctokit.request.mock.callCount(), 0);
    assert.equal(mockStateManager.updateTaskState.mock.callCount(), 0);
    assert.equal(mockEnsureGitRepository.mock.callCount(), 0);
    assert.equal(mockEnsureRepoCloned.mock.callCount(), 0);
    assert.equal(mockCreateWorktreeFromExistingBranch.mock.callCount(), 0);
    assert.equal(mockExecuteReviewProcessing.mock.callCount(), 0);
    assert.equal(mockResolveAndExecuteAgent.mock.callCount(), 0);
    assert.equal(mockHandlePostExecution.mock.callCount(), 0);
}

describe('processPullRequestCommentJob terminal createTaskState results', () => {
    beforeEach(resetExternalWorkMocks);

    test('returns an idempotently created completed task before external work', async () => {
        createdState = makeTaskState('completed');

        const result = await processPullRequestCommentJob(createJob());

        assert.deepEqual(result, {
            status: 'complete',
            reason: 'task_already_completed',
            pullRequestNumber: 1899,
        });
        assert.equal(mockStateManager.createTaskState.mock.callCount(), 1);
        assertNoExternalWork();
    });

    test('returns an exhausted matching failed task before external work', async () => {
        createdState = makeTaskState('failed');

        const result = await processPullRequestCommentJob(createJob(2, 2));

        assert.deepEqual(result, {
            status: 'failed',
            reason: 'task_already_failed',
            pullRequestNumber: 1899,
        });
        assert.equal(mockStateManager.createTaskState.mock.callCount(), 1);
        assertNoExternalWork();
    });
});

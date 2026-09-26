import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

let events: string[] = [];
let continuation: { source_pr: number; continuation_pr: number; branch_name: string; publication_bundle?: string; publication_completion?: string } | undefined;
let preparationError: Error | undefined;
let onLockAcquired: (() => void) | undefined;
let blockedLock: string | undefined;
let resolutionError: Error | undefined;
let handledStartingComment: unknown;
let handledTaskIds: string[] = [];
let onPrepare: (() => void) | undefined;
let onTaskStateRead: ((taskId: string) => void) | undefined;
const log = { info() {}, warn() {}, error() {}, debug() {} };
const taskStates = new Map<string, string>();
const stateManager = {
    updateTaskState: async (taskId: string, state: string, metadata?: { isRetry?: boolean }) => {
        taskStates.set(taskId, state);
        events.push(`state:${taskId}:${state}${metadata?.isRetry ? ':retry' : ''}`);
    },
    getTaskState: async (taskId: string) => {
        const current = taskStates.has(taskId) ? { state: taskStates.get(taskId) } : null;
        onTaskStateRead?.(taskId);
        return current;
    },
};
const octokit = {
    auth: async () => ({ token: 'fixture-token' }),
    request: async (route: string, params: Record<string, unknown>) => {
        if (route.startsWith('POST')) {
            events.push(`comment:${params.issue_number}`);
            return { data: { id: 123, html_url: 'https://github.com/upstream/project/issues/42#issuecomment-123' } };
        }
        return { data: { head: { ref: 'fork-branch' }, labels: [{ name: 'propr' }], title: 'Contribution', body: '', user: { login: 'contributor' } } };
    },
};
const noOp = async () => {};
await mock.module('ioredis', { namedExports: { Redis: class {} } });
await mock.module('@propr/core', { namedExports: {
    getAuthenticatedOctokit: async () => octokit,
    hashTaskAttemptToken: () => 'hash', logger: { ...log, withCorrelation: () => log },
    retryConfigs: { githubApi: {} }, withRetry: async (fn: () => unknown) => fn(),
    runWithExecutionAbortSignal: async (_signal: unknown, fn: () => unknown) => fn(),
    getStateManager: () => stateManager, TaskStates: { PROCESSING: 'processing', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
    ensureGitRepository: noOp, createLogFiles: noOp, UsageLimitError: class extends Error {},
    recordLLMMetrics: noOp, loadPrimaryProcessingLabels: async () => ['propr'],
    loadRepositoryVisualPreviewSettings: noOp,
} });
const modules: Record<string, Record<string, unknown>> = {
    prCommentJobHelpers: {
        validateAndFilterComments: async (comments: unknown) => comments,
        filterUnprocessedComments: (comments: unknown) => comments,
        fetchLinkedIssueContext: async () => ({ context: '' }), buildCommentHistory: () => '',
        updateTaskTitleForPR: noOp, resolvePrReasoningLevelOverride: () => undefined,
    },
    issueJobHelpers: { localizeContentImages: noOp },
    // The follow-up CI suspension is covered by test/followupCiSuspension.test.ts.
    followupCiSuspension: { suspendObsoleteValidationForImplementation: noOp, releaseFollowupCiSuspensionsForTask: noOp },

    prCommentJobUtils: {
        buildCombinedComment: () => ({ combinedCommentBody: 'Implement', commentAuthors: ['contributor'] }),
        extractModelFromLabels: () => 'model', fetchAllComments: async () => [], buildPrompt: () => '',
        handleJobError: async (_error: Error, _job: unknown, context: { startingWorkComment: unknown; taskId: string }) => {
            handledStartingComment = context.startingWorkComment;
            handledTaskIds.push(context.taskId);
            await stateManager.updateTaskState(context.taskId, 'failed');
        },
        cleanupJob: noOp, toClaudeResult: noOp, buildStartingWorkCommentBody: () => 'Starting work',
    },
    prPendingComments: {
        restorePendingComments: noOp,
        pickUpPendingCommentsWithClaim: async (comments: unknown) => ({ commentsToProcess: comments, pickedUpComments: [] }),
        applyPendingCommentCommandContext: noOp,
    },
    prCommentReviewJob: { executeReviewProcessing: async (params: { context: { pullRequestNumber: number } }) => { events.push(`review:${params.context.pullRequestNumber}`); return { status: 'complete' }; } },
    prCommentAgentUtils: { generateSummaryTitle: noOp, resolveAndExecuteAgent: async () => { events.push('agent'); }, resolvePRCommentModelName: async () => 'model' },
    reviewCommentFormatter: { isReviewComment: () => false },
    reviewFindingSelector: { hasAuthorizedFixFeedback: () => true, prepareFixReviewFeedback: async () => ({ isFixMode: false, selectedReviewComments: [] }) },
    ultrafixOrchestrationService: { retainOriginalScope: noOp, stopLoop: async () => { events.push('stop'); } },
    ultrafixJobHelpers: { handleUltrafixContinuation: noOp, markSelectedUltrafixFindings: noOp, restorePendingCommentsIfUltrafixJobSuperseded: async () => false },
    ultrafixReviewExecutionGate: { shouldDeferUltrafixReview: async () => { events.push('check-gate'); return false; } },
    prCommentNoAuthorizedFindings: { handleNoAuthorizedFindings: noOp },
    prCommentPostExecution: { handlePostExecution: noOp },
    prTaskTitleHelpers: Object.fromEntries(['buildDeterministicPrTaskSubtitle', 'buildPrTaskTitle', 'buildPrTaskTitleContext', 'buildPrTaskTitleContextHistoryMetadata', 'getPrTaskWorkflowLabel', 'resolvePrTaskWorkflow'].map(name => [name, noOp])),
    prProcessingLock: {
        acquirePRProcessingLock: async (_redis: unknown, key: string) => { events.push(key); if (key === blockedLock) return false; onLockAcquired?.(); return true; },
        ensurePRProcessingLockToken: async () => 'token', releasePRProcessingLock: async (_redis: unknown, key: string) => { events.push(`release:${key}`); },
        startPRProcessingLockHeartbeat: () => noOp,
    },
    prCommentCollisionRecovery: { createPRCommentTaskStateIfMissing: noOp, evaluatePRCommentPreExecutionRecovery: async () => ({}), handlePRCommentLockContention: async () => ({ status: 'deferred' }) },
    prPublication: { PullRequestPublication: class {
        status = '';
        continuation: typeof continuation;
        get pendingCompletion() { return this.continuation?.publication_completion ? JSON.parse(this.continuation.publication_completion) : undefined; }
        async reconcilePublication() { events.push('reconcile'); }
        async announce() {}
        async prepare(_name: string, options?: { beforePublish?: () => Promise<void> }) {
            events.push('prepare'); onPrepare?.();
            if (preparationError) throw preparationError;
            // The real prepare() runs the guard after worktree creation, right before the checkpoint push.
            await options?.beforePublish?.();
            events.push('publish');
            return { localRepoPath: '/repo', worktreeInfo: { worktreePath: '/worktree', branchName: 'continuation' } };
        }
    } },
    prContinuation: {
        savePublicationCheckpoint: async (record: NonNullable<typeof continuation>, bundle: string | null, completion?: string | null) => {
            events.push(`checkpoint:${bundle}:${completion}`);
            record.publication_bundle = bundle ?? undefined;
            if (completion !== undefined) record.publication_completion = completion ?? undefined;
        },
        findPRContinuation: async () => { if (resolutionError) throw resolutionError; return continuation; },
        continuationStatus: () => 'Continue at https://github.com/upstream/project/pull/100',
    },
};
for (const [name, namedExports] of Object.entries(modules)) {
    await mock.module(`../src/jobs/${name}.js`, { namedExports });
}
const { processPullRequestCommentJob } = await import('../src/jobs/processPullRequestCommentJob.js');
const job = (commandMode = 'default', pullRequestNumber = 42) => ({
    id: 'task-1', updateData: noOp,
    data: { repoOwner: 'upstream', repoName: 'project', pullRequestNumber, commandMode, correlationId: 'correlation', commentId: 5, commentBody: 'Implement', commentAuthor: 'contributor' },
});
beforeEach(() => {
    onLockAcquired = undefined; blockedLock = undefined; resolutionError = undefined; taskStates.clear();
    events = []; continuation = undefined; preparationError = undefined; handledStartingComment = undefined;
    handledTaskIds = []; onPrepare = undefined; onTaskStateRead = undefined;
});

for (const error of ['Preflight network error', 'Continuation creation failed']) {
    test(`${error} leaves a starting comment available to the error handler`, async () => {
        preparationError = new Error(error);
        await assert.rejects(processPullRequestCommentJob(job() as never), new RegExp(error));
        assert.ok(events.indexOf('comment:42') < events.indexOf('prepare'));
        assert.deepEqual(handledStartingComment, { data: { id: 123, html_url: 'https://github.com/upstream/project/issues/42#issuecomment-123' } });
        assert.ok(!events.includes('agent'));
    });
}

const savedStartingComment = { data: { id: 777, html_url: 'https://github.com/upstream/project/pull/42#issuecomment-777' } };
const pendingCompletion = () => {
    continuation = {
        source_pr: 42, continuation_pr: 100, branch_name: 'continuation', publication_bundle: 'bundle',
        publication_completion: JSON.stringify({ taskId: 'task-1', authorsText: '@contributor', unprocessedComments: [{ id: 5 }], startingWorkComment: savedStartingComment, jobData: {} }),
    };
    taskStates.set('task-1', 'failed');
};
for (const retryTaskId of ['task-1', 'replacement-task']) {
    test(`recovery preparation failure reaches the saved originating comment on retry ${retryTaskId}`, async () => {
        pendingCompletion();
        preparationError = new Error('Continuation creation failed');
        await assert.rejects(processPullRequestCommentJob({ ...job(), id: retryTaskId } as never), /Continuation creation failed/);
        assert.deepEqual(handledStartingComment, savedStartingComment);
        assert.ok(!events.includes('comment:42'));
        assert.ok(events.indexOf('state:task-1:processing:retry') < events.indexOf('reconcile'));
        assert.ok(events.indexOf('reconcile') < events.indexOf('prepare'));
        assert.ok(!events.includes('agent'));
        // Both the originating task and the triggering task end the attempt final.
        assert.deepEqual(handledTaskIds, [retryTaskId]);
        assert.equal(taskStates.get('task-1'), 'failed');
        assert.equal(taskStates.get(retryTaskId), 'failed');
        assert.equal(events.filter(event => event === 'state:task-1:failed').length, 1);
        if (retryTaskId !== 'task-1') assert.ok(events.indexOf('state:task-1:failed') < events.indexOf(`state:${retryTaskId}:failed`));
    });
}

test('recovery failure leaves an originating task cancelled during recovery untouched', async () => {
    pendingCompletion();
    onPrepare = () => { taskStates.set('task-1', 'cancelled'); };
    preparationError = new Error('Continuation creation failed');
    await assert.rejects(processPullRequestCommentJob({ ...job(), id: 'replacement-task' } as never), /Continuation creation failed/);
    assert.equal(taskStates.get('task-1'), 'cancelled');
    assert.ok(!events.includes('state:task-1:failed'));
    assert.deepEqual(handledTaskIds, ['replacement-task']);
});

// A /fix request on the original ends deterministically after recovery, which shows the
// replacement request continued as a fresh one instead of inheriting the retired checkpoint.
test('cancellation after the initial checkpoint read retires the checkpoint before preparation', async () => {
    pendingCompletion();
    let reads = 0;
    onTaskStateRead = taskId => { if (taskId === 'task-1' && ++reads === 1) taskStates.set('task-1', 'cancelled'); };
    const result = await processPullRequestCommentJob({ ...job('fix'), id: 'replacement-task' } as never);
    assert.equal(result.reason, 'review_moved_to_continuation');
    assert.ok(events.includes('checkpoint:null:null'));
    assert.equal(continuation?.publication_bundle, undefined);
    assert.equal(continuation?.publication_completion, undefined);
    assert.ok(!events.includes('reconcile'));
    assert.ok(!events.includes('prepare'));
    assert.ok(!events.includes('state:task-1:processing:retry'));
    assert.ok(!events.includes('state:task-1:failed'));
    assert.equal(taskStates.get('task-1'), 'cancelled');
    assert.deepEqual(handledTaskIds, []);
});

test('cancellation during preparation stops the recovery push and retires the checkpoint', async () => {
    pendingCompletion();
    onPrepare = () => { taskStates.set('task-1', 'cancelled'); };
    const result = await processPullRequestCommentJob({ ...job('fix'), id: 'replacement-task' } as never);
    assert.equal(result.reason, 'review_moved_to_continuation');
    assert.ok(events.indexOf('prepare') < events.indexOf('checkpoint:null:null'));
    assert.ok(!events.includes('publish'));
    assert.equal(continuation?.publication_bundle, undefined);
    assert.equal(continuation?.publication_completion, undefined);
    assert.ok(!events.includes('state:task-1:failed'));
    assert.equal(taskStates.get('task-1'), 'cancelled');
    assert.deepEqual(handledTaskIds, []);
});

for (const mode of ['review', 'fix']) {
    test(`${mode} on the original shares the source lock and stops before agent execution`, async () => {
        continuation = { source_pr: 42, continuation_pr: 100, branch_name: 'continuation' };
        const result = await processPullRequestCommentJob(job(mode) as never);
        assert.equal(result.reason, 'review_moved_to_continuation');
        assert.ok(events.includes('lock:pr:upstream:project:42'));
        assert.ok(events.includes('stop'));
        assert.ok(events.includes('comment:42'));
        assert.ok(!events.includes('review:42'));
        assert.ok(!events.includes('agent'));
        assert.ok(!events.includes('check-gate'));
    });
}

test('review on the continuation keeps its own PR context and exact-head check gate', async () => {
    continuation = { source_pr: 42, continuation_pr: 100, branch_name: 'continuation' };
    await processPullRequestCommentJob(job('review', 100) as never);
    assert.ok(events.includes('lock:pr:upstream:project:42'));
    assert.ok(events.includes('check-gate'));
    assert.ok(events.includes('review:100'));
    assert.ok(!events.includes('stop'));
});

for (const contended of [false, true]) {
    test(`mapping resolved after acquisition reacquires the source lock before processing (contention: ${contended})`, async () => {
        onLockAcquired = () => { continuation = { source_pr: 42, continuation_pr: 100, branch_name: 'continuation' }; };
        if (contended) blockedLock = 'lock:pr:upstream:project:42';
        const result = await processPullRequestCommentJob(job('review', 100) as never);
        assert.deepEqual(events.slice(0, 3), ['lock:pr:upstream:project:100', 'release:lock:pr:upstream:project:100', 'lock:pr:upstream:project:42']);
        assert.equal(result.status, contended ? 'deferred' : 'complete');
        assert.equal(events.includes('review:100'), !contended);
        assert.ok(!events.includes('agent'));
    });
}

test('failed mapping revalidation releases the acquired lock without processing', async () => {
    onLockAcquired = () => { resolutionError = new Error('Mapping lookup failed'); };
    await assert.rejects(processPullRequestCommentJob(job('review', 100) as never), /Mapping lookup failed/);
    assert.deepEqual(events, ['lock:pr:upstream:project:100', 'release:lock:pr:upstream:project:100']);
});

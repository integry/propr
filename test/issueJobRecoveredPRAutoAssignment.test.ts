import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';
import * as pushSalvageExports from '../packages/core/src/git/pushSalvage.js';

/**
 * A pull request published through final validation's recovery paths (found
 * after post-processing missed it, or created by the API retry) receives the
 * same auto-assignment as one published by post-processing.
 */

type PRInfo = { number: number; url: string; title: string };

let validation: { isValid: boolean; pr?: PRInfo } = { isValid: false };
const validatePRCreation = mock.fn(async () => validation);
const safeUpdateLabels = mock.fn(async () => ({ success: true, removed: [], added: ['AI-done'], errors: [] }));
const linkPRToPlanIssue = mock.fn(async () => undefined);

const retryOctokit = {
    create: (async () => ({ data: { number: 77 } })) as () => Promise<{ data: { number: number } }>,
    existing: [] as Array<{ number: number }>,
    async request(route: string) {
        if (route === 'POST /repos/{owner}/{repo}/pulls') return await this.create();
        if (route === 'GET /repos/{owner}/{repo}/pulls') return { data: this.existing };
        throw new Error(`Unexpected route ${route}`);
    },
};

await mock.module('@propr/core', {
    namedExports: {
        ...pushSalvageExports,
        AI_COMMIT_AUTHOR: { name: 'ProPR AI', email: 'ai@propr.dev' },
        pushBranch: mock.fn(),
        loadRepositoryVisualPreviewSettings: mock.fn(),
        cleanupWorktree: mock.fn(async () => undefined),
        cleanupPreparedVisualPreviewEvidence: mock.fn(async () => undefined),
        commitChanges: mock.fn(),
        prepareVisualPreviewEvidence: mock.fn(),
        TaskStates: { CANCELLED: 'cancelled' },
        describeAgentTermination: mock.fn(() => ''),
        resolveAgentTerminationReason: mock.fn(() => undefined),
        sanitizeAgentReport: (value: string | null | undefined) => value ?? '',
        getAuthenticatedOctokit: mock.fn(async () => retryOctokit),
        linkPRToPlanIssue,
        safeUpdateLabels,
        generateCompletionComment: mock.fn(),
        redactSecrets: (value: string) => value,
        validatePRCreation,
    },
});

await mock.module('../src/jobs/issueJobHelpers.js', {
    namedExports: { createPullRequest: mock.fn(), ensureEpicBaseBranchExists: mock.fn() },
});

await mock.module('../src/jobs/issueJobPostProcessingHelpers.js', {
    namedExports: { handleCreatedPlanIssuePR: mock.fn(), handleNoCodeChanges: mock.fn() },
});

const autoAssignCompletedPullRequest = mock.fn(async (_context: Record<string, unknown>, _published: { pr?: { number?: number } | null } | null) => undefined);
await mock.module('../src/jobs/issueJobAutoAssignment.js', {
    namedExports: { autoAssignCompletedPullRequest },
});

const { handlePRValidation } = await import('../src/jobs/issueJobPostProcessing.js');

const logger = { debug: mock.fn(), info: mock.fn(), warn: mock.fn(), error: mock.fn() } as never;
const octokit = { request: mock.fn(async () => ({ data: {} })) };
const stateManager = { getTaskState: mock.fn(), updateTaskState: mock.fn() };
const currentIssueData = { data: { user: { login: 'alice' } } };

function validate(postProcessingResult: { success: boolean; pr: PRInfo | null; updatedLabels: string[] } | null) {
    return handlePRValidation({
        claudeResult: { success: true } as never,
        worktreeInfo: { worktreePath: '/tmp/worktree', branchName: 'issue-12' } as never,
        issueRef: { repoOwner: 'integry', repoName: 'propr', number: 12 } as never,
        octokit,
        postProcessingResult,
        commitResult: { commitHash: 'abc' } as never,
        repoValidation: { isValid: true, repoData: { defaultBranch: 'main' } } as never,
        AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done',
        correlationId: 'corr', correlatedLogger: logger, jobId: 'job-1',
        taskId: 'task-1', stateManager: stateManager as never, currentIssueData,
    });
}

function assignedPrNumbers(): Array<number | undefined> {
    return autoAssignCompletedPullRequest.mock.calls.map(call => call.arguments[1]?.pr?.number ?? undefined);
}

beforeEach(() => {
    validation = { isValid: false };
    retryOctokit.create = async () => ({ data: { number: 77 } });
    retryOctokit.existing = [];
    autoAssignCompletedPullRequest.mock.resetCalls();
    linkPRToPlanIssue.mock.resetCalls();
    linkPRToPlanIssue.mock.mockImplementation(async () => undefined);
});

describe('handlePRValidation auto-assignment of a recovered pull request', () => {
    test('assigns a pull request final validation finds after post-processing missed it', async () => {
        validation = { isValid: true, pr: { number: 55, url: 'https://github.com/integry/propr/pull/55', title: 'Fix' } };
        const result = await validate({ success: false, pr: null, updatedLabels: [] });

        assert.equal(result?.pr?.number, 55);
        assert.deepEqual(assignedPrNumbers(), [55]);
        const [context] = autoAssignCompletedPullRequest.mock.calls[0].arguments;
        assert.equal(context.taskId, 'task-1');
        assert.equal(context.stateManager, stateManager);
        assert.equal(context.currentIssueData, currentIssueData);
        assert.equal(context.octokit, octokit);
    });

    test('assigns a pull request the API retry creates', async () => {
        await validate(null);
        assert.deepEqual(assignedPrNumbers(), [77]);
    });

    test('assigns the existing pull request the API retry finds after GitHub reports a duplicate', async () => {
        retryOctokit.create = async () => { throw Object.assign(new Error('A pull request already exists'), { status: 422 }); };
        retryOctokit.existing = [{ number: 81 }];
        await validate(null);
        assert.deepEqual(assignedPrNumbers(), [81]);
    });

    test('still assigns a retried pull request when linking it to the plan fails', async () => {
        linkPRToPlanIssue.mock.mockImplementation(async () => { throw new Error('db down'); });
        await validate(null);
        assert.deepEqual(assignedPrNumbers(), [77]);
    });

    test('passes no pull request when the API retry fails', async () => {
        retryOctokit.create = async () => { throw Object.assign(new Error('Server error'), { status: 500 }); };
        await validate(null);
        assert.deepEqual(assignedPrNumbers(), [undefined]);
    });

    test('does not assign again a pull request post-processing already published', async () => {
        const pr = { number: 55, url: 'https://github.com/integry/propr/pull/55', title: 'Fix' };
        validation = { isValid: true, pr };
        await validate({ success: true, pr, updatedLabels: ['AI-done'] });
        assert.equal(autoAssignCompletedPullRequest.mock.callCount(), 0);
    });
});

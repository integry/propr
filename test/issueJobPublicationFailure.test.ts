import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import * as pushSalvageExports from '../packages/core/src/git/pushSalvage.js';

// Issue #3688: a run that committed work but opened no pull request was reported
// as a successful "no changes" run. These tests pin both publication outcomes.

const COMMIT = { commitHash: 'c1e1862e3c7a007cb38c7931e7ae15273ad14ec8', commitMessage: 'Fix it', filesChanged: ['src/a.ts'] };
const commitChanges = mock.fn(async (): Promise<typeof COMMIT | null> => COMMIT);
const pushBranch = mock.fn(async () => undefined);
const safeUpdateLabels = mock.fn(async () => ({ success: true, removed: ['AI-processing'], added: [], errors: [] }));
const generateCompletionComment = mock.fn(async () => 'Generated report.');
const createPullRequest = mock.fn(async (): Promise<unknown> => ({ success: true, pr: { number: 9, url: 'https://github.com/owner/repo/pull/9', title: 'PR' }, updatedLabels: [] }));
const handleNoCodeChanges = mock.fn(async () => ({ success: true, pr: null, updatedLabels: ['AI-done'] }));
const validatePRCreation = mock.fn(async () => ({ isValid: false, pr: null }));
const retryPRCreationViaAPI = mock.fn(async (): Promise<{ number: number } | null> => null);

await mock.module('timers/promises', { namedExports: { setTimeout: async () => undefined } });

await mock.module('@propr/core', {
    namedExports: {
        ...pushSalvageExports,
        cleanupWorktree: mock.fn(async () => undefined),
        cleanupPreparedVisualPreviewEvidence: mock.fn(async () => undefined),
        commitChanges,
        prepareVisualPreviewEvidence: mock.fn(async () => ({ evidence: { assets: [], toolSuggestions: [] } })),
        pushBranch,
        AI_COMMIT_AUTHOR: { name: 'ProPR AI', email: 'ai@propr.dev' },
        TaskStates: { CANCELLED: 'cancelled' },
        describeAgentTermination: mock.fn(() => 'Agent stopped.'),
        resolveAgentTerminationReason: mock.fn(() => undefined),
        getAuthenticatedOctokit: mock.fn(),
        linkPRToPlanIssue: mock.fn(async () => undefined),
        safeUpdateLabels,
        generateCompletionComment,
        sanitizeAgentReport: (value: string | null | undefined) => value ?? '',
        redactSecrets: (value: string) => value,
        validatePRCreation,
    },
});

await mock.module('../src/jobs/issueJobHelpers.js', {
    namedExports: { createPullRequest, ensureEpicBaseBranchExists: mock.fn(async () => undefined) },
});

await mock.module('../src/jobs/issueJobPostProcessingHelpers.js', {
    namedExports: { handleCreatedPlanIssuePR: mock.fn(async () => undefined), handleNoCodeChanges },
});

await mock.module('../src/jobs/issueJobAutoAssignment.js', {
    namedExports: { autoAssignCompletedPullRequest: mock.fn(async () => undefined) },
});

await mock.module('../src/jobs/issueJobPRRetry.js', { namedExports: { retryPRCreationViaAPI } });

const { performPostProcessing, handlePRValidation } = await import('../src/jobs/issueJobPostProcessing.js');

const logger = { debug: mock.fn(), info: mock.fn(), warn: mock.fn(), error: mock.fn() } as never;
const issueRef = { repoOwner: 'owner', repoName: 'repo', number: 3620 } as never;
const worktreeInfo = { worktreePath: '/tmp/worktree', branchName: '3620/fix' };

function successfulAgentResult() {
    return { success: true, executionTime: 10, output: null, logs: '', modifiedFiles: [], commitMessage: 'Fix it', summary: 'I fixed it.' };
}

function reset() {
    for (const fn of [commitChanges, pushBranch, safeUpdateLabels, generateCompletionComment, createPullRequest, handleNoCodeChanges, validatePRCreation, retryPRCreationViaAPI]) fn.mock.resetCalls();
    commitChanges.mock.mockImplementation(async () => COMMIT);
}

function run(request: ReturnType<typeof mock.fn>) {
    return performPostProcessing({
        octokit: { request, auth: async () => ({ token: 'github-token' }) } as never,
        issueRef,
        worktreeInfo,
        currentIssueData: { data: { title: 'Fix startup', labels: [{ name: 'AI' }] } },
        claudeResult: successfulAgentResult(),
        modelName: 'claude-test',
        repoValidation: { isValid: true, repoData: { defaultBranch: 'main' } } as never,
        repoUrl: 'https://github.com/owner/repo.git',
        githubToken: { token: 'github-token' },
        PR_LABEL: 'propr',
        AI_PROCESSING_TAG: 'AI-processing',
        AI_DONE_TAG: 'AI-done',
        jobId: 'job-3620',
        correlatedLogger: logger,
        visualPreviewSettings: { enabled: false, types: ['image'] } as never,
    });
}

function commentBodies(request: ReturnType<typeof mock.fn>): string[] {
    return request.mock.calls
        .filter(call => String(call.arguments[0]).endsWith('/comments'))
        .map(call => String((call.arguments[1] as { body: string }).body));
}

test('committed and pushed work whose pull request creation fails ends with the failed step named, not done', async () => {
    reset();
    createPullRequest.mock.mockImplementationOnce(async () => { throw new Error('API rate limit exceeded for installation'); });
    const request = mock.fn(async () => ({ data: {} }));

    const { commitResult, postProcessingResult } = await run(request);

    assert.equal(pushBranch.mock.callCount(), 1, 'the branch was pushed before the pull request was attempted');
    assert.equal(commitResult?.commitHash, COMMIT.commitHash);
    assert.equal(postProcessingResult?.pr, null);
    assert.equal(postProcessingResult?.failedStep, 'pull_request');
    assert.equal(postProcessingResult?.error, 'API rate limit exceeded for installation');
    assert.deepEqual(postProcessingResult?.updatedLabels, [], 'the issue is not marked AI-done');
    assert.deepEqual(safeUpdateLabels.mock.calls[0].arguments.slice(1), [['AI-processing'], []]);

    const [comment] = commentBodies(request);
    assert.match(comment, /Opening the pull request failed/);
    assert.match(comment, /committed \(`c1e1862`\) and pushed to `3620\/fix`, so no pull request was opened/);
    assert.match(comment, /API rate limit exceeded for installation/);
    assert.doesNotMatch(comment, /ProPR analysis was completed/);
});

test('a pull request creation that returns no pull request is a failed step, not a success', async () => {
    reset();
    createPullRequest.mock.mockImplementationOnce(async () => ({ success: true, pr: null, updatedLabels: [] }));
    const request = mock.fn(async () => ({ data: {} }));

    const { postProcessingResult } = await run(request);

    assert.equal(postProcessingResult?.pr, null);
    assert.equal(postProcessingResult?.failedStep, 'pull_request');
    assert.match(commentBodies(request)[0], /Opening the pull request failed/);
});

test('a commit failure names the commit step', async () => {
    reset();
    commitChanges.mock.mockImplementationOnce(async () => { throw new Error('index.lock exists'); });
    const request = mock.fn(async () => ({ data: {} }));

    const { commitResult, postProcessingResult } = await run(request);

    assert.equal(commitResult, null);
    assert.equal(pushBranch.mock.callCount(), 0);
    assert.equal(postProcessingResult?.failedStep, 'commit');
    assert.match(commentBodies(request)[0], /Committing the changes failed\.\*\* The changes were not committed/);
});

test('the failure comment is still posted when the processing report cannot be built', async () => {
    reset();
    createPullRequest.mock.mockImplementationOnce(async () => { throw new Error('Validation Failed'); });
    generateCompletionComment.mock.mockImplementationOnce(async () => { throw new Error('log upload failed'); });
    const request = mock.fn(async () => ({ data: {} }));

    const { postProcessingResult } = await run(request);

    assert.equal(postProcessingResult?.failedStep, 'pull_request');
    assert.match(commentBodies(request)[0], /Opening the pull request failed/);
});

test('a run with no changes takes the no-change path and never attempts a pull request', async () => {
    reset();
    commitChanges.mock.mockImplementationOnce(async () => null);
    const request = mock.fn(async () => ({ data: {} }));

    const { commitResult, postProcessingResult } = await run(request);

    assert.equal(commitResult, null);
    assert.equal(pushBranch.mock.callCount(), 0);
    assert.equal(createPullRequest.mock.callCount(), 0);
    assert.equal(handleNoCodeChanges.mock.callCount(), 1);
    assert.equal(postProcessingResult?.failedStep, undefined);
    assert.deepEqual(commentBodies(request), [], 'the no-change handler owns the comment');
});

test('a successful pull request carries no failed step', async () => {
    reset();
    const request = mock.fn(async () => ({ data: {} }));

    const { postProcessingResult } = await run(request);

    assert.equal(postProcessingResult?.pr?.number, 9);
    assert.equal(postProcessingResult?.failedStep, undefined);
    assert.deepEqual(commentBodies(request), []);
});

test('a pull request recreated by final validation becomes the run outcome', async () => {
    reset();
    retryPRCreationViaAPI.mock.mockImplementationOnce(async () => ({ number: 77 }));
    const failed = { success: false, pr: null, updatedLabels: [], error: 'Validation Failed', failedStep: 'pull_request' as const };

    const result = await handlePRValidation({
        claudeResult: successfulAgentResult(), worktreeInfo, issueRef, octokit: { request: mock.fn(async () => ({ data: {} })) },
        postProcessingResult: failed, commitResult: COMMIT, repoValidation: { isValid: true, repoData: { defaultBranch: 'main' } } as never,
        AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', correlationId: 'c', correlatedLogger: logger, jobId: 'job-3620',
    });

    assert.equal(retryPRCreationViaAPI.mock.callCount(), 1);
    assert.equal(result?.pr?.number, 77);
    assert.equal(result?.success, true);
    assert.equal(result?.failedStep, undefined);
});

test('final validation keeps the failure when the pull request cannot be recreated', async () => {
    reset();
    const failed = { success: false, pr: null, updatedLabels: [], error: 'Validation Failed', failedStep: 'pull_request' as const };

    const result = await handlePRValidation({
        claudeResult: successfulAgentResult(), worktreeInfo, issueRef, octokit: { request: mock.fn(async () => ({ data: {} })) },
        postProcessingResult: failed, commitResult: COMMIT, repoValidation: { isValid: true, repoData: { defaultBranch: 'main' } } as never,
        AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', correlationId: 'c', correlatedLogger: logger, jobId: 'job-3620',
    });

    assert.equal(result, failed);
});

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const commitChanges = mock.fn(async () => null);
const pushBranch = mock.fn(async () => undefined);
const safeUpdateLabels = mock.fn(async () => ({ success: true, removed: ['AI-processing'], added: [], errors: [] }));
const generateCompletionComment = mock.fn(async () => 'Generated failure details.');
const createPullRequest = mock.fn(async () => ({ success: true, pr: null, updatedLabels: [] }));
const resolveAgentTerminationReason = mock.fn((result: { terminationReason?: 'timeout' | 'max_turns' }) => result.terminationReason);

await mock.module('@propr/core', {
    namedExports: {
        cleanupWorktree: mock.fn(async () => undefined),
        cleanupPreparedVisualPreviewEvidence: mock.fn(async () => undefined),
        commitChanges,
        loadRepositoryVisualPreviewSettings: mock.fn(async () => ({ enabled: false, types: ['image'] })),
        prepareVisualPreviewEvidence: mock.fn(async () => ({ evidence: { assets: [], toolSuggestions: [] } })),
        pushBranch,
        AI_COMMIT_AUTHOR: { name: 'ProPR AI', email: 'ai@propr.dev' },
        TaskStates: { CANCELLED: 'cancelled' },
        describeAgentTermination: mock.fn(() => 'Agent stopped.'),
        resolveAgentTerminationReason,
        getAuthenticatedOctokit: mock.fn(),
        linkPRToPlanIssue: mock.fn(),
        safeUpdateLabels,
        generateCompletionComment,
        redactSecrets: (value: string) => value.replace('secret-token', '[REDACTED]'),
        validatePRCreation: mock.fn(),
    },
});

await mock.module('../src/jobs/issueJobHelpers.js', {
    namedExports: {
        createPullRequest,
        ensureEpicBaseBranchExists: mock.fn(async () => undefined),
    },
});

await mock.module('../src/jobs/issueJobPostProcessingHelpers.js', {
    namedExports: {
        handleCreatedPlanIssuePR: mock.fn(async () => undefined),
        handleNoCodeChanges: mock.fn(async () => ({ success: true, pr: null, updatedLabels: ['AI-done'] })),
    },
});

const { performPostProcessing } = await import('../src/jobs/issueJobPostProcessing.js');

const logger = {
    debug: mock.fn(),
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
} as never;

function failedAgentResult() {
    return {
        success: false,
        executionTime: 10,
        output: null,
        logs: '',
        modifiedFiles: [],
        commitMessage: null,
        summary: null,
        error: 'Docker rejected secret-token before the agent started',
    };
}

test('an agent failure without publishable work remains retryable and never creates an empty PR', async () => {
    commitChanges.mock.resetCalls();
    pushBranch.mock.resetCalls();
    safeUpdateLabels.mock.resetCalls();
    safeUpdateLabels.mock.mockImplementation(async () => ({ success: true, removed: ['AI-processing'], added: [], errors: [] }));
    generateCompletionComment.mock.resetCalls();
    createPullRequest.mock.resetCalls();
    const request = mock.fn(async () => ({ data: {} }));

    const result = await performPostProcessing({
        octokit: { request },
        issueRef: { repoOwner: 'owner', repoName: 'repo', number: 42 },
        worktreeInfo: { worktreePath: '/tmp/worktree', branchName: 'propr/42-fix' },
        currentIssueData: { data: { title: 'Fix startup', labels: [{ name: 'AI' }] } },
        claudeResult: failedAgentResult(),
        modelName: 'codex-test',
        repoValidation: { isValid: true, repoData: { defaultBranch: 'main' } },
        repoUrl: 'https://github.com/owner/repo.git',
        githubToken: { token: 'github-token' },
        PR_LABEL: 'propr',
        AI_PROCESSING_TAG: 'AI-processing',
        AI_DONE_TAG: 'AI-done',
        jobId: 'job-42',
        correlatedLogger: logger,
    });

    assert.equal(commitChanges.mock.calls.length, 0);
    assert.equal(pushBranch.mock.calls.length, 0);
    assert.equal(createPullRequest.mock.calls.length, 0);
    assert.deepEqual(safeUpdateLabels.mock.calls[0].arguments[1], ['AI-processing']);
    assert.deepEqual(safeUpdateLabels.mock.calls[0].arguments[2], []);
    assert.deepEqual(result, {
        commitResult: null,
        postProcessingResult: {
            success: false,
            pr: null,
            updatedLabels: [],
            error: 'Docker rejected secret-token before the agent started',
        },
    });

    assert.equal(request.mock.calls.length, 1);
    const comment = request.mock.calls[0].arguments[1].body as string;
    assert.match(comment, /failed before producing publishable work/i);
    assert.match(comment, /\[REDACTED\]/);
    assert.doesNotMatch(comment, /Post-processing encountered an error/);
    assert.doesNotMatch(comment, /AI-done/);
    assert.deepEqual(generateCompletionComment.mock.calls[0].arguments[2], { publishedAs: 'issue_comment' });
});

test('an unsuccessful processing-label removal is retried by failure post-processing', async () => {
    commitChanges.mock.resetCalls();
    pushBranch.mock.resetCalls();
    safeUpdateLabels.mock.resetCalls();
    generateCompletionComment.mock.resetCalls();
    createPullRequest.mock.resetCalls();
    let labelUpdateAttempt = 0;
    safeUpdateLabels.mock.mockImplementation(async () => {
        labelUpdateAttempt += 1;
        return labelUpdateAttempt === 1
            ? { success: false, removed: [], added: [], errors: ["Failed to remove 'AI-processing'"] }
            : { success: true, removed: ['AI-processing'], added: [], errors: [] };
    });
    const request = mock.fn(async () => ({ data: {} }));

    const result = await performPostProcessing({
        octokit: { request },
        issueRef: { repoOwner: 'owner', repoName: 'repo', number: 42 },
        worktreeInfo: { worktreePath: '/tmp/worktree', branchName: 'propr/42-fix' },
        currentIssueData: { data: { title: 'Fix startup', labels: [{ name: 'AI' }] } },
        claudeResult: failedAgentResult(),
        modelName: 'codex-test',
        repoValidation: { isValid: true, repoData: { defaultBranch: 'main' } },
        repoUrl: 'https://github.com/owner/repo.git',
        githubToken: { token: 'github-token' },
        PR_LABEL: 'propr',
        AI_PROCESSING_TAG: 'AI-processing',
        AI_DONE_TAG: 'AI-done',
        jobId: 'job-42',
        correlatedLogger: logger,
    });

    assert.equal(commitChanges.mock.calls.length, 0);
    assert.equal(pushBranch.mock.calls.length, 0);
    assert.equal(createPullRequest.mock.calls.length, 0);
    assert.equal(safeUpdateLabels.mock.calls.length, 2);
    assert.deepEqual(safeUpdateLabels.mock.calls[0].arguments[1], ['AI-processing']);
    assert.deepEqual(safeUpdateLabels.mock.calls[0].arguments[2], []);
    assert.deepEqual(safeUpdateLabels.mock.calls[1].arguments[1], ['AI-processing']);
    assert.deepEqual(safeUpdateLabels.mock.calls[1].arguments[2], []);
    assert.equal(result.postProcessingResult?.success, false);
    assert.match(result.postProcessingResult?.error || '', /Failed to remove the processing label/);
    assert.equal(request.mock.calls.length, 1);
    assert.match(request.mock.calls[0].arguments[1].body as string, /Post-processing Error/);
});

test('an interrupted execution without a commit remains retryable and never creates an empty PR', async () => {
    commitChanges.mock.resetCalls();
    commitChanges.mock.mockImplementation(async () => null);
    pushBranch.mock.resetCalls();
    safeUpdateLabels.mock.resetCalls();
    safeUpdateLabels.mock.mockImplementation(async () => ({ success: true, removed: ['AI-processing'], added: [], errors: [] }));
    generateCompletionComment.mock.resetCalls();
    createPullRequest.mock.resetCalls();
    const request = mock.fn(async () => ({ data: {} }));
    const claudeResult = {
        ...failedAgentResult(),
        terminationReason: 'timeout' as const,
        error: 'Agent execution timed out after 1800000ms',
    };

    const result = await performPostProcessing({
        octokit: { request },
        issueRef: { repoOwner: 'owner', repoName: 'repo', number: 43 },
        worktreeInfo: { worktreePath: '/tmp/worktree', branchName: 'propr/43-fix' },
        currentIssueData: { data: { title: 'Partial timeout', labels: [{ name: 'AI' }] } },
        claudeResult,
        modelName: 'codex-test',
        repoValidation: { isValid: true, repoData: { defaultBranch: 'main' } },
        repoUrl: 'https://github.com/owner/repo.git',
        githubToken: { token: 'github-token' },
        PR_LABEL: 'propr',
        AI_PROCESSING_TAG: 'AI-processing',
        AI_DONE_TAG: 'AI-done',
        jobId: 'job-43',
        correlatedLogger: logger,
    });

    assert.equal(commitChanges.mock.calls.length, 1);
    assert.equal(pushBranch.mock.calls.length, 0);
    assert.equal(createPullRequest.mock.calls.length, 0);
    assert.deepEqual(safeUpdateLabels.mock.calls[0].arguments[1], ['AI-processing']);
    assert.deepEqual(safeUpdateLabels.mock.calls[0].arguments[2], []);
    assert.equal(result.commitResult, null);
    assert.equal(result.postProcessingResult?.success, false);
    assert.deepEqual(result.postProcessingResult?.updatedLabels, []);
    assert.equal(request.mock.calls.length, 1);
    assert.match(request.mock.calls[0].arguments[1].body as string, /failed before producing publishable work/i);
    assert.doesNotMatch(request.mock.calls[0].arguments[1].body as string, /AI-done/);
});

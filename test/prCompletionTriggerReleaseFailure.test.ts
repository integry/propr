import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import * as pushSalvageExports from '../packages/core/src/git/pushSalvage.js';
import { safeUpdateLabels } from '../packages/core/src/utils/github/labelOperations.js';

/**
 * Once a pull request exists, a failed trigger release (GitHub 5xx on the
 * label DELETE) is logged and post-processing continues: the run is not
 * recorded as failed, and the PR is still assigned and linked to its plan
 * issue so the epic queue can observe its merge.
 */

type PRInfo = { number: number; url: string; title: string };
const pr: PRInfo = { number: 55, url: 'https://github.com/integry/propr/pull/55', title: 'Fix' };

let liveLabels: string[] = [];
let rejectTriggerRemoval = false;
let rejectDonePublication = false;
const comments: string[] = [];
const octokit = {
    auth: async () => ({ token: 'fixture' }),
    request: async (route: string, body: Record<string, unknown>) => {
        if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
            if (rejectDonePublication) throw Object.assign(new Error('GitHub unavailable'), { status: 502 });
            for (const label of body.labels as string[]) if (!liveLabels.includes(label)) liveLabels.push(label);
            return { data: {} };
        }
        if (route === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}') {
            if (rejectTriggerRemoval && body.name === 'AI') throw Object.assign(new Error('GitHub unavailable'), { status: 502 });
            liveLabels = liveLabels.filter(label => label !== body.name);
            return { data: {} };
        }
        if (route.endsWith('/comments')) { comments.push(String(body.body)); return { data: {} }; }
        throw new Error(`Unexpected route ${route}`);
    },
};

let validation: { isValid: boolean; pr?: PRInfo } = { isValid: false };
const linkPRToPlanIssue = mock.fn(async () => undefined);
await mock.module('@propr/core', {
    namedExports: {
        ...pushSalvageExports,
        AI_COMMIT_AUTHOR: { name: 'ProPR AI', email: 'ai@propr.dev' },
        pushBranch: mock.fn(),
        loadRepositoryVisualPreviewSettings: mock.fn(),
        cleanupWorktree: mock.fn(async () => undefined),
        cleanupPreparedVisualPreviewEvidence: mock.fn(async () => undefined),
        commitChanges: mock.fn(async () => ({ commitHash: 'abc', filesChanged: ['src/a.ts'] })),
        prepareVisualPreviewEvidence: mock.fn(async () => ({ evidence: { assets: [], toolSuggestions: [] } })),
        TaskStates: { CANCELLED: 'cancelled' },
        describeAgentTermination: mock.fn(() => ''),
        resolveAgentTerminationReason: mock.fn(() => undefined),
        sanitizeAgentReport: (value: string | null | undefined) => value ?? '',
        getAuthenticatedOctokit: mock.fn(async () => octokit),
        linkPRToPlanIssue,
        safeUpdateLabels,
        generateCompletionComment: mock.fn(async () => 'Completed.'),
        redactSecrets: (value: string) => value,
        validatePRCreation: mock.fn(async () => validation),
    },
});
await mock.module('timers/promises', { namedExports: { setTimeout: async () => undefined } });
await mock.module('../src/jobs/issueJobPush.js', {
    namedExports: {
        pushImplementationBranch: mock.fn(async () => undefined),
        describePushFailure: () => ({ pushFailure: undefined, failureFields: {} }),
        formatIssuePushFailure: () => '',
    },
});
const createPullRequest = mock.fn(async (): Promise<unknown> => ({ success: true, pr, updatedLabels: [] }));
await mock.module('../src/jobs/issueJobHelpers.js', {
    namedExports: {
        createPullRequest,
        ensureEpicBaseBranchExists: mock.fn(async () => undefined),
    },
});
const handleCreatedPlanIssuePR = mock.fn(async () => undefined);
await mock.module('../src/jobs/issueJobPostProcessingHelpers.js', {
    namedExports: { handleCreatedPlanIssuePR, handleNoCodeChanges: mock.fn() },
});
const autoAssignCompletedPullRequest = mock.fn(async (_context: unknown, _published: { pr?: { number?: number } | null } | null) => undefined);
await mock.module('../src/jobs/issueJobAutoAssignment.js', { namedExports: { autoAssignCompletedPullRequest } });

const { performPostProcessing, handlePRValidation } = await import('../src/jobs/issueJobPostProcessing.js');

const warnings: string[] = [];
const logger = {
    debug() {}, info() {}, error() {},
    warn(_fields: unknown, message?: string) { if (message) warnings.push(message); },
} as never;
const issueRef = { repoOwner: 'integry', repoName: 'propr', number: 12, triggeringLabel: 'AI' } as never;
const claudeResult = () => ({ success: true, modifiedFiles: [], commitMessage: null, summary: null } as never);

beforeEach(() => {
    liveLabels = ['AI', 'AI-processing'];
    rejectTriggerRemoval = true;
    rejectDonePublication = false;
    comments.length = 0;
    warnings.length = 0;
    validation = { isValid: false };
    autoAssignCompletedPullRequest.mock.resetCalls();
    linkPRToPlanIssue.mock.resetCalls();
    handleCreatedPlanIssuePR.mock.resetCalls();
});

function postProcess() {
    return performPostProcessing({
        octokit: octokit as never, issueRef,
        worktreeInfo: { worktreePath: '/tmp/worktree', branchName: 'issue-12' } as never,
        currentIssueData: { data: { title: 'Fix dates', labels: [{ name: 'AI' }], user: { login: 'alice' } } },
        claudeResult: claudeResult(), modelName: 'model',
        repoValidation: { isValid: true, repoData: { defaultBranch: 'main' } } as never,
        repoUrl: 'https://github.com/integry/propr', githubToken: 'token' as never, PR_LABEL: 'PR',
        AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', jobId: 'job-1', correlatedLogger: logger,
        visualPreviewSettings: { enabled: false } as never,
    });
}

test('post-processing completes and assigns the created PR when the trigger release fails', async () => {
    const { postProcessingResult } = await postProcess();

    assert.equal(postProcessingResult?.success, true);
    assert.equal(postProcessingResult?.pr?.number, 55);
    assert.equal(handleCreatedPlanIssuePR.mock.callCount(), 1);
    assert.deepEqual(autoAssignCompletedPullRequest.mock.calls.map(call => call.arguments[1]?.pr?.number), [55]);
    assert.deepEqual(comments, [], 'no failure comment for a successful run');
    assert.deepEqual(liveLabels.sort(), ['AI', 'AI-done'], 'done published; leftover trigger left for the epic handoff');
    assert.ok(warnings.some(message => /could not release the trigger labels/u.test(message)), 'the leftover trigger is logged');
});

test('post-processing continues when even the done marker cannot be published', async () => {
    rejectDonePublication = true;
    const { postProcessingResult } = await postProcess();

    assert.equal(postProcessingResult?.success, true);
    assert.deepEqual(autoAssignCompletedPullRequest.mock.calls.map(call => call.arguments[1]?.pr?.number), [55]);
    assert.deepEqual(liveLabels, ['AI'], 'the processing label is released, the trigger kept as the request record');
});

test('a post-processing failure still posts its comment when the trigger release fails', async () => {
    createPullRequest.mock.mockImplementationOnce(async () => { throw new Error('PR creation exploded'); });
    const { postProcessingResult } = await postProcess();

    assert.equal(postProcessingResult?.success, false);
    assert.equal(postProcessingResult?.error, 'PR creation exploded');
    assert.equal(comments.length, 1, 'the label failure does not suppress the fallback comment');
    assert.match(comments[0], /Post-processing encountered an error/u);
    assert.deepEqual(liveLabels.sort(), ['AI', 'AI-done']);
});

test('validation links and assigns a PR it finds when the trigger release fails', async () => {
    validation = { isValid: true, pr };
    const result = await handlePRValidation({
        claudeResult: claudeResult(),
        worktreeInfo: { worktreePath: '/tmp/worktree', branchName: 'issue-12' } as never,
        issueRef, octokit, postProcessingResult: { success: false, pr: null, updatedLabels: [] },
        commitResult: { commitHash: 'abc' } as never,
        repoValidation: { isValid: true, repoData: { defaultBranch: 'main' } } as never,
        AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done',
        correlationId: 'corr', correlatedLogger: logger, jobId: 'job-1',
    });

    assert.equal(result?.success, true);
    assert.equal(result?.pr?.number, 55);
    assert.deepEqual(linkPRToPlanIssue.mock.calls.map(call => (call.arguments as unknown[]).slice(1)), [[12, 55]]);
    assert.deepEqual(autoAssignCompletedPullRequest.mock.calls.map(call => call.arguments[1]?.pr?.number), [55]);
    assert.deepEqual(liveLabels.sort(), ['AI', 'AI-done']);
    assert.ok(warnings.some(message => /could not release the trigger labels/u.test(message)));
});

import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import * as pushSalvageExports from '../packages/core/src/git/pushSalvage.js';
import { BLOCKER_MARKER, detectBlockerReport } from '../packages/core/src/workflow/blockerReport.js';
import { isGeneratedRuntimePath } from '../packages/core/src/git/commitOperations.js';

/**
 * Issue runs whose workflow sets `on_blocker: report` and whose agent ends
 * with the blocker marker publish nothing: no commit, no PR, no done label,
 * no plan-issue status change. Runs without the option are unchanged.
 */

let worktreeFiles: string[] = [];
const commitChanges = mock.fn(async () => null);
const safeUpdateLabels = mock.fn(async () => ({ success: true, removed: ['AI-processing'], added: [], errors: [] }));
const createNotificationEvent = mock.fn(async () => ({ id: 'event' }));
const handleNoCodeChanges = mock.fn(async () => ({ success: true, pr: null, updatedLabels: ['AI-done'] }));
let planIssue: { draft_id: string } | null = null;
const findPlanIssueByRepoAndNumber = mock.fn(async () => planIssue);
const markEpicQueueHeadBlocked = mock.fn(async () => true);
const clearEpicQueueHeadBlocked = mock.fn(async () => false);
const createPullRequest = mock.fn(async () => ({ success: true, pr: { number: 5, url: 'https://github.test/pr/5', title: 'PR' }, updatedLabels: [] }));

await mock.module('@propr/core', {
    namedExports: {
        ...pushSalvageExports,
        cleanupWorktree: mock.fn(async () => undefined),
        cleanupPreparedVisualPreviewEvidence: mock.fn(async () => undefined),
        commitChanges,
        AI_COMMIT_AUTHOR: { name: 'ProPR AI', email: 'ai@propr.dev' },
        prepareVisualPreviewEvidence: mock.fn(async () => ({ evidence: { assets: [], toolSuggestions: [] } })),
        TaskStates: { CANCELLED: 'cancelled' },
        describeAgentTermination: mock.fn(() => 'Agent stopped.'),
        resolveAgentTerminationReason: mock.fn(() => undefined),
        getAuthenticatedOctokit: mock.fn(),
        linkPRToPlanIssue: mock.fn(),
        safeUpdateLabels,
        generateCompletionComment: mock.fn(async () => ''),
        sanitizeAgentReport: (value: string | null | undefined) => value ?? '',
        redactSecrets: (value: string) => value,
        validatePRCreation: mock.fn(),
        detectBlockerReport,
        isGeneratedRuntimePath,
        createHooklessGit: () => ({ status: async () => ({ files: worktreeFiles.map(path => ({ path })) }) }),
        createNotificationEvent,
        findPlanIssueByRepoAndNumber,
        markEpicQueueHeadBlocked,
        clearEpicQueueHeadBlocked,
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
await mock.module('../src/jobs/issueJobPush.js', {
    namedExports: { pushImplementationBranch: mock.fn(async () => undefined), describePushFailure: () => ({}), formatIssuePushFailure: () => '' },
});
await mock.module('../src/jobs/runCostCap.js', {
    namedExports: {
        repositoryNotificationsEnabled: async () => true,
        instanceMemberNotificationRecipients: async () => [{ userId: '42', pushEnabled: true }],
    },
});

const { performPostProcessing } = await import('../src/jobs/issueJobPostProcessing.js');
const { syncEpicQueueBlocker } = await import('../src/jobs/issueJobBlocked.js');

const logger = { debug: mock.fn(), info: mock.fn(), warn: mock.fn(), error: mock.fn() } as never;
const comments: string[] = [];
const octokit = {
    request: mock.fn(async (route: string, options: Record<string, unknown>) => {
        if (route.endsWith('/comments')) comments.push(String(options.body));
        return { data: {} };
    }),
};

function run(summary: string, reportsBlockers: boolean | undefined) {
    return performPostProcessing({
        octokit, issueRef: { repoOwner: 'acme', repoName: 'widgets', number: 12 },
        worktreeInfo: { worktreePath: '/worktree', branchName: 'ai/12' },
        currentIssueData: { data: { title: 'Integrate payments', labels: [] } },
        claudeResult: { success: true, executionTime: 1, output: null, logs: '', modifiedFiles: [], commitMessage: null, summary },
        modelName: 'model', repoValidation: { isValid: true }, repoUrl: '', githubToken: { token: 't' },
        PR_LABEL: 'propr', AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', jobId: 'job',
        correlatedLogger: logger, taskId: 'task-12', visualPreviewSettings: { enabled: false, types: [] },
        ...(reportsBlockers === undefined ? {} : { reportsBlockers }),
    } as never);
}

beforeEach(() => {
    worktreeFiles = [];
    comments.length = 0;
    planIssue = null;
    for (const fn of [commitChanges, safeUpdateLabels, createNotificationEvent, handleNoCodeChanges, createPullRequest,
        findPlanIssueByRepoAndNumber, markEpicQueueHeadBlocked, clearEpicQueueHeadBlocked]) fn.mock.resetCalls();
});

const BLOCKED_SUMMARY = `I could not finish.\n\n${BLOCKER_MARKER} The payment sandbox credentials are missing.\nA sandbox key is needed.`;

test('a reported blocker publishes nothing and comments with the explanation', async () => {
    const { commitResult, postProcessingResult } = await run(BLOCKED_SUMMARY, true);

    assert.equal(commitResult, null);
    assert.equal(commitChanges.mock.callCount(), 0, 'nothing is committed');
    assert.equal(createPullRequest.mock.callCount(), 0, 'no pull request');
    assert.equal(handleNoCodeChanges.mock.callCount(), 0, 'not reported as "no changes needed", which marks done and the plan issue merged');
    assert.deepEqual(postProcessingResult?.blocked, {
        explanation: 'The payment sandbox credentials are missing.\nA sandbox key is needed.', uncommittedFiles: [],
    });
    assert.equal(postProcessingResult?.pr, null);
    assert.deepEqual(postProcessingResult?.updatedLabels, []);

    // Only the processing label is removed; the done label is never added.
    assert.equal(safeUpdateLabels.mock.callCount(), 1);
    const [, remove, add] = safeUpdateLabels.mock.calls[0].arguments as unknown as [unknown, string[], string[]];
    assert.deepEqual(remove, ['AI-processing']);
    assert.deepEqual(add, []);

    assert.equal(comments.length, 1);
    assert.match(comments[0], /stopped on a blocker/);
    assert.match(comments[0], /> The payment sandbox credentials are missing\.\n> A sandbox key is needed\./);
    assert.match(comments[0], /Nothing was committed and no pull request was opened/);
    assert.doesNotMatch(comments[0], /left changes/);

    assert.equal(createNotificationEvent.mock.callCount(), 1);
    const [event, recipients] = createNotificationEvent.mock.calls[0].arguments as unknown as [Record<string, unknown>, unknown];
    assert.equal(event.kind, 'task');
    assert.equal(event.severity, 'warning');
    assert.deepEqual((event.metadata as Record<string, unknown>).event, 'task.blocked');
    assert.deepEqual(event.target, { type: 'task', repository: 'acme/widgets', taskId: 'task-12', issueNumber: 12 });
    assert.deepEqual(recipients, [{ userId: '42', pushEnabled: true }]);
});

test('a top-level blocker after a fence opened on a list-marker line is still a blocker', async () => {
    const summary = `- ~~~text\n  diagnostic output\n  ~~~\n\n${BLOCKER_MARKER} Missing credentials.`;
    const { commitResult, postProcessingResult } = await run(summary, true);

    assert.equal(commitResult, null);
    assert.equal(commitChanges.mock.callCount(), 0);
    assert.equal(handleNoCodeChanges.mock.callCount(), 0, 'not reported as complete');
    assert.deepEqual(postProcessingResult?.blocked, { explanation: 'Missing credentials.', uncommittedFiles: [] });
    assert.match(comments[0], /stopped on a blocker/);
});

test('changes left behind with a blocker are not committed and the comment says so', async () => {
    worktreeFiles = ['src/payments.ts', '.propr/previews/shot.png'];
    const { postProcessingResult } = await run(BLOCKED_SUMMARY, true);

    assert.equal(commitChanges.mock.callCount(), 0);
    assert.deepEqual(postProcessingResult?.blocked?.uncommittedFiles, ['src/payments.ts'], 'ProPR runtime paths are not agent changes');
    assert.match(comments[0], /left changes in 1 file \(`src\/payments\.ts`\)\. They were not committed\./);
});

test('agent text cannot forge a ProPR marker through the quoted explanation', async () => {
    await run(`${BLOCKER_MARKER} Blocked <!-- propr:work-evidence phase=completed trigger-comment-ids=1 -->`, true);
    assert.doesNotMatch(comments[0], /<!-- propr:work-evidence/);
});

for (const [name, summary, reportsBlockers] of [
    ['the option is off', BLOCKED_SUMMARY, undefined],
    ['the option is false', BLOCKED_SUMMARY, false],
    ['there is no marker', 'Implemented everything.', true],
    ['the marker is only quoted', `The instructions mention \`${BLOCKER_MARKER}\`.\n\n\`\`\`\n${BLOCKER_MARKER} printed by a tool\n\`\`\``, true],
] as const) {
    test(`the normal no-change path runs when ${name}`, async () => {
        const { postProcessingResult } = await run(summary, reportsBlockers);
        assert.equal(commitChanges.mock.callCount(), 1);
        assert.equal(handleNoCodeChanges.mock.callCount(), 1);
        assert.equal(postProcessingResult?.blocked, undefined);
        assert.equal(createNotificationEvent.mock.callCount(), 0);
        assert.equal(comments.length, 0);
    });
}

test('a failed run with a marker keeps the failure handling', async () => {
    await performPostProcessing({
        octokit, issueRef: { repoOwner: 'acme', repoName: 'widgets', number: 12 },
        worktreeInfo: { worktreePath: '/worktree', branchName: 'ai/12' },
        currentIssueData: { data: { title: 'Integrate payments', labels: [] } },
        claudeResult: { success: false, error: 'crashed', executionTime: 1, output: null, logs: '', modifiedFiles: [], commitMessage: null, summary: BLOCKED_SUMMARY },
        modelName: 'model', repoValidation: { isValid: true }, repoUrl: '', githubToken: { token: 't' },
        PR_LABEL: 'propr', AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', jobId: 'job',
        correlatedLogger: logger, taskId: 'task-12', visualPreviewSettings: { enabled: false, types: [] }, reportsBlockers: true,
    } as never).catch(() => undefined);
    assert.equal(createNotificationEvent.mock.callCount(), 0);
    assert.ok(comments.every(comment => !/stopped on a blocker/.test(comment)));
});

test('a blocked plan issue holds its epic queue; a later normal run releases it', async () => {
    const issueRef = { repoOwner: 'acme', repoName: 'widgets', number: 12 };
    await syncEpicQueueBlocker({ issueRef, blocked: true, correlatedLogger: logger });
    assert.equal(markEpicQueueHeadBlocked.mock.callCount(), 0, 'an issue outside every plan has no queue');

    planIssue = { draft_id: 'draft-1' };
    await syncEpicQueueBlocker({ issueRef, blocked: true, correlatedLogger: logger });
    assert.deepEqual(findPlanIssueByRepoAndNumber.mock.calls.at(-1)?.arguments, ['acme/widgets', 12]);
    assert.deepEqual(markEpicQueueHeadBlocked.mock.calls[0].arguments, [{ draftId: 'draft-1', issueNumber: 12 }]);
    assert.equal(clearEpicQueueHeadBlocked.mock.callCount(), 0);

    await syncEpicQueueBlocker({ issueRef, blocked: false, correlatedLogger: logger });
    assert.deepEqual(clearEpicQueueHeadBlocked.mock.calls[0].arguments, [{ draftId: 'draft-1', issueNumber: 12 }]);
    assert.equal(markEpicQueueHeadBlocked.mock.callCount(), 1);
});

test('a queue write failure never fails the run', async () => {
    planIssue = { draft_id: 'draft-1' };
    markEpicQueueHeadBlocked.mock.mockImplementationOnce(async () => { throw new Error('database down'); });
    await syncEpicQueueBlocker({ issueRef: { repoOwner: 'acme', repoName: 'widgets', number: 12 }, blocked: true, correlatedLogger: logger });
});

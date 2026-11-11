import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { BLOCKER_MARKER, detectBlockerReport } from '../packages/core/src/workflow/blockerReport.js';
import { isGeneratedRuntimePath } from '../packages/core/src/git/commitOperations.js';

/**
 * Follow-up and `/fix` runs whose agent reports a blocker commit and push
 * nothing; the completion comment states the blocker instead of the
 * no-change text and the task ends with terminal reason `blocked`.
 */

const noOp = async () => undefined;
let worktreeFiles: string[] = [];
const commitChanges = mock.fn(async () => null);
const markReviewFindingsProcessed = mock.fn(noOp);
const createNotificationEvent = mock.fn(async () => ({ id: 'event' }));
const events: string[] = [];

await mock.module('@propr/core', {
    namedExports: {
        commitChanges,
        cleanupPreparedVisualPreviewEvidence: noOp,
        prepareVisualPreviewEvidence: async () => ({ evidence: { assets: [], toolSuggestions: [] } }),
        loadRepositoryVisualPreviewSettings: async () => ({ enabled: false, types: [] }),
        appendVisualPreviewSection: (body: string) => body,
        renderVisualPreviewSection: () => '',
        renderVisualPreviewUploadFailureSection: () => '',
        resolveAgentTerminationReason: () => undefined,
        describeAgentTermination: () => '',
        sanitizeAgentReport: (value: string | null | undefined) => value ?? '',
        redactSecrets: (value: string) => value,
        redactVisualPreviewPaths: (value: string) => value,
        VISUAL_PREVIEW_DIRECTORY: '.propr/previews',
        getAuthenticatedOctokit: noOp,
        db: () => ({ where: () => ({ update: async () => 1 }) }),
        TaskStates: { PROCESSING: 'processing', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
        VISUAL_PREVIEW_SLOT: '<!-- slot -->',
        AI_COMMIT_AUTHOR: { name: 'ProPR AI', email: 'ai@propr.dev' },
        detectBlockerReport,
        isGeneratedRuntimePath,
        createHooklessGit: () => ({ status: async () => ({ files: worktreeFiles.map(path => ({ path })) }) }),
        createNotificationEvent,
    },
});
for (const [name, namedExports] of Object.entries({
    prCommentJobUtils: { buildCommitMessage: () => 'commit', buildMetricsSection: async () => '**Metrics**' },
    reviewCommentGatherer: { markReviewFindingsProcessed },
    reviewFindingSelector: { selectedReviewFeedbackIds: (comments: Array<{ id: number }>) => ({ findingIds: comments.length ? ['F3'] : [], suggestionIds: [] }) },
    ultrafixJobHelpers: { resolveUltrafixHistoryMeta: async () => ({ ultrafixCycle: true }) },
    prContinuation: { savePublicationCheckpoint: noOp },
    pushSalvageTimeline: { recordPushSalvageEvent: () => noOp },
    notificationRecap: { buildWorkNotificationRecap: () => '', fullNotificationSummary: () => undefined },
    prCommentAutoAssignment: { autoAssignFollowUpPullRequest: noOp },
    prCommentHandoffIntegration: {
        markExecutionHandoffCommitted: async () => { events.push('committed'); },
        markExecutionHandoffPushed: async () => { events.push('pushed'); },
        markExecutionHandoffCommentPublished: async (_state: unknown, url: string) => { events.push(`comment_published:${url}`); },
    },
    runCostCap: {
        repositoryNotificationsEnabled: async () => true,
        instanceMemberNotificationRecipients: async () => [{ userId: '42', pushEnabled: true }],
    },
})) {
    await mock.module(`../src/jobs/${name}.js`, { namedExports });
}
await mock.module('../src/github/visualPreviewAttachments.js', {
    namedExports: { isVisualPreviewUploadAuthenticationError: () => false, publishPullRequestCommentVisualPreviews: noOp },
});

const { handlePostExecution } = await import('../src/jobs/prCommentPostExecution.js');

const updates: Array<{ state: string; metadata: Record<string, unknown> }> = [];
let body = '';
const push = mock.fn(async () => ({ commitHash: undefined }));

async function runFollowUp(summary: string, options: { reportsBlockers?: boolean; reviewComments?: Array<{ id: number }>; commandMode?: string } = {}) {
    const octokit = {
        async request(route: string, parameters: Record<string, unknown>) {
            if (route.startsWith('PATCH ')) {
                body = String(parameters.body);
                return { data: { id: parameters.comment_id, html_url: 'https://github.test/comment/900', body } };
            }
            throw new Error(`Unexpected request: ${route}`);
        },
    };
    return handlePostExecution({
        state: {
            octokit, worktreeInfo: { worktreePath: '/worktree', branchName: 'feature' }, authorsText: '@alice',
            unprocessedComments: [{ id: 11, body: 'please integrate payments', author: 'alice' }],
            claudeResult: { success: true, summary, modifiedFiles: [] },
            startingWorkComment: { data: { id: 900, html_url: '' } },
        },
        job: { data: { commandMode: options.commandMode ?? 'default' } },
        taskId: 'task-7',
        stateManager: {
            async getTaskState() { return null; },
            async updateTaskState(_taskId: string, state: string, metadata: Record<string, unknown>) { updates.push({ state, metadata }); },
        },
        context: {
            pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets',
            publication: { status: '', push },
            correlatedLogger: { info() {}, warn() {}, error() {}, debug() {} },
        },
        unprocessedReviewComments: options.reviewComments ?? [], llm: null, redisClient: {}, prProcessingLockKey: 'lock', prProcessingLockToken: 'token',
        ...(options.reportsBlockers === undefined ? {} : { reportsBlockers: options.reportsBlockers }),
    } as never, 'https://propr.test/tasks/task-7');
}

beforeEach(() => {
    worktreeFiles = [];
    updates.length = 0;
    events.length = 0;
    body = '';
    for (const fn of [commitChanges, markReviewFindingsProcessed, createNotificationEvent, push]) fn.mock.resetCalls();
});

const BLOCKED = `Looked at it.\n\n${BLOCKER_MARKER} The payments API needs a sandbox key that this environment does not have.`;

test('a follow-up that reports a blocker commits and pushes nothing and states the blocker', async () => {
    worktreeFiles = ['src/payments.ts'];
    const result = await runFollowUp(BLOCKED, { reportsBlockers: true });

    assert.deepEqual(result, { partial: false, blocked: true });
    assert.equal(commitChanges.mock.callCount(), 0);
    assert.equal(push.mock.callCount(), 0);
    assert.match(body, /Stopped on a blocker/);
    assert.match(body, /> The payments API needs a sandbox key/);
    assert.match(body, /Nothing was committed or pushed/);
    assert.match(body, /left changes in 1 file \(`src\/payments\.ts`\)\. They were not committed\./);
    assert.doesNotMatch(body, /No code changes were necessary/, 'not the no-change text');
    // The trigger comment is marked handled, but no accepted request is bound: the work was not done.
    assert.match(body, /<!-- propr:work-evidence phase=completed trigger-comment-ids=11 -->/);
    assert.doesNotMatch(body, /propr:accepted-request/);
    assert.deepEqual(events, ['comment_published:https://github.test/comment/900']);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].state, 'completed');
    assert.equal(updates[0].metadata.terminalReason, 'blocked');
    const history = updates[0].metadata.historyMetadata as Record<string, unknown>;
    assert.deepEqual(history.blocker, { explanation: 'The payments API needs a sandbox key that this environment does not have.', uncommittedFiles: ['src/payments.ts'] });
    assert.equal(history.ultrafixCycle, true);

    const [event] = createNotificationEvent.mock.calls[0].arguments as unknown as [Record<string, unknown>];
    assert.equal(event.severity, 'warning');
    assert.equal(event.kind, 'task');
    assert.deepEqual(event.target, { type: 'task', repository: 'acme/widgets', taskId: 'task-7', prNumber: 7 });
});

test('a blocked /fix run leaves its selected review findings pending', async () => {
    await runFollowUp(BLOCKED, { reportsBlockers: true, reviewComments: [{ id: 501 }], commandMode: 'fix' });
    assert.equal(markReviewFindingsProcessed.mock.callCount(), 0);
    assert.match(body, /Requested finding F3/);
});

for (const [name, summary, reportsBlockers] of [
    ['the option is off', BLOCKED, undefined],
    ['there is no marker', 'Done.', true],
    ['the marker is quoted', `> ${BLOCKER_MARKER} from the issue body`, true],
] as const) {
    test(`the normal no-change completion runs when ${name}`, async () => {
        const result = await runFollowUp(summary, { reportsBlockers });
        assert.deepEqual(result, { commitHash: undefined, partial: false });
        assert.equal(commitChanges.mock.callCount(), 1);
        assert.match(body, /No code changes were necessary/);
        assert.equal(updates[0].metadata.terminalReason, undefined);
        assert.equal(createNotificationEvent.mock.callCount(), 0);
    });
}

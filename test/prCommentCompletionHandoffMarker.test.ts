import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

/**
 * Review 6229573230 F27: the normal completion comment is published before
 * its durable handoff checkpoint, so it must carry the handoff's stable marker
 * (and the normal-completion flag) for restart recovery to reconcile it
 * instead of overwriting or duplicating it.
 */

const noOp = async () => undefined;
let nextCommit: { commitHash: string; filesChanged: string[] } | null = null;
const events: string[] = [];

await mock.module('@propr/core', {
    namedExports: {
        commitChanges: async () => (nextCommit ? { ...nextCommit } : null),
        cleanupPreparedVisualPreviewEvidence: noOp,
        prepareVisualPreviewEvidence: async () => ({ evidence: { assets: [], toolSuggestions: [] } }),
        loadRepositoryVisualPreviewSettings: async () => ({ enabled: false, types: [] }),
        appendVisualPreviewSection: (body: string) => body,
        renderVisualPreviewSection: () => '',
        renderVisualPreviewUploadFailureSection: () => '',
        resolveAgentTerminationReason: () => undefined,
        describeAgentTermination: () => '',
        sanitizeAgentReport: (value: string | null | undefined) => value ?? '',
        getAuthenticatedOctokit: noOp,
        db: () => ({ where: () => ({ update: async () => 1 }) }),
        TaskStates: { PROCESSING: 'processing', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
        VISUAL_PREVIEW_SLOT: '<!-- slot -->',
        AI_COMMIT_AUTHOR: { name: 'ProPR AI', email: 'ai@propr.dev' },
    },
});
for (const [name, namedExports] of Object.entries({
    prCompletionComment: { buildCompletionComment: async () => 'Follow-up done' },
    prCommentJobUtils: { buildCommitMessage: () => 'commit' },
    reviewCommentGatherer: { markReviewFindingsProcessed: noOp },
    reviewFindingSelector: { selectedReviewFeedbackIds: () => ({ findingIds: [], suggestionIds: [] }) },
    ultrafixJobHelpers: { resolveUltrafixHistoryMeta: async () => ({}) },
    prContinuation: { savePublicationCheckpoint: noOp },
    pushSalvageTimeline: { recordPushSalvageEvent: () => noOp },
    notificationRecap: { buildWorkNotificationRecap: () => '', fullNotificationSummary: () => undefined },
    prCommentAutoAssignment: { autoAssignFollowUpPullRequest: noOp },
    prCommentHandoffIntegration: {
        markExecutionHandoffCommitted: async () => { events.push('checkpoint:committed'); },
        markExecutionHandoffPushed: async () => { events.push('checkpoint:pushed'); },
        markExecutionHandoffCommentPublished: async (_state: unknown, url: string) => { events.push(`checkpoint:comment_published:${url}`); },
    },
})) {
    await mock.module(`../src/jobs/${name}.js`, { namedExports });
}
await mock.module('../src/github/visualPreviewAttachments.js', {
    namedExports: { isVisualPreviewUploadAuthenticationError: () => false, publishPullRequestCommentVisualPreviews: noOp },
});

const { handlePostExecution } = await import('../src/jobs/prCommentPostExecution.js');
const { handoffCommentMarker, HANDOFF_NORMAL_COMPLETION_MARKER } = await import('../src/jobs/followupHandoffMarker.js');

const HANDOFF = { repository: 'acme/widgets', pull_request: 7, task_id: 'task-7', incarnation: 'inc-1', generation: 3 };

async function runFollowUp(followupHandoff: typeof HANDOFF | null): Promise<string> {
    let body = '';
    const octokit = {
        async request(route: string, parameters: Record<string, unknown>) {
            if (route.startsWith('PATCH ')) {
                body = String(parameters.body);
                events.push('publish');
                return { data: { id: parameters.comment_id, html_url: 'https://example.test/comment/900', body } };
            }
            throw new Error(`Unexpected request: ${route}`);
        },
    };
    await handlePostExecution({
        state: {
            octokit, worktreeInfo: { worktreePath: '/worktree', branchName: 'feature' }, authorsText: '@alice',
            unprocessedComments: [{ id: 11, body: 'please fix the widget', author: 'alice' }],
            claudeResult: { success: true, summary: 'Fixed the widget' },
            startingWorkComment: { data: { id: 900, html_url: '' } },
            followupHandoff,
        },
        job: { data: { commandMode: 'default' } },
        taskId: 'task-7',
        stateManager: { async getTaskState() { return null; }, async updateTaskState() { return undefined; } },
        context: {
            pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets',
            publication: { status: '', push: async () => ({ commitHash: nextCommit?.commitHash }) },
            correlatedLogger: { info() {}, warn() {}, error() {}, debug() {} },
        },
        unprocessedReviewComments: [], llm: null, redisClient: {}, prProcessingLockKey: 'lock', prProcessingLockToken: 'token',
    } as never, 'https://propr.test/tasks/task-7');
    return body;
}

beforeEach(() => {
    events.length = 0;
    nextCommit = null;
});

for (const commit of ['c'.repeat(40), null]) {
    test(`the normal completion carries the handoff marker before its checkpoint (${commit ? 'commit' : 'no changes'})`, async () => {
        nextCommit = commit ? { commitHash: commit, filesChanged: ['src/widget.ts'] } : null;
        const body = await runFollowUp({ ...HANDOFF });
        assert.ok(body.includes(handoffCommentMarker(HANDOFF)), 'recovery finds the delivered completion by the stable marker');
        assert.ok(body.includes(HANDOFF_NORMAL_COMPLETION_MARKER), 'and tells it apart from its own recovery notices');
        assert.ok(body.includes('Follow-up done'));
        // The external publication precedes the checkpoint: the window recovery reconciles.
        assert.deepEqual(events.slice(-2), ['publish', 'checkpoint:comment_published:https://example.test/comment/900']);
    });
}

test('a run without a handoff publishes no handoff marker', async () => {
    const body = await runFollowUp(null);
    assert.doesNotMatch(body, /propr-followup-handoff/);
});

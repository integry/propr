import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
process.env.PROPR_DEMO_MODE = 'true';
const cancellations: Array<{ target: any; reason: string }> = [];
await mock.module('../packages/core/src/services/taskIntent.js', { namedExports: {
    cancelWithdrawnIntent: async (target: any, reason: string) => { cancellations.push({ target, reason }); },
} });
await mock.module('../packages/core/src/webhook/planIssueTracking.js', { namedExports: {
    handlePlanIssueStatusUpdate: async () => {}, handlePlanPRUpdate: async () => {}, handlePlanPRCommentTracking: async () => {},
} });
await mock.module('../packages/core/src/webhook/epicPRHandler.js', { namedExports: {
    handleEpicPRCreationOnMerge: async () => {}, handleEpicPRLabelCleanup: async () => {},
} });
await mock.module('../packages/core/src/webhook/closedPullRequestCi.js', { namedExports: {
    getClosedPullRequestCiRedis: () => ({}), recordClosedPullRequestForCiCancellation: async () => {},
} });
await mock.module('../packages/core/src/webhook/mergeConflictDetector.js', { namedExports: {
    handlePullRequestConflictDetection: async () => {}, handlePushConflictDetection: async () => {},
} });
const { initializeWebhookHandler, processWebhookEvent } = await import('../packages/core/src/webhook/webhookHandler.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
after(closeConnection);
const processed: any[] = [];
await initializeWebhookHandler({
    issueProcessor: async issue => { processed.push(issue); }, commentProcessor: async () => {},
    commentDeletedHandler: async () => {}, commentEditedHandler: async () => {}, redisClient: {} as never,
    repositoryFilter: repo => repo === 'acme/widgets',
});
const repository = { full_name: 'acme/widgets', name: 'widgets', owner: { login: 'acme' } };

test('a single issue closed or trigger unlabeled event cancels work; model removal never does', async () => {
    await processWebhookEvent({ repository, action: 'closed', issue: { number: 42 } }, 'issues', 'close');
    assert.equal(cancellations.at(-1)?.reason, 'cancelled_issue_closed');
    await processWebhookEvent({ repository, action: 'unlabeled', label: { name: 'AI' }, issue: { number: 42 } }, 'issues', 'unlabel');
    assert.equal(cancellations.at(-1)?.reason, 'cancelled_label_removed');
    const count = cancellations.length;
    await processWebhookEvent({ repository, action: 'unlabeled', label: { name: 'llm-codex-astra' }, issue: { number: 42 } }, 'issues', 'model');
    assert.equal(cancellations.length, count);
    await processWebhookEvent({ repository, action: 'labeled', issue: { number: 42, state: 'closed' } }, 'issues', 'late-label');
    assert.equal(processed.length, 0);
});

test('unmerged PR closure cancels PR work without treating it as an issue or changing merge handling', async () => {
    const count = cancellations.length;
    await processWebhookEvent({ repository, action: 'closed', pull_request: { number: 87, merged: false } }, 'pull_request', 'pr-close');
    assert.equal(cancellations.length, count + 1);
    assert.equal(cancellations.at(-1)?.reason, 'cancelled_pr_closed');
    assert.equal(cancellations.at(-1)?.target.kind, 'pr');
    await processWebhookEvent({ repository, action: 'closed', pull_request: { number: 87, merged: true } }, 'pull_request', 'pr-merge');
    await processWebhookEvent({ repository, action: 'closed', issue: { number: 87, pull_request: {} } }, 'issues', 'pr-issue');
    assert.equal(cancellations.length, count + 1);
});

test('repository filtering happens before cancellation', async () => {
    const count = cancellations.length;
    await processWebhookEvent({ repository: { full_name: 'other/widgets' }, action: 'closed', issue: { number: 42 } }, 'issues', 'unmonitored');
    assert.equal(cancellations.length, count);
});

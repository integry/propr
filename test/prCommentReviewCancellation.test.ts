import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

process.env.PROPR_DEMO_MODE = 'true';
const core = await import('@propr/core');
await mock.module('@propr/core', { namedExports: {
    ...core,
    getAuthenticatedOctokit: async () => ({}),
    withRetry: async (fn: () => unknown) => fn(),
} });
const { executeReviewProcessing } = await import('../src/jobs/prCommentReviewJob.js');
after(core.closeConnection);

test('review validation of a closed PR persists readable cancellation history', async () => {
    const markTaskCancelled = mock.fn(async () => undefined);
    const result = await executeReviewProcessing({
        job: { data: { commandMode: 'review' } },
        context: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 42, correlationId: 'review', correlatedLogger: {} },
        taskId: 'review-task', stateManager: { markTaskCancelled }, state: {},
        validatePRAndComments: async () => ({ skip: true, reason: 'pull_request_closed' }),
    } as never);
    assert.deepEqual(result, { status: 'cancelled', reason: 'cancelled_pr_closed', pullRequestNumber: 42 });
    assert.deepEqual(markTaskCancelled.mock.calls[0].arguments, ['review-task', 'system', {
        reason: 'Cancelled because the pull request was closed without merging.', terminalReason: 'cancelled_pr_closed',
    }]);
});

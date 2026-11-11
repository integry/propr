import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

/**
 * A blocked issue run ends completed with the distinct terminal reason
 * `blocked`: never failed (which would retry or replace it), and its plan
 * issue keeps its status.
 */

const updatePlanIssueStatus = mock.fn(async () => true);
const findPlanIssueByRepoAndNumber = mock.fn(async () => ({ draft_id: 'draft-1', issue_number: 12, status: 'processing' }));
const completeProviderReplacement = mock.fn(async () => undefined);
const dbUpdate = mock.fn(async () => 1);

await mock.module('@propr/core', {
    namedExports: {
        db: () => ({ where: () => ({ update: dbUpdate }) }),
        findPlanIssueByRepoAndNumber,
        updatePlanIssueStatus,
        PlanIssueStatus: { CLOSED: 'closed', MERGED: 'merged' },
        resolveAgentTerminationReason: () => undefined,
        ErrorCategories: { CLAUDE_EXECUTION: 'claude_execution', GIT_OPERATION: 'git_operation' },
        formatPushFailureMessage: () => '',
    },
});
await mock.module('../src/jobs/providerReplacement.js', { namedExports: { completeProviderReplacement } });

const { getTaskCompletionStatus, markTaskComplete } = await import('../src/jobs/issueJob/completion.js');

const claudeResult = { success: true, executionTime: 1, output: null, logs: '', modifiedFiles: [], commitMessage: null, summary: 'PROPR_BLOCKED: no key' };
const blocked = { explanation: 'No sandbox key.\nPlease add one.', uncommittedFiles: ['src/a.ts'] };
const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;

test('a blocked run is completed with terminal reason blocked and leaves the plan issue alone', async () => {
    const stateManager = { markTaskCompleted: mock.fn(async () => undefined), markTaskFailed: mock.fn(async () => undefined) };
    const postProcessingResult = { success: false, pr: null, updatedLabels: [], blocked };
    assert.equal(getTaskCompletionStatus(claudeResult as never, postProcessingResult), 'blocked');

    await markTaskComplete({
        stateManager: stateManager as never, taskId: 'task-12', issueRef: { repoOwner: 'acme', repoName: 'widgets', number: 12 } as never,
        currentIssueLabels: [], claudeResult: claudeResult as never, postProcessingResult, commitResult: null, correlatedLogger: logger,
    });

    assert.equal(stateManager.markTaskFailed.mock.callCount(), 0, 'a failed task would be retried');
    assert.equal(stateManager.markTaskCompleted.mock.callCount(), 1);
    const [taskId, result] = stateManager.markTaskCompleted.mock.calls[0].arguments as unknown as [string, Record<string, unknown>];
    assert.equal(taskId, 'task-12');
    assert.equal(result.status, 'blocked');
    assert.equal(result.terminalReason, 'blocked');
    assert.equal(result.prCreated, false);
    assert.deepEqual(result.blocker, blocked);
    assert.equal(result.notificationRecap, 'Stopped on a blocker: No sandbox key.');

    assert.equal(completeProviderReplacement.mock.callCount(), 0, 'no provider replacement');
    assert.equal(updatePlanIssueStatus.mock.callCount(), 0, 'the plan issue is neither merged nor closed');
    assert.equal(dbUpdate.mock.callCount(), 0, 'no commit or PR recorded');
});

test('without a blocker the completion status is unchanged', () => {
    assert.equal(getTaskCompletionStatus(claudeResult as never, { success: true, pr: null, updatedLabels: [] }), 'claude_success_no_changes');
    assert.equal(getTaskCompletionStatus({ ...claudeResult, success: false } as never, { success: false, pr: null, updatedLabels: [], blocked }), 'claude_processing_failed');
});

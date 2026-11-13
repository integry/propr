import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';

/**
 * The issue and PR-comment jobs record an agent's result as soon as it runs,
 * then their failure handlers record the result again when a later step
 * throws. Both records must carry the one execution id, so the second is the
 * no-op `recordLLMMetrics` makes it (see llmMetricsFailedExecutions.test.ts):
 * this covers the ids reaching `recordLLMMetrics` on both paths.
 */

const recorded: Array<{ executionId?: string; success?: boolean; jobType?: string }> = [];
const core = await import('@propr/core');
await mock.module('@propr/core', {
    namedExports: {
        ...core,
        recordLLMMetrics: async (result: { executionId?: string; success?: boolean } | null, _ref: unknown, options: { jobType?: string } = {}) => {
            recorded.push({ executionId: result?.executionId, success: result?.success, jobType: options.jobType });
        },
        safeRemoveLabel: async () => {}, safeAddLabel: async () => {}, updateWithdrawnIssueLabels: async () => {},
    },
});
await mock.module('../src/taskReplacement/index.js', { namedExports: {
    getTaskReplacementService: () => ({
        prepare: async () => ({ eligible: false }), complete: async () => ({ action: 'none' }), lineage: async () => [], formatAttempts: () => '',
    }),
    isTransientProviderError: () => false,
} });
// The issue job's shared Redis client is created at import; nothing here needs it.
await mock.module('../src/jobs/issueJob/config.js', { namedExports: {
    redisClient: {}, DEFAULT_MODEL_NAME: null, getPrimaryProcessingLabels: async () => ['AI'], getPrLabel: () => 'propr',
} });
await mock.module('../src/jobs/prCommentUsageLimitRecovery.js', { namedExports: { schedulePRCommentUsageLimitRetry: async () => 'unused' } });
await mock.module('../src/jobs/prContributionDiscussion.js', { namedExports: { loadOriginalContributionDiscussion: async () => undefined } });
after(async () => { await core.closeConnection?.(); });

const { handleGenericError } = await import('../src/jobs/errorHandlers.js');
const { toClaudeResult: issueAgentToClaudeResult, agentResultToClaudeResponse: issueAgentToResponse } = await import('../src/jobs/issueJob/agent.js');
const { handleJobError, toClaudeResult: prToClaudeResult, agentResultToClaudeResponse: prAgentToResponse } = await import('../src/jobs/prCommentJobUtils.js');

const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } };
const stateManager = {
    getTaskState: async () => ({ state: 'processing' }),
    updateTaskState: async () => {},
    markTaskFailed: async () => {},
};
const agentResult = () => ({
    executionId: 'execution-3437', success: true, executionTimeMs: 1000, logs: '', modifiedFiles: [], commitMessage: null,
    modelUsed: 'claude-opus-5-5', sessionId: 'session-3437', tokenUsage: { input_tokens: 100, output_tokens: 10 },
});

beforeEach(() => { recorded.length = 0; });

test('issue path: the failure handler records the agent result under the id the run recorded', async () => {
    const result = agentResult();
    // What executeAgentAndRecordMetrics records, and the response it hands back to the job.
    const recordedByRun = issueAgentToClaudeResult(result);
    const response = issueAgentToResponse(result);
    assert.equal(recordedByRun.executionId, 'execution-3437');

    await handleGenericError(new Error('final validation failed'), { id: 'job' } as never,
        { repoOwner: 'integry', repoName: 'propr', number: 3437, correlationId: 'c' } as never, {
            octokit: { request: async () => ({}) } as never, claudeResult: response, worktreeInfo: undefined,
            correlatedLogger: log as never, stateManager: stateManager as never, taskId: 'task-3437', AI_PROCESSING_TAG: 'AI-processing',
        });

    assert.deepEqual(recorded, [{ executionId: 'execution-3437', success: true, jobType: 'issue' }]);
});

test('PR-comment path: the failure handler records the agent result under the id the run recorded', async () => {
    const response = prAgentToResponse(agentResult());
    // What processPullRequestCommentJob records once the agent returns.
    assert.equal(prToClaudeResult(response).executionId, 'execution-3437');

    await handleJobError(new Error('push rejected'), { id: 'job-1', data: { pullRequestNumber: 7 }, attemptsMade: 0, opts: {} } as never, {
        pullRequestNumber: 7, repoOwner: 'integry', repoName: 'propr', authorsText: '@alice',
        unprocessedComments: [], octokit: null, startingWorkComment: null, claudeResult: response, correlationId: 'corr-1',
        correlatedLogger: log as never, stateManager: stateManager as never, taskId: 'task-3437',
    });

    assert.deepEqual(recorded, [{ executionId: 'execution-3437', success: true, jobType: 'pr_comment' }]);
});

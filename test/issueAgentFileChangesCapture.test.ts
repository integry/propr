import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// The issue run's shutdown path through the real capture wrapper; core's monitor is covered in core.
const events: string[] = [];
let agentOutcome: () => Promise<unknown> = async () => ({ success: true, modelUsed: 'claude-test', executionTimeMs: 1, summary: 'done', conversationLog: [] });
const agent = { config: { type: 'claude' }, executeTask: async () => { events.push('execute'); return agentOutcome(); } };
mock.module('@propr/core', {
    namedExports: {
        TaskStates: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled', CLAUDE_EXECUTION: 'claude_execution' },
        AgentRegistry: { getInstance: () => ({ getAgentByAlias: () => agent }) },
        findIssueSubmission: async () => null,
        submissionExtensionsForRun: () => ({}),
        generateClaudePrompt: () => 'prompt',
        updateFileChangesFromWorktree: async () => { events.push('post-capture'); return []; },
        recordLLMMetrics: async () => undefined,
        resolveAgentTerminationReason: () => undefined,
        repositoryWorkflowPrompt: () => '',
        startLiveFileChangesCapture: (options: { taskId: string; repository: string }) => {
            events.push(`start:${options.taskId}@${options.repository}`);
            return { tick: async () => undefined, stop: async ({ finalCapture = false } = {}) => { events.push(`stop:${finalCapture}`); } };
        },
    },
});
mock.module('../src/jobs/issueJobHelpers.js', { namedExports: { localizeContentImages: async (body: string) => body } });
mock.module('../src/jobs/issueJobCallbacks.js', { namedExports: { createSessionIdCallback: () => undefined, createContainerIdCallback: () => undefined } });
mock.module('../src/jobs/repositoryWorkflow.js', { namedExports: { runRepositoryWorkflow: async (_options: unknown, execute: () => Promise<unknown>) => execute() } });
mock.module('../src/jobs/providerReplacement.js', { namedExports: { markAgentExecutionFailure: (error: unknown) => error } });
mock.module('../src/jobs/issueJob/config.js', { namedExports: { redisClient: { name: 'worker-redis' } } });

const { executeAgentAndRecordMetrics } = await import('../src/jobs/issueJob/agent.js');

const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined };
const run = () => executeAgentAndRecordMetrics({
    worktreeInfo: { worktreePath: '/tmp/issue-worktree', branchName: 'feature' },
    issueRef: { number: 7, repoOwner: 'acme', repoName: 'widget' },
    githubToken: { token: 'token' },
    currentIssueData: { data: { title: 'Title', body: '', labels: [] } },
    issueComments: [],
    visualPreviewSettings: {},
} as never, {
    taskId: 'issue-task', agentAlias: 'claude', modelName: 'claude-test', correlatedLogger: logger, correlationId: 'c',
    stateManager: { getTaskState: async () => ({ state: 'claude_execution' }), updateTaskState: async () => undefined },
} as never);

test('a completed issue run stops the capture with a final scan and comparison before unregistering', async () => {
    events.length = 0;
    await run();
    assert.deepEqual(events.slice(0, 3), ['start:issue-task@acme/widget', 'execute', 'stop:true']);
});

test('a failed issue run still stops the capture (with its final comparison) but skips the final scan', async () => {
    events.length = 0;
    agentOutcome = async () => { throw new Error('agent crashed'); };
    await assert.rejects(run(), /agent crashed/);
    assert.deepEqual(events, ['start:issue-task@acme/widget', 'execute', 'stop:false']);
});

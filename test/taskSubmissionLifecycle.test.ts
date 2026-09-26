import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import type { Job } from 'bullmq';
import type { IssueJobData } from '@propr/core';

process.env.PROPR_DEMO_MODE = 'true';
const core = await import('@propr/core');
const log = { info() {}, debug() {}, warn() {}, error() {} };
let submitted = false;
let outcome: 'completed' | 'failed' | 'cancelled' = 'completed';
const taskLinks: string[] = [];
const terminal: Array<{ taskId: string; result: Record<string, unknown> }> = [];
const stateManager = {
  createTaskState: async () => undefined,
  updateTaskState: async () => undefined,
  markTaskCompleted: async (taskId: string, result: Record<string, unknown>) => { terminal.push({ taskId, result }); },
  markTaskFailed: async (taskId: string, error: Error) => { terminal.push({ taskId, result: { status: 'failed', error: error.message } }); },
};
await mock.module('@propr/core', { namedExports: {
  ...core,
  associateSubmissionTask: async (_database: unknown, _id: string, taskId: string) => { taskLinks.push(taskId); },
  findIssueSubmission: async () => submitted ? { id: 'submission' } : undefined,
  logger: { ...log, withCorrelation: () => log },
  addModelSpecificDelay: async () => undefined,
  updatePlanIssueTaskId: async () => undefined,
  ensureRepoCloned: async () => '/tmp/repository',
  ensureGitRepository: async () => undefined,
} });
const { markTaskTerminalState } = await import('../src/jobs/issueJob/completion.js');
await mock.module('../src/jobs/issueJobDispatcher.js', { namedExports: { handleDispatch: async () => ({ status: 'dispatched' }) } });
await mock.module('../src/jobs/issueJobHelpers.js', { namedExports: {
  handleUsageLimitError: async () => undefined,
  handleGenericError: async (error: Error) => {
    terminal.push({ taskId: 'ordinary-task', result: { status: error.message.includes('aborted by user') ? 'cancelled' : 'failed' } });
  },
  updateTaskTitleInStorage: async () => undefined,
  buildFinalResult: () => ({ status: 'processed' }),
} });
await mock.module('../src/jobs/issueJobPostProcessing.js', { namedExports: { performFinalValidation: async () => undefined } });
await mock.module('../src/jobs/issueJob/index.js', { namedExports: {
  initializeJobContext: async (job: Job<IssueJobData>) => ({
    jobId: job.id, issueRef: job.data, correlationId: 'correlation', correlatedLogger: log,
    stateManager, modelName: 'model', taskId: 'ordinary-task', AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done',
  }),
  getAuthenticatedClient: async () => ({ auth: async () => ({ token: 'fixture' }) }),
  checkLabelConditions: () => ({ skip: false }),
  ensureProcessingLabel: async () => undefined,
  executeWorktreeOperations: async () => {
    if (outcome === 'cancelled') throw new Error('Execution aborted by user');
    return { worktreeInfo: { worktreePath: '/tmp/worktree' },
      claudeResult: { success: outcome === 'completed', error: outcome === 'failed' ? 'Agent failed' : null },
      postProcessingResult: outcome === 'completed' ? { success: true, pr: { number: 43, url: 'https://github.com/owner/repo/pull/43' } } : null,
      commitResult: null };
  },
  markTaskComplete: markTaskTerminalState,
} });
const { processGitHubIssueJob } = await import('../src/jobs/processGitHubIssueJob.js');
after(core.closeConnection);

test('UI issue tasks use the same worker completion, cancellation, failure and PR association as externally triggered issues', async () => {
  const externalResults: unknown[] = [];
  for (const source of ['external', 'submission']) {
    submitted = source === 'submission';
    for (const state of ['completed', 'failed', 'cancelled'] as const) {
      outcome = state; terminal.length = 0;
      const result = await processGitHubIssueJob({ id: 'ordinary-job', name: 'processGitHubIssue', data: {
        repoOwner: 'owner', repoName: 'repo', number: 42, userId: 'alice', isChildJob: true, agentAlias: 'issue-agent', modelName: 'model',
        issuePayload: { title: 'Fix dates', body: 'Fix invoice dates', labels: [{ name: 'AI' }] }, repoPayload: { defaultBranch: 'main' },
      }, updateProgress: async () => undefined } as unknown as Job<IssueJobData>);
      const contract = { result, terminal: structuredClone(terminal) };
      if (!submitted) externalResults.push(contract);
      else assert.deepEqual(contract, externalResults[['completed', 'failed', 'cancelled'].indexOf(state)]);
      if (state === 'completed') {
        assert.equal(terminal[0].result.prNumber, 43);
        assert.equal(terminal[0].result.prUrl, 'https://github.com/owner/repo/pull/43');
      } else if (state === 'cancelled') assert.equal(result.status, 'cancelled');
      else assert.equal(terminal[0].result.status, 'failed');
    }
  }
  assert.deepEqual(taskLinks, ['ordinary-task', 'ordinary-task', 'ordinary-task']);
});

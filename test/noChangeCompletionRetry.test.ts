import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mock } from 'node:test';
import type { Job } from 'bullmq';
import type { IssueJobData } from '@propr/core';
import { createNoChangeCompletionStoreDouble } from './fixtures/noChangeCompletionStoreDouble.js';

/**
 * A no-change run that published its done marker but could not release its
 * trigger leaves the issue looking finished. A later, ordinary (non-sibling)
 * job for the issue must finish that completion — trigger cleanup, comment and
 * plan-status write — before the already-done check skips it, and must not
 * rerun the implementation.
 */
process.env.PROPR_DEMO_MODE = 'true';
const core = await import('@propr/core');
const log = { info() {}, debug() {}, warn() {}, error() {} };

const tasks = new Map<string, { state: string; terminalReason?: string }>();
let liveLabels: string[] = [];
let rejectPrimaryRemoval = false;
let failStatusWrite = false;
const ran: string[] = [];
const comments: string[] = [];
const statusWrites: Array<[string, number, string]> = [];
const redisDouble = createNoChangeCompletionStoreDouble();
const store = { clear: () => redisDouble.clear(), get size() { return redisDouble.records().length; } };

const stateManager = {
  createTaskStateIfAbsent: async (taskId: string) => {
    if (!tasks.has(taskId)) tasks.set(taskId, { state: 'pending' });
    return { taskId, ...tasks.get(taskId)! };
  },
  getTaskState: async (taskId: string) => tasks.has(taskId) ? { taskId, ...tasks.get(taskId)! } : null,
  updateTaskState: async (taskId: string, state: string) => { tasks.set(taskId, { ...tasks.get(taskId), state }); },
  markTaskCancelled: async (taskId: string, _by: string, metadata: { terminalReason?: string }) => {
    tasks.set(taskId, { state: 'cancelled', terminalReason: metadata.terminalReason });
    return { taskId, ...tasks.get(taskId)! };
  },
  markTaskFailed: async (taskId: string) => { tasks.set(taskId, { state: 'failed' }); },
};

const octokit = {
  auth: async () => ({ token: 'fixture' }),
  request: async (route: string, body: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') {
      return { data: { state: 'open', title: 'Fix dates', body: 'Fix invoice dates', labels: liveLabels.map(name => ({ name })) } };
    }
    if (route.startsWith('POST ') && route.endsWith('/labels')) {
      for (const label of body.labels as string[]) if (!liveLabels.includes(label)) liveLabels.push(label);
      return { data: {} };
    }
    if (route.startsWith('DELETE ')) {
      if (rejectPrimaryRemoval && body.name === 'AI') throw Object.assign(new Error('GitHub unavailable'), { status: 502 });
      liveLabels = liveLabels.filter(label => label !== body.name);
      return { data: {} };
    }
    if (route.startsWith('GET ') && route.endsWith('/comments')) return { data: comments.map(text => ({ body: text })) };
    if (route.endsWith('/comments')) { comments.push(String(body.body)); return { data: {} }; }
    throw new Error(`Unexpected request ${route}`);
  },
};

await mock.module('@propr/core', { namedExports: {
  ...core,
  db: () => ({ where: () => ({ update: async () => undefined }) }),
  associateSubmissionTask: async () => undefined,
  findIssueSubmission: async () => undefined,
  readIssueCostCapOverride: async () => undefined,
  logger: { ...log, withCorrelation: () => log },
  addModelSpecificDelay: async () => undefined,
  updatePlanIssueTaskId: async () => undefined,
  ensureRepoCloned: async () => '/tmp/repository',
  ensureGitRepository: async () => undefined,
  loadSettings: async () => ({ worker_concurrency: 1 }),
  generateCompletionComment: async () => 'Completed.',
  findPlanIssueByRepoAndNumber: async () => ({ draft_id: 'draft', issue_number: 7, status: 'processing' }),
  getEpicExecutionQueue: async () => ({ status: 'active', issues: [7, 8], cursor: 0 }),
  updatePlanIssueStatus: async (repository: string, issueNumber: number, status: string) => {
    if (failStatusWrite) throw new Error('database unavailable');
    statusWrites.push([repository, issueNumber, status]);
  },
} });
await mock.module('../src/jobs/issueJob/config.js', { namedExports: {
  // Workflow admission scripts succeed; the completion obligation's own commands are modelled.
  redisClient: redisDouble,
  DEFAULT_MODEL_NAME: 'model', getPrimaryProcessingLabels: async () => ['AI'], getPrLabel: async () => 'PR',
} });
const { handleNoCodeChanges } = await import('../src/jobs/issueJobPostProcessingHelpers.js');
await mock.module('../src/jobs/issueJobDispatcher.js', { namedExports: { handleDispatch: async () => ({ status: 'dispatched' }) } });
await mock.module('../src/jobs/issueJobHelpers.js', { namedExports: {
  handleUsageLimitError: async () => undefined,
  handleGenericError: async (error: Error) => { throw error; },
  updateTaskTitleInStorage: async () => undefined,
  buildFinalResult: () => ({ status: 'processed' }),
} });
await mock.module('../src/jobs/issueJobPostProcessing.js', { namedExports: { performFinalValidation: async () => undefined } });
const github = await import('../src/jobs/issueJob/github.js');
await mock.module('../src/jobs/issueJob/index.js', { namedExports: {
  initializeJobContext: async (job: Job<IssueJobData>) => ({
    jobId: job.id, issueRef: job.data, correlationId: 'submission', correlatedLogger: log, stateManager,
    agentAlias: 'claude', modelName: job.data.modelName, taskId: `task-${job.id}`,
    AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', AI_WAITING_TAG: 'AI-waiting', AI_PRIMARY_TAG: 'AI', PR_LABEL: 'PR',
  }),
  getAuthenticatedClient: async () => octokit,
  checkLabelConditions: github.checkLabelConditions,
  ensureProcessingLabel: async () => { if (!liveLabels.includes('AI-processing')) liveLabels.push('AI-processing'); },
  // The agent finds the work already done, so post-processing takes the real no-change path.
  executeWorktreeOperations: async ({ job, currentIssueData }: { job: Job<IssueJobData>; currentIssueData: { data: { labels: Array<{ name: string }> } } }) => {
    ran.push(String(job.id));
    const postProcessingResult = await handleNoCodeChanges({
      octokit: octokit as never, issueRef: job.data, claudeResult: { success: true } as never, currentIssueData,
      AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', correlatedLogger: log as never,
    });
    return { worktreeInfo: { worktreePath: '/tmp/worktree' }, claudeResult: { success: true }, postProcessingResult, commitResult: null };
  },
  markTaskComplete: async ({ taskId }: { taskId: string }) => { tasks.set(taskId, { state: 'completed' }); },
} });
const workflowJobs = await import('../src/jobs/repositoryWorkflow.js');
await mock.module('../src/jobs/repositoryWorkflow.js', { namedExports: { ...workflowJobs, prepareRepositoryWorkflow: async () => undefined } });
const { processGitHubIssueJob } = await import('../src/jobs/processGitHubIssueJob.js');
after(core.closeConnection);

/** A model job outside any dispatch, so the sibling exemption never applies to it. */
function issueJob(id: string, correlationId = 'submission'): Job<IssueJobData> {
  const job = {
    id, name: 'processGitHubIssue',
    data: { repoOwner: 'o', repoName: 'r', number: 7, isChildJob: true, agentAlias: 'claude', modelName: 'model', correlationId,
      baseBranch: 'main', triggeringLabel: 'AI', repoPayload: { defaultBranch: 'main' } } as IssueJobData,
    updateData: async (data: IssueJobData) => { job.data = data; },
    updateProgress: async () => undefined,
  };
  return job as unknown as Job<IssueJobData>;
}

beforeEach(() => {
  tasks.clear(); store.clear(); ran.length = 0; comments.length = 0; statusWrites.length = 0;
  liveLabels = ['AI', 'auto-merge']; rejectPrimaryRemoval = false; failStatusWrite = false;
});

test('a non-sibling retry finishes a no-change completion whose trigger cleanup failed', async () => {
  rejectPrimaryRemoval = true;
  await assert.rejects(processGitHubIssueJob(issueJob('first')), /Failed to remove 'AI'/);
  assert.deepEqual(ran, ['first']);
  assert.ok(liveLabels.includes('AI-done') && liveLabels.includes('AI'), 'done published, trigger still applied');
  assert.deepEqual(statusWrites, [], 'the plan has not advanced');
  assert.equal(store.size, 1, 'the remaining completion steps are owed');

  rejectPrimaryRemoval = false;
  const result = await processGitHubIssueJob(issueJob('retry'));
  assert.deepEqual(result, { status: 'skipped', reason: 'Already done', issueNumber: 7 });
  assert.deepEqual(ran, ['first'], 'the implementation is not rerun');
  assert.deepEqual(liveLabels.sort(), ['AI-done', 'auto-merge']);
  assert.deepEqual(statusWrites, [['o/r', 7, 'merged']], 'the plan advances past the no-change issue');
  assert.equal(comments.length, 1);
  assert.match(comments[0], /No code changes needed/);
  assert.equal(store.size, 0);

  // Once settled, a further delivery is an ordinary already-done skip.
  assert.equal((await processGitHubIssueJob(issueJob('again'))).status, 'skipped');
  assert.deepEqual(statusWrites, [['o/r', 7, 'merged']]);
  assert.equal(comments.length, 1);
});

test('a retry whose replay still fails keeps the completion owed', async () => {
  rejectPrimaryRemoval = true;
  await assert.rejects(processGitHubIssueJob(issueJob('first')), /Failed to remove 'AI'/);
  await assert.rejects(processGitHubIssueJob(issueJob('retry')), /Failed to remove 'AI'/);
  assert.deepEqual(ran, ['first']);
  assert.deepEqual(statusWrites, []);
  assert.equal(store.size, 1);
});

test('admitting renewed work drops an older request\'s owed no-change completion', async () => {
  failStatusWrite = true;
  await processGitHubIssueJob(issueJob('first', 'request-1'));
  assert.deepEqual(liveLabels.sort(), ['AI-done', 'auto-merge']);
  assert.equal(store.size, 1, 'the status write is owed');
  failStatusWrite = false;

  // The user removes AI-done and reapplies AI: a new request is admitted and runs.
  liveLabels = ['AI', 'auto-merge'];
  await processGitHubIssueJob(issueJob('renewed', 'request-2'));
  assert.deepEqual(ran, ['first', 'renewed']);
  assert.deepEqual(statusWrites, [['o/r', 7, 'merged']], 'only the renewed run\'s own completion writes status');
  assert.equal(store.size, 0, 'the superseded completion is no longer owed');
  assert.equal(comments.length, 2);
});

import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import type { Job } from 'bullmq';
import type { IssueJobData } from '@propr/core';

process.env.PROPR_DEMO_MODE = 'true';
const core = await import('@propr/core');
const log = { info() {}, debug() {}, warn() {}, error() {} };

interface StoredTask { state: string; terminalReason?: string; reason?: string }
const tasks = new Map<string, StoredTask>();
let liveLabels: string[] = [];
let labelWithdrawalDetected = true;
const ran: string[] = [];

const stateManager = {
  createTaskStateIfAbsent: async (taskId: string) => {
    if (!tasks.has(taskId)) tasks.set(taskId, { state: 'pending' });
    return { taskId, ...tasks.get(taskId)! };
  },
  getTaskState: async (taskId: string) => tasks.has(taskId) ? { taskId, ...tasks.get(taskId)! } : null,
  updateTaskState: async (taskId: string, state: string) => { tasks.set(taskId, { ...tasks.get(taskId), state }); },
  markTaskCancelled: async (taskId: string, _by: string, metadata: { reason?: string; terminalReason?: string }) => {
    tasks.set(taskId, { state: 'cancelled', reason: metadata.reason, terminalReason: metadata.terminalReason });
    return { taskId, ...tasks.get(taskId)! };
  },
  markTaskCompleted: async (taskId: string) => { tasks.set(taskId, { state: 'completed' }); },
  markTaskFailed: async (taskId: string) => { tasks.set(taskId, { state: 'failed' }); },
};

await mock.module('@propr/core', { namedExports: {
  ...core,
  db: () => ({ where: () => ({ update: async () => undefined }) }),
  withdrawnIntentReason: (...args: Parameters<typeof core.withdrawnIntentReason>) => labelWithdrawalDetected ? core.withdrawnIntentReason(...args) : null,
  associateSubmissionTask: async () => undefined,
  findIssueSubmission: async () => undefined,
  readIssueCostCapOverride: async () => undefined,
  logger: { ...log, withCorrelation: () => log },
  addModelSpecificDelay: async () => undefined,
  updatePlanIssueTaskId: async () => undefined,
  ensureRepoCloned: async () => '/tmp/repository',
  ensureGitRepository: async () => undefined,
  loadSettings: async () => ({ worker_concurrency: 1 }),
} });
const { handleDispatchWithDeps } = await import('../src/jobs/issueJobDispatcher.js');
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
    agentAlias: 'claude', modelName: job.data.modelName, taskId: `task-${job.data.modelName}`,
    AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', AI_WAITING_TAG: 'AI-waiting', AI_PRIMARY_TAG: 'AI', PR_LABEL: 'PR',
  }),
  getAuthenticatedClient: async () => ({
    auth: async () => ({ token: 'fixture' }),
    request: async () => ({ data: { state: 'open', title: 'Fix dates', body: 'Fix invoice dates', labels: liveLabels.map(name => ({ name })) } }),
  }),
  checkLabelConditions: github.checkLabelConditions,
  ensureProcessingLabel: async () => { if (!liveLabels.includes('AI-processing')) liveLabels.push('AI-processing'); },
  // Each model's post-processing swaps the processing label for the done label, as a finished run does.
  executeWorktreeOperations: async ({ job }: { job: Job<IssueJobData> }) => {
    ran.push(job.data.modelName!);
    liveLabels = [...liveLabels.filter(label => label !== 'AI-processing' && label !== 'AI-done'), 'AI-done'];
    return { worktreeInfo: { worktreePath: '/tmp/worktree' }, claudeResult: { success: true }, postProcessingResult: { success: true, pr: { number: 1, url: 'https://github.com/o/r/pull/1' } }, commitResult: null };
  },
  markTaskComplete: async ({ taskId }: { taskId: string }) => { tasks.set(taskId, { state: 'completed' }); },
} });
const workflowJobs = await import('../src/jobs/repositoryWorkflow.js');
await mock.module('../src/jobs/repositoryWorkflow.js', { namedExports: { ...workflowJobs, prepareRepositoryWorkflow: async () => undefined } });
await mock.module('../src/jobs/issueJob/config.js', { namedExports: {
  redisClient: { eval: async () => 1 },
  DEFAULT_MODEL_NAME: 'model', getPrimaryProcessingLabels: async () => ['AI'], getPrLabel: async () => 'PR',
} });
const { processGitHubIssueJob } = await import('../src/jobs/processGitHubIssueJob.js');
after(core.closeConnection);

function childJob(modelName: string, extra: Partial<IssueJobData> = {}, dispatchLabels = ['AI']): Job<IssueJobData> {
  const job = {
    id: `issue-o-r-7-claude-${modelName}-main`, name: 'processGitHubIssue',
    data: {
      repoOwner: 'o', repoName: 'r', number: 7, isChildJob: true, agentAlias: 'claude', modelName, correlationId: 'submission',
      baseBranch: 'main', dispatchId: 'dispatch-job-1', dispatchIssueLabels: dispatchLabels, repoPayload: { defaultBranch: 'main' },
      issuePayload: { title: 'Fix dates', body: 'Fix invoice dates', labels: [...liveLabels].map(name => ({ name })) },
      ...extra,
    } as IssueJobData,
    updateData: async (data: IssueJobData) => { job.data = data; },
    updateProgress: async () => undefined,
  };
  return job as unknown as Job<IssueJobData>;
}

beforeEach(() => {
  tasks.clear(); ran.length = 0; liveLabels = ['AI']; labelWithdrawalDetected = true;
});

test('with concurrency 1, models of one request still run after the first labels the issue done', async () => {
  const models = ['model-a', 'model-b', 'model-c'];
  // One worker slot: each sibling starts only after the previous one finished and labelled the issue.
  for (const model of models) {
    const result = await processGitHubIssueJob(childJob(model));
    assert.equal(result.status, 'processed', `${model} ran`);
  }
  assert.deepEqual(ran, models);
  assert.deepEqual(models.map(model => tasks.get(`task-${model}`)?.state), ['completed', 'completed', 'completed']);
  assert.deepEqual(liveLabels, ['AI', 'AI-done'], 'the issue ends done with no processing label left');
});

test('a stale job on an already-done issue is skipped and its task ends instead of staying pending', async () => {
  liveLabels = ['AI', 'AI-done'];
  const stale = [
    childJob('legacy', { dispatchId: undefined }),
    // Dispatched after an earlier, separate request had already finished the issue.
    childJob('late', {}, ['AI', 'AI-done']),
  ];
  for (const job of stale) {
    const result = await processGitHubIssueJob(job);
    assert.deepEqual(result, { status: 'skipped', reason: 'Already done', issueNumber: 7 });
  }
  assert.deepEqual(ran, []);
  for (const model of ['legacy', 'late']) {
    const task = tasks.get(`task-${model}`);
    assert.equal(task?.state, 'cancelled');
    assert.equal(task?.terminalReason, 'skipped_issue_done');
    assert.equal(task?.reason, 'Skipped because the issue was already completed by another run.');
  }
});

test('a duplicate delivery of a sibling that already completed is skipped and keeps its completed task', async () => {
  await processGitHubIssueJob(childJob('model-a'));
  const result = await processGitHubIssueJob(childJob('model-a'));
  assert.equal(result.status, 'skipped');
  assert.deepEqual(ran, ['model-a']);
  assert.deepEqual(tasks.get('task-model-a'), { state: 'completed' });
});

test('the primary-tag-removed skip also ends its task', async () => {
  // The withdrawal check normally catches this first; the label gate must still not orphan the task.
  labelWithdrawalDetected = false;
  liveLabels = ['bug'];
  const result = await processGitHubIssueJob(childJob('model-a'));
  assert.deepEqual(result, { status: 'skipped', reason: 'Primary tag missing', issueNumber: 7 });
  assert.equal(tasks.get('task-model-a')?.state, 'cancelled');
  assert.equal(tasks.get('task-model-a')?.terminalReason, 'cancelled_label_removed');
});

test('a retried dispatch whose first child already finished the issue still runs its remaining models', async () => {
  liveLabels = ['AI', 'llm-model-a', 'llm-model-b', 'llm-model-c'];
  const queued = new Map<string, { name: string; data: IssueJobData }>();
  let failNextAdd = false;
  const deps = {
    findSubmission: async () => undefined,
    getAuthenticatedOctokit: async () => ({ request: async () => ({ data: { labels: liveLabels.map(name => ({ name })) } }) }),
    withRetry: async (fn: () => Promise<unknown>) => fn(),
    retryConfigs: { githubApi: {} },
    validateRepositoryInfo: async () => ({ isValid: true, repoData: { defaultBranch: 'main' } }),
    issueQueue: { add: async (name: string, data: IssueJobData, opts: { jobId: string }) => {
      if (failNextAdd && queued.size === 1) throw new Error('redis connection lost');
      if (!queued.has(opts.jobId)) queued.set(opts.jobId, { name, data });
    } },
    resolveLlmLabel: async (model: string) => ({ agentAlias: 'claude', model }),
    getAllCustomLabels: async () => [],
  } as unknown as Parameters<typeof handleDispatchWithDeps>[1];
  // BullMQ hands a retry the job data it stored, not the previous attempt's in-memory copy.
  let stored: IssueJobData = { repoOwner: 'o', repoName: 'r', number: 7, correlationId: 'submission' } as IssueJobData;
  const dispatcherAttempt = () => ({
    id: 'dispatch-job-1', name: 'processGitHubIssue', data: structuredClone(stored),
    updateData: async (data: IssueJobData) => { stored = structuredClone(data); },
  }) as unknown as Job<IssueJobData>;
  const runChild = (jobId: string) => processGitHubIssueJob({
    id: jobId, ...structuredClone(queued.get(jobId)!), updateData: async () => undefined, updateProgress: async () => undefined,
  } as unknown as Job<IssueJobData>);

  failNextAdd = true;
  await assert.rejects(handleDispatchWithDeps(dispatcherAttempt(), deps), /redis connection lost/);
  assert.deepEqual([...queued.keys()], ['issue-o-r-7-claude-model-a-main'], 'only the first child was accepted');
  // The accepted child finishes and labels the issue done before the dispatcher retries.
  assert.equal((await runChild('issue-o-r-7-claude-model-a-main')).status, 'processed');
  assert.ok(liveLabels.includes('AI-done'));

  failNextAdd = false;
  assert.equal((await handleDispatchWithDeps(dispatcherAttempt(), deps)).status, 'dispatched');
  for (const model of ['model-b', 'model-c']) {
    const result = await runChild(`issue-o-r-7-claude-${model}-main`);
    assert.equal(result.status, 'processed', `${model} ran after the retried dispatch`);
  }
  assert.deepEqual(ran, ['model-a', 'model-b', 'model-c']);
  assert.deepEqual(['model-a', 'model-b', 'model-c'].map(model => tasks.get(`task-${model}`)?.state), ['completed', 'completed', 'completed']);

  // A new dispatch that first sees the issue done still records it, so its children stay stale.
  stored = { repoOwner: 'o', repoName: 'r', number: 7, correlationId: 'submission' } as IssueJobData;
  queued.clear();
  await handleDispatchWithDeps(dispatcherAttempt(), deps);
  assert.ok(stored.dispatchIssueLabels?.includes('AI-done'));
  assert.deepEqual(await runChild('issue-o-r-7-claude-model-b-main'), { status: 'skipped', reason: 'Already done', issueNumber: 7 });
});

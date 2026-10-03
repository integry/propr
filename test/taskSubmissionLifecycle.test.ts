import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { DelayedError, type Job } from 'bullmq';
import type { IssueJobData } from '@propr/core';

process.env.PROPR_DEMO_MODE = 'true';
const core = await import('@propr/core');
const log = { info() {}, debug() {}, warn() {}, error() {} };
let submitted = false;
let capacityFull = false;
let workflowError: Error | undefined;
let taskState = 'pending';
const events: string[] = [];
let outcome: 'completed' | 'failed' | 'cancelled' = 'completed';
const taskLinks: string[] = [];
const terminal: Array<{ taskId: string; result: Record<string, unknown> }> = [];
const processingHistory: Array<{ state: string; metadata: Record<string, unknown> }> = [];
// When set, preparation uses the real policy loader against this fake GitHub API.
let githubRequests: string[] | undefined;
const workflowYaml = 'limits: { max_parallel_tasks: 1 }\nvalidation: [npm test]';
const fakeGitHubRequest = async (route: string, params: { path?: string }) => {
  githubRequests!.push(route);
  if (route === 'GET /repos/{owner}/{repo}') return { data: { default_branch: 'main' } };
  if (route === 'GET /repos/{owner}/{repo}/commits/{ref}') return { data: { sha: 'base-sha' } };
  if (route === 'GET /repos/{owner}/{repo}/contents/{path}' && params.path === '.propr/workflow.yml') {
    return { data: { type: 'file', encoding: 'base64', size: workflowYaml.length, sha: 'blob-sha', content: Buffer.from(workflowYaml).toString('base64') } };
  }
  throw new Error(`unexpected GitHub request ${route}`);
};
const stateManager = {
  createTaskStateIfAbsent: async () => { events.push('create-if-absent'); },
  createTaskState: async () => { taskState = 'pending'; events.push('create'); },
  getTaskState: async () => ({ state: taskState }),
  updateTaskState: async (_taskId: string, state: string, metadata: { historyMetadata?: Record<string, unknown> }) => {
    processingHistory.push({ state, metadata: metadata.historyMetadata ?? {} });
  },
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
  ensureRepoCloned: async () => { events.push('clone'); return '/tmp/repository'; },
  ensureGitRepository: async () => undefined,
  loadSettings: async () => ({ worker_concurrency: 4 }),
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
    stateManager, agentAlias: 'issue-agent', modelName: 'model', taskId: 'ordinary-task', AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done',
  }),
  getAuthenticatedClient: async () => ({ auth: async () => ({ token: 'fixture' }), request: fakeGitHubRequest }),
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
const workflowJobs = await import('../src/jobs/repositoryWorkflow.js');
await mock.module('../src/jobs/repositoryWorkflow.js', { namedExports: {
  ...workflowJobs,
  prepareRepositoryWorkflow: async (options: Parameters<typeof workflowJobs.prepareRepositoryWorkflow>[0]) => {
    if (workflowError) throw workflowError;
    return githubRequests ? workflowJobs.prepareRepositoryWorkflow(options) : undefined;
  },
} });
await mock.module('../src/jobs/issueJob/config.js', { namedExports: {
  redisClient: { eval: async () => capacityFull ? 0 : 1 },
  DEFAULT_MODEL_NAME: 'model', getPrimaryProcessingLabels: async () => ['AI'], getPrLabel: async () => 'PR',
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
      }, updateData: async () => undefined, updateProgress: async () => undefined } as unknown as Job<IssueJobData>);
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


test('issue capacity refusal delays before cloning, preserves task identity, and checks cancellation on re-entry', async () => {
  capacityFull = true; submitted = false; events.length = 0; terminal.length = 0;
  const job = {
    id: 'capacity-job', name: 'processGitHubIssue', token: 'lock-token',
    data: { repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true } as IssueJobData,
    updateData: async (data: IssueJobData) => { job.data = data; events.push(data.repositoryWorkflowDeferred ? 'persist-deferral' : 'persist-identity'); },
    moveToDelayed: async (_deadline: number, token?: string) => { assert.equal(token, 'lock-token'); events.push('delay'); },
  };
  try {
    await assert.rejects(processGitHubIssueJob(job as never), DelayedError);
    assert.deepEqual(events, ['persist-identity', 'create', 'persist-deferral', 'delay']);
    assert.equal(job.data.correlationId, 'correlation');
    assert.equal(terminal.length, 0, 'capacity refusal is not a task failure');
    taskState = 'cancelled'; events.length = 0;
    await assert.rejects(processGitHubIssueJob(job as never), /Task ended/);
    assert.deepEqual(events, ['create-if-absent']);
    assert.equal(terminal.length, 0, 're-entry does not overwrite cancellation');
  } finally { capacityFull = false; taskState = 'pending'; }
});

test('workflow preparation failures retain normal issue error reporting', async () => {
  workflowError = new Error('Invalid .propr/workflow.yml: expanded wrapper exceeds limit');
  terminal.length = 0;
  try {
    await assert.rejects(processGitHubIssueJob({
      id: 'invalid-workflow', name: 'processGitHubIssue',
      data: { repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true, agentAlias: 'issue-agent', modelName: 'model', correlationId: 'correlation' },
    } as never), /expanded wrapper/);
    assert.equal(terminal[0].result.status, 'failed');
  } finally { workflowError = undefined; }
});


test('ordinary failed issue retries retain their existing task initialization behavior', async () => {
  taskState = 'failed'; outcome = 'completed'; events.length = 0;
  try {
    const result = await processGitHubIssueJob({
      id: 'retry-job', name: 'processGitHubIssue',
      data: { repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true, agentAlias: 'issue-agent', modelName: 'model', correlationId: 'correlation',
        issuePayload: { title: 'Fix dates', body: '', labels: [{ name: 'AI' }] }, repoPayload: { defaultBranch: 'main' } },
      updateProgress: async () => undefined,
    } as never);
    assert.equal(result.status, 'processed');
    assert.ok(events.includes('create'));
    assert.ok(events.includes('clone'));
  } finally { taskState = 'pending'; }
});

const issueJobData = (): IssueJobData => ({
  repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true, agentAlias: 'issue-agent', modelName: 'model', correlationId: 'correlation',
  issuePayload: { title: 'Fix dates', body: '', labels: [{ name: 'AI' }] }, repoPayload: { defaultBranch: 'main' },
} as IssueJobData);

test('the PROCESSING timeline entry records the workflow path and base revision that governed the issue', async () => {
  githubRequests = []; processingHistory.length = 0; outcome = 'completed';
  try {
    const result = await processGitHubIssueJob({
      id: 'workflow-job', name: 'processGitHubIssue', data: issueJobData(),
      updateData: async () => undefined, updateProgress: async () => undefined,
    } as never);
    assert.equal(result.status, 'processed');
    const processing = processingHistory.filter(entry => entry.state === core.TaskStates.PROCESSING);
    assert.equal(processing.length, 1);
    assert.deepEqual(processing[0].metadata.repositoryWorkflow, {
      path: '.propr/workflow.yml', baseBranch: 'main', revision: 'base-sha', fileRevision: 'blob-sha', maxParallelTasks: 1, timeoutMs: 600_000,
    });
  } finally { githubRequests = undefined; }
});

test('capacity re-entries reuse the resolved policy, back off, and reload it after admission', async () => {
  githubRequests = []; processingHistory.length = 0; outcome = 'completed'; capacityFull = true;
  const delays: number[] = [];
  const job = {
    id: 'waiting-job', name: 'processGitHubIssue', token: 'lock-token', data: issueJobData(),
    updateData: async (data: IssueJobData) => { job.data = JSON.parse(JSON.stringify(data)); },
    updateProgress: async () => undefined,
    moveToDelayed: async (deadline: number) => { delays.push(deadline - Date.now()); },
  };
  try {
    for (let refusal = 0; refusal < 3; refusal++) await assert.rejects(processGitHubIssueJob(job as never), DelayedError);
    assert.equal(githubRequests.filter(route => route.includes('/contents/')).length, 1, 'policy is fetched once across refusals');
    assert.equal(githubRequests.length, 3);
    assert.equal(job.data.repositoryWorkflowDeferrals, 3);
    assert.equal(job.data.repositoryWorkflow?.revision, 'base-sha');
    // Jittered exponential backoff: each ceiling doubles from 10 s.
    delays.forEach((delay, index) => assert.ok(delay >= 5_000 * 2 ** index - 50 && delay <= 10_000 * 2 ** index + 50, `delay ${index}: ${delay}`));
    capacityFull = false;
    assert.equal((await processGitHubIssueJob(job as never)).status, 'processed');
    assert.equal(githubRequests.length, 3, 'admitted re-entry reuses the policy that was waiting');
    assert.equal((processingHistory.find(entry => entry.state === core.TaskStates.PROCESSING)?.metadata.repositoryWorkflow as { revision: string }).revision, 'base-sha');
    assert.equal(job.data.repositoryWorkflowDeferred, false);
    assert.equal(job.data.repositoryWorkflow, undefined, 'ordinary retries reload base branch policy');
    assert.equal(job.data.repositoryWorkflowDeferrals, undefined);
  } finally { githubRequests = undefined; capacityFull = false; }
});

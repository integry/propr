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
let liveIssue = { state: 'open', title: 'Fix dates', body: 'Fix invoice dates', labels: [{ name: 'AI' }] };
const cancellations: Array<Record<string, unknown>> = [];
let outcome: 'completed' | 'failed' | 'cancelled' | 'withdrawn' | 'rate-limited' = 'completed';
let withdrawnDuringExecution = false;
let handoffDuringRetry: 'before scheduling' | 'after scheduling' | undefined;
let handoffState: any;
let scheduled = 0;
let initialState: { state: string; terminalReason?: string; history?: unknown[] } | undefined;
let executionCancellationReason: string | undefined = 'cancelled_label_removed';
const labelCleanups: unknown[][] = [];
// Closure obligation lifecycle: retained, passed to exclusion, released.
const obligations: string[] = [];
const exclusions: unknown[][] = [];
let exclusionStands = true;
let exclusionError: Error | undefined;
const taskLinks: string[] = [];
const githubComments: string[] = [];
const storedRefs: unknown[] = [];
const queueAssignments: unknown[] = [];
const transitions: unknown[] = [];
const terminal: Array<{ taskId: string; result: Record<string, unknown> }> = [];
const processingHistory: Array<{ state: string; metadata: Record<string, unknown> }> = [];
const deferralHistory: unknown[][] = [];
// When set, preparation uses the real policy loader against this fake GitHub API.
let githubRequests: string[] | undefined;
const workflowYaml = 'limits: { max_parallel_tasks: 1 }\nvalidation: [npm test]';
const fakeGitHubRequest = async (route: string, params: { path?: string; body?: string }) => {
  if (route.endsWith('/comments')) { githubComments.push(params.body!); return { data: liveIssue }; }
  if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') return { data: liveIssue };
  githubRequests!.push(route);
  if (route === 'GET /repos/{owner}/{repo}') return { data: { default_branch: 'main' } };
  if (route === 'GET /repos/{owner}/{repo}/commits/{ref}') return { data: { sha: 'base-sha' } };
  if (route === 'GET /repos/{owner}/{repo}/contents/{path}' && params.path === '.propr/workflow.yml') {
    return { data: { type: 'file', encoding: 'base64', size: workflowYaml.length, sha: 'blob-sha', content: Buffer.from(workflowYaml).toString('base64') } };
  }
  throw new Error(`unexpected GitHub request ${route}`);
};
const stateManager = {
  markTaskCancelled: async (_id: string, _by: string, metadata: Record<string, unknown>) => { obligations.push('record'); cancellations.push(metadata); },
  createTaskStateIfAbsent: async (_id: string, ref: unknown) => { events.push('create-if-absent'); storedRefs.push(ref); return initialState; },
  updateTaskStateIfCurrent: async (...args: unknown[]) => { deferralHistory.push(args); events.push('deferral-history'); return {}; },
  getTaskState: async () => handoffState ?? (withdrawnDuringExecution ? { state: 'cancelled', terminalReason: executionCancellationReason } : taskState === 'pending' ? null : { state: taskState }),
  updateTaskState: async (...args: unknown[]) => {
    transitions.push(args);
    const [, state, metadata] = args as [string, string, { historyMetadata?: Record<string, unknown> } | undefined];
    processingHistory.push({ state, metadata: metadata?.historyMetadata ?? {} });
  },
  markTaskCompleted: async (taskId: string, result: Record<string, unknown>) => { terminal.push({ taskId, result }); },
  markTaskFailed: async (taskId: string, error: Error) => { terminal.push({ taskId, result: { status: 'failed', error: error.message } }); },
};
await mock.module('@propr/core', { namedExports: {
  ...core,
  db: () => ({ where: (where: unknown) => ({ update: async (fields: unknown) => { queueAssignments.push({ where, fields }); } }) }),
  preventWithdrawnJob: async () => null,
  updateWithdrawnIssueLabels: async (...args: unknown[]) => { labelCleanups.push(args); },
  retainClosureCleanup: async (_target: unknown, reason: string) => {
    if (reason !== 'cancelled_issue_closed') return undefined;
    obligations.push('retain');
    return { member: 'obligation' };
  },
  releaseWithdrawalCleanup: async (cleanup: unknown) => { if (cleanup) obligations.push('release'); },
  excludeWithdrawnIssue: async (...args: unknown[]) => {
    exclusions.push(args);
    if (exclusionError) {
      // The cancellation is recorded, so the processor's catch path sees it.
      handoffState = { state: 'cancelled', terminalReason: args[1] };
      throw exclusionError;
    }
    return exclusionStands;
  },
  loadPrimaryProcessingLabels: async () => ['AI', 'build'],
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
  handleUsageLimitError: async () => { scheduled++; if (handoffDuringRetry === 'after scheduling') handoffState = { state: 'cancelled', history: [{ metadata: { jobResultStatus: 'requeued' } }] }; },
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
    stateManager, agentAlias: 'issue-agent', modelName: 'model', taskId: 'ordinary-task', AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', AI_PRIMARY_TAG: 'AI',
  }),
  getAuthenticatedClient: async () => ({ auth: async () => ({ token: 'fixture' }), request: fakeGitHubRequest }),
  checkLabelConditions: () => ({ skip: false }),
  ensureProcessingLabel: async () => undefined,
  executeWorktreeOperations: async () => {
    if (outcome === 'rate-limited') {
      if (handoffDuringRetry === 'before scheduling') handoffState = { state: 'cancelled', history: [{ metadata: { jobResultStatus: 'requeued' } }] };
      throw new core.UsageLimitError('Usage limit', 1);
    }
    if (outcome === 'withdrawn') {
      withdrawnDuringExecution = true;
      throw new Error(executionCancellationReason === 'cancelled_by_user' ? 'Execution aborted by user' : 'Execution aborted after cancellation');
    }
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
    assert.deepEqual(events, ['persist-identity', 'create-if-absent', 'persist-deferral', 'delay']);
    assert.equal(job.data.correlationId, 'correlation');
    assert.equal(terminal.length, 0, 'capacity refusal is not a task failure');
    taskState = 'cancelled'; events.length = 0;
    await assert.rejects(processGitHubIssueJob(job as never), /Task ended/);
    assert.deepEqual(events, ['create-if-absent']);
    assert.equal(terminal.length, 0, 're-entry does not overwrite cancellation');
  } finally { capacityFull = false; taskState = 'pending'; }
});

test('an issue capacity wait is explained on the timeline after the deferral is persisted', async () => {
  capacityFull = true; taskState = 'queued'; events.length = 0; deferralHistory.length = 0;
  const job = {
    id: 'capacity-job', name: 'processGitHubIssue', token: 'lock-token',
    data: { repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true, correlationId: 'c', agentAlias: 'a', modelName: 'm' } as IssueJobData,
    updateData: async (data: IssueJobData) => { job.data = data; events.push('persist-deferral'); },
    moveToDelayed: async (deadline: number) => { events.push(`delay:${deadline === job.data.repositoryWorkflowRetryAt}`); },
  };
  try {
    await assert.rejects(processGitHubIssueJob(job as never), DelayedError);
    assert.deepEqual(events.filter(event => event !== 'create-if-absent'), ['persist-deferral', 'deferral-history', 'delay:true']);
    const [taskId, , state, metadata] = deferralHistory[0] as [string, unknown, string, { reason: string; historyMetadata: Record<string, unknown> }];
    assert.equal(state, 'queued', 'the wait does not change task state');
    assert.ok(taskId);
    assert.match(metadata.reason, /Waiting for repository workflow capacity/);
    assert.deepEqual(metadata.historyMetadata, { repositoryWorkflowDeferrals: 1, repositoryWorkflowRetryAt: new Date(job.data.repositoryWorkflowRetryAt!).toISOString() });
  } finally { capacityFull = false; taskState = 'pending'; }
});

test('an issue capacity refusal that cannot be persisted fails the task instead of leaving it pending', async () => {
  capacityFull = true; terminal.length = 0; deferralHistory.length = 0;
  const job = {
    id: 'capacity-job', name: 'processGitHubIssue', token: 'lock-token',
    data: { repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true, correlationId: 'c', agentAlias: 'a', modelName: 'm' } as IssueJobData,
    updateData: async () => { throw new Error('Queue data update failed'); },
    moveToDelayed: async () => assert.fail('an unpersisted deferral must not be delayed'),
  };
  try {
    await assert.rejects(processGitHubIssueJob(job as never), /Queue data update failed/);
    assert.deepEqual(terminal.map(entry => entry.result.status), ['failed']);
    assert.equal(deferralHistory.length, 0, 'no wait is announced for an unpersisted deferral');
  } finally { capacityFull = false; }
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


test('ordinary failed issue retries resume their existing task', async () => {
  initialState = { state: 'failed' }; outcome = 'completed'; events.length = 0; transitions.length = 0;
  try {
    const result = await processGitHubIssueJob({
      id: 'retry-job', name: 'processGitHubIssue',
      data: { repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true, agentAlias: 'issue-agent', modelName: 'model', correlationId: 'correlation',
        issuePayload: { title: 'Fix dates', body: '', labels: [{ name: 'AI' }] }, repoPayload: { defaultBranch: 'main' } },
      updateProgress: async () => undefined,
    } as never);
    assert.equal(result.status, 'processed');
    assert.ok(events.includes('create-if-absent'));
    assert.deepEqual(transitions[0], ['ordinary-task', 'processing', { isRetry: true, reason: 'Resuming issue task' }]);
    assert.ok(events.includes('clone'));
  } finally { initialState = undefined; }
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
    // The dispatched repository payload already names the default branch.
    assert.deepEqual(githubRequests, ['GET /repos/{owner}/{repo}/commits/{ref}', 'GET /repos/{owner}/{repo}/contents/{path}']);
    assert.equal(job.data.repositoryWorkflowDeferrals, 3);
    assert.equal(job.data.repositoryWorkflow?.revision, 'base-sha');
    // Jittered exponential backoff: each ceiling doubles from 10 s.
    delays.forEach((delay, index) => assert.ok(delay >= 5_000 * 2 ** index - 50 && delay <= 10_000 * 2 ** index + 50, `delay ${index}: ${delay}`));
    capacityFull = false;
    assert.equal((await processGitHubIssueJob(job as never)).status, 'processed');
    assert.equal(githubRequests.length, 2, 'admitted re-entry reuses the policy that was waiting');
    assert.equal((processingHistory.find(entry => entry.state === core.TaskStates.PROCESSING)?.metadata.repositoryWorkflow as { revision: string }).revision, 'base-sha');
    assert.equal(job.data.repositoryWorkflowDeferred, false);
    assert.equal(job.data.repositoryWorkflow, undefined, 'ordinary retries reload base branch policy');
    assert.equal(job.data.repositoryWorkflowDeferrals, undefined);
  } finally { githubRequests = undefined; capacityFull = false; }
});

test('issue withdrawal detected after admission persists readable history and retains its result code', async () => {
  for (const [state, labels, code, explanation] of [
    ['closed', [{ name: 'AI' }], 'cancelled_issue_closed', 'Cancelled because the issue was closed.'],
    ['open', [], 'cancelled_label_removed', 'Cancelled because the processing trigger label was removed.'],
  ] as const) {
    liveIssue = { ...liveIssue, state, labels: [...labels] };
    cancellations.length = 0;
    const result = await processGitHubIssueJob({ id: 'ordinary-job', updateData: async () => undefined, name: 'processGitHubIssue', data: {
      repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true, modelName: 'model',
    } } as unknown as Job<IssueJobData>);
    assert.deepEqual(result, { status: 'cancelled', reason: code });
    assert.deepEqual(cancellations, [{ reason: explanation, terminalReason: code }]);
  }
});


for (const [cancellationReason, phase] of [
  ['cancelled_label_removed', 'after admission'],
  ['cancelled_label_removed', 'during execution'],
  ['cancelled_issue_closed', 'during execution'],
]) {
  test(`${cancellationReason} ${phase} gives label cleanup the task trigger, relevant triggers and terminal reason`, async () => {
    liveIssue = { ...liveIssue, state: 'open', labels: [{ name: phase === 'after admission' ? 'build' : 'AI' }] };
    outcome = 'withdrawn';
    executionCancellationReason = cancellationReason;
    exclusions.length = 0;
    try {
      const result = await processGitHubIssueJob({ id: 'ordinary-job', updateData: async () => undefined, name: 'processGitHubIssue', data: {
        repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true, modelName: 'model', repoPayload: { defaultBranch: 'main' },
      }, updateProgress: async () => undefined } as unknown as Job<IssueJobData>);
      assert.deepEqual(result, { status: 'cancelled', reason: cancellationReason });
      assert.equal(exclusions.length, 1);
      const [target, reason] = exclusions[0] as [Record<string, unknown>, string];
      assert.equal(target.triggeringLabel, 'AI');
      assert.equal(reason, cancellationReason);
    } finally {
      withdrawnDuringExecution = false;
      executionCancellationReason = 'cancelled_label_removed';
      outcome = 'completed';
    }
  });
}

test('a closure found by the worker retains its obligation before recording and keeps it when exclusion fails', async () => {
  liveIssue = { ...liveIssue, state: 'closed', labels: [{ name: 'AI' }] };
  for (const stands of [false, true]) {
    exclusionStands = stands;
    obligations.length = 0;
    exclusions.length = 0;
    const result = await processGitHubIssueJob({ id: 'ordinary-job', updateData: async () => undefined, name: 'processGitHubIssue', data: {
      repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true, modelName: 'model',
    } } as unknown as Job<IssueJobData>);
    assert.deepEqual(result, { status: 'cancelled', reason: 'cancelled_issue_closed' });
    // The worker leaves release to the exclusion, which drops it only once the marker stands.
    assert.deepEqual(obligations, ['retain', 'record']);
    assert.equal(exclusions.length, 1);
    assert.equal(exclusions[0][1], 'cancelled_issue_closed');
    assert.deepEqual(exclusions[0][3], { member: 'obligation' }, 'the pre-recording obligation is handed to the exclusion');
  }
  exclusionStands = true;
  liveIssue = { ...liveIssue, state: 'open' };
});

test('worker closure cleanup failures keep the obligation through the catch path', async () => {
  liveIssue = { ...liveIssue, state: 'closed', labels: [{ name: 'AI' }] };
  obligations.length = 0;
  exclusions.length = 0;
  exclusionError = new Error('Service Unavailable');
  try {
    await assert.rejects(processGitHubIssueJob({ id: 'ordinary-job', updateData: async () => undefined, name: 'processGitHubIssue', data: {
      repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true, modelName: 'model',
    } } as unknown as Job<IssueJobData>), /Service Unavailable/);
    assert.deepEqual(obligations, ['retain', 'record'], 'no failed cleanup releases the obligation');
    assert.equal(exclusions.length, 2, 'the catch path retries the exclusion');
    assert.equal(exclusions[1][1], 'cancelled_issue_closed');
  } finally {
    exclusionError = undefined;
    handoffState = undefined;
    liveIssue = { ...liveIssue, state: 'open' };
  }
});

for (const reason of ['cancelled_by_user', 'timed_out', 'cancelled_pr_closed', 'pr_merged', undefined]) {
  test(`matrix child cancellation (${reason ?? 'missing reason'}) does not request issue-wide label cleanup`, async () => {
    // A completed sibling has a PR; another sibling is still processing.
    liveIssue = { ...liveIssue, state: 'open', labels: ['AI', 'AI-done', 'AI-processing', 'AI-waiting'].map(name => ({ name })) };
    outcome = 'withdrawn';
    executionCancellationReason = reason;
    labelCleanups.length = 0;
    terminal.length = 0;
    githubComments.length = 0;
    try {
      const result = await processGitHubIssueJob({ id: 'matrix-child-b', updateData: async () => undefined, name: 'processGitHubIssue', data: {
        repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true, modelName: 'model-b', repoPayload: { defaultBranch: 'main' },
      }, updateProgress: async () => undefined } as unknown as Job<IssueJobData>);
      assert.deepEqual(result, { status: 'cancelled', reason });
      if (reason === 'cancelled_by_user') {
        assert.equal(githubComments.length, 1);
        assert.match(githubComments[0], /Execution Cancelled/);
        assert.match(githubComments[0], /remove and re-add the trigger label/);
        assert.equal(labelCleanups.length, 1);
        assert.equal(labelCleanups[0][2], reason);
        assert.equal(labelCleanups[0][3], 'ordinary-task', 'cleanup must exclude only the stopped attempt');
      } else { assert.deepEqual(labelCleanups, []); assert.deepEqual(githubComments, []); }
      assert.deepEqual(terminal, [], 'the recorded cancellation remains authoritative');
    } finally {
      withdrawnDuringExecution = false;
      executionCancellationReason = 'cancelled_label_removed';
      outcome = 'completed';
    }
  });
}


test('user cancellation during state creation still cleans up its processing label', async () => {
  initialState = { state: 'cancelled', terminalReason: 'cancelled_by_user' };
  labelCleanups.length = 0;
  try {
    const result = await processGitHubIssueJob({ id: 'ordinary-job', updateData: async () => undefined, name: 'processGitHubIssue', data: {
      repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true, modelName: 'model',
    } } as unknown as Job<IssueJobData>);
    assert.deepEqual(result, { status: 'cancelled', reason: 'cancelled_by_user' });
    assert.equal(labelCleanups.length, 1);
    assert.equal(labelCleanups[0][3], 'ordinary-task');
  } finally { initialState = undefined; }
});

test('issue preparation persists only intent and display reference fields', async () => {
  initialState = { state: 'cancelled', terminalReason: 'cancelled_by_user' };
  storedRefs.length = 0;
  try {
    await processGitHubIssueJob({ id: 'compact', updateData: async () => undefined, data: {
      repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true,
      modelName: 'model', agentAlias: 'codex', triggeringLabel: 'AI', correlationId: 'goal-id',
      issuePayload: { body: 'large issue body' }, repoPayload: { description: 'large repo' }, prProcessingLockToken: 'secret',
    } } as unknown as Job<IssueJobData>);
    assert.deepEqual(storedRefs[0], { repoOwner: 'owner', repoName: 'repo', number: 42, type: 'issue',
      modelName: 'model', agentAlias: 'codex', triggeringLabel: 'AI', correlationId: 'goal-id' });
  } finally { initialState = undefined; }
});

test('resuming a handoff retains the task and parent correlation while assigning its retry queue job', async () => {
  initialState = { state: 'cancelled', history: [{ reason: 'Task job requeued: rate_limit', metadata: { jobResultStatus: 'requeued' } }] };
  outcome = 'completed';
  liveIssue = { ...liveIssue, state: 'open', labels: [{ name: 'AI' }] };
  queueAssignments.length = 0;
  transitions.length = 0;
  try {
    const result = await processGitHubIssueJob({ id: 'retry-queue-job', updateData: async () => undefined, data: {
      repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true, isRetryFromRateLimit: true,
      modelName: 'model', correlationId: 'parent-goal', triggeringLabel: 'AI', repoPayload: { defaultBranch: 'main' },
    }, updateProgress: async () => undefined } as unknown as Job<IssueJobData>);
    assert.equal(result.status, 'processed');
    assert.deepEqual(queueAssignments, [{ where: { task_id: 'ordinary-task' }, fields: { job_id: 'retry-queue-job' } }]);
    assert.deepEqual(transitions[0], ['ordinary-task', 'processing', { isRetry: true, reason: 'Resuming issue task' }]);
    assert.equal((storedRefs.at(-1) as any).correlationId, 'parent-goal');
  } finally { initialState = undefined; }
});

for (const boundary of ['before scheduling', 'after scheduling'] as const) {
  test(`processor reports a rate-limit handoff when bookkeeping cancellation appears ${boundary}`, async () => {
    handoffDuringRetry = boundary;
    outcome = 'rate-limited';
    scheduled = 0;
    try {
      const result = await processGitHubIssueJob({ id: 'source', updateData: async () => undefined, data: {
        repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true,
        modelName: 'model', correlationId: 'parent-goal', triggeringLabel: 'AI', repoPayload: { defaultBranch: 'main' },
      }, updateProgress: async () => undefined } as unknown as Job<IssueJobData>);
      assert.deepEqual(result, { status: 'requeued', reason: 'rate_limit' });
      assert.equal(scheduled, 1);
    } finally { handoffDuringRetry = undefined; handoffState = undefined; outcome = 'completed'; }
  });
}

test('worker cancels a retry with a stale failure result when the issue closes after admission', async () => {
  initialState = { state: 'failed' };
  handoffState = { state: 'processing', prResult: { status: 'failed', prCreated: false } };
  liveIssue = { ...liveIssue, state: 'closed', labels: [{ name: 'AI' }] };
  cancellations.length = 0;
  terminal.length = 0;
  try {
    const result = await processGitHubIssueJob({ id: 'retry-queue-job', updateData: async () => undefined, data: {
      repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true,
      modelName: 'model', triggeringLabel: 'AI', repoPayload: { defaultBranch: 'main' },
    }, updateProgress: async () => undefined } as unknown as Job<IssueJobData>);
    assert.deepEqual(result, { status: 'cancelled', reason: 'cancelled_issue_closed' });
    assert.equal(cancellations[0].terminalReason, 'cancelled_issue_closed');
    assert.deepEqual(terminal, [], 'the worker must stop before executing or publishing a result');
  } finally {
    initialState = undefined;
    handoffState = undefined;
    liveIssue = { ...liveIssue, state: 'open' };
  }
});

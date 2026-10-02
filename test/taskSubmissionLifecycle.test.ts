import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import type { Job } from 'bullmq';
import type { IssueJobData } from '@propr/core';

process.env.PROPR_DEMO_MODE = 'true';
const core = await import('@propr/core');
const log = { info() {}, debug() {}, warn() {}, error() {} };
let submitted = false;
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
const taskLinks: string[] = [];
const githubComments: string[] = [];
const storedRefs: unknown[] = [];
const queueAssignments: unknown[] = [];
const transitions: unknown[] = [];
const terminal: Array<{ taskId: string; result: Record<string, unknown> }> = [];
const stateManager = {
  markTaskCancelled: async (_id: string, _by: string, metadata: Record<string, unknown>) => { cancellations.push(metadata); },
  createTaskStateIfAbsent: async (_id: string, ref: unknown) => { storedRefs.push(ref); return initialState; },
  getTaskState: async () => handoffState ?? (withdrawnDuringExecution ? { state: 'cancelled', terminalReason: executionCancellationReason } : null),
  updateTaskState: async (...args: unknown[]) => { transitions.push(args); },
  markTaskCompleted: async (taskId: string, result: Record<string, unknown>) => { terminal.push({ taskId, result }); },
  markTaskFailed: async (taskId: string, error: Error) => { terminal.push({ taskId, result: { status: 'failed', error: error.message } }); },
};
await mock.module('@propr/core', { namedExports: {
  ...core,
  db: () => ({ where: (where: unknown) => ({ update: async (fields: unknown) => { queueAssignments.push({ where, fields }); } }) }),
  preventWithdrawnJob: async () => null,
  updateWithdrawnIssueLabels: async (...args: unknown[]) => { labelCleanups.push(args); },
  loadPrimaryProcessingLabels: async () => ['AI', 'build'],
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
    stateManager, modelName: 'model', taskId: 'ordinary-task', AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', AI_PRIMARY_TAG: 'AI',
  }),
  getAuthenticatedClient: async () => ({ auth: async () => ({ token: 'fixture' }), request: async (endpoint: string, params: any) => { if (endpoint.endsWith('/comments')) githubComments.push(params.body); return { data: liveIssue }; } }),
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

test('issue withdrawal detected after admission persists readable history and retains its result code', async () => {
  for (const [state, labels, code, explanation] of [
    ['closed', [{ name: 'AI' }], 'cancelled_issue_closed', 'Cancelled because the issue was closed.'],
    ['open', [], 'cancelled_label_removed', 'Cancelled because the processing trigger label was removed.'],
  ] as const) {
    liveIssue = { ...liveIssue, state, labels: [...labels] };
    cancellations.length = 0;
    const result = await processGitHubIssueJob({ id: 'ordinary-job', name: 'processGitHubIssue', data: {
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
    labelCleanups.length = 0;
    try {
      const result = await processGitHubIssueJob({ id: 'ordinary-job', name: 'processGitHubIssue', data: {
        repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true, modelName: 'model', repoPayload: { defaultBranch: 'main' },
      }, updateProgress: async () => undefined } as unknown as Job<IssueJobData>);
      assert.deepEqual(result, { status: 'cancelled', reason: cancellationReason });
      assert.equal(labelCleanups.length, 1);
      const [target, triggers, reason] = labelCleanups[0] as [Record<string, unknown>, string[], string];
      assert.equal(target.triggeringLabel, 'AI');
      assert.deepEqual(triggers, ['AI', 'build']);
      assert.equal(reason, cancellationReason);
    } finally {
      withdrawnDuringExecution = false;
      executionCancellationReason = 'cancelled_label_removed';
      outcome = 'completed';
    }
  });
}

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
      const result = await processGitHubIssueJob({ id: 'matrix-child-b', name: 'processGitHubIssue', data: {
        repoOwner: 'owner', repoName: 'repo', number: 42, isChildJob: true, modelName: 'model-b', repoPayload: { defaultBranch: 'main' },
      }, updateProgress: async () => undefined } as unknown as Job<IssueJobData>);
      assert.deepEqual(result, { status: 'cancelled', reason });
      if (reason === 'cancelled_by_user') {
        assert.equal(githubComments.length, 1);
        assert.match(githubComments[0], /Execution Cancelled/);
        assert.match(githubComments[0], /re-add the AI label/);
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
    const result = await processGitHubIssueJob({ id: 'ordinary-job', name: 'processGitHubIssue', data: {
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
    await processGitHubIssueJob({ id: 'compact', data: {
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
    const result = await processGitHubIssueJob({ id: 'retry-queue-job', data: {
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
      const result = await processGitHubIssueJob({ id: 'source', data: {
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
    const result = await processGitHubIssueJob({ id: 'retry-queue-job', data: {
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

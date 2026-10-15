/**
 * A requested issue retry withdrawn between its publication and its run, at
 * the issue worker's actual cancellation boundary.
 *
 * The follow-up is published through the route and dispatched by the matrix
 * dispatcher, as in the other follow-up suites; its child then runs through
 * the actual issue worker, `processGitHubIssueJob`, whose withdrawal checks
 * read the issue from the same simulated GitHub. Only the provider's
 * execution, the task state store and the repository's worktree are
 * simulated: a provider run records the job it was given.
 */

import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import type { Job } from 'bullmq';
import type { IssueJobData, JobResult } from '../../core/src/queue/taskQueue.types.js';
import { state, request, claims, postFollowup, FIRST_COMMENT_ID } from './taskFollowupFixture.js';
import { openRequests, dispatchQueued, promptFor, onIssue, dedupKey, requestChildId } from './taskFollowupIssueDispatch.js';

const core = await import('@propr/core');
const log = { info() {}, debug() {}, warn() {}, error() {}, withCorrelation: () => log };

/** The provider runs the worker started: the job each was given. */
const providerRuns: IssueJobData[] = [];
/** Whether a provider run is withdrawn while it executes: the trigger is removed, and the run aborts. */
let withdrawDuringRun = false;
const tasks = new Map<string, { state: string; terminalReason?: string }>();
const exclusions: Array<{ number: number; reason: string }> = [];

const stateManager = {
  createTaskStateIfAbsent: async (taskId: string) => {
    if (!tasks.has(taskId)) tasks.set(taskId, { state: 'pending' });
    return tasks.get(taskId);
  },
  getTaskState: async (taskId: string) => tasks.get(taskId) ?? null,
  updateTaskState: async (taskId: string, next: string) => { tasks.set(taskId, { ...tasks.get(taskId), state: next }); },
  updateTaskStateIfCurrent: async () => ({}),
  markTaskCancelled: async (taskId: string, _by: string, metadata: { terminalReason: string }) => {
    tasks.set(taskId, { state: 'cancelled', terminalReason: metadata.terminalReason });
    return tasks.get(taskId);
  },
  markTaskCompleted: async (taskId: string) => { tasks.set(taskId, { state: 'completed' }); },
  markTaskFailed: async (taskId: string) => { tasks.set(taskId, { state: 'failed' }); },
};

await mock.module('@propr/core', { namedExports: {
  ...core,
  db: () => ({ where: () => ({ update: async () => 0 }) }),
  findIssueSubmission: async () => undefined,
  retainClosureCleanup: async () => undefined,
  releaseWithdrawalCleanup: async () => undefined,
  excludeWithdrawnIssue: async (target: { number: number }, reason: string) => { exclusions.push({ number: target.number, reason }); return true; },
  updateWithdrawnIssueLabels: async () => undefined,
  readIssueCostCapOverride: async () => undefined,
  logger: log,
  addModelSpecificDelay: async () => undefined,
  updatePlanIssueTaskId: async () => undefined,
  ensureRepoCloned: async () => '/tmp/repository',
  ensureGitRepository: async () => undefined,
  loadSettings: async () => ({ worker_concurrency: 4 }),
} });
await mock.module('../../../src/jobs/issueJobHelpers.js', { namedExports: {
  handleUsageLimitError: async () => undefined,
  handleGenericError: async () => undefined,
  updateTaskTitleInStorage: async () => undefined,
  buildFinalResult: () => ({ status: 'processed' }),
} });
await mock.module('../../../src/jobs/issueJobPostProcessing.js', { namedExports: { performFinalValidation: async () => undefined } });
await mock.module('../../../src/jobs/issueJob/index.js', { namedExports: {
  initializeJobContext: async (job: Job<IssueJobData>) => ({
    jobId: job.id, issueRef: job.data, correlationId: job.data.correlationId ?? `correlation-${job.id}`, correlatedLogger: log,
    stateManager, agentAlias: job.data.agentAlias, modelName: job.data.modelName, taskId: `task-${job.id}`,
    AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', AI_PRIMARY_TAG: 'AI', AI_WAITING_TAG: 'AI-waiting',
  }),
  // The worker reads the issue from the same GitHub the route published the request on.
  getAuthenticatedClient: async () => ({ auth: async () => ({ token: 'fixture' }), request }),
  checkLabelConditions: () => ({ skip: false }),
  ensureProcessingLabel: async () => undefined,
  // The provider's execution: it records the job it was given, or is aborted by a withdrawal while it runs.
  executeWorktreeOperations: async ({ job }: { job: Job<IssueJobData> }) => {
    providerRuns.push(job.data);
    if (withdrawDuringRun) {
      state.issueLabels = state.issueLabels.filter(label => label !== 'AI');
      tasks.set(`task-${job.id}`, { state: 'cancelled', terminalReason: 'cancelled_label_removed' });
      throw new Error('Execution aborted after cancellation');
    }
    return { worktreeInfo: { worktreePath: '/tmp/worktree' }, claudeResult: { success: true }, postProcessingResult: { success: true }, commitResult: null };
  },
  markTaskComplete: async () => undefined,
} });
const workflowJobs = await import('../../../src/jobs/repositoryWorkflow.js');
await mock.module('../../../src/jobs/repositoryWorkflow.js', { namedExports: {
  ...workflowJobs,
  prepareRepositoryWorkflow: async () => undefined,
} });
// The worker's own Redis connection is never opened: admission has no repository policy to hold a slot for.
await mock.module('../../../src/jobs/issueJob/config.js', { namedExports: {
  redisClient: { eval: async () => 1 },
  DEFAULT_MODEL_NAME: 'claude-opus-5-5', getPrimaryProcessingLabels: async () => ['AI'], getPrLabel: async () => 'PR',
} });
const { processGitHubIssueJob } = await import('../../../src/jobs/processGitHubIssueJob.js');

beforeEach(() => {
  providerRuns.length = 0;
  tasks.clear();
  exclusions.length = 0;
  withdrawDuringRun = false;
});

/** Runs the child the dispatcher added through the actual issue worker, as BullMQ would hand it over. */
async function runChild(child: { jobId: string; data: IssueJobData }): Promise<JobResult> {
  let data = { ...child.data };
  return processGitHubIssueJob({
    id: child.jobId, name: 'processGitHubIssue', get data() { return data; },
    updateData: async (next: IssueJobData) => { data = next; },
    updateProgress: async () => undefined,
  } as unknown as Job<IssueJobData>);
}

/** The provider ran once more, for `requester`'s request with its instructions and none of `foreign`. */
async function assertProviderRan(run: IssueJobData | undefined, { requester, commentId, instructions, foreign }: {
  requester: string; commentId: number; instructions: RegExp; foreign: RegExp;
}) {
  assert.ok(run, 'the provider ran');
  assert.deepEqual([run.userId, run.retryRequesterId, run.retryCommentId], [requester, requester, commentId]);
  const prompt = await promptFor(run);
  assert.match(prompt, instructions);
  assert.doesNotMatch(prompt, foreign);
}

const withdrawals = [
  ['its trigger label is removed', () => { state.issueLabels = state.issueLabels.filter(label => label !== 'AI'); },
    () => { state.issueLabels = ['AI', ...state.issueLabels]; }, 'cancelled_label_removed'],
  ['the issue is closed', () => { state.issueState = 'closed'; }, () => { state.issueState = 'open'; }, 'cancelled_issue_closed'],
] as const;

for (const [routing, backed] of [['submission-backed', true], ['issue-only', false]] as const) {
  for (const [withdrawal, withdraw, restore, reason] of withdrawals) {
    test(`a ${routing} retry whose ${withdrawal.replace(/^its |^the /, '')} after it was published is cancelled by the issue worker before the provider runs, and a later follow-up runs its own once`, async () => {
      await onIssue(backed, `withdrawn-${backed}-${reason}`, async () => {
        const first = await postFollowup({ body: 'First instructions' }, 'failed-issue-task');
        assert.equal(first.json.state, 'queued', String(first.json.message ?? first.json.error));
        const { dispatched, children } = await dispatchQueued(0);
        assert.equal(dispatched.status, 'dispatched');
        assert.equal(children.length, 1);
        assert.equal(children[0].jobId, await requestChildId());
        assert.deepEqual(await openRequests(), [], 'the published request was carried into its child');

        // Withdrawn after publication, before the child runs: the worker reads the issue and ends the run.
        withdraw();
        assert.deepEqual(await runChild(children[0]), { status: 'cancelled', reason });
        assert.equal(providerRuns.length, 0, 'the provider never ran the withdrawn request');
        assert.deepEqual(tasks.get(`task-${children[0].jobId}`), { state: 'cancelled', terminalReason: reason });
        assert.deepEqual(exclusions, [{ number: 14, reason }], 'the withdrawal is recorded for the issue');

        // The issue is triggered again by a later follow-up of another user, once the claim expires.
        restore();
        state.now += 60_000;
        claims.delete(dedupKey);
        const next = await postFollowup({ body: 'Second instructions' }, 'failed-issue-task', 'user-2');
        assert.equal(next.json.state, 'queued', String(next.json.message ?? next.json.error));
        assert.equal(next.json.restartedRequest, undefined, 'the withdrawn request is not restarted');
        const later = await dispatchQueued(1);
        assert.equal(later.dispatched.status, 'dispatched');
        assert.deepEqual(later.children.map(child => child.jobId), [await requestChildId(FIRST_COMMENT_ID + 1)], 'only the later request is dispatched');
        assert.notEqual(later.children[0].jobId, children[0].jobId);
        assert.deepEqual(await runChild(later.children[0]), { status: 'processed' });
        assert.equal(providerRuns.length, 1, 'the provider ran once, for the later request only');
        await assertProviderRan(providerRuns[0], { requester: 'user-2', commentId: FIRST_COMMENT_ID + 1, instructions: /Second instructions/, foreign: /First instructions/ });
        assert.deepEqual(await openRequests(), []);
      });
    });
  }

  test(`a ${routing} retry withdrawn while the provider runs it ends cancelled rather than failed, so the queue does not run it again`, async () => {
    await onIssue(backed, `withdrawn-running-${backed}`, async () => {
      assert.equal((await postFollowup({ body: 'First instructions' }, 'failed-issue-task')).json.state, 'queued');
      const { children } = await dispatchQueued(0);
      withdrawDuringRun = true;
      assert.deepEqual(await runChild(children[0]), { status: 'cancelled', reason: 'cancelled_label_removed' });
      assert.equal(providerRuns.length, 1);
      await assertProviderRan(providerRuns[0], { requester: 'user-1', commentId: FIRST_COMMENT_ID, instructions: /First instructions/, foreign: /Second instructions/ });
      // Redelivered, as after a worker restart, the withdrawn run is not executed again.
      withdrawDuringRun = false;
      assert.deepEqual(await runChild(children[0]), { status: 'cancelled', reason: 'cancelled_label_removed' });
      assert.equal(providerRuns.length, 1, 'the provider did not run it again');
      assert.deepEqual(await openRequests(), []);
    });
  });
}

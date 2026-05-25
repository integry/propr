import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GH_APP_ID ??= '1';
process.env.GH_PRIVATE_KEY_PATH ??= '.propr/test-private-key.pem';
process.env.GH_INSTALLATION_ID ??= '1';
process.env.NODE_ENV ??= 'test';

const { getActiveTasksForPR } = await import('../packages/core/src/webhook/checkRunHelpers.ts');
const { stopTaskExecution } = await import('../packages/api/routes/stopTaskExecution.ts');
const { ensureTaskStateForCancellation, loadStopTaskContext } = await import('../packages/api/routes/stopTaskExecutionContext.ts');

type QueueState = 'waiting' | 'active' | 'delayed' | 'paused' | 'prioritized' | 'waiting-children';

interface MockJob {
  id: string;
  data: Record<string, unknown>;
  getState: () => Promise<QueueState>;
}

function createQueueMock(jobs: MockJob[]) {
  return {
    async getJob(jobId: string) {
      return jobs.find((job) => job.id === jobId) ?? null;
    },
    async getJobs(states: string[]) {
      const matchingJobs: MockJob[] = [];
      for (const job of jobs) {
        if (states.includes(await job.getState())) {
          matchingJobs.push(job);
        }
      }
      return matchingJobs;
    },
  };
}

function createMockJob(id: string, state: QueueState, data: Record<string, unknown>): MockJob {
  return {
    id,
    data,
    async getState() {
      return state;
    },
  };
}

function createTaskQueryDbMock(rows: Array<{ task_id: string; job_id: string | null; state: string }>) {
  const chain = {
    select: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    whereNotNull: () => chain,
    whereIn: async () => rows,
    whereNotIn: async (_column: string, states: readonly string[]) => rows.filter((row) => !states.includes(row.state)),
  };

  return Object.assign(() => chain, {
    raw: () => 'raw',
  }) as unknown as typeof import('@propr/core').db;
}

const silentLog = {
  info(): void {},
  warn(): void {},
};

test('getActiveTasksForPR finds PR jobs by scanning the live queue', async () => {
  const queue = createQueueMock([
    createMockJob('comment-job', 'waiting', { repository: 'integry/propr', prNumber: 1464 }),
    createMockJob('other-job', 'active', { repository: 'integry/propr', prNumber: 999 }),
  ]);

  const tasks = await getActiveTasksForPR('integry/propr', 1464, {
    getIssueQueue: async () => queue as never,
    db: createTaskQueryDbMock([{ task_id: 'persisted-task', job_id: null, state: 'processing' }]),
    log: silentLog,
  });

  assert.deepEqual(
    tasks.map((task) => `${task.taskId}:${task.state}`).sort(),
    ['comment-job:waiting', 'persisted-task:processing'],
  );
});

test('getActiveTasksForPR includes active BullMQ jobs when stoppableOnly is true', async () => {
  const queue = createQueueMock([
    createMockJob('active-pr-job', 'active', { repository: 'integry/propr', prNumber: 1464 }),
  ]);

  const tasks = await getActiveTasksForPR('integry/propr', 1464, {
    getIssueQueue: async () => queue as never,
    db: createTaskQueryDbMock([]),
    stoppableOnly: true,
    log: silentLog,
  });

  assert.deepEqual(tasks, [{ taskId: 'active-pr-job', state: 'active' }]);
});

test('stopTaskExecution records a pending merged-PR cancellation for abort-only active jobs', async () => {
  const setCalls: Array<{ key: string; value: Record<string, unknown> }> = [];
  const delCalls: string[] = [];
  const conversationMessages: Array<{ key: string; message: Record<string, unknown> }> = [];
  const markTaskCancelledCalls: Array<{
    taskId: string;
    requestedBy: string;
    metadata: Record<string, unknown>;
  }> = [];
  const updateHistoryMetadataCalls: Array<{
    taskId: string;
    currentState: string;
    metadata: Record<string, unknown>;
  }> = [];

  const redisClient = {
    async get(): Promise<null> {
      return null;
    },
    async set(key: string, value: string): Promise<string> {
      setCalls.push({ key, value: JSON.parse(value) as Record<string, unknown> });
      return 'OK';
    },
    async del(key: string): Promise<number> {
      delCalls.push(key);
      return 1;
    },
    async rPush(key: string, value: string): Promise<number> {
      conversationMessages.push({ key, message: JSON.parse(value) as Record<string, unknown> });
      return conversationMessages.length;
    },
  };

  const result = await stopTaskExecution('task-1464', {
    redisClient,
    requestedBy: 'system',
    cancellation: {
      code: 'pull_request_merged',
      message: 'Task cancelled because pull request #1464 was merged.',
    },
  }, {
    async loadStopTaskContext() {
      return {
        normalizedTaskId: 'task-1464',
        state: {
          history: [{ state: 'processing' }],
        },
        currentState: 'processing',
        queueJob: { id: 'job-1464' } as never,
        queueState: 'active',
        taskId: 'task-1464',
        abortTaskIds: ['task-1464', 'job-1464'],
      };
    },
    async ensureTaskStateForCancellation() {},
    getStateManager: () => ({
      async markTaskCancelled(taskId: string, requestedBy: string, metadata: Record<string, unknown>) {
        markTaskCancelledCalls.push({ taskId, requestedBy, metadata });
        return {} as never;
      },
      async updateHistoryMetadata(taskId: string, currentState: string, metadata: Record<string, unknown>) {
        updateHistoryMetadataCalls.push({ taskId, currentState, metadata });
        return {} as never;
      },
    }) as never,
  });

  assert.equal(result.success, true);
  assert.equal(result.containerStopped, false);
  assert.equal(result.jobRemoved, false);
  assert.equal(result.message, 'Stop request sent to worker. The execution will be terminated shortly.');
  assert.deepEqual(delCalls, []);
  assert.deepEqual(
    setCalls.map((call) => call.key).sort(),
    ['worker:abort:job-1464', 'worker:abort:task-1464', 'worker:stop-requested:task-1464'],
  );
  assert.equal(markTaskCancelledCalls.length, 0);
  assert.deepEqual(updateHistoryMetadataCalls, [{
    taskId: 'task-1464',
    currentState: 'processing',
    metadata: {
      cancellationRequested: {
        code: 'pull_request_merged',
        message: 'Task cancelled because pull request #1464 was merged.',
        requestedBy: 'system',
        source: 'pull_request_merged',
        abortSignalArmed: true,
        queueState: 'active',
      },
    },
  }]);
  assert.deepEqual(
    conversationMessages.map((entry) => entry.message.content),
    ['Cancellation requested. Worker shutdown is still in progress.'],
  );
});

test('ensureTaskStateForCancellation fails loudly when a queued job cannot be reconstructed into a task', async () => {
  let createTaskStateCalled = false;
  let dbUpdated = false;

  await assert.rejects(
    ensureTaskStateForCancellation('queued-job', null, {
      id: 'queued-job',
      data: {},
    } as never, {
      getStateManager: () => ({
        async createTaskState() {
          createTaskStateCalled = true;
        },
      }) as never,
      db: (() => {
        dbUpdated = true;
        throw new Error('db should not be called');
      }) as never,
    }),
    /Cannot reconstruct IssueRef for queued task cancellation: queued-job/,
  );

  assert.equal(createTaskStateCalled, false);
  assert.equal(dbUpdated, false);
});

test('ensureTaskStateForCancellation reconstructs queue-only PR jobs from repository and prNumber', async () => {
  const insertedRows: Record<string, unknown>[] = [];
  const updatedRows: Record<string, unknown>[] = [];
  const createdStates: Array<{ taskId: string; issueRef: Record<string, unknown>; correlationId: string | null }> = [];
  const insertChain = {
    onConflict(column: string) {
      assert.equal(column, 'task_id');
      return {
        async ignore() {},
      };
    },
  };
  const taskQuery = {
    insert(row: Record<string, unknown>) {
      insertedRows.push(row);
      return insertChain;
    },
    where(criteria: Record<string, unknown>) {
      assert.deepEqual(criteria, { task_id: 'queue-only-task' });
      return {
        async update(row: Record<string, unknown>) {
          updatedRows.push(row);
          return 1;
        },
      };
    },
  };

  await ensureTaskStateForCancellation('queue-only-task', null, {
    id: 'pr-comments-batch-owner-repo-42-123',
    name: 'processPullRequestComment',
    data: {
      repository: 'owner/repo',
      prNumber: 42,
      commandMode: 'fix',
      correlationId: 'corr-queue-only',
    },
  } as never, {
    getStateManager: () => ({
      async createTaskState(taskId: string, issueRef: Record<string, unknown>, correlationId: string | null) {
        createdStates.push({ taskId, issueRef, correlationId });
      },
    }) as never,
    db: (() => taskQuery) as never,
  });

  assert.deepEqual(insertedRows, [{
    task_id: 'queue-only-task',
    job_id: null,
    correlation_id: 'corr-queue-only',
    repository: 'owner/repo',
    issue_number: 42,
    task_type: 'pr-fix',
    model_name: null,
    initial_job_data: JSON.stringify({
      repository: 'owner/repo',
      prNumber: 42,
      commandMode: 'fix',
      correlationId: 'corr-queue-only',
    }),
    pr_number: 42,
  }]);
  assert.deepEqual(createdStates, [{
    taskId: 'queue-only-task',
    issueRef: {
      number: 42,
      repoOwner: 'owner',
      repoName: 'repo',
      pullRequestNumber: 42,
      type: 'pr-fix',
    },
    correlationId: 'corr-queue-only',
  }]);
  assert.deepEqual(updatedRows, [{
    job_id: 'pr-comments-batch-owner-repo-42-123',
    pr_number: 42,
    initial_job_data: JSON.stringify({
      repository: 'owner/repo',
      prNumber: 42,
      commandMode: 'fix',
      correlationId: 'corr-queue-only',
    }),
  }]);
});

test('loadStopTaskContext fallback scan matches raw queue job ids before normalization', async () => {
  const rawJobId = 'issue-owner-repo-42-123';
  const queueJob = {
    id: rawJobId,
    data: { repository: 'owner/repo', prNumber: 42 },
    async getState() {
      return 'waiting';
    },
  };
  const dbQueryBuilder = {
    whereIn() {
      return dbQueryBuilder;
    },
    orWhereIn() {
      return dbQueryBuilder;
    },
  };
  const dbTasksQuery = {
    select() {
      return dbTasksQuery;
    },
    async where(callback: (queryBuilder: typeof dbQueryBuilder) => void) {
      callback(dbQueryBuilder);
      return [];
    },
  };

  const context = await loadStopTaskContext(rawJobId, {
    async get() {
      return null;
    },
  }, {
    getIssueQueue: async () => ({
      async getJob() {
        return null;
      },
      async getJobs() {
        return [queueJob];
      },
    }) as never,
    db: (() => dbTasksQuery) as never,
  });

  assert.equal(context.queueJob, queueJob);
  assert.equal(context.taskId, 'owner-repo-42');
  assert.deepEqual(context.abortTaskIds, ['owner-repo-42', rawJobId]);
});

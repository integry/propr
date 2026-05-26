import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.GH_APP_ID ??= '1';
process.env.GH_PRIVATE_KEY_PATH ??= '.propr/test-private-key.pem';
process.env.GH_INSTALLATION_ID ??= '1';
process.env.NODE_ENV ??= 'test';

const { getActiveTasksForPR } = await import('../packages/core/src/webhook/checkRunHelpers.ts');
const { createDockerRoutes } = await import('../packages/api/routes/dockerRoutes.ts');
const { stopTaskExecution } = await import('../packages/api/routes/stopTaskExecution.ts');
const { ensureTaskStateForCancellation, loadStopTaskContext } = await import('../packages/api/routes/stopTaskExecutionContext.ts');

after(async () => {
  const { closeConnection: closePackageConnection } = await import('@propr/core');
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closePackageConnection();
  await closeConnection();
});

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

test('getActiveTasksForPR paginates queue scans beyond the first page', async () => {
  const waitingJobs = Array.from({ length: 1001 }, (_, index) => createMockJob(
    `waiting-job-${index}`,
    'waiting',
    { repository: 'integry/propr', prNumber: index === 1000 ? 1464 : 999 },
  ));
  const queue = {
    async getJob() {
      return null;
    },
    async getJobs(states: string[], start = 0, end = 999) {
      return states.includes('waiting') ? waitingJobs.slice(start, end + 1) : [];
    },
  };

  const tasks = await getActiveTasksForPR('integry/propr', 1464, {
    getIssueQueue: async () => queue as never,
    db: createTaskQueryDbMock([]),
    stoppableOnly: true,
    log: silentLog,
  });

  assert.deepEqual(tasks, [{ taskId: 'waiting-job-1000', state: 'waiting' }]);
});

test('Docker info falls back to extended stop context when direct state has no container', async () => {
  const loadStopTaskContext = mock.fn(async () => {
    throw new Error('DB unavailable');
  });
  const redisClient = {
    async get(key: string): Promise<string | null> {
      if (key !== 'worker:state:task-1464') {
        return null;
      }
      return JSON.stringify({
        history: [{ state: 'processing' }],
      });
    },
  };
  const routes = createDockerRoutes({
    redisClient: redisClient as never,
    loadStopTaskContext: loadStopTaskContext as never,
  });
  const response = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };

  await routes.getDockerInfo({ params: { taskId: 'task-1464' } } as never, response as never);

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { error: 'No Docker container info available for this task' });
  assert.equal(loadStopTaskContext.mock.calls.length, 1);
});

test('Docker info resolves container metadata through persisted task aliases', async () => {
  const loadStopTaskContextMock = mock.fn(async () => ({
    normalizedTaskId: 'job-alias',
    state: {
      history: [
        { state: 'claude_execution', metadata: { containerId: 'container-alias-1', containerName: 'task-alias' } },
      ],
    },
    currentState: 'claude_execution',
    queueJob: null,
    queueState: null,
    taskId: 'persisted-task-alias',
    abortTaskIds: ['persisted-task-alias', 'job-alias'],
  }));
  const redisClient = {
    async get(): Promise<null> {
      return null;
    },
  };
  const routes = createDockerRoutes({
    redisClient: redisClient as never,
    loadStopTaskContext: loadStopTaskContextMock as never,
  });
  const response = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };

  await routes.getDockerInfo({ params: { taskId: 'job-alias' } } as never, response as never);

  assert.equal(response.statusCode, 200);
  assert.equal(loadStopTaskContextMock.mock.calls.length, 1);
  assert.deepEqual(loadStopTaskContextMock.mock.calls[0]?.arguments.slice(0, 3), [
    'job-alias',
    redisClient,
    { forceQueueScan: false },
  ]);
  const body = response.body as Record<string, unknown>;
  assert.equal(body.id, 'container-alias-1');
  assert.equal(body.name, 'task-alias');
  assert.ok(body.status === 'removed' || body.status === 'error');
});

test('Docker info can inspect container metadata from terminal task history', async () => {
  const redisClient = {
    async get(key: string): Promise<string | null> {
      if (key !== 'worker:state:task-terminal') {
        return null;
      }
      return JSON.stringify({
        history: [
          { state: 'claude_execution', metadata: { containerId: 'container-stale-1' } },
          { state: 'cancelled' },
        ],
      });
    },
  };
  const routes = createDockerRoutes({ redisClient: redisClient as never });
  const response = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };

  await routes.getDockerInfo({ params: { taskId: 'task-terminal' } } as never, response as never);

  assert.equal(response.statusCode, 200);
  const body = response.body as Record<string, unknown>;
  assert.equal(body.id, 'container-stale-1');
  assert.equal(body.name, null);
  assert.equal(body.logsAvailable, false);
  assert.ok(body.status === 'removed' || body.status === 'error');
  if (body.status === 'error') {
    assert.match(String(body.error), /Failed to get container info/);
  }
});

test('manual Docker stop route accepts abort-only running task stops without verified container stop', async () => {
  const stopTaskExecutionMock = mock.fn(async () => ({
    success: true,
    message: 'Stop request sent to worker. The execution will be terminated shortly.',
    taskId: 'task-manual-stop',
    containerStopped: false,
    jobRemoved: false,
    stopVerified: false,
    cancellationRequested: true,
    abortSignalArmed: true,
    currentState: 'processing',
    queueState: null,
    cancellation: {
      code: 'user_requested_stop',
      message: 'Task cancelled by user request.',
    },
  }));
  const redisClient = {
    async get(): Promise<null> {
      return null;
    },
    async set(): Promise<string> {
      return 'OK';
    },
    async del(): Promise<number> {
      return 1;
    },
    async rPush(): Promise<number> {
      return 1;
    },
  };
  const routes = createDockerRoutes({
    redisClient: redisClient as never,
    stopTaskExecution: stopTaskExecutionMock as never,
  });
  const response = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };

  await routes.stopTask({
    params: { taskId: 'task-manual-stop' },
    user: { username: 'octocat' },
  } as never, response as never);

  assert.equal(response.statusCode, 202);
  assert.deepEqual(stopTaskExecutionMock.mock.calls[0]?.arguments[1], {
    redisClient,
    requestedBy: 'octocat',
    forceQueueScan: false,
  });
  assert.deepEqual(response.body, {
    success: true,
    message: 'Stop request sent to worker. The execution will be terminated shortly.',
    taskId: 'task-manual-stop',
    containerStopped: false,
    jobRemoved: false,
    stopVerified: false,
    cancellationRequested: true,
    abortSignalArmed: true,
    currentState: 'processing',
    queueState: null,
    cancellation: {
      code: 'user_requested_stop',
      message: 'Task cancelled by user request.',
    },
  });
});

test('manual Docker stop route serializes structural stop errors without instanceof', async () => {
  const stopTaskExecutionMock = mock.fn(async () => {
    throw {
      name: 'StopTaskExecutionError',
      status: 409,
      body: {
        error: 'Task is not stoppable',
        message: 'The task is not in a stoppable worker or queue state.',
      },
      message: 'The task is not in a stoppable worker or queue state.',
    };
  });
  const redisClient = {
    async get(): Promise<null> {
      return null;
    },
    async set(): Promise<string> {
      return 'OK';
    },
    async del(): Promise<number> {
      return 1;
    },
    async rPush(): Promise<number> {
      return 1;
    },
  };
  const routes = createDockerRoutes({
    redisClient: redisClient as never,
    stopTaskExecution: stopTaskExecutionMock as never,
  });
  const response = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };

  await routes.stopTask({
    params: { taskId: 'task-manual-stop' },
    user: { username: 'octocat' },
  } as never, response as never);

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, {
    error: 'Task is not stoppable',
    message: 'The task is not in a stoppable worker or queue state.',
  });
});

test('stopTaskExecution records a durable pending merged-PR cancellation for abort-only active jobs', async () => {
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
  assert.deepEqual(delCalls.sort(), []);
  assert.deepEqual(
    setCalls.map((call) => call.key)
      .filter((key) => !key.startsWith('conversation:stop-message-dedupe:'))
      .sort(),
    [
      'worker:abort:job-1464',
      'worker:abort:task-1464',
      'worker:stop-requested:job-1464',
      'worker:stop-requested:task-1464',
    ],
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
        andWhere(callback: (queryBuilder: {
          whereNull: (column: string) => { orWhere: (column: string, value: string) => unknown };
        }) => void) {
          callback({
            whereNull(column: string) {
              assert.equal(column, 'job_id');
              return {
                orWhere(jobIdColumn: string, value: string) {
                  assert.equal(jobIdColumn, 'job_id');
                  assert.equal(value, 'pr-comments-batch-owner-repo-42-123');
                },
              };
            },
          });
          return this;
        },
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
      async getTaskState() {
        return null;
      },
      async createTaskState(taskId: string, issueRef: Record<string, unknown>, correlationId: string | null) {
        createdStates.push({ taskId, issueRef, correlationId });
      },
    }) as never,
    db: (() => taskQuery) as never,
  });

  assert.deepEqual(insertedRows, [{
    task_id: 'queue-only-task',
    job_id: 'pr-comments-batch-owner-repo-42-123',
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

test('ensureTaskStateForCancellation continues when an existing task has a different job id', async () => {
  const createdStates: string[] = [];
  const insertChain = {
    onConflict() {
      return {
        async ignore() {},
      };
    },
  };
  const taskQuery = {
    insert() {
      return insertChain;
    },
    where() {
      return {
        andWhere() {
          return this;
        },
        async update() {
          return 0;
        },
      };
    },
    select() {
      return {
        where() {
          return {
            async first() {
              return { task_id: 'queue-existing-task', job_id: 'legacy-job-id' };
            },
          };
        },
      };
    },
  };

  const state = await ensureTaskStateForCancellation('queue-existing-task', null, {
    id: 'pr-comments-batch-owner-repo-42-456',
    name: 'processPullRequestComment',
    data: {
      repository: 'owner/repo',
      prNumber: 42,
    },
  } as never, {
    getStateManager: () => ({
      async getTaskState() {
        return null;
      },
      async createTaskState(taskId: string) {
        createdStates.push(taskId);
        return { history: [{ state: 'pending' }] };
      },
    }) as never,
    db: (() => taskQuery) as never,
  });

  assert.deepEqual(state, { history: [{ state: 'pending' }] });
  assert.deepEqual(createdStates, ['queue-existing-task']);
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
    forceQueueScan: true,
  });

  assert.equal(context.queueJob, queueJob);
  assert.equal(context.taskId, 'owner-repo-42');
  assert.deepEqual(context.abortTaskIds, ['owner-repo-42', rawJobId]);
});

test('loadStopTaskContext forced fallback scan checks beyond 10000 queued jobs', async () => {
  const targetJobId = 'issue-owner-repo-42-999';
  const waitingJobs = Array.from({ length: 10550 }, (_, index) => ({
    id: index === 10200 ? targetJobId : `issue-other-repo-${index}-1`,
    data: index === 10200
      ? { repository: 'owner/repo', prNumber: 42 }
      : { repository: 'other/repo', prNumber: index },
    async getState() {
      return 'waiting';
    },
  }));
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

  const context = await loadStopTaskContext(targetJobId, {
    async get() {
      return null;
    },
  }, {
    getIssueQueue: async () => ({
      async getJob() {
        return null;
      },
      async getJobs(states: string[], start = 0, end = 99) {
        if (!states.includes('waiting')) {
          return [];
        }
        return end === -1 ? waitingJobs : waitingJobs.slice(start, end + 1);
      },
    }) as never,
    db: (() => dbTasksQuery) as never,
    forceQueueScan: true,
  });

  assert.equal(context.queueJob?.id, targetJobId);
  assert.equal(context.taskId, 'owner-repo-42');
});

test('loadStopTaskContext does not scan queue job data unless forced', async () => {
  let scannedQueue = false;
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

  const context = await loadStopTaskContext('owner-repo-42', {
    async get() {
      return null;
    },
  }, {
    getIssueQueue: async () => ({
      async getJob() {
        return null;
      },
      async getJobs() {
        scannedQueue = true;
        return [];
      },
    }) as never,
    db: (() => dbTasksQuery) as never,
  });

  assert.equal(context.queueJob, null);
  assert.equal(scannedQueue, false);
});

test('loadStopTaskContext avoids DB and queue lookups when Redis worker state exists', async () => {
  let dbLoaded = false;
  let queueLoaded = false;
  const queueJob = {
    id: 'task-redis-first',
    data: { repository: 'owner/repo', prNumber: 42 },
    async getState() {
      return 'delayed';
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
      dbLoaded = true;
      callback(dbQueryBuilder);
      return [];
    },
  };

  const context = await loadStopTaskContext('task-redis-first', {
    async get(key: string) {
      if (key !== 'worker:state:task-redis-first') {
        return null;
      }

      return JSON.stringify({
        history: [{ state: 'processing' }],
      });
    },
  }, {
    getIssueQueue: async () => {
      queueLoaded = true;
      return {
        async getJob(jobId: string) {
          return jobId === 'task-redis-first' ? queueJob : null;
        },
        async getJobs() {
          return [];
        },
      } as never;
    },
    db: (() => dbTasksQuery) as never,
  });

  assert.equal(context.taskId, 'task-redis-first');
  assert.equal(context.currentState, 'processing');
  assert.equal(context.queueJob, null);
  assert.equal(context.queueState, null);
  assert.equal(dbLoaded, false);
  assert.equal(queueLoaded, false);
  assert.equal(queueJob.id, 'task-redis-first');
});

import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

after(async () => {
  const { closeConnection: closePackageConnection } = await import('@propr/core');
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closePackageConnection();
  await closeConnection();
});

function createStopResult(overrides: Partial<{
  message: string;
  containerStopped: boolean;
  jobRemoved: boolean;
  stopVerified: boolean;
  cancellationRequested: boolean;
  abortSignalArmed: boolean;
  currentState: string | null;
  queueState: string | null;
}> = {}) {
  return {
    success: true as const,
    message: 'Stop request sent to worker. The execution will be terminated shortly.',
    taskId: 'task-1',
    containerStopped: false,
    jobRemoved: false,
    stopVerified: false,
    cancellationRequested: true,
    abortSignalArmed: true,
    currentState: 'claude_execution',
    queueState: 'active',
    cancellation: {
      code: 'pull_request_merged',
      message: 'Task cancelled because pull request #42 was merged.',
      source: 'pull_request_merged',
    },
    ...overrides,
  };
}

function createEmptyDb() {
  const joinBuilder = {
    on() {
      return joinBuilder;
    },
    andOn() {
      return joinBuilder;
    },
  };

  const queryBuilder = {
    select() {
      return queryBuilder;
    },
    leftJoin(_table: unknown, callback: (this: typeof joinBuilder) => void) {
      callback.call(joinBuilder);
      return queryBuilder;
    },
    where() {
      return queryBuilder;
    },
    whereNotNull() {
      return queryBuilder;
    },
    whereIn() {
      return Promise.resolve([]);
    },
    whereNotIn() {
      return Promise.resolve([]);
    },
  };

  return Object.assign(() => queryBuilder, {
    raw() {
      return 'raw';
    },
  });
}

test('cancelMergedPullRequestTasks waits until abort-only worker stops disappear on recheck', async () => {
  process.env.NODE_ENV = 'test';
  const { cancelMergedPullRequestTasks } = await import('../packages/api/mergedPullRequestCancellation.ts');
  const loadActiveTasksCalls: Array<{ forceQueueScan?: boolean }> = [];
  const stopCalls: string[] = [];

  await assert.doesNotReject(
    cancelMergedPullRequestTasks(
      {
        action: 'closed',
        repository: { full_name: 'acme/widgets' },
        pull_request: { number: 42, merged: true },
      },
      'corr-1',
      {
        redisClient: {} as never,
        markPullRequestMerged: async () => {},
        getActiveTasksForPR: async (_repository, _prNumber, options) => {
          loadActiveTasksCalls.push({ forceQueueScan: options?.forceQueueScan });
          return loadActiveTasksCalls.length === 1
            ? [{ taskId: 'task-1', state: 'claude_execution' }]
            : [];
        },
        stopTaskExecution: async (taskId) => {
          stopCalls.push(taskId);
          return createStopResult();
        },
        recheckDelayMs: 0,
        log: {
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      },
    ),
  );

  assert.deepEqual(loadActiveTasksCalls, [{ forceQueueScan: true }, { forceQueueScan: true }]);
  assert.deepEqual(stopCalls, ['task-1']);
});

test('cancelMergedPullRequestTasks accepts abort-only stops while worker shutdown is pending', async () => {
  process.env.NODE_ENV = 'test';
  const { cancelMergedPullRequestTasks } = await import('../packages/api/mergedPullRequestCancellation.ts');
  const markMergedCalls: Array<{ repository: string; prNumber: number }> = [];
  const loadActiveTasksCalls: string[][] = [];
  const stopCalls: string[] = [];

  await cancelMergedPullRequestTasks(
    {
      action: 'closed',
      repository: { full_name: 'acme/widgets' },
      pull_request: { number: 42, merged: true },
    },
    'corr-1',
    {
      redisClient: {} as never,
      markPullRequestMerged: async (_redisClient, repository, prNumber) => {
        markMergedCalls.push({ repository, prNumber });
      },
      getActiveTasksForPR: async () => {
        loadActiveTasksCalls.push(['task-1']);
        return [{ taskId: 'task-1', state: 'claude_execution' }];
      },
      stopTaskExecution: async (taskId) => {
        stopCalls.push(taskId);
        return createStopResult();
      },
      recheckDelayMs: 0,
      log: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    },
  );

  assert.deepEqual(stopCalls, ['task-1']);
  assert.equal(loadActiveTasksCalls.length, 2);
  assert.deepEqual(markMergedCalls, [{ repository: 'acme/widgets', prNumber: 42 }]);
});

test('getActiveTasksForPR includes matching jobs from the live queue', async () => {
  process.env.NODE_ENV = 'test';
  const { getActiveTasksForPR } = await import('../packages/core/src/webhook/checkRunHelpers.ts');
  const job1 = {
    id: 'job-1',
    data: { repository: 'acme/widgets', prNumber: 42 },
    async getState() {
      return 'waiting';
    },
  };
  const job2 = {
    id: 'job-2',
    data: { repository: 'acme/widgets', prNumber: 42 },
    async getState() {
      return 'delayed';
    },
  };
  const queue = {
    async getJob(jobId: string) {
      return jobId === 'job-1' ? job1 : null;
    },
    async getJobs(states: string[]) {
      const matchingJobs = [];
      for (const job of [job1, job2]) {
        if (states.includes(await job.getState())) {
          matchingJobs.push(job);
        }
      }
      return matchingJobs;
    },
  };

  const activeTasks = await getActiveTasksForPR('acme/widgets', 42, {
    getIssueQueue: async () => queue as never,
    db: createEmptyDb() as never,
    forceQueueScan: true,
    stoppableOnly: true,
    log: {
      info: () => {},
      warn: () => {},
    },
  });

  assert.deepEqual(activeTasks, [
    { taskId: 'job-1', state: 'waiting' },
    { taskId: 'job-2', state: 'delayed' },
  ]);
});

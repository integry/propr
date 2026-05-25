import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

function createStopResult(overrides: Partial<{
  message: string;
  containerStopped: boolean;
  jobRemoved: boolean;
  stopVerified: boolean;
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

test('cancelMergedPullRequestTasks treats abort-only active worker stops as requested cancellation', async () => {
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
          return [{ taskId: 'task-1', state: 'claude_execution' }];
        },
        stopTaskExecution: async (taskId) => {
          stopCalls.push(taskId);
          return createStopResult();
        },
        log: {
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      },
    ),
  );

  assert.deepEqual(loadActiveTasksCalls, [{ forceQueueScan: undefined }]);
  assert.deepEqual(stopCalls, ['task-1']);
});

test('getActiveTasksForPR includes live queue jobs that are missing from the PR queue index when forced', async () => {
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
    client: Promise.resolve({
      expire: async () => 1,
      sMembers: async (key: string) => (key.includes('pr-pending-queue-jobs') ? [] : ['job-1']),
    }),
    async getJob(jobId: string) {
      return jobId === 'job-1' ? job1 : null;
    },
    async getJobs() {
      return [job1, job2];
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

import { after, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert';

process.env.GH_APP_ID ??= '1';
process.env.GH_PRIVATE_KEY_PATH ??= '.propr/test-private-key.pem';
process.env.GH_INSTALLATION_ID ??= '1';
process.env.NODE_ENV ??= 'test';

const { stopTaskExecution } = await import('../packages/api/routes/dockerRoutes.ts');
const { getActiveTasksForPR } = await import('../packages/core/src/webhook/checkRunHelpers.ts');
const { closeConnection } = await import('../packages/core/src/db/connection.ts');
const { closeStateManager } = await import('../packages/core/src/utils/workerStateManager.ts');
const { closeUltrafixStateRedis } = await import('../packages/core/src/webhook/checkRunHelpers.ts');

const mockCreateTaskState = mock.fn(async () => ({}));
const mockMarkTaskCancelled = mock.fn(async () => ({}));
const mockTasksUpdate = mock.fn(async () => 1);
const mockStopDockerContainer = mock.fn(async () => ({ success: true }));

function createRedisClient() {
  return {
    get: mock.fn(async () => null),
    set: mock.fn(async () => 'OK'),
    del: mock.fn(async () => 1),
    rPush: mock.fn(async () => 1),
  };
}

function createQueueJob(id: string, data: Record<string, unknown>, state: string) {
  return {
    id,
    data,
    remove: mock.fn(async () => undefined),
    getState: mock.fn(async () => state),
  };
}

function createTaskUpdateDb() {
  return Object.assign(
    () => ({
      where() {
        return {
          select() {
            return this;
          },
          first: async () => undefined,
          update: mockTasksUpdate,
        };
      },
    }),
    {
      raw: mock.fn(() => 'mock-raw'),
    },
  );
}

function createPersistedTaskLookupDb(record: { task_id: string; job_id: string | null } | undefined) {
  return Object.assign(
    () => ({
      where(filter: Record<string, unknown>) {
        const matches = record && Object.entries(filter).every(([key, value]) => record[key as keyof typeof record] === value);
        return {
          select() {
            return this;
          },
          first: async () => matches ? record : undefined,
          update: mockTasksUpdate,
        };
      },
    }),
    {
      raw: mock.fn(() => 'mock-raw'),
    },
  );
}

function createActiveTasksDb(result: Array<{ task_id: string; job_id: string | null; state: string }>) {
  return Object.assign(
    () => ({
      select() {
        return this;
      },
      leftJoin(_table: string, callback: (this: { on: () => { andOn: () => unknown } }) => void) {
        callback.call({
          on() {
            return {
              andOn() {
                return this;
              },
            };
          },
        });
        return this;
      },
      where() {
        return this;
      },
      whereNotIn: async () => result,
    }),
    {
      raw: mock.fn(() => 'mock-raw'),
    },
  );
}

beforeEach(() => {
  mockCreateTaskState.mock.resetCalls();
  mockMarkTaskCancelled.mock.resetCalls();
  mockTasksUpdate.mock.resetCalls();
  mockStopDockerContainer.mock.resetCalls();
});

after(async () => {
  await closeUltrafixStateRedis();
  await closeStateManager();
  await closeConnection();
});

describe('merged PR queue follow-up fixes', () => {
  test('stopTaskExecution reconstructs issueRef from repository-only queue payloads', async () => {
    const queueJobId = 'pr-comments-batch-integry-propr-1463-123';
    const redisClient = createRedisClient();

    const result = await stopTaskExecution(queueJobId, {
      redisClient,
      requestedBy: 'system',
      cancellation: {
        code: 'pull_request_merged',
        message: 'Task cancelled because pull request #1463 was merged.',
      },
    }, {
      getIssueQueue: async () => ({
        getJob: async (id: string) => id === queueJobId ? createQueueJob(queueJobId, {
          repository: 'integry/propr',
          pullRequestNumber: 1463,
          correlationId: 'corr-123',
        }, 'waiting') : null,
      }) as never,
      getStateManager: () => ({
        createTaskState: mockCreateTaskState,
        markTaskCancelled: mockMarkTaskCancelled,
      }) as never,
      db: createTaskUpdateDb() as never,
      stopDockerContainer: mockStopDockerContainer as never,
    });

    assert.strictEqual(result.taskId, queueJobId);
    assert.strictEqual(mockCreateTaskState.mock.calls.length, 1);
    assert.deepStrictEqual(mockCreateTaskState.mock.calls[0].arguments, [
      queueJobId,
      {
        number: 1463,
        repoOwner: 'integry',
        repoName: 'propr',
        pullRequestNumber: 1463,
        type: 'pr_followup',
      },
      'corr-123',
    ]);
    assert.strictEqual(mockMarkTaskCancelled.mock.calls.length, 1);
    assert.strictEqual(mockTasksUpdate.mock.calls.length, 1);
  });

  test('stopTaskExecution removes queued jobs by persisted job_id when task_id differs', async () => {
    const redisClient = createRedisClient();
    const queueJob = createQueueJob('pr-comments-batch-integry-propr-1463-123', {
      repository: 'integry/propr',
      pullRequestNumber: 1463,
      correlationId: 'corr-123',
    }, 'waiting');

    const result = await stopTaskExecution('task-running-1', {
      redisClient,
      requestedBy: 'system',
      cancellation: {
        code: 'pull_request_merged',
        message: 'Task cancelled because pull request #1463 was merged.',
      },
    }, {
      getIssueQueue: async () => ({
        getJob: async (id: string) => id === 'pr-comments-batch-integry-propr-1463-123' ? queueJob : null,
      }) as never,
      getStateManager: () => ({
        createTaskState: mockCreateTaskState,
        markTaskCancelled: mockMarkTaskCancelled,
      }) as never,
      db: createPersistedTaskLookupDb({
        task_id: 'task-running-1',
        job_id: 'pr-comments-batch-integry-propr-1463-123',
      }) as never,
      stopDockerContainer: mockStopDockerContainer as never,
    });

    assert.strictEqual(result.taskId, 'task-running-1');
    assert.strictEqual(result.jobRemoved, true);
    assert.strictEqual(queueJob.remove.mock.calls.length, 1);
    assert.deepStrictEqual(mockCreateTaskState.mock.calls[0].arguments, [
      'task-running-1',
      {
        number: 1463,
        repoOwner: 'integry',
        repoName: 'propr',
        pullRequestNumber: 1463,
        type: 'pr_followup',
      },
      'corr-123',
    ]);
    assert.strictEqual(mockMarkTaskCancelled.mock.calls[0].arguments[0], 'task-running-1');
  });

  test('stopTaskExecution sets abort markers for both queue and normalized task ids during active startup windows', async () => {
    const queueJobId = 'issue-owner-repo-99-12345';
    const redisClient = createRedisClient();

    await stopTaskExecution(queueJobId, {
      redisClient,
      requestedBy: 'system',
      cancellation: {
        code: 'pull_request_merged',
        message: 'Task cancelled because pull request #99 was merged.',
      },
    }, {
      getIssueQueue: async () => ({
        getJob: async (id: string) => id === queueJobId ? createQueueJob(queueJobId, {
          repository: 'owner/repo',
          prNumber: 99,
          correlationId: 'corr-99',
        }, 'active') : null,
      }) as never,
      getStateManager: () => ({
        createTaskState: mockCreateTaskState,
        markTaskCancelled: mockMarkTaskCancelled,
      }) as never,
      db: createTaskUpdateDb() as never,
      stopDockerContainer: mockStopDockerContainer as never,
    });

    const abortKeys = redisClient.set.mock.calls.map(call => call.arguments[0]).sort();
    assert.deepStrictEqual(abortKeys, [
      'worker:abort:issue-owner-repo-99-12345',
      'worker:abort:owner-repo-99',
    ]);
  });

  test('stopTaskExecution preserves pr_followup type for queue payloads that use prNumber', async () => {
    const queueJobId = 'pr-comments-batch-integry-propr-99-456';
    const redisClient = createRedisClient();

    await stopTaskExecution(queueJobId, {
      redisClient,
      requestedBy: 'system',
      cancellation: {
        code: 'pull_request_merged',
        message: 'Task cancelled because pull request #99 was merged.',
      },
    }, {
      getIssueQueue: async () => ({
        getJob: async (id: string) => id === queueJobId ? createQueueJob(queueJobId, {
          repository: 'integry/propr',
          prNumber: 99,
          correlationId: 'corr-99',
        }, 'waiting') : null,
      }) as never,
      getStateManager: () => ({
        createTaskState: mockCreateTaskState,
        markTaskCancelled: mockMarkTaskCancelled,
      }) as never,
      db: createTaskUpdateDb() as never,
      stopDockerContainer: mockStopDockerContainer as never,
    });

    assert.deepStrictEqual(mockCreateTaskState.mock.calls[0].arguments, [
      queueJobId,
      {
        number: 99,
        repoOwner: 'integry',
        repoName: 'propr',
        pullRequestNumber: 99,
        type: 'pr_followup',
      },
      'corr-99',
    ]);
  });

  test('stopTaskExecution rejects when cancellation state persistence fails', async () => {
    const queueJobId = 'pr-comments-batch-integry-propr-1463-123';
    const redisClient = createRedisClient();

    await assert.rejects(async () => {
      await stopTaskExecution(queueJobId, {
        redisClient,
        requestedBy: 'system',
        cancellation: {
          code: 'pull_request_merged',
          message: 'Task cancelled because pull request #1463 was merged.',
        },
      }, {
        getIssueQueue: async () => ({
          getJob: async (id: string) => id === queueJobId ? createQueueJob(queueJobId, {
            repository: 'integry/propr',
            pullRequestNumber: 1463,
            correlationId: 'corr-123',
          }, 'waiting') : null,
        }) as never,
        getStateManager: () => ({
          createTaskState: mockCreateTaskState,
          markTaskCancelled: mock.fn(async () => {
            throw new Error('persist failed');
          }),
        }) as never,
        db: createTaskUpdateDb() as never,
        stopDockerContainer: mockStopDockerContainer as never,
      });
    }, /persist failed/);
  });

  test('getActiveTasksForPR dedupes queue jobs against persisted tasks via job_id', async () => {
    const activeTasks = await getActiveTasksForPR('integry/propr', 1463, {
      getIssueQueue: async () => ({
        getJobs: async ([queueState]: string[]) => (
          queueState === 'active'
            ? [{ id: 'pr-comments-batch-integry-propr-1463-123', data: { repository: 'integry/propr', pullRequestNumber: 1463 } }]
            : []
        ),
      }) as never,
      db: createActiveTasksDb([
        {
          task_id: 'task-running-1',
          job_id: 'pr-comments-batch-integry-propr-1463-123',
          state: 'processing',
        },
        {
          task_id: 'task-running-2',
          job_id: null,
          state: 'processing',
        },
      ]) as never,
      log: {
        info: mock.fn(),
        warn: mock.fn(),
      },
    });

    assert.deepStrictEqual(activeTasks, [
      { taskId: 'task-running-1', state: 'processing' },
      { taskId: 'task-running-2', state: 'processing' },
    ]);
  });
});

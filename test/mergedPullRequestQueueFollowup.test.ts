import { after, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert';

process.env.GH_APP_ID ??= '1';
process.env.GH_PRIVATE_KEY_PATH ??= '.propr/test-private-key.pem';
process.env.GH_INSTALLATION_ID ??= '1';
process.env.NODE_ENV ??= 'test';

const { stopTaskExecution } = await import('../packages/api/routes/dockerRoutes.ts');
const { getActiveTasksForPR, hasActiveTasksForPR } = await import('../packages/core/src/webhook/checkRunHelpers.ts');
const { discardFreshQueueJobAfterMerge } = await import('../packages/core/src/webhook/mergedPrQueueHelpers.ts');
const { hasPullRequestMerged } = await import('../packages/core/src/webhook/prMergeState.ts');
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

function createQueueJob(
  id: string,
  data: Record<string, unknown>,
  state: string,
  name = id.startsWith('pr-comments-batch-')
    ? 'processPullRequestComment'
    : id.startsWith('merge-conflict-')
      ? 'processMergeConflict'
      : 'processGitHubIssue',
) {
  return {
    id,
    name,
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
        type: 'pr-comment',
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
        type: 'pr-comment',
      },
      'corr-123',
    ]);
    assert.strictEqual(mockMarkTaskCancelled.mock.calls[0].arguments[0], 'task-running-1');
  });

  test('stopTaskExecution sets abort markers for both queue and normalized task ids during active startup windows', async () => {
    const queueJobId = 'issue-owner-repo-99-12345';
    const redisClient = createRedisClient();

    const result = await stopTaskExecution(queueJobId, {
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

    assert.strictEqual(result.taskId, 'owner-repo-99');
    assert.deepStrictEqual(mockCreateTaskState.mock.calls[0].arguments, [
      'owner-repo-99',
      {
        number: 99,
        repoOwner: 'owner',
        repoName: 'repo',
        pullRequestNumber: 99,
        type: 'pr-followup',
      },
      'corr-99',
    ]);
    assert.strictEqual(mockMarkTaskCancelled.mock.calls.length, 0);
    const abortKeys = redisClient.set.mock.calls.map(call => call.arguments[0]).sort();
    assert.deepStrictEqual(abortKeys, [
      'worker:abort:issue-owner-repo-99-12345',
      'worker:abort:owner-repo-99',
    ]);
  });

  test('stopTaskExecution clears queued-job abort markers after successful removal', async () => {
    const queueJobId = 'issue-owner-repo-99-12345';
    const redisClient = createRedisClient();

    const result = await stopTaskExecution(queueJobId, {
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
        }, 'waiting') : null,
      }) as never,
      getStateManager: () => ({
        createTaskState: mockCreateTaskState,
        markTaskCancelled: mockMarkTaskCancelled,
      }) as never,
      db: createTaskUpdateDb() as never,
      stopDockerContainer: mockStopDockerContainer as never,
    });

    assert.strictEqual(result.jobRemoved, true);
    assert.deepStrictEqual(redisClient.set.mock.calls.map(call => call.arguments[0]).sort(), [
      'worker:abort:issue-owner-repo-99-12345',
      'worker:abort:owner-repo-99',
    ]);
    assert.deepStrictEqual(redisClient.del.mock.calls.map(call => call.arguments[0]).sort(), [
      'worker:abort:issue-owner-repo-99-12345',
      'worker:abort:owner-repo-99',
    ]);
  });

  test('stopTaskExecution keeps abort markers when a waiting job becomes active during removal', async () => {
    const queueJobId = 'issue-owner-repo-99-12345';
    const redisClient = createRedisClient();
    const queueStates = ['waiting', 'active'];
    const queueJob = {
      id: queueJobId,
      data: {
        repository: 'owner/repo',
        prNumber: 99,
        correlationId: 'corr-99',
      },
      remove: mock.fn(async () => {
        throw new Error('job lock changed');
      }),
      getState: mock.fn(async () => queueStates.shift() ?? 'active'),
    };

    const result = await stopTaskExecution(queueJobId, {
      redisClient,
      requestedBy: 'system',
      cancellation: {
        code: 'pull_request_merged',
        message: 'Task cancelled because pull request #99 was merged.',
      },
    }, {
      getIssueQueue: async () => ({
        getJob: async (id: string) => id === queueJobId ? queueJob : null,
      }) as never,
      getStateManager: () => ({
        createTaskState: mockCreateTaskState,
        markTaskCancelled: mockMarkTaskCancelled,
      }) as never,
      db: createTaskUpdateDb() as never,
      stopDockerContainer: mockStopDockerContainer as never,
    });

    assert.strictEqual(result.jobRemoved, false);
    assert.strictEqual(queueJob.remove.mock.calls.length, 1);
    assert.strictEqual(queueJob.getState.mock.calls.length, 2);
    assert.deepStrictEqual(redisClient.set.mock.calls.map(call => call.arguments[0]).sort(), [
      'worker:abort:issue-owner-repo-99-12345',
      'worker:abort:owner-repo-99',
    ]);
    assert.strictEqual(redisClient.del.mock.calls.length, 0);
    assert.strictEqual(mockMarkTaskCancelled.mock.calls.length, 0);
  });

  test('stopTaskExecution preserves command-specific task type for queued PR comment jobs', async () => {
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
          commandMode: 'review',
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
        type: 'pr-review',
      },
      'corr-99',
    ]);
  });

  test('stopTaskExecution tags merge-conflict queue jobs with a merge-conflict task type', async () => {
    const queueJobId = 'merge-conflict-integry-propr-99-456';
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
          pullRequestNumber: 99,
          correlationId: 'corr-99',
        }, 'waiting', 'processMergeConflict') : null,
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
        type: 'merge-conflict',
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

  test('stopTaskExecution rejects when task state is non-terminal but no stoppable work is found', async () => {
    const redisClient = createRedisClient();
    redisClient.get.mock.mockImplementation(async (key: string) => (
      key === 'worker:state:task-pending'
        ? JSON.stringify({ history: [{ state: 'pending', metadata: {} }] })
        : null
    ));

    await assert.rejects(async () => {
      await stopTaskExecution('task-pending', {
        redisClient,
        requestedBy: 'system',
        cancellation: {
          code: 'pull_request_merged',
          message: 'Task cancelled because pull request #99 was merged.',
        },
      }, {
        getIssueQueue: async () => ({
          getJob: async () => null,
        }) as never,
        getStateManager: () => ({
          createTaskState: mockCreateTaskState,
          markTaskCancelled: mockMarkTaskCancelled,
        }) as never,
        db: createPersistedTaskLookupDb(undefined) as never,
        stopDockerContainer: mockStopDockerContainer as never,
      });
    }, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.strictEqual(error.name, 'StopTaskExecutionError');
      assert.strictEqual((error as { status?: number }).status, 409);
      assert.match(error.message, /not in a stoppable worker or queue state/);
      return true;
    });

    assert.strictEqual(redisClient.set.mock.calls.length, 0);
    assert.strictEqual(redisClient.del.mock.calls.length, 0);
    assert.strictEqual(mockMarkTaskCancelled.mock.calls.length, 0);
  });

  test('getActiveTasksForPR dedupes queue jobs against persisted tasks via job_id', async () => {
    const activeTasks = await getActiveTasksForPR('integry/propr', 1463, {
      getIssueQueue: async () => ({
        client: Promise.resolve({
          sMembers: async () => ['pr-comments-batch-integry-propr-1463-123'],
          sRem: async () => 1,
          expire: async () => 1,
        }),
        getJob: async (jobId: string) => jobId === 'pr-comments-batch-integry-propr-1463-123'
          ? createQueueJob(jobId, { repository: 'integry/propr', pullRequestNumber: 1463 }, 'active')
          : null,
        getJobs: async () => [],
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

  test('getActiveTasksForPR backfills untracked PR jobs when forceQueueScan is enabled for a partial PR index', async () => {
    const activeTasks = await getActiveTasksForPR('integry/propr', 1463, {
      getIssueQueue: async () => ({
        client: Promise.resolve({
          sMembers: async (key: string) => key.startsWith('pr-pending-queue-jobs:')
            ? ['merge-conflict-integry-propr-1463-456']
            : ['pr-comments-batch-integry-propr-1463-123'],
          sAdd: async () => 1,
          expire: async () => 1,
          sRem: async () => 1,
        }),
        getJob: async (jobId: string) => {
          if (jobId === 'pr-comments-batch-integry-propr-1463-123') {
            return createQueueJob(jobId, { repository: 'integry/propr', pullRequestNumber: 1463 }, 'active');
          }
          if (jobId === 'merge-conflict-integry-propr-1463-456') {
            return createQueueJob(jobId, { repository: 'integry/propr', pullRequestNumber: 1463 }, 'waiting');
          }
          return null;
        },
        getJobs: async ([queueState]: string[]) => (
          queueState === 'waiting'
            ? [{ id: 'merge-conflict-integry-propr-1463-456', data: { repository: 'integry/propr', pullRequestNumber: 1463 } }]
            : []
        ),
      }) as never,
      db: createActiveTasksDb([]) as never,
      log: {
        info: mock.fn(),
        warn: mock.fn(),
      },
      forceQueueScan: true,
    });

    assert.deepStrictEqual(activeTasks, [
      { taskId: 'pr-comments-batch-integry-propr-1463-123', state: 'active' },
      { taskId: 'merge-conflict-integry-propr-1463-456', state: 'waiting' },
    ]);
  });

  test('getActiveTasksForPR keeps non-terminal persisted task states even when they are not worker-running states', async () => {
    const activeTasks = await getActiveTasksForPR('integry/propr', 1463, {
      getIssueQueue: async () => ({
        client: Promise.resolve({
          sMembers: async () => [],
          expire: async () => 1,
        }),
        getJob: async () => null,
        getJobs: async () => [],
      }) as never,
      db: createActiveTasksDb([
        {
          task_id: 'task-pending-1',
          job_id: null,
          state: 'pending',
        },
      ]) as never,
      log: {
        info: mock.fn(),
        warn: mock.fn(),
      },
    });

    assert.deepStrictEqual(activeTasks, [
      { taskId: 'task-pending-1', state: 'pending' },
    ]);
  });

  test('hasPullRequestMerged falls back to GitHub when the Redis marker is missing and refreshes the cache', async () => {
    const redisClient = {
      get: mock.fn(async () => null),
      set: mock.fn(async () => 'OK'),
    };
    const getAuthenticatedOctokit = mock.fn(async () => ({
      request: async () => ({
        data: {
          merged: true,
          merged_at: '2026-05-24T00:00:00.000Z',
        },
      }),
    }));
    const merged = await hasPullRequestMerged(redisClient as never, 'integry/propr', 1463, {
      getAuthenticatedOctokit: getAuthenticatedOctokit as never,
    });

    assert.strictEqual(merged, true);
    assert.strictEqual(getAuthenticatedOctokit.mock.calls.length, 1);
    assert.strictEqual(redisClient.get.mock.calls.length, 2);
    assert.strictEqual(redisClient.set.mock.calls.length, 1);
    assert.strictEqual(redisClient.set.mock.calls[0].arguments[0], 'pr-merged:integry/propr:1463');
    assert.match(String(redisClient.set.mock.calls[0].arguments[1]), /^\d{4}-\d{2}-\d{2}T/);
    assert.deepStrictEqual(redisClient.set.mock.calls[0].arguments[2], { EX: 2592000 });
  });

  test('hasPullRequestMerged returns cached open-state markers without rechecking GitHub', async () => {
    const redisClient = {
      get: mock.fn(async (key: string) => key.startsWith('pr-open:') ? 'cached-open' : null),
      set: mock.fn(async () => 'OK'),
    };
    const getAuthenticatedOctokit = mock.fn(async () => ({
      request: async () => ({
        data: {
          merged: false,
          merged_at: null,
        },
      }),
    }));

    const merged = await hasPullRequestMerged(redisClient as never, 'integry/propr', 1463, {
      getAuthenticatedOctokit: getAuthenticatedOctokit as never,
    });

    assert.strictEqual(merged, false);
    assert.strictEqual(redisClient.get.mock.calls.length, 2);
    assert.strictEqual(getAuthenticatedOctokit.mock.calls.length, 0);
    assert.strictEqual(redisClient.set.mock.calls.length, 0);
  });

  test('hasPullRequestMerged negative-caches open PRs after a GitHub lookup', async () => {
    const redisClient = {
      get: mock.fn(async () => null),
      set: mock.fn(async () => 'OK'),
    };
    const getAuthenticatedOctokit = mock.fn(async () => ({
      request: async () => ({
        data: {
          merged: false,
          merged_at: null,
        },
      }),
    }));

    const merged = await hasPullRequestMerged(redisClient as never, 'integry/propr', 1463, {
      getAuthenticatedOctokit: getAuthenticatedOctokit as never,
    });

    assert.strictEqual(merged, false);
    assert.strictEqual(getAuthenticatedOctokit.mock.calls.length, 1);
    assert.strictEqual(redisClient.get.mock.calls.length, 2);
    assert.strictEqual(redisClient.set.mock.calls.length, 1);
    assert.strictEqual(redisClient.set.mock.calls[0].arguments[0], 'pr-open:integry/propr:1463');
    assert.match(String(redisClient.set.mock.calls[0].arguments[1]), /^\d{4}-\d{2}-\d{2}T/);
    assert.deepStrictEqual(redisClient.set.mock.calls[0].arguments[2], { EX: 60 });
  });

  test('getActiveTasksForPR skips full queue scans when tracked PR queue-job indexes already resolve the work', async () => {
    const getJobs = mock.fn(async () => []);
    const activeTasks = await getActiveTasksForPR('integry/propr', 1463, {
      getIssueQueue: async () => ({
        client: Promise.resolve({
          sMembers: async () => ['pr-comments-batch-integry-propr-1463-123'],
          sRem: async () => 1,
          expire: async () => 1,
        }),
        getJob: async (jobId: string) => jobId === 'pr-comments-batch-integry-propr-1463-123'
          ? createQueueJob(jobId, { repository: 'integry/propr', pullRequestNumber: 1463 }, 'active')
          : null,
        getJobs,
      }) as never,
      db: createActiveTasksDb([]) as never,
      log: {
        info: mock.fn(),
        warn: mock.fn(),
      },
    });

    assert.deepStrictEqual(activeTasks, [
      { taskId: 'pr-comments-batch-integry-propr-1463-123', state: 'active' },
    ]);
    assert.strictEqual(getJobs.mock.calls.length, 0);
  });

  test('getActiveTasksForPR falls back to queue scans when no tracked PR jobs exist yet', async () => {
    const activeTasks = await getActiveTasksForPR('integry/propr', 1463, {
      getIssueQueue: async () => ({
        client: Promise.resolve({
          sMembers: async () => [],
          sAdd: async () => 1,
          expire: async () => 1,
        }),
        getJob: async () => null,
        getJobs: async ([queueState]: string[]) => (
          queueState === 'waiting'
            ? [{ id: 'merge-conflict-integry-propr-1463-123', data: { repository: 'integry/propr', pullRequestNumber: 1463 } }]
            : []
        ),
      }) as never,
      db: createActiveTasksDb([]) as never,
      log: {
        info: mock.fn(),
        warn: mock.fn(),
      },
    });

    assert.deepStrictEqual(activeTasks, [
      { taskId: 'merge-conflict-integry-propr-1463-123', state: 'waiting' },
    ]);
  });

  test('hasActiveTasksForPR preserves fail-open compatibility on lookup errors', async () => {
    const result = await hasActiveTasksForPR('integry/propr', 1463, {
      getIssueQueue: async () => {
        throw new Error('lookup failed');
      },
      log: {
        info: mock.fn(),
        warn: mock.fn(),
      },
    });

    assert.deepStrictEqual(result, {
      hasActive: false,
      activeTasks: [],
      queuedJobs: [],
    });
  });

  test('discardFreshQueueJobAfterMerge fails when a merged PR job is still waiting after removal fails', async () => {
    const queuedJob = {
      id: 'pr-comments-batch-integry-propr-1463-123',
      name: 'processPullRequestComment',
      data: {
        repository: 'integry/propr',
        pullRequestNumber: 1463,
      },
      remove: mock.fn(async () => {
        throw new Error('lock lost');
      }),
      getState: mock.fn(async () => 'waiting'),
    };
    const queue = {
      client: Promise.resolve({
        expire: async () => 1,
        sAdd: mock.fn(async () => 1),
        sRem: mock.fn(async () => 1),
      }),
    };
    const redisClient = {
      set: mock.fn(async () => 'OK'),
    };
    const log = {
      info: mock.fn(),
      warn: mock.fn(),
    };

    await assert.rejects(async () => {
      await discardFreshQueueJobAfterMerge({
        queuedJob,
        queue: queue as never,
        redisClient: redisClient as never,
        repository: 'integry/propr',
        prNumber: 1463,
        jobId: 'pr-comments-batch-integry-propr-1463-123',
        taskIds: ['pr-comments-batch-integry-propr-1463-123', 'integry-propr-1463'],
        log,
        removedMessage: 'removed',
        removalFailureMessage: 'failed to remove',
        pendingIndexClearFailureMessage: 'failed to clear pending index',
        trackFailureMessage: 'failed to track',
      });
    }, /queue job remained waiting after removal failure/);

    assert.strictEqual(redisClient.set.mock.calls.length, 2);
  });
});

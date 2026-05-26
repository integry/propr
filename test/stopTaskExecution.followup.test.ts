import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert';

process.env.GH_APP_ID ??= '1';
process.env.GH_PRIVATE_KEY_PATH ??= '.propr/test-private-key.pem';
process.env.GH_INSTALLATION_ID ??= '1';
process.env.NODE_ENV ??= 'test';

const { stopTaskExecution, isBenignQueueRemovalRace } = await import('../packages/api/routes/stopTaskExecution.js');
const { cancelMergedPullRequestTasks } = await import('../packages/api/mergedPullRequestCancellation.js');

const markTaskCancelled = mock.fn(async () => ({}));
const stopDockerContainer = mock.fn(async () => ({ success: true }));
const log = {
  info: mock.fn(),
  warn: mock.fn(),
  error: mock.fn(),
};

function createRedisClient() {
  const messages: Array<Record<string, unknown>> = [];
  const conversationEntries = new Map<string, string[]>();
  const store = new Map<string, string>();

  return {
    messages,
    conversationEntries,
    store,
    get: mock.fn(async (key: string) => store.get(key) ?? null),
    set: mock.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: mock.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
    rPush: mock.fn(async (key: string, value: string) => {
      const entries = conversationEntries.get(key) ?? [];
      entries.push(value);
      conversationEntries.set(key, entries);
      messages.push(JSON.parse(value) as Record<string, unknown>);
      return 1;
    }),
  };
}

beforeEach(() => {
  markTaskCancelled.mock.resetCalls();
  markTaskCancelled.mock.mockImplementation(async () => ({}));
  stopDockerContainer.mock.resetCalls();
  stopDockerContainer.mock.mockImplementation(async () => ({ success: true }));
  log.info.mock.resetCalls();
  log.warn.mock.resetCalls();
  log.error.mock.resetCalls();
});

test('stopTaskExecution rejects pending non-terminal tasks without a queue-backed worker', async () => {
  const redisClient = createRedisClient();
  await assert.rejects(async () => {
    await stopTaskExecution(
      'task-1',
      {
        redisClient,
        requestedBy: 'system',
        cancellation: {
          code: 'pull_request_merged',
          message: 'Task cancelled because pull request #42 was merged.',
        },
      },
      {
        loadStopTaskContext: async () => ({
          normalizedTaskId: 'task-1',
          state: { history: [{ state: 'pending' }] },
          currentState: 'pending',
          queueJob: null,
          queueState: null,
          taskId: 'task-1',
          abortTaskIds: ['task-1'],
        }),
        ensureTaskStateForCancellation: async () => null,
        getStateManager: () => ({ markTaskCancelled }) as never,
        stopDockerContainer,
      },
    );
  }, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.strictEqual(error.name, 'StopTaskExecutionError');
    assert.strictEqual((error as { status?: number }).status, 409);
    assert.match(error.message, /not in a stoppable worker or queue state/);
    return true;
  });

  assert.strictEqual(redisClient.set.mock.calls.length, 0);
  assert.strictEqual(markTaskCancelled.mock.calls.length, 0);
  assert.deepStrictEqual(redisClient.messages, []);
});

test('stopTaskExecution rejects queued cancellation when removal loses the race to a terminal state', async () => {
  const redisClient = createRedisClient();
  const queueJob = {
    id: 'queue-job-1',
    remove: mock.fn(async () => {
      throw new Error('job lock missing');
    }),
    getState: mock.fn(async () => 'completed'),
  };

  await assert.rejects(async () => {
    await stopTaskExecution(
      'queue-job-1',
      {
        redisClient,
        requestedBy: 'system',
        cancellation: {
          code: 'pull_request_merged',
          message: 'Task cancelled because pull request #42 was merged.',
        },
      },
      {
        loadStopTaskContext: async () => ({
          normalizedTaskId: 'queue-job-1',
          state: null,
          currentState: null,
          queueJob: queueJob as never,
          queueState: 'waiting',
          taskId: 'task-queue-1',
          abortTaskIds: ['task-queue-1', 'queue-job-1'],
        }),
        ensureTaskStateForCancellation: async () => null,
        getStateManager: () => ({ markTaskCancelled }) as never,
        stopDockerContainer,
      },
    );
  }, /reached a terminal state before cancellation was applied/);

  assert.strictEqual(markTaskCancelled.mock.calls.length, 0);
  assert.strictEqual(redisClient.set.mock.calls.length, 0);
  assert.strictEqual(redisClient.del.mock.calls.length, 0);
});

test('stopTaskExecution persists cancellation when a queued job starts during removal', async () => {
  const redisClient = createRedisClient();
  const queueJob = {
    id: 'queue-job-active-race-1',
    remove: mock.fn(async () => {
      throw new Error('job lock missing');
    }),
    getState: mock.fn(async () => 'active'),
  };

  const result = await stopTaskExecution(
    'queue-job-active-race-1',
    {
      redisClient,
      requestedBy: 'system',
      cancellation: {
        code: 'pull_request_merged',
        message: 'Task cancelled because pull request #42 was merged.',
      },
    },
    {
      loadStopTaskContext: async () => ({
        normalizedTaskId: 'queue-job-active-race-1',
        state: null,
        currentState: null,
        queueJob: queueJob as never,
        queueState: 'waiting',
        taskId: 'task-active-race-1',
        abortTaskIds: ['task-active-race-1', 'queue-job-active-race-1'],
      }),
      ensureTaskStateForCancellation: async () => null,
      getStateManager: () => ({ markTaskCancelled }) as never,
      stopDockerContainer,
    },
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.stopVerified, false);
  assert.strictEqual(result.cancellationRequested, true);
  assert.strictEqual(result.queueState, 'active');
  assert.strictEqual(markTaskCancelled.mock.calls.length, 1);
  assert.strictEqual(redisClient.set.mock.calls.length, 2);
  assert.deepStrictEqual(redisClient.messages.map((message) => message.content), [
    'Cancellation requested. Worker shutdown is still in progress.',
  ]);
  assert.deepStrictEqual(markTaskCancelled.mock.calls[0]?.arguments[2].historyMetadata, {
    cancellation: {
      code: 'pull_request_merged',
      message: 'Task cancelled because pull request #42 was merged.',
    },
    requestedBy: 'system',
    containerStopped: false,
    jobRemoved: false,
    stopVerified: false,
    abortSignalArmed: true,
    queueState: 'active',
  });
});

test('stopTaskExecution leaves abort-armed container-backed tasks non-terminal when the container stop fails', async () => {
  const redisClient = createRedisClient();
  const result = await stopTaskExecution(
    'task-2',
    {
      redisClient,
      requestedBy: 'system',
      cancellation: {
        code: 'pull_request_merged',
        message: 'Task cancelled because pull request #42 was merged.',
      },
    },
    {
      loadStopTaskContext: async () => ({
        normalizedTaskId: 'task-2',
        state: { history: [{ state: 'claude_execution', metadata: { containerId: 'container-1' } }] },
        currentState: 'claude_execution',
        queueJob: null,
        queueState: null,
        taskId: 'task-2',
        abortTaskIds: ['task-2'],
      }),
      ensureTaskStateForCancellation: async () => null,
      getStateManager: () => ({ markTaskCancelled }) as never,
      stopDockerContainer: mock.fn(async () => ({ success: false, error: 'timeout' })),
    },
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.containerStopped, false);
  assert.strictEqual(result.jobRemoved, false);
  assert.strictEqual(result.stopVerified, false);
  assert.strictEqual(result.cancellationRequested, true);
  assert.strictEqual(result.message, 'Stop request sent to worker. The execution will be terminated shortly.');
  assert.strictEqual(redisClient.set.mock.calls.length, 1);
  assert.strictEqual(markTaskCancelled.mock.calls.length, 0);
});

test('stopTaskExecution retries persisted cancellation after a queue removal persistence failure', async () => {
  const redisClient = createRedisClient();
  const queueJob = {
    id: 'queue-job-retry-1',
    data: {
      repository: 'owner/repo',
      prNumber: 42,
    },
    remove: mock.fn(async () => undefined),
    getState: mock.fn(async () => 'waiting'),
  };
  let callCount = 0;
  markTaskCancelled.mock.mockImplementation(async () => {
    callCount += 1;
    if (callCount === 1) {
      throw new Error('persist failed');
    }
    return {};
  });

  await assert.rejects(async () => {
    await stopTaskExecution(
      'queue-job-retry-1',
      {
        redisClient,
        requestedBy: 'system',
        cancellation: {
          code: 'pull_request_merged',
          message: 'Task cancelled because pull request #42 was merged.',
        },
      },
      {
        loadStopTaskContext: async () => ({
          normalizedTaskId: 'queue-job-retry-1',
          state: null,
          currentState: null,
          queueJob: queueJob as never,
          queueState: 'waiting',
          taskId: 'task-retry-1',
          abortTaskIds: ['task-retry-1', 'queue-job-retry-1'],
        }),
        ensureTaskStateForCancellation: async () => null,
        getStateManager: () => ({ markTaskCancelled }) as never,
        stopDockerContainer,
      },
    );
  }, /persist failed/);

  const retriedResult = await stopTaskExecution(
    'task-retry-1',
    {
      redisClient,
      requestedBy: 'system',
      cancellation: {
        code: 'pull_request_merged',
        message: 'Task cancelled because pull request #42 was merged.',
      },
    },
    {
      loadStopTaskContext: async () => ({
        normalizedTaskId: 'task-retry-1',
        state: null,
        currentState: null,
        queueJob: null,
        queueState: null,
        taskId: 'task-retry-1',
        abortTaskIds: ['task-retry-1', 'queue-job-retry-1'],
      }),
      ensureTaskStateForCancellation: async () => null,
      getStateManager: () => ({ markTaskCancelled }) as never,
      stopDockerContainer,
    },
  );

  assert.strictEqual(retriedResult.success, true);
  assert.strictEqual(retriedResult.jobRemoved, true);
  assert.strictEqual(retriedResult.message, 'Queued task cancelled before execution started.');
  assert.strictEqual(queueJob.remove.mock.calls.length, 1);
  assert.strictEqual(markTaskCancelled.mock.calls.length, 2);
  assert.deepStrictEqual(redisClient.del.mock.calls.map((call) => call.arguments[0]).sort(), [
    'worker:abort:queue-job-retry-1',
    'worker:abort:task-retry-1',
    'worker:stop-outcome:queue-job-retry-1',
    'worker:stop-outcome:task-retry-1',
  ]);
});

test('stopTaskExecution rejects queued cancellation for unknown queue-removal races', async () => {
  const redisClient = createRedisClient();
  const queueJob = {
    id: 'queue-job-unknown-1',
    remove: mock.fn(async () => {
      throw new Error('job lock missing');
    }),
    getState: mock.fn(async () => 'unknown'),
  };

  await assert.rejects(async () => {
    await stopTaskExecution(
      'queue-job-unknown-1',
      {
        redisClient,
        requestedBy: 'system',
        cancellation: {
          code: 'pull_request_merged',
          message: 'Task cancelled because pull request #42 was merged.',
        },
      },
      {
        loadStopTaskContext: async () => ({
          normalizedTaskId: 'queue-job-unknown-1',
          state: null,
          currentState: null,
          queueJob: queueJob as never,
          queueState: 'waiting',
          taskId: 'task-queue-unknown-1',
          abortTaskIds: ['task-queue-unknown-1', 'queue-job-unknown-1'],
        }),
        ensureTaskStateForCancellation: async () => null,
        getStateManager: () => ({ markTaskCancelled }) as never,
        stopDockerContainer,
      },
    );
  }, /job lock missing/);

  assert.strictEqual(markTaskCancelled.mock.calls.length, 0);
  assert.strictEqual(redisClient.set.mock.calls.length, 0);
  assert.strictEqual(redisClient.del.mock.calls.length, 0);
});

test('stopTaskExecution still terminates the Claude container from post_processing state', async () => {
  const redisClient = createRedisClient();

  const result = await stopTaskExecution(
    'task-post-processing',
    {
      redisClient,
      requestedBy: 'system',
      cancellation: {
        code: 'pull_request_merged',
        message: 'Task cancelled because pull request #42 was merged.',
      },
    },
    {
      loadStopTaskContext: async () => ({
        normalizedTaskId: 'task-post-processing',
        state: {
          history: [
            { state: 'claude_execution', metadata: { containerId: 'container-post-1' } },
            { state: 'post_processing' },
          ],
        },
        currentState: 'post_processing',
        queueJob: null,
        queueState: null,
        taskId: 'task-post-processing',
        abortTaskIds: ['task-post-processing'],
      }),
      ensureTaskStateForCancellation: async () => null,
      getStateManager: () => ({ markTaskCancelled }) as never,
      stopDockerContainer,
    },
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.containerStopped, true);
  assert.strictEqual(stopDockerContainer.mock.calls.length, 1);
  assert.deepStrictEqual(stopDockerContainer.mock.calls[0]?.arguments, ['container-post-1', 10]);
  assert.strictEqual(markTaskCancelled.mock.calls.length, 1);
});

test('stopTaskExecution records the cancellation reason only after a verified stop', async () => {
  const redisClient = createRedisClient();
  const queueJob = {
    id: 'queue-job-success-1',
    data: {
      repository: 'owner/repo',
      prNumber: 42,
    },
    remove: mock.fn(async () => undefined),
    getState: mock.fn(async () => 'waiting'),
  };

  const result = await stopTaskExecution(
    'queue-job-success-1',
    {
      redisClient,
      requestedBy: 'system',
      cancellation: {
        code: 'pull_request_merged',
        message: 'Task cancelled because pull request #42 was merged.',
      },
    },
    {
      loadStopTaskContext: async () => ({
        normalizedTaskId: 'queue-job-success-1',
        state: null,
        currentState: null,
        queueJob: queueJob as never,
        queueState: 'waiting',
        taskId: 'task-queue-success-1',
        abortTaskIds: ['task-queue-success-1', 'queue-job-success-1'],
      }),
      ensureTaskStateForCancellation: async () => null,
      getStateManager: () => ({ markTaskCancelled }) as never,
      stopDockerContainer,
    },
  );

  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(redisClient.messages.map((message) => message.content), [
    'Task cancelled because pull request #42 was merged.',
    'Task cancelled successfully.',
  ]);
});

test('isBenignQueueRemovalRace only accepts active removal races', () => {
  assert.strictEqual(isBenignQueueRemovalRace('active'), true);
  assert.strictEqual(isBenignQueueRemovalRace('completed'), false);
  assert.strictEqual(isBenignQueueRemovalRace('failed'), false);
  assert.strictEqual(isBenignQueueRemovalRace('unknown'), false);
  assert.strictEqual(isBenignQueueRemovalRace(null), false);
  assert.strictEqual(isBenignQueueRemovalRace('waiting'), false);
});

test('cancelMergedPullRequestTasks force-scans the initial merged-PR lookup and rechecks queued work', async () => {
  const redisClient = createRedisClient();
  let lookupCount = 0;
  const getActiveTasksForPR = mock.fn(async () => {
    lookupCount += 1;
    return lookupCount === 1
      ? [{ taskId: 'queue-task-1', state: 'waiting' }]
      : [];
  });
  const markPullRequestMerged = mock.fn(async () => {});
  const stopTaskExecutionForMerge = mock.fn(async () => ({
    success: true,
    taskId: 'queue-task-1',
    stopVerified: true,
  }));
  const sleep = mock.fn(async () => {});

  await cancelMergedPullRequestTasks(
    {
      action: 'closed',
      repository: { full_name: 'owner/repo' },
      pull_request: { number: 42, merged: true },
    },
    'cid-1',
    {
      redisClient,
      getActiveTasksForPR,
      markPullRequestMerged,
      stopTaskExecution: stopTaskExecutionForMerge as never,
      sleep,
      log,
    },
  );

  assert.strictEqual(getActiveTasksForPR.mock.calls.length, 2);
  assert.deepStrictEqual(getActiveTasksForPR.mock.calls[0]?.arguments, ['owner/repo', 42, {
    forceQueueScan: true,
    log,
    stoppableOnly: true,
  }]);
  assert.deepStrictEqual(getActiveTasksForPR.mock.calls[1]?.arguments, ['owner/repo', 42, {
    forceQueueScan: true,
    log,
    stoppableOnly: true,
  }]);
  assert.strictEqual(markPullRequestMerged.mock.calls.length, 1);
});

test('stopTaskExecution rejects queued cancellation when queue state cannot be reloaded after removal failure', async () => {
  const redisClient = createRedisClient();
  const queueJob = {
    id: 'queue-job-2',
    remove: mock.fn(async () => {
      throw new Error('job lock missing');
    }),
    getState: mock.fn(async () => {
      throw new Error('redis unavailable');
    }),
  };

  await assert.rejects(async () => {
    await stopTaskExecution(
      'queue-job-2',
      {
        redisClient,
        requestedBy: 'system',
        cancellation: {
          code: 'pull_request_merged',
          message: 'Task cancelled because pull request #42 was merged.',
        },
      },
      {
        loadStopTaskContext: async () => ({
          normalizedTaskId: 'queue-job-2',
          state: null,
          currentState: null,
          queueJob: queueJob as never,
          queueState: 'waiting',
          taskId: 'task-queue-2',
          abortTaskIds: ['task-queue-2', 'queue-job-2'],
        }),
        ensureTaskStateForCancellation: async () => null,
        getStateManager: () => ({ markTaskCancelled }) as never,
        stopDockerContainer,
      },
    );
  }, /job lock missing/);

  assert.strictEqual(markTaskCancelled.mock.calls.length, 0);
  assert.strictEqual(redisClient.set.mock.calls.length, 0);
  assert.strictEqual(redisClient.del.mock.calls.length, 0);
});

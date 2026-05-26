import { after, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GH_APP_ID ??= '1';
process.env.GH_PRIVATE_KEY_PATH ??= '.propr/test-private-key.pem';
process.env.GH_INSTALLATION_ID ??= '1';
process.env.NODE_ENV ??= 'test';

const { cancelMergedPullRequestTasks } = await import('../packages/api/mergedPullRequestCancellation.ts');

after(async () => {
  const { closeConnection: closePackageConnection } = await import('@propr/core');
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closePackageConnection();
  await closeConnection();
});

function createRedisClient() {
  return {
    get: mock.fn(async () => null),
    set: mock.fn(async () => 'OK'),
    del: mock.fn(async () => 1),
    rPush: mock.fn(async () => 1),
  };
}

function createMergedPrPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'closed',
    repository: { full_name: 'integry/propr' },
    pull_request: { number: 1463, merged: true },
    ...overrides,
  };
}

function createStopResult(taskId: string, overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    message: 'cancelled',
    taskId,
    containerStopped: false,
    jobRemoved: false,
    stopVerified: true,
    cancellationRequested: false,
    abortSignalArmed: false,
    currentState: 'processing',
    queueState: null,
    cancellation: { code: 'pull_request_merged', message: 'Task cancelled because pull request #1463 was merged.' },
    ...overrides,
  };
}

describe('cancelMergedPullRequestTasks', () => {
  const mockLogger = {
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
  };
  const mockMarkPullRequestMerged = mock.fn(async () => undefined);
  const mockGetActiveTasksForPR = mock.fn(async () => []);
  const mockStopTaskExecution = mock.fn(async (taskId: string) => createStopResult(taskId));

  beforeEach(() => {
    mockLogger.info.mock.resetCalls();
    mockLogger.warn.mock.resetCalls();
    mockLogger.error.mock.resetCalls();
    mockMarkPullRequestMerged.mock.resetCalls();
    mockGetActiveTasksForPR.mock.resetCalls();
    mockStopTaskExecution.mock.resetCalls();

    mockMarkPullRequestMerged.mock.mockImplementation(async () => undefined);
    mockGetActiveTasksForPR.mock.mockImplementation(async () => []);
    mockStopTaskExecution.mock.mockImplementation(async (taskId: string) => createStopResult(taskId));
  });

  test('cancels active PR tasks for merged PR closes and rechecks once', async () => {
    const redisClient = createRedisClient();
    let lookupCount = 0;
    mockGetActiveTasksForPR.mock.mockImplementation(async () => {
      lookupCount += 1;
      return lookupCount === 1
        ? [
            { taskId: 'task-running', state: 'processing' },
            { taskId: 'job-queued', state: 'waiting' },
          ]
        : [];
    });

    await cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
      redisClient,
      markPullRequestMerged: mockMarkPullRequestMerged,
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      recheckDelayMs: 0,
      log: mockLogger,
    });

    assert.deepEqual(mockMarkPullRequestMerged.mock.calls[0].arguments, [redisClient, 'integry/propr', 1463]);
    assert.equal(mockGetActiveTasksForPR.mock.calls.length, 2);
    assert.deepEqual(mockGetActiveTasksForPR.mock.calls[0].arguments, ['integry/propr', 1463, {
      forceQueueScan: true,
      log: mockLogger,
      stoppableOnly: true,
    }]);
    assert.deepEqual(
      mockStopTaskExecution.mock.calls.map((call) => call.arguments[0]),
      ['task-running', 'job-queued'],
    );
    assert.equal(
      mockStopTaskExecution.mock.calls[0].arguments[1].cancellation.message,
      'Task cancelled because pull request integry/propr#1463 was merged.',
    );
    assert.equal(mockStopTaskExecution.mock.calls[0].arguments[1].forceQueueScan, false);
    assert.equal(mockStopTaskExecution.mock.calls[1].arguments[1].forceQueueScan, true);
  });

  test('force-scans stop lookup for queue-scanned PR jobs whose BullMQ id differs from task id', async () => {
    const redisClient = createRedisClient();
    let lookupCount = 0;
    mockGetActiveTasksForPR.mock.mockImplementation(async () => {
      lookupCount += 1;
      return lookupCount === 1 ? [{ taskId: 'owner-repo-1463', state: 'waiting' }] : [];
    });
    mockStopTaskExecution.mock.mockImplementation(async (taskId: string, options: { forceQueueScan?: boolean }) => {
      if (taskId === 'owner-repo-1463' && options.forceQueueScan !== true) {
        throw new Error('Task not found without queue scan');
      }
      return createStopResult(taskId, { jobRemoved: true, queueState: 'removed_before_start' });
    });

    await cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
      redisClient,
      markPullRequestMerged: mockMarkPullRequestMerged,
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      recheckDelayMs: 0,
      log: mockLogger,
    });

    assert.equal(mockStopTaskExecution.mock.calls.length, 1);
    assert.equal(mockStopTaskExecution.mock.calls[0].arguments[0], 'owner-repo-1463');
    assert.equal(mockStopTaskExecution.mock.calls[0].arguments[1].forceQueueScan, true);
  });

  test('does nothing for unmerged PR closes', async () => {
    await cancelMergedPullRequestTasks(createMergedPrPayload({
      pull_request: { number: 1463, merged: false },
    }), 'test-correlation-id', {
      redisClient: createRedisClient(),
      markPullRequestMerged: mockMarkPullRequestMerged,
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      recheckDelayMs: 0,
      log: mockLogger,
    });

    assert.equal(mockMarkPullRequestMerged.mock.calls.length, 0);
    assert.equal(mockGetActiveTasksForPR.mock.calls.length, 0);
    assert.equal(mockStopTaskExecution.mock.calls.length, 0);
  });

  test('does not fail the webhook when the merge gate write fails and no active tasks remain', async () => {
    mockMarkPullRequestMerged.mock.mockImplementation(async () => {
      throw new Error('redis write failed');
    });

    await cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
      redisClient: createRedisClient(),
      markPullRequestMerged: mockMarkPullRequestMerged,
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      recheckDelayMs: 0,
      log: mockLogger,
    });

    assert.equal(mockGetActiveTasksForPR.mock.calls.length, 1);
    assert.equal(mockStopTaskExecution.mock.calls.length, 0);
    assert.equal(mockLogger.error.mock.calls.length, 1);
    assert.equal(mockLogger.warn.mock.calls.length, 1);
  });

  test('does nothing for irrelevant payloads even when cancellation deps are unavailable', async () => {
    await cancelMergedPullRequestTasks({ action: 'opened' }, 'test-correlation-id', undefined as never);

    assert.equal(mockMarkPullRequestMerged.mock.calls.length, 0);
    assert.equal(mockGetActiveTasksForPR.mock.calls.length, 0);
    assert.equal(mockStopTaskExecution.mock.calls.length, 0);
  });

  test('ignores a stop error when the recheck shows the task is no longer active', async () => {
    const redisClient = createRedisClient();
    let lookupCount = 0;
    mockGetActiveTasksForPR.mock.mockImplementation(async () => {
      lookupCount += 1;
      return lookupCount === 1 ? [{ taskId: 'task-raced', state: 'processing' }] : [];
    });
    mockStopTaskExecution.mock.mockImplementation(async () => {
      throw new Error('task already gone');
    });

    await cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
      redisClient,
      markPullRequestMerged: mockMarkPullRequestMerged,
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      recheckDelayMs: 0,
      log: mockLogger,
    });

    assert.equal(mockStopTaskExecution.mock.calls.length, 1);
    assert.equal(mockLogger.warn.mock.calls.length, 1);
  });

  test('succeeds after persisting a warning when requested abort-only cancellation remains active after rechecks', async () => {
    const redisClient = createRedisClient();
    mockGetActiveTasksForPR.mock.mockImplementation(async () => ([{ taskId: 'task-processing', state: 'processing' }]));
    mockStopTaskExecution.mock.mockImplementation(async (taskId: string) => {
      return createStopResult(taskId, {
        stopVerified: false,
        cancellationRequested: true,
        abortSignalArmed: true,
      });
    });

    await cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
      redisClient,
      markPullRequestMerged: mockMarkPullRequestMerged,
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      recheckDelayMs: 0,
      log: mockLogger,
    });

    assert.equal(mockGetActiveTasksForPR.mock.calls.length, 4);
    assert.deepEqual(
      mockStopTaskExecution.mock.calls.map((call) => call.arguments[0]),
      ['task-processing', 'task-processing', 'task-processing'],
    );
    assert.equal(mockStopTaskExecution.mock.calls[0].arguments[1].containerStopTimeoutSeconds, 30);
    assert.equal(mockStopTaskExecution.mock.calls[0].arguments[1].requireVerifiedStop, undefined);
    assert.deepEqual(mockMarkPullRequestMerged.mock.calls[0].arguments, [redisClient, 'integry/propr', 1463]);
    assert.equal(mockLogger.warn.mock.calls.length, 4);
    assert.equal(redisClient.set.mock.calls.length, 2);
  });

  test('succeeds when an abort-only cancellation disappears during merged-PR recheck', async () => {
    const redisClient = createRedisClient();
    let lookupCount = 0;
    mockGetActiveTasksForPR.mock.mockImplementation(async () => {
      lookupCount += 1;
      return lookupCount === 1 ? [{ taskId: 'task-processing', state: 'processing' }] : [];
    });
    mockStopTaskExecution.mock.mockImplementation(async (taskId: string) => {
      return createStopResult(taskId, {
        stopVerified: false,
        cancellationRequested: true,
        abortSignalArmed: true,
      });
    });

    await cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
      redisClient,
      markPullRequestMerged: mockMarkPullRequestMerged,
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      recheckDelayMs: 0,
      log: mockLogger,
    });

    assert.equal(mockGetActiveTasksForPR.mock.calls.length, 2);
    assert.equal(mockStopTaskExecution.mock.calls.length, 1);
    assert.equal(mockStopTaskExecution.mock.calls[0].arguments[1].requireVerifiedStop, undefined);
    assert.equal(mockLogger.warn.mock.calls.length, 1);
  });

  test('rejects the webhook when a task still errors after the merged-PR retry', async () => {
    const redisClient = createRedisClient();
    mockGetActiveTasksForPR.mock.mockImplementation(async () => ([{ taskId: 'task-stuck', state: 'processing' }]));
    mockStopTaskExecution.mock.mockImplementation(async () => {
      throw new Error('stop failed');
    });

    await assert.rejects(
      cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
        redisClient,
        markPullRequestMerged: mockMarkPullRequestMerged,
        getActiveTasksForPR: mockGetActiveTasksForPR,
        stopTaskExecution: mockStopTaskExecution,
        recheckDelayMs: 0,
        log: mockLogger,
      }),
      /Failed to cancel 1 merged PR task/,
    );

    assert.equal(mockStopTaskExecution.mock.calls.length, 3);
    assert.deepEqual(mockMarkPullRequestMerged.mock.calls[0].arguments, [redisClient, 'integry/propr', 1463]);
    assert.equal(mockLogger.warn.mock.calls.length, 4);
  });

  test('does not fail the webhook for pending abort-only stops that remain active after the PR merged gate is marked', async () => {
    const redisClient = {
      ...createRedisClient(),
      get: mock.fn(async () => JSON.stringify({
        timestamp: '2026-05-25T00:00:00.000Z',
        requestedBy: 'system',
        reasonCode: 'pull_request_merged',
        reason: 'Task cancelled because pull request #1463 was merged.',
        source: 'pull_request_merged',
      })),
    };
    mockGetActiveTasksForPR.mock.mockImplementation(async () => ([{ taskId: 'task-stuck', state: 'processing' }]));
    mockStopTaskExecution.mock.mockImplementation(async (taskId: string) => createStopResult(taskId, {
      stopVerified: false,
      cancellationRequested: true,
      abortSignalArmed: true,
    }));

    await cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
      redisClient,
      markPullRequestMerged: mockMarkPullRequestMerged,
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      recheckDelayMs: 0,
      log: mockLogger,
    });

    assert.equal(mockGetActiveTasksForPR.mock.calls.length, 4);
    assert.equal(mockStopTaskExecution.mock.calls.length, 3);
    assert.deepEqual(mockMarkPullRequestMerged.mock.calls[0].arguments, [redisClient, 'integry/propr', 1463]);
    assert.equal(mockLogger.warn.mock.calls.length, 4);
    assert.equal(redisClient.set.mock.calls.length, 2);
  });

  test('still cancels active tasks when persisting the merged PR gate fails', async () => {
    const redisClient = createRedisClient();
    let lookupCount = 0;
    mockMarkPullRequestMerged.mock.mockImplementation(async () => {
      throw new Error('redis write failed');
    });
    mockGetActiveTasksForPR.mock.mockImplementation(async () => {
      lookupCount += 1;
      return lookupCount === 1 ? [{ taskId: 'task-running', state: 'processing' }] : [];
    });

    await cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
      redisClient,
      markPullRequestMerged: mockMarkPullRequestMerged,
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      recheckDelayMs: 0,
      log: mockLogger,
    });

    assert.equal(mockStopTaskExecution.mock.calls.length, 1);
    assert.equal(mockGetActiveTasksForPR.mock.calls.length, 2);
    assert.equal(mockLogger.error.mock.calls.length, 1);
    assert.equal(mockLogger.warn.mock.calls.length, 1);
  });

  test('rejects merged PR cancellation when active-task lookup fails', async () => {
    const redisClient = createRedisClient();
    mockGetActiveTasksForPR.mock.mockImplementation(async () => {
      throw new Error('redis unavailable');
    });

    await assert.rejects(
      cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
        redisClient,
        markPullRequestMerged: mockMarkPullRequestMerged,
        getActiveTasksForPR: mockGetActiveTasksForPR,
        stopTaskExecution: mockStopTaskExecution,
        recheckDelayMs: 0,
        log: mockLogger,
      }),
      /redis unavailable/,
    );

    assert.deepEqual(mockMarkPullRequestMerged.mock.calls[0].arguments, [redisClient, 'integry/propr', 1463]);
    assert.equal(mockStopTaskExecution.mock.calls.length, 0);
    assert.equal(mockLogger.error.mock.calls.length, 1);
  });

  test('rejects merged PR cancellation when required dependencies are missing', async () => {
    await assert.rejects(
      cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', undefined as never),
      /dependencies are required/,
    );
  });

  test('waits through the final configured recheck delay before failing cancellation', async () => {
    const redisClient = createRedisClient();
    const sleep = mock.fn(async () => undefined);
    mockGetActiveTasksForPR.mock.mockImplementation(async () => ([{ taskId: 'task-still-active', state: 'processing' }]));
    mockStopTaskExecution.mock.mockImplementation(async () => {
      throw new Error('stop failed');
    });

    await assert.rejects(
      cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
        redisClient,
        markPullRequestMerged: mockMarkPullRequestMerged,
        getActiveTasksForPR: mockGetActiveTasksForPR,
        stopTaskExecution: mockStopTaskExecution,
        recheckDelaysMs: [1, 3, 5],
        sleep,
        log: mockLogger,
      }),
      /Failed to cancel 1 merged PR task/,
    );

    assert.deepEqual(sleep.mock.calls.map((call) => call.arguments[0]), [1, 3, 5]);
    assert.equal(mockGetActiveTasksForPR.mock.calls.length, 4);
    assert.equal(mockStopTaskExecution.mock.calls.length, 3);
  });
});

import { after, test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';

process.env.GH_APP_ID ??= '1';
process.env.GH_PRIVATE_KEY_PATH ??= '.propr/test-private-key.pem';
process.env.GH_INSTALLATION_ID ??= '1';
process.env.NODE_ENV ??= 'test';

const { cancelMergedPullRequestTasks, handleWebhookRequest } = await import('../packages/api/webhookHandler.js');
const { StopTaskExecutionError } = await import('../packages/api/routes/dockerRoutes.ts');
const { closeConnection } = await import('../packages/core/src/db/connection.ts');
const { closeStateManager } = await import('../packages/core/src/utils/workerStateManager.ts');
const { closeUltrafixStateRedis } = await import('../packages/core/src/webhook/checkRunHelpers.ts');

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

function createWebhookRequest(payload: Record<string, unknown>, secret: string) {
  const body = Buffer.from(JSON.stringify(payload));
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

  return {
    body,
    headers: {
      'x-hub-signature-256': signature,
      'x-github-delivery': 'delivery-123',
      'x-github-event': 'pull_request',
    },
  };
}

function createWebhookResponse() {
  return {
    statusCode: 200,
    body: '',
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: string) {
      this.body = payload;
      return this;
    },
  };
}

after(async () => {
  await closeUltrafixStateRedis();
  await closeStateManager();
  await closeConnection();
});

describe('cancelMergedPullRequestTasks', () => {
  const mockLogger = {
    info: mock.fn(),
    warn: mock.fn(),
  };
  const mockMarkPullRequestMerged = mock.fn(async () => undefined);
  const mockGetActiveTasksForPR = mock.fn(async () => []);
  const mockStopTaskExecution = mock.fn(async () => ({
    success: true,
    message: 'cancelled',
    taskId: 'task-1',
    containerStopped: false,
    jobRemoved: false,
    currentState: 'processing',
    queueState: 'active',
    cancellation: { code: 'pull_request_merged', message: 'Task cancelled because pull request #1463 was merged.' },
  }));

  beforeEach(() => {
    mockLogger.info.mock.resetCalls();
    mockLogger.warn.mock.resetCalls();
    mockMarkPullRequestMerged.mock.resetCalls();
    mockGetActiveTasksForPR.mock.resetCalls();
    mockStopTaskExecution.mock.resetCalls();

    mockGetActiveTasksForPR.mock.mockImplementation(async () => []);
    mockStopTaskExecution.mock.mockImplementation(async () => ({
      success: true,
      message: 'cancelled',
      taskId: 'task-1',
      containerStopped: false,
      jobRemoved: false,
      currentState: 'processing',
      queueState: 'active',
      cancellation: { code: 'pull_request_merged', message: 'Task cancelled because pull request #1463 was merged.' },
    }));
  });

  test('cancels all active PR tasks for merged PR closes', async () => {
    const redisClient = createRedisClient();
    mockGetActiveTasksForPR.mock.mockImplementation(async () => ([
      { taskId: 'task-running', state: 'processing' },
      { taskId: 'job-queued', state: 'waiting' },
    ]));

    await cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
      redisClient,
      markPullRequestMerged: mockMarkPullRequestMerged,
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      log: mockLogger,
    });

    assert.strictEqual(mockGetActiveTasksForPR.mock.calls.length, 1);
    assert.deepStrictEqual(mockMarkPullRequestMerged.mock.calls[0].arguments, [redisClient, 'integry/propr', 1463]);
    assert.deepStrictEqual(mockGetActiveTasksForPR.mock.calls[0].arguments, ['integry/propr', 1463, {
      log: mockLogger,
      forceQueueScan: true,
    }]);
    assert.strictEqual(mockStopTaskExecution.mock.calls.length, 2);
    assert.strictEqual(mockStopTaskExecution.mock.calls[0].arguments[0], 'task-running');
    assert.strictEqual(mockStopTaskExecution.mock.calls[1].arguments[0], 'job-queued');
    assert.deepStrictEqual(mockStopTaskExecution.mock.calls[0].arguments[1], {
      redisClient,
      requestedBy: 'system',
      cancellation: {
        code: 'pull_request_merged',
        message: 'Task cancelled because pull request #1463 was merged.',
      },
      containerStopTimeoutSeconds: 1,
    });
  });

  test('does nothing for unmerged PR closes', async () => {
    const redisClient = createRedisClient();

    await cancelMergedPullRequestTasks(createMergedPrPayload({
      pull_request: { number: 1463, merged: false },
    }), 'test-correlation-id', {
      redisClient,
      markPullRequestMerged: mockMarkPullRequestMerged,
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      log: mockLogger,
    });

    assert.strictEqual(mockGetActiveTasksForPR.mock.calls.length, 0);
    assert.strictEqual(mockStopTaskExecution.mock.calls.length, 0);
  });

  test('rejects merged PR cancellation when required dependencies are missing', async () => {
    await assert.rejects(
      async () => cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id'),
      /dependencies are required/,
    );
  });

  test('does nothing when there are no active PR tasks', async () => {
    const redisClient = createRedisClient();

    await cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
      redisClient,
      markPullRequestMerged: mockMarkPullRequestMerged,
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      log: mockLogger,
    });

    assert.strictEqual(mockGetActiveTasksForPR.mock.calls.length, 1);
    assert.strictEqual(mockStopTaskExecution.mock.calls.length, 0);
  });

  test('attempts all cancellations and rejects when a task stop fails', async () => {
    const redisClient = createRedisClient();
    mockGetActiveTasksForPR.mock.mockImplementation(async () => ([
      { taskId: 'task-fails', state: 'processing' },
      { taskId: 'task-succeeds', state: 'waiting' },
    ]));
    mockStopTaskExecution.mock.mockImplementation(async (taskId: string) => {
      if (taskId === 'task-fails') {
        throw new Error('simulated cancellation failure');
      }
      return {
        success: true,
        message: 'cancelled',
        taskId,
        containerStopped: false,
        jobRemoved: true,
        currentState: null,
        queueState: 'waiting',
        cancellation: { code: 'pull_request_merged', message: 'Task cancelled because pull request #1463 was merged.' },
      };
    });

    await assert.rejects(async () => {
      await cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
      redisClient,
      markPullRequestMerged: mockMarkPullRequestMerged,
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      log: mockLogger,
      });
    }, /Failed to cancel 1 merged PR task/);

    assert.strictEqual(mockStopTaskExecution.mock.calls.length, 2);
    assert.strictEqual(mockStopTaskExecution.mock.calls[0].arguments[0], 'task-fails');
    assert.strictEqual(mockStopTaskExecution.mock.calls[1].arguments[0], 'task-succeeds');
    assert.strictEqual(mockLogger.warn.mock.calls.length, 1);
  });

  test('ignores already-inactive stop races during merge cancellation', async () => {
    const redisClient = createRedisClient();
    mockGetActiveTasksForPR.mock.mockImplementation(async () => ([
      { taskId: 'task-raced', state: 'processing' },
      { taskId: 'task-succeeds', state: 'waiting' },
    ]));
    mockStopTaskExecution.mock.mockImplementation(async (taskId: string) => {
      if (taskId === 'task-raced') {
        throw new StopTaskExecutionError(404, {
          error: 'Task not found',
          message: 'The task may have already completed or does not exist.',
        });
      }
      return {
        success: true,
        message: 'cancelled',
        taskId,
        containerStopped: false,
        jobRemoved: true,
        currentState: null,
        queueState: 'waiting',
        cancellation: { code: 'pull_request_merged', message: 'Task cancelled because pull request #1463 was merged.' },
      };
    });

    await assert.doesNotReject(async () => {
      await cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
      redisClient,
      markPullRequestMerged: mockMarkPullRequestMerged,
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      log: mockLogger,
      });
    });

    assert.strictEqual(mockStopTaskExecution.mock.calls.length, 2);
    assert.strictEqual(mockLogger.info.mock.calls.length > 0, true);
  });

  test('fails closed when active PR lookup fails', async () => {
    const redisClient = createRedisClient();
    mockGetActiveTasksForPR.mock.mockImplementation(async () => {
      throw new Error('lookup failed');
    });

    await assert.rejects(async () => {
      await cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
      redisClient,
      markPullRequestMerged: mockMarkPullRequestMerged,
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      log: mockLogger,
      });
    }, /lookup failed/);

    assert.strictEqual(mockStopTaskExecution.mock.calls.length, 0);
  });

  test('handleWebhookRequest waits for merge-task cancellation before responding', async () => {
    const redisClient = createRedisClient();
    const payload = createMergedPrPayload();
    const req = createWebhookRequest(payload, 'test-secret');
    const res = createWebhookResponse();
    const processor = mock.fn(async () => {});
    const reserveDelivery = mock.fn(async () => 'OK');
    let releaseStopTask: (() => void) | null = null;
    let stopTaskResolved = false;

    mockGetActiveTasksForPR.mock.mockImplementation(async () => ([
      { taskId: 'task-running', state: 'processing' },
    ]));
    mockStopTaskExecution.mock.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseStopTask = () => {
          stopTaskResolved = true;
          resolve();
        };
      });
      return {
        success: true,
        message: 'cancelled',
        taskId: 'task-running',
        containerStopped: false,
        jobRemoved: false,
        currentState: 'processing',
        queueState: null,
        cancellation: { code: 'pull_request_merged', message: 'Task cancelled because pull request #1463 was merged.' },
      };
    });

    let requestResolved = false;
    const requestPromise = handleWebhookRequest(req as never, res as never, {
      webhookSecret: 'test-secret',
      redis: {
        set: reserveDelivery,
      },
      processor,
      correlationId: 'test-correlation-id',
      mergeTaskCancellation: {
        redisClient,
        markPullRequestMerged: mockMarkPullRequestMerged,
        getActiveTasksForPR: mockGetActiveTasksForPR,
        stopTaskExecution: mockStopTaskExecution,
        log: mockLogger,
      },
    }).then(() => {
      requestResolved = true;
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(requestResolved, false);
    assert.strictEqual(res.body, '');
    assert.strictEqual(processor.mock.calls.length, 0);
    assert.strictEqual(mockStopTaskExecution.mock.calls.length, 1);
    assert.strictEqual(stopTaskResolved, false);
    assert.strictEqual(reserveDelivery.mock.calls.length, 1);

    releaseStopTask?.();
    await requestPromise;
    assert.strictEqual(stopTaskResolved, true);
    assert.strictEqual(reserveDelivery.mock.calls.length, 1);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, 'Webhook processed.');
    assert.strictEqual(processor.mock.calls.length, 1);
  });

  test('handleWebhookRequest continues processing when merge-task cancellation fails', async () => {
    const redisClient = createRedisClient();
    const payload = createMergedPrPayload();
    const req = createWebhookRequest(payload, 'test-secret');
    const res = createWebhookResponse();
    const processor = mock.fn(async () => {});
    const reserveDelivery = mock.fn(async () => 'OK');

    mockGetActiveTasksForPR.mock.mockImplementation(async () => ([
      { taskId: 'task-running', state: 'processing' },
    ]));
    mockStopTaskExecution.mock.mockImplementation(async () => {
      throw new Error('simulated cancellation failure');
    });

    await assert.doesNotReject(async () => {
      await handleWebhookRequest(req as never, res as never, {
      webhookSecret: 'test-secret',
      redis: {
        set: reserveDelivery,
      },
      processor,
      correlationId: 'test-correlation-id',
        mergeTaskCancellation: {
        redisClient,
        markPullRequestMerged: mockMarkPullRequestMerged,
        getActiveTasksForPR: mockGetActiveTasksForPR,
        stopTaskExecution: mockStopTaskExecution,
        log: mockLogger,
        },
      });
    });

    assert.strictEqual(mockStopTaskExecution.mock.calls.length, 1);
    assert.strictEqual(processor.mock.calls.length, 1);
    assert.strictEqual(reserveDelivery.mock.calls.length, 1);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, 'Webhook processed.');
    assert.strictEqual(mockLogger.warn.mock.calls.length > 0, true);
  });
});

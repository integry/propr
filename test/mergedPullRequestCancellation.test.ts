import { after, test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';

process.env.GH_APP_ID ??= '1';
process.env.GH_PRIVATE_KEY_PATH ??= '.propr/test-private-key.pem';
process.env.GH_INSTALLATION_ID ??= '1';
process.env.NODE_ENV ??= 'test';

const { cancelMergedPullRequestTasks, handleWebhookRequest } = await import('../packages/api/webhookHandler.js');
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
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      log: mockLogger,
    });

    assert.strictEqual(mockGetActiveTasksForPR.mock.calls.length, 1);
    assert.deepStrictEqual(mockGetActiveTasksForPR.mock.calls[0].arguments, ['integry/propr', 1463]);
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
    });
  });

  test('does nothing for unmerged PR closes', async () => {
    const redisClient = createRedisClient();

    await cancelMergedPullRequestTasks(createMergedPrPayload({
      pull_request: { number: 1463, merged: false },
    }), 'test-correlation-id', {
      redisClient,
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      log: mockLogger,
    });

    assert.strictEqual(mockGetActiveTasksForPR.mock.calls.length, 0);
    assert.strictEqual(mockStopTaskExecution.mock.calls.length, 0);
  });

  test('does nothing when there are no active PR tasks', async () => {
    const redisClient = createRedisClient();

    await cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
      redisClient,
      getActiveTasksForPR: mockGetActiveTasksForPR,
      stopTaskExecution: mockStopTaskExecution,
      log: mockLogger,
    });

    assert.strictEqual(mockGetActiveTasksForPR.mock.calls.length, 1);
    assert.strictEqual(mockStopTaskExecution.mock.calls.length, 0);
  });

  test('continues cancelling remaining tasks if one cancellation fails', async () => {
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

    await assert.doesNotReject(async () => {
      await cancelMergedPullRequestTasks(createMergedPrPayload(), 'test-correlation-id', {
        redisClient,
        getActiveTasksForPR: mockGetActiveTasksForPR,
        stopTaskExecution: mockStopTaskExecution,
        log: mockLogger,
      });
    });

    assert.strictEqual(mockStopTaskExecution.mock.calls.length, 2);
    assert.strictEqual(mockStopTaskExecution.mock.calls[0].arguments[0], 'task-fails');
    assert.strictEqual(mockStopTaskExecution.mock.calls[1].arguments[0], 'task-succeeds');
    assert.strictEqual(mockLogger.warn.mock.calls.length, 1);
  });

  test('handleWebhookRequest does not block the response on merge-task cancellation', async () => {
    const redisClient = createRedisClient();
    const payload = createMergedPrPayload();
    const req = createWebhookRequest(payload, 'test-secret');
    const res = createWebhookResponse();
    const processor = mock.fn(async () => {});
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

    await handleWebhookRequest(req as never, res as never, {
      webhookSecret: 'test-secret',
      redis: {
        set: mock.fn(async () => 'OK'),
      },
      processor,
      correlationId: 'test-correlation-id',
      mergeTaskCancellation: {
        redisClient,
        getActiveTasksForPR: mockGetActiveTasksForPR,
        stopTaskExecution: mockStopTaskExecution,
        log: mockLogger,
      },
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body, 'Webhook processed.');
    assert.strictEqual(processor.mock.calls.length, 1);
    assert.strictEqual(mockStopTaskExecution.mock.calls.length, 1);
    assert.strictEqual(stopTaskResolved, false);

    releaseStopTask?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.strictEqual(stopTaskResolved, true);
  });
});

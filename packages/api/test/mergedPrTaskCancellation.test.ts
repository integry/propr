import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, test } from 'node:test';
import type { Request, Response } from 'express';
import { db } from '@propr/core';
import {
  cancelActiveTasksForMergedPR,
  handleWebhookRequest,
  isMergedPullRequestClose,
  PR_MERGED_CANCELLATION_REASON,
  type MergedPRStopContext,
  type MergedPRTaskCancellerDeps,
} from '../webhookHandler.js';
import { stopTaskExecution, type StopTaskQueue, type StopTaskRedisClient } from '../routes/dockerRoutes.js';

const REPOSITORY = 'acme/widgets';
const PR_NUMBER = 42;

// The @propr/core barrel eagerly opens the shared db connection on import;
// close it so the test process can exit.
after(async () => {
  await db.destroy();
});

function makeCancellerDeps(overrides: Partial<MergedPRTaskCancellerDeps> = {}): {
  deps: MergedPRTaskCancellerDeps;
  stopCalls: Array<{ id: string; context: MergedPRStopContext }>;
} {
  const stopCalls: Array<{ id: string; context: MergedPRStopContext }> = [];
  const deps: MergedPRTaskCancellerDeps = {
    getActiveTasksForPR: async () => ({
      activeTasks: [
        { taskId: 'task-a', state: 'claude_execution' },
        { taskId: 'task-b', state: 'processing' },
      ],
      queuedJobs: [{ jobId: 'issue-acme-widgets-42-99', state: 'waiting' }],
    }),
    stopTask: async (id, context) => {
      stopCalls.push({ id, context });
      return { success: true };
    },
    ...overrides,
  };
  return { deps, stopCalls };
}

test('isMergedPullRequestClose only matches merged PR close events', () => {
  const merged = { action: 'closed', pull_request: { merged: true } };
  const unmerged = { action: 'closed', pull_request: { merged: false } };
  const reopened = { action: 'reopened', pull_request: { merged: true } };

  assert.equal(isMergedPullRequestClose('pull_request', merged), true);
  assert.equal(isMergedPullRequestClose('pull_request', unmerged), false);
  assert.equal(isMergedPullRequestClose('pull_request', reopened), false);
  assert.equal(isMergedPullRequestClose('issues', merged), false);
  assert.equal(isMergedPullRequestClose('pull_request', { action: 'closed' }), false);
});

test('cancelActiveTasksForMergedPR stops every active task and queued job with the merge reason', async () => {
  const { deps, stopCalls } = makeCancellerDeps();

  const summary = await cancelActiveTasksForMergedPR(REPOSITORY, PR_NUMBER, deps);

  assert.deepEqual(summary, { attempted: 3, cancelled: 3, failed: 0 });
  assert.deepEqual(stopCalls.map(c => c.id).sort(), ['issue-acme-widgets-42-99', 'task-a', 'task-b']);
  for (const call of stopCalls) {
    assert.equal(call.context.cancellationReason, PR_MERGED_CANCELLATION_REASON);
    assert.equal(call.context.requestedBy, 'system');
    assert.equal(call.context.ensureCancelled, true, 'merge-triggered stops must record the cancellation');
    assert.match(call.context.reason, /acme\/widgets#42 was merged/);
  }
});

test('cancelActiveTasksForMergedPR does nothing when there is no active work', async () => {
  const { deps, stopCalls } = makeCancellerDeps({
    getActiveTasksForPR: async () => ({ activeTasks: [], queuedJobs: [] }),
  });

  const summary = await cancelActiveTasksForMergedPR(REPOSITORY, PR_NUMBER, deps);

  assert.deepEqual(summary, { attempted: 0, cancelled: 0, failed: 0 });
  assert.equal(stopCalls.length, 0);
});

test('cancelActiveTasksForMergedPR continues cancelling after a task fails to stop', async () => {
  const stopCalls: string[] = [];
  const { deps } = makeCancellerDeps({
    stopTask: async (id) => {
      stopCalls.push(id);
      if (id === 'task-a') throw new Error('container stop blew up');
      return { success: true };
    },
  });

  const summary = await cancelActiveTasksForMergedPR(REPOSITORY, PR_NUMBER, deps);

  assert.equal(stopCalls.length, 3, 'all tasks should be attempted despite the failure');
  assert.deepEqual(summary, { attempted: 3, cancelled: 2, failed: 1 });
});

// --- handleWebhookRequest integration (no live Redis/GitHub) ---

const WEBHOOK_SECRET = 'test-secret';

function makeWebhookRequest(event: string, payload: Record<string, unknown>): Request {
  const body = Buffer.from(JSON.stringify(payload));
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  hmac.update(body);
  return {
    body,
    headers: {
      'x-hub-signature-256': `sha256=${hmac.digest('hex')}`,
      'x-github-delivery': `delivery-${Math.random().toString(36).slice(2)}`,
      'x-github-event': event,
    },
  } as unknown as Request;
}

function makeWebhookResponse(): { res: Response; result: { statusCode?: number; sent?: unknown } } {
  const result: { statusCode?: number; sent?: unknown } = {};
  const res = {
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      result.sent = payload;
      return this;
    },
  } as unknown as Response;
  return { res, result };
}

function makeHandlerDeps(canceller: MergedPRTaskCancellerDeps) {
  const processed: string[] = [];
  return {
    processed,
    deps: {
      webhookSecret: WEBHOOK_SECRET,
      redis: { set: async () => 'OK' },
      processor: async (_payload: Record<string, unknown>, event: string) => {
        processed.push(event);
      },
      correlationId: 'test-correlation',
      mergedPRTaskCanceller: canceller,
    },
  };
}

function prClosedPayload(merged: boolean): Record<string, unknown> {
  return {
    action: 'closed',
    repository: { full_name: REPOSITORY },
    pull_request: { number: PR_NUMBER, merged },
  };
}

test('handleWebhookRequest cancels active tasks when a PR is merged', async () => {
  const { deps: canceller, stopCalls } = makeCancellerDeps();
  const { deps, processed } = makeHandlerDeps(canceller);
  const { res, result } = makeWebhookResponse();

  await handleWebhookRequest(makeWebhookRequest('pull_request', prClosedPayload(true)), res, deps);

  assert.equal(result.statusCode, 200);
  assert.equal(stopCalls.length, 3);
  assert.deepEqual(processed, ['pull_request'], 'standard processing still runs');
});

test('handleWebhookRequest does not cancel anything for an unmerged PR close', async () => {
  const { deps: canceller, stopCalls } = makeCancellerDeps();
  const { deps } = makeHandlerDeps(canceller);
  const { res, result } = makeWebhookResponse();

  await handleWebhookRequest(makeWebhookRequest('pull_request', prClosedPayload(false)), res, deps);

  assert.equal(result.statusCode, 200);
  assert.equal(stopCalls.length, 0);
});

test('handleWebhookRequest still succeeds when the PR task lookup fails entirely', async () => {
  const { deps: canceller } = makeCancellerDeps({
    getActiveTasksForPR: async () => { throw new Error('database unavailable'); },
  });
  const { deps, processed } = makeHandlerDeps(canceller);
  const { res, result } = makeWebhookResponse();

  await handleWebhookRequest(makeWebhookRequest('pull_request', prClosedPayload(true)), res, deps);

  assert.equal(result.statusCode, 200, 'webhook delivery must not fail');
  assert.deepEqual(processed, ['pull_request']);
});

// --- stopTaskExecution (shared stop helper) ---

interface FakeRedisCall { method: string; key: string; value?: string }

function makeFakeRedis(initial: Record<string, string> = {}): StopTaskRedisClient & { store: Map<string, string>; calls: FakeRedisCall[] } {
  const store = new Map(Object.entries(initial));
  const calls: FakeRedisCall[] = [];
  return {
    store,
    calls,
    async get(key) {
      calls.push({ method: 'get', key });
      return store.get(key) ?? null;
    },
    async set(key, value) {
      calls.push({ method: 'set', key, value });
      store.set(key, value);
      return 'OK';
    },
    async rPush(key, value) {
      calls.push({ method: 'rPush', key, value });
      return 1;
    },
    async del(key) {
      calls.push({ method: 'del', key });
      store.delete(key);
      return 1;
    },
  };
}

function makeFakeQueue(
  pendingJobs: Array<{ id: string; data?: Record<string, unknown> }>,
  activeJobs: Array<{ id: string }> = [],
): StopTaskQueue & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    async getJobs(states) {
      const jobs = states.includes('active') ? activeJobs : pendingJobs;
      return jobs.map(job => ({
        id: job.id,
        data: 'data' in job ? job.data : undefined,
        remove: async () => { removed.push(job.id); },
      }));
    },
  };
}

function runningTaskState(containerId?: string): string {
  return JSON.stringify({
    history: [
      { state: 'pending' },
      { state: 'claude_execution', metadata: containerId ? { containerId } : {} },
    ],
  });
}

test('stopTaskExecution stops the container and marks the task cancelled with the merge reason', async () => {
  const redis = makeFakeRedis({ 'worker:state:task-a': runningTaskState('container-1') });
  const queue = makeFakeQueue([]);
  const stoppedContainers: string[] = [];
  const cancelCalls: Array<{ taskId: string; cancelledBy: string; metadata: { reason?: string; historyMetadata?: Record<string, unknown> } }> = [];

  const result = await stopTaskExecution('task-a', {
    redisClient: redis,
    requestedBy: 'system',
    reason: 'Pull request acme/widgets#42 was merged. Task cancelled automatically.',
    cancellationReason: 'pr_merged',
    getQueue: async () => queue,
    stopContainer: async (containerId) => { stoppedContainers.push(containerId); return { success: true }; },
    markCancelled: async (taskId, cancelledBy, metadata) => { cancelCalls.push({ taskId, cancelledBy, metadata }); },
  });

  assert.equal(result.success, true);
  assert.equal(result.containerStopped, true);
  assert.deepEqual(stoppedContainers, ['container-1']);
  assert.equal(cancelCalls.length, 1);
  assert.equal(cancelCalls[0].taskId, 'task-a');
  assert.equal(cancelCalls[0].cancelledBy, 'system');
  assert.match(cancelCalls[0].metadata.reason ?? '', /was merged/);
  assert.equal(cancelCalls[0].metadata.historyMetadata?.cancellationReason, 'pr_merged');
  assert.ok(redis.calls.some(c => c.method === 'set' && c.key === 'worker:abort:task-a'), 'abort signal set');
  assert.ok(redis.calls.some(c => c.method === 'del' && c.key === 'worker:abort:task-a'), 'abort signal cleared after container stop');
});

test('stopTaskExecution removes queued jobs that never started and records the cancellation', async () => {
  const redis = makeFakeRedis(); // no worker state — job never started
  const queue = makeFakeQueue([
    { id: 'issue-acme-widgets-42-99', data: { repository: REPOSITORY, prNumber: PR_NUMBER } },
    { id: 'issue-other-repo-7-12' },
  ]);
  const createdStates: Array<{ taskId: string; issueRef: Record<string, unknown> }> = [];
  const cancelCalls: string[] = [];

  const result = await stopTaskExecution('issue-acme-widgets-42-99', {
    redisClient: redis,
    requestedBy: 'system',
    cancellationReason: 'pr_merged',
    getQueue: async () => queue,
    createTaskState: async (taskId, issueRef) => { createdStates.push({ taskId, issueRef }); },
    markCancelled: async (taskId) => { cancelCalls.push(taskId); },
  });

  assert.equal(result.success, true);
  assert.equal(result.containerStopped, false);
  assert.equal(result.removedQueuedJobs, 1);
  assert.equal(result.cancellationRecorded, true);
  assert.deepEqual(queue.removed, ['issue-acme-widgets-42-99'], 'only the matching job is removed');
  assert.deepEqual(createdStates, [
    { taskId: 'acme-widgets-42', issueRef: { number: PR_NUMBER, repoOwner: 'acme', repoName: 'widgets' } },
  ], 'a task state is created so the cancellation reason can be recorded');
  assert.deepEqual(cancelCalls, ['acme-widgets-42'], 'the removed queued job is marked cancelled');
});

test('stopTaskExecution sets the abort signal for an active queue job without worker state', async () => {
  const redis = makeFakeRedis(); // worker picked the job up but has not written worker:state yet
  const queue = makeFakeQueue([], [{ id: 'pr-comments-batch-acme-widgets-42-123' }]);
  const cancelCalls: string[] = [];

  const result = await stopTaskExecution('pr-comments-batch-acme-widgets-42-123', {
    redisClient: redis,
    requestedBy: 'system',
    cancellationReason: 'pr_merged',
    getQueue: async () => queue,
    markCancelled: async (taskId) => { cancelCalls.push(taskId); },
  });

  assert.equal(result.success, true);
  assert.equal(result.containerStopped, false);
  assert.equal(result.abortSignalled, true);
  assert.equal(result.cancellationRecorded, false);
  assert.ok(
    redis.calls.some(c => c.method === 'set' && c.key === 'worker:abort:pr-comments-batch-acme-widgets-42-123'),
    'abort signal set for the worker to observe',
  );
  assert.equal(cancelCalls.length, 0, 'the worker records the cancellation when it aborts');
});

test('stopTaskExecution with ensureCancelled records the cancellation when the container stop fails', async () => {
  const redis = makeFakeRedis({ 'worker:state:task-a': runningTaskState('container-1') });
  const queue = makeFakeQueue([]);
  const cancelCalls: Array<{ taskId: string; metadata: { reason?: string; historyMetadata?: Record<string, unknown> } }> = [];

  const result = await stopTaskExecution('task-a', {
    redisClient: redis,
    requestedBy: 'system',
    reason: 'Pull request acme/widgets#42 was merged. Task cancelled automatically.',
    cancellationReason: 'pr_merged',
    ensureCancelled: true,
    getQueue: async () => queue,
    stopContainer: async () => ({ success: false, error: 'docker daemon unreachable' }),
    markCancelled: async (taskId, _cancelledBy, metadata) => { cancelCalls.push({ taskId, metadata }); },
  });

  assert.equal(result.success, true);
  assert.equal(result.containerStopped, false);
  assert.equal(result.abortSignalled, true);
  assert.equal(result.cancellationRecorded, true);
  assert.equal(cancelCalls.length, 1);
  assert.equal(cancelCalls[0].metadata.historyMetadata?.abortSignalled, true);
  assert.equal(cancelCalls[0].metadata.historyMetadata?.cancellationReason, 'pr_merged');
  assert.ok(
    !redis.calls.some(c => c.method === 'del' && c.key === 'worker:abort:task-a'),
    'abort signal left in place for the worker',
  );
});

test('stopTaskExecution without ensureCancelled leaves recording to the worker when the container stop fails', async () => {
  const redis = makeFakeRedis({ 'worker:state:task-a': runningTaskState('container-1') });
  const queue = makeFakeQueue([]);
  const cancelCalls: string[] = [];

  const result = await stopTaskExecution('task-a', {
    redisClient: redis,
    getQueue: async () => queue,
    stopContainer: async () => ({ success: false, error: 'docker daemon unreachable' }),
    markCancelled: async (taskId) => { cancelCalls.push(taskId); },
  });

  assert.equal(result.success, true);
  assert.equal(result.containerStopped, false);
  assert.equal(result.cancellationRecorded, false);
  assert.equal(cancelCalls.length, 0, 'manual stop keeps relying on the worker abort path');
});

test('stopTaskExecution reports notFound for unknown tasks without queued jobs', async () => {
  const redis = makeFakeRedis();
  const queue = makeFakeQueue([]);

  const result = await stopTaskExecution('task-missing', {
    redisClient: redis,
    getQueue: async () => queue,
    markCancelled: async () => {},
  });

  assert.equal(result.success, false);
  assert.equal(result.notFound, true);
});

test('stopTaskExecution reports notRunning for already-finished tasks', async () => {
  const redis = makeFakeRedis({
    'worker:state:task-done': JSON.stringify({ history: [{ state: 'completed' }] }),
  });
  const queue = makeFakeQueue([]);

  const result = await stopTaskExecution('task-done', {
    redisClient: redis,
    getQueue: async () => queue,
    markCancelled: async () => {},
  });

  assert.equal(result.success, false);
  assert.equal(result.notRunning, true);
  assert.equal(result.currentState, 'completed');
});

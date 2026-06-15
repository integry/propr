import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { db } from '@propr/core';
import { stopTaskExecution, type StopTaskQueue, type StopTaskRedisClient } from '../routes/dockerRoutes.js';

const REPOSITORY = 'acme/widgets';
const PR_NUMBER = 42;

// The @propr/core barrel eagerly opens the shared db connection on import;
// close it so the test process can exit.
after(async () => {
  await db.destroy();
});

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
  activeJobs: Array<{ id: string; data?: Record<string, unknown> }> = [],
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

test('stopTaskExecution reports an unrecorded cancellation when the queued job payload is unsupported', async () => {
  const redis = makeFakeRedis(); // no worker state — job never started
  // Repository is present but no issue/PR number field — no issue ref can be
  // derived, so no task state can be created to attach the cancellation to.
  const queue = makeFakeQueue([{ id: 'issue-acme-widgets-42-99', data: { repository: REPOSITORY } }]);
  const createdStates: string[] = [];
  const cancelCalls: string[] = [];

  const result = await stopTaskExecution('issue-acme-widgets-42-99', {
    redisClient: redis,
    requestedBy: 'system',
    cancellationReason: 'pr_merged',
    getQueue: async () => queue,
    createTaskState: async (taskId) => { createdStates.push(taskId); },
    markCancelled: async (taskId) => { cancelCalls.push(taskId); },
  });

  assert.equal(result.success, true, 'the queued job was still removed');
  assert.equal(result.removedQueuedJobs, 1);
  assert.equal(result.cancellationRecorded, false, 'no state record exists to attach the cancellation to');
  assert.match(result.message, /could not be recorded/);
  assert.equal(createdStates.length, 0, 'no state is created under a fabricated issue number');
  assert.equal(cancelCalls.length, 0, 'markCancelled is skipped when there is no state to mark');
});

test('stopTaskExecution reports an unrecorded cancellation when task state creation fails', async () => {
  const redis = makeFakeRedis(); // no worker state — job never started
  const queue = makeFakeQueue([{ id: 'issue-acme-widgets-42-99', data: { repository: REPOSITORY, prNumber: PR_NUMBER } }]);
  const cancelCalls: string[] = [];

  const result = await stopTaskExecution('issue-acme-widgets-42-99', {
    redisClient: redis,
    requestedBy: 'system',
    cancellationReason: 'pr_merged',
    getQueue: async () => queue,
    createTaskState: async () => { throw new Error('redis write failed'); },
    markCancelled: async (taskId) => { cancelCalls.push(taskId); },
  });

  assert.equal(result.success, true, 'the queued job was still removed');
  assert.equal(result.cancellationRecorded, false);
  assert.equal(cancelCalls.length, 0, 'markCancelled is skipped when the state could not be created');
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

test('stopTaskExecution with ensureCancelled durably marks an active queue job without worker state as cancelled', async () => {
  const redis = makeFakeRedis(); // worker picked the job up but has not written worker:state yet
  const queue = makeFakeQueue([], [
    { id: 'pr-comments-batch-acme-widgets-42-123', data: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: PR_NUMBER } },
  ]);
  const createdStates: Array<{ taskId: string; issueRef: Record<string, unknown> }> = [];
  const cancelCalls: Array<{ taskId: string; metadata: { reason?: string; historyMetadata?: Record<string, unknown> } }> = [];

  const result = await stopTaskExecution('pr-comments-batch-acme-widgets-42-123', {
    redisClient: redis,
    requestedBy: 'system',
    cancellationReason: 'pr_merged',
    ensureCancelled: true,
    getQueue: async () => queue,
    createTaskState: async (taskId, issueRef) => { createdStates.push({ taskId, issueRef }); },
    markCancelled: async (taskId, _cancelledBy, metadata) => { cancelCalls.push({ taskId, metadata }); },
  });

  assert.equal(result.success, true);
  assert.equal(result.abortSignalled, true);
  assert.equal(result.cancellationRecorded, true, 'merge-triggered stop must durably record the cancellation');
  assert.deepEqual(createdStates, [
    { taskId: 'pr-comments-batch-acme-widgets-42-123', issueRef: { number: PR_NUMBER, repoOwner: 'acme', repoName: 'widgets' } },
  ], 'a task state is created from the active job data so the cancellation can be recorded');
  assert.equal(cancelCalls.length, 1);
  assert.equal(cancelCalls[0].metadata.historyMetadata?.cancellationReason, 'pr_merged');
  assert.equal(cancelCalls[0].metadata.historyMetadata?.abortSignalled, true);
  assert.ok(
    redis.calls.some(c => c.method === 'set' && c.key === 'worker:abort:pr-comments-batch-acme-widgets-42-123'),
    'abort signal still set so the worker terminates',
  );
  assert.ok(
    !redis.calls.some(c => c.method === 'del' && c.key === 'worker:abort:pr-comments-batch-acme-widgets-42-123'),
    'abort signal left in place for the worker',
  );
});

test('stopTaskExecution with ensureCancelled reports an unrecorded cancellation for an active job with unsupported payload', async () => {
  const redis = makeFakeRedis(); // worker picked the job up but has not written worker:state yet
  const queue = makeFakeQueue([], [{ id: 'pr-comments-batch-acme-widgets-42-123', data: { unrelated: true } }]);
  const cancelCalls: string[] = [];

  const result = await stopTaskExecution('pr-comments-batch-acme-widgets-42-123', {
    redisClient: redis,
    requestedBy: 'system',
    cancellationReason: 'pr_merged',
    ensureCancelled: true,
    getQueue: async () => queue,
    createTaskState: async () => {},
    markCancelled: async (taskId) => { cancelCalls.push(taskId); },
  });

  assert.equal(result.success, true);
  assert.equal(result.abortSignalled, true, 'the abort signal still terminates the worker');
  assert.equal(result.cancellationRecorded, false, 'no issue ref could be derived, so nothing was recorded');
  assert.equal(cancelCalls.length, 0, 'markCancelled is skipped when no state record could be created');
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

test('stopTaskExecution tolerates malformed worker state and still removes queued jobs', async () => {
  const redis = makeFakeRedis({ 'worker:state:acme-widgets-42': '{not valid json' });
  const queue = makeFakeQueue([
    { id: 'issue-acme-widgets-42-99', data: { repository: REPOSITORY, prNumber: PR_NUMBER } },
  ]);
  const cancelCalls: string[] = [];

  const result = await stopTaskExecution('issue-acme-widgets-42-99', {
    redisClient: redis,
    requestedBy: 'system',
    cancellationReason: 'pr_merged',
    getQueue: async () => queue,
    createTaskState: async () => {},
    markCancelled: async (taskId) => { cancelCalls.push(taskId); },
  });

  assert.equal(result.success, true, 'a corrupt worker:state entry must not fail the stop');
  assert.equal(result.removedQueuedJobs, 1);
  assert.equal(result.cancellationRecorded, true);
  assert.deepEqual(cancelCalls, ['acme-widgets-42']);
});

test('stopTaskExecution still reports the cancellation as recorded when the conversation append fails', async () => {
  const redis = makeFakeRedis();
  redis.rPush = async () => { throw new Error('redis connection lost'); };
  const queue = makeFakeQueue([
    { id: 'issue-acme-widgets-42-99', data: { repository: REPOSITORY, prNumber: PR_NUMBER } },
  ]);

  const result = await stopTaskExecution('issue-acme-widgets-42-99', {
    redisClient: redis,
    requestedBy: 'system',
    cancellationReason: 'pr_merged',
    getQueue: async () => queue,
    createTaskState: async () => {},
    markCancelled: async () => {},
  });

  assert.equal(result.success, true);
  assert.equal(result.cancellationRecorded, true, 'the state update succeeded; the conversation note is informational');
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

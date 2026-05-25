import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GH_APP_ID ??= '1';
process.env.GH_PRIVATE_KEY_PATH ??= '.propr/test-private-key.pem';
process.env.GH_INSTALLATION_ID ??= '1';
process.env.NODE_ENV ??= 'test';

const { getActiveTasksForPR } = await import('../packages/core/src/webhook/checkRunHelpers.ts');
const { closeConnection } = await import('../packages/core/src/db/connection.ts');
const { stopTaskExecution } = await import('../packages/api/routes/stopTaskExecution.ts');
const { ensureTaskStateForCancellation } = await import('../packages/api/routes/stopTaskExecutionContext.ts');

type QueueState = 'waiting' | 'active' | 'delayed' | 'paused' | 'prioritized' | 'waiting-children';

interface MockJob {
  id: string;
  name?: string;
  data: Record<string, unknown>;
  getState: () => Promise<QueueState>;
  remove?: () => Promise<void>;
}

function createQueueIndexClient(initialMembers: Record<string, string[]>) {
  const sets = new Map<string, Set<string>>(
    Object.entries(initialMembers).map(([key, members]) => [key, new Set(members)]),
  );

  return {
    sets,
    async expire(): Promise<void> {},
    async sAdd(key: string, ...members: string[]): Promise<void> {
      const set = sets.get(key) ?? new Set<string>();
      for (const member of members) {
        set.add(member);
      }
      sets.set(key, set);
    },
    async sRem(key: string, ...members: string[]): Promise<void> {
      const set = sets.get(key);
      if (!set) {
        return;
      }
      for (const member of members) {
        set.delete(member);
      }
    },
    async sMembers(key: string): Promise<string[]> {
      return [...(sets.get(key) ?? new Set<string>())];
    },
  };
}

function createQueueMock(params: {
  trackedJobIds?: string[];
  pendingJobIds?: string[];
  jobs: MockJob[];
}) {
  const { trackedJobIds = [], pendingJobIds = [], jobs } = params;
  const client = createQueueIndexClient({
    'pr-queue-jobs:integry/propr:1464': trackedJobIds,
    'pr-pending-queue-jobs:integry/propr:1464': pendingJobIds,
  });
  const jobsById = new Map(jobs.map((job) => [job.id, job]));

  const queue = {
    client: Promise.resolve(client),
    async getJob(jobId: string) {
      return jobsById.get(jobId) ?? null;
    },
    async getJobs(states: string[]) {
      const matchingJobs: MockJob[] = [];
      for (const job of jobs) {
        if (states.includes(await job.getState())) {
          matchingJobs.push(job);
        }
      }
      return matchingJobs;
    },
  };

  return { client, queue };
}

function createMockJob(id: string, state: QueueState, data: Record<string, unknown>): MockJob {
  return {
    id,
    data,
    async getState() {
      return state;
    },
  };
}

function createTaskQueryDbMock(rows: Array<{ task_id: string; job_id: string | null; state: string }>) {
  const chain = {
    select: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    whereNotNull: () => chain,
    whereIn: async () => rows,
    whereNotIn: async (_column: string, states: readonly string[]) => rows.filter((row) => !states.includes(row.state)),
  };

  return (() => chain) as unknown as typeof import('@propr/core').db;
}

const silentLog = {
  info(): void {},
  warn(): void {},
};

test.after(async () => {
  await closeConnection();
});

test('getActiveTasksForPR force-scans queued jobs without mutating the PR queue index', async () => {
  const indexedJob = createMockJob('indexed-job', 'active', {
    repository: 'integry/propr',
    prNumber: 1464,
  });
  const scannedJob = createMockJob('scanned-job', 'waiting', {
    repository: 'integry/propr',
    prNumber: 1464,
  });
  const { client, queue } = createQueueMock({
    trackedJobIds: ['indexed-job'],
    jobs: [indexedJob, scannedJob],
  });

  const tasks = await getActiveTasksForPR('integry/propr', 1464, {
    getIssueQueue: async () => queue as never,
    db: createTaskQueryDbMock([]),
    log: silentLog,
    forceQueueScan: true,
  });

  assert.deepEqual(
    tasks.map((task) => `${task.taskId}:${task.state}`).sort(),
    ['indexed-job:active', 'scanned-job:waiting'],
  );
  assert.deepEqual(
    [...(client.sets.get('pr-queue-jobs:integry/propr:1464') ?? new Set<string>())].sort(),
    ['indexed-job'],
  );
});

test('getActiveTasksForPR reads pending queue jobs without promoting index state', async () => {
  const pendingJob = createMockJob('pending-job', 'waiting', {
    repository: 'integry/propr',
    prNumber: 1464,
  });
  const { client, queue } = createQueueMock({
    pendingJobIds: ['pending-job'],
    jobs: [pendingJob],
  });

  const tasks = await getActiveTasksForPR('integry/propr', 1464, {
    getIssueQueue: async () => queue as never,
    db: createTaskQueryDbMock([]),
    log: silentLog,
  });

  assert.deepEqual(tasks, [{ taskId: 'pending-job', state: 'waiting' }]);
  assert.deepEqual(
    [...(client.sets.get('pr-queue-jobs:integry/propr:1464') ?? new Set<string>())],
    [],
  );
  assert.deepEqual(
    [...(client.sets.get('pr-pending-queue-jobs:integry/propr:1464') ?? new Set<string>())],
    ['pending-job'],
  );
});

test('stopTaskExecution does not persist merged-PR cancellation metadata for abort-only active jobs', async () => {
  const setCalls: Array<{ key: string; value: Record<string, unknown> }> = [];
  const delCalls: string[] = [];
  const conversationMessages: Array<{ key: string; message: Record<string, unknown> }> = [];
  const markTaskCancelledCalls: Array<{
    taskId: string;
    requestedBy: string;
    metadata: Record<string, unknown>;
  }> = [];

  const redisClient = {
    async get(): Promise<null> {
      return null;
    },
    async set(key: string, value: string): Promise<string> {
      setCalls.push({ key, value: JSON.parse(value) as Record<string, unknown> });
      return 'OK';
    },
    async del(key: string): Promise<number> {
      delCalls.push(key);
      return 1;
    },
    async rPush(key: string, value: string): Promise<number> {
      conversationMessages.push({ key, message: JSON.parse(value) as Record<string, unknown> });
      return conversationMessages.length;
    },
  };

  const result = await stopTaskExecution('task-1464', {
    redisClient,
    requestedBy: 'system',
    cancellation: {
      code: 'pull_request_merged',
      message: 'Task cancelled because pull request #1464 was merged.',
    },
  }, {
    async loadStopTaskContext() {
      return {
        normalizedTaskId: 'task-1464',
        state: {
          history: [{ state: 'processing' }],
        },
        currentState: 'processing',
        queueJob: { id: 'job-1464' } as never,
        queueState: 'active',
        taskId: 'task-1464',
        abortTaskIds: ['task-1464', 'job-1464'],
      };
    },
    async ensureTaskStateForCancellation() {},
    getStateManager: () => ({
      async markTaskCancelled(taskId: string, requestedBy: string, metadata: Record<string, unknown>) {
        markTaskCancelledCalls.push({ taskId, requestedBy, metadata });
        return {} as never;
      },
    }) as never,
  });

  assert.equal(result.success, true);
  assert.equal(result.containerStopped, false);
  assert.equal(result.jobRemoved, false);
  assert.equal(result.message, 'Stop request sent to worker. The execution will be terminated shortly.');
  assert.deepEqual(delCalls, []);
  assert.deepEqual(
    setCalls.map((call) => call.key).sort(),
    ['worker:abort:job-1464', 'worker:abort:task-1464'],
  );
  assert.equal(markTaskCancelledCalls.length, 0);
  assert.deepEqual(
    conversationMessages.map((entry) => entry.message.content),
    [
      'Cancellation requested. Worker shutdown is still in progress.',
    ],
  );
});

test('ensureTaskStateForCancellation fails loudly when a queued job cannot be reconstructed into a task', async () => {
  let createTaskStateCalled = false;
  let dbUpdated = false;

  await assert.rejects(
    ensureTaskStateForCancellation('queued-job', null, {
      id: 'queued-job',
      data: {},
    } as never, {
      getStateManager: () => ({
        async createTaskState() {
          createTaskStateCalled = true;
        },
      }) as never,
      db: (() => {
        dbUpdated = true;
        throw new Error('db should not be called');
      }) as never,
    }),
    /Cannot reconstruct IssueRef for queued task cancellation: queued-job/,
  );

  assert.equal(createTaskStateCalled, false);
  assert.equal(dbUpdated, false);
});

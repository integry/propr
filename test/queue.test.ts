import { test, mock, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const lifecycleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-lifecycle-'));
const previousClones = process.env.GIT_CLONES_BASE_PATH;
process.env.GIT_CLONES_BASE_PATH = path.join(lifecycleRoot, 'clones');
after(async () => {
    if (previousClones === undefined) delete process.env.GIT_CLONES_BASE_PATH;
    else process.env.GIT_CLONES_BASE_PATH = previousClones;
    await fs.rm(lifecycleRoot, { recursive: true, force: true });
});

const mockRedis = {
    on: mock.fn(),
    connect: mock.fn(async () => {}),
    quit: mock.fn(async () => {}),
};

await mock.module('ioredis', {
    namedExports: {
        Redis: function Redis() {
            return mockRedis;
        }
    }
});

const mockQueue = {
    add: mock.fn(async () => ({ id: 'test-job-id' })),
    close: mock.fn(async () => {}),
    on: mock.fn(),
};

interface MockWorker {
    on: ReturnType<typeof mock.fn>;
    close: ReturnType<typeof mock.fn>;
    opts: { concurrency: number };
    processor?: unknown;
    name?: string;
}

const mockWorker: MockWorker = {
    on: mock.fn(),
    close: mock.fn(async () => {}),
    opts: { concurrency: 5 },
};

await mock.module('bullmq', {
    namedExports: {
        Queue: function Queue() {
            return mockQueue;
        },
        Worker: function Worker(name: string, processor: unknown, opts?: { concurrency?: number }) {
            mockWorker.processor = processor;
            mockWorker.name = name;
            mockWorker.opts = { ...mockWorker.opts, ...opts };
            return mockWorker;
        }
    }
});

const planRefinementSyncs: unknown[] = [];
await mock.module('../packages/core/src/services/taskPlanning/planRefinementSettlement.js', {
    namedExports: { syncPlanRefinementForJob: async (data: unknown) => { planRefinementSyncs.push(data); } },
});

const { issueQueue, getIssueQueue, createWorker, shutdownQueue } = await import('../packages/core/src/queue/taskQueue.ts');

await getIssueQueue();

test('issueQueue is created successfully', () => {
    assert.ok(issueQueue);
    assert.strictEqual(typeof issueQueue.add, 'function');
    assert.strictEqual(typeof issueQueue.close, 'function');
});

test('Redis connection events are registered', () => {
    assert.strictEqual(mockRedis.on.mock.calls.length, 2);
    assert.strictEqual(mockRedis.on.mock.calls[0].arguments[0], 'connect');
    assert.strictEqual(mockRedis.on.mock.calls[1].arguments[0], 'error');
});

test('createWorker creates a worker with correct configuration', async () => {
    const { repositoryStorageLifecycle } = await import('../packages/core/src/storage/lifecycle.ts');
    const processorFn = async (): Promise<{ status: string }> => {
        assert.equal(await repositoryStorageLifecycle.busy(), true, 'worker holds a storage claim');
        return { status: 'completed' };
    };
    const worker = await createWorker('test-queue', processorFn as Parameters<typeof createWorker>[1]);

    assert.ok(worker);
    assert.strictEqual(mockWorker.name, 'test-queue');
    assert.deepEqual(await (mockWorker.processor as typeof processorFn)(), { status: 'completed' });
    assert.equal(await repositoryStorageLifecycle.busy(), false, 'worker releases its claim');
    assert.strictEqual(mockWorker.opts.concurrency, 5);

    const eventNames = mockWorker.on.mock.calls.map((call: { arguments: unknown[] }) => call.arguments[0]);
    assert.ok(eventNames.includes('completed'));
    assert.ok(eventNames.includes('failed'));
    assert.ok(eventNames.includes('error'));
    assert.ok(eventNames.includes('stalled'));
});

test('a failed attempt and a resumed retry resynchronize plan refinement for the job', async () => {
    mockWorker.on.mock.resetCalls();
    await createWorker('test-queue', (async () => ({ status: 'completed' })) as Parameters<typeof createWorker>[1]);
    const handler = (event: string) => (mockWorker.on.mock.calls as Array<{ arguments: unknown[] }>)
        .find(call => call.arguments[0] === event)!.arguments[1] as (...args: unknown[]) => unknown;
    const data = { repoOwner: 'o', repoName: 'r', pullRequestNumber: 7 };
    // The handlers load the settlement lazily and do not block BullMQ on it.
    const settle = async (count = planRefinementSyncs.length) => {
        for (let waited = 0; planRefinementSyncs.length < count && waited < 2_000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    };

    planRefinementSyncs.length = 0;
    handler('active')({ id: 'j', data, attemptsMade: 0, attemptsStarted: 1 });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(planRefinementSyncs, [], 'a first attempt was already admitted by its webhook');

    await handler('failed')({ id: 'j', data, attemptsMade: 1, attemptsStarted: 1 }, new Error('boom'));
    await settle(1);
    assert.deepEqual(planRefinementSyncs, [data], 'the failure moved the job to its delayed retry');

    handler('active')({ id: 'j', data, attemptsMade: 1, attemptsStarted: 2 });
    await settle(2);
    assert.deepEqual(planRefinementSyncs, [data, data], 'the retry resumed processing');

    handler('completed')({ id: 'j', name: 'processPullRequestComment', data, attemptsMade: 1, attemptsStarted: 2, timestamp: Date.now() }, { status: 'complete' });
    await settle(3);
    assert.deepEqual(planRefinementSyncs, [data, data, data], 'the retry completed and left active work');
});

test('shutdownQueue closes issue and indexing queues and Redis connection', async () => {
    mockQueue.close.mock.resetCalls();
    mockRedis.quit.mock.resetCalls();
    
    await shutdownQueue();
    
    assert.strictEqual(mockQueue.close.mock.calls.length, 2);
    assert.strictEqual(mockRedis.quit.mock.calls.length, 1);
});

test('queue can add jobs', async () => {
    mockQueue.add.mock.resetCalls();
    const queue = await getIssueQueue();
    
    const jobData = { 
        repoOwner: 'test',
        repoName: 'repo',
        number: 123
    };
    const result = await queue.add('testJob', jobData);
    
    assert.strictEqual(mockQueue.add.mock.calls.length, 1);
    const calls = mockQueue.add.mock.calls as Array<{ arguments: unknown[] }>;
    assert.strictEqual(calls[0].arguments[0], 'testJob');
    assert.deepStrictEqual(calls[0].arguments[1], jobData);
    assert.deepStrictEqual(result, { id: 'test-job-id' });
});

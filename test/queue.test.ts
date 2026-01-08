import { test, mock, after } from 'node:test';
import assert from 'node:assert';

// Set test environment before imports
process.env.NODE_ENV = 'test';

// Mock Redis and BullMQ before importing the module
const mockRedis = {
    on: mock.fn(),
    quit: mock.fn(async () => {}),
};

await mock.module('ioredis', {
    namedExports: {
        default: function Redis() {
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

// Now import the module with mocked dependencies
const { issueQueue, createWorker, shutdownQueue } = await import('../packages/core/src/queue/taskQueue.js');

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

test('createWorker creates a worker with correct configuration', () => {
    const processorFn = async (): Promise<{ status: string }> => ({ status: 'completed' });
    const worker = createWorker('test-queue', processorFn as Parameters<typeof createWorker>[1]);

    assert.ok(worker);
    assert.strictEqual(mockWorker.name, 'test-queue');
    assert.strictEqual(mockWorker.processor, processorFn);
    assert.strictEqual(mockWorker.opts.concurrency, 5);

    const eventNames = mockWorker.on.mock.calls.map((call: { arguments: unknown[] }) => call.arguments[0]);
    assert.ok(eventNames.includes('completed'));
    assert.ok(eventNames.includes('failed'));
    assert.ok(eventNames.includes('error'));
    assert.ok(eventNames.includes('stalled'));
});

test('shutdownQueue closes queue and Redis connection', async () => {
    mockQueue.close.mock.resetCalls();
    mockRedis.quit.mock.resetCalls();

    await shutdownQueue();

    assert.strictEqual(mockQueue.close.mock.calls.length, 3); // issueQueue, analysisQueue, indexingQueue
    assert.strictEqual(mockRedis.quit.mock.calls.length, 1);
});

test('queue can add jobs', async () => {
    mockQueue.add.mock.resetCalls();

    const jobData = {
        repoOwner: 'test',
        repoName: 'repo',
        number: 123
    };
    const result = await issueQueue.add('testJob', jobData);

    assert.strictEqual(mockQueue.add.mock.calls.length, 1);
    const calls = mockQueue.add.mock.calls as Array<{ arguments: unknown[] }>;
    assert.strictEqual(calls[0].arguments[0], 'testJob');
    assert.deepStrictEqual(calls[0].arguments[1], jobData);
    assert.deepStrictEqual(result, { id: 'test-job-id' });
});

// Cleanup after tests
after(async () => {
    try {
        const {
            closeConnection,
            shutdownQueue,
            hasQueueResources,
            closeAnalysisRedis,
            hasAnalysisRedisResources,
            closeStateManager
        } = await import('@gitfix/core');

        await closeConnection();

        if (hasQueueResources()) {
            await shutdownQueue();
        }

        if (hasAnalysisRedisResources()) {
            await closeAnalysisRedis();
        }

        await closeStateManager();
    } catch {
        // Ignore cleanup errors
    }
    // Brief delay for cleanup
    await new Promise(resolve => setTimeout(resolve, 50));
});

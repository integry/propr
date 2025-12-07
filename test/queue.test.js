import { test, mock } from 'node:test';
import assert from 'node:assert';

// Mock Redis before importing modules that use it
const mockRedis = {
    on: mock.fn(),
    quit: mock.fn(async () => {}),
};

// Mock ioredis module
await mock.module('ioredis', {
    namedExports: {
        default: function Redis() {
            return mockRedis;
        }
    }
});

// Mock BullMQ module
const mockQueue = {
    add: mock.fn(async () => ({ id: 'test-job-id' })),
    close: mock.fn(async () => {}),
    on: mock.fn(),
};

const mockWorker = {
    on: mock.fn(),
    close: mock.fn(async () => {}),
    opts: { concurrency: 5 },
};

await mock.module('bullmq', {
    namedExports: {
        Queue: function Queue() {
            return mockQueue;
        },
        Worker: function Worker(name, processor, opts) {
            mockWorker.processor = processor;
            mockWorker.name = name;
            mockWorker.opts = { ...mockWorker.opts, ...opts };
            return mockWorker;
        }
    }
});

// Now import the modules
const { issueQueue, createWorker, shutdownQueue } = await import('../src/queue/taskQueue.ts');

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
    const processorFn = async () => {};
    const worker = createWorker('test-queue', processorFn);
    
    assert.ok(worker);
    assert.strictEqual(worker.name, 'test-queue');
    assert.strictEqual(worker.processor, processorFn);
    assert.strictEqual(worker.opts.concurrency, 5);
    
    // Check worker event handlers are registered
    const eventNames = mockWorker.on.mock.calls.map(call => call.arguments[0]);
    assert.ok(eventNames.includes('completed'));
    assert.ok(eventNames.includes('failed'));
    assert.ok(eventNames.includes('error'));
    assert.ok(eventNames.includes('stalled'));
});

test('shutdownQueue closes queue and Redis connection', async () => {
    mockQueue.close.mock.resetCalls();
    mockRedis.quit.mock.resetCalls();
    
    await shutdownQueue();
    
    assert.strictEqual(mockQueue.close.mock.calls.length, 1);
    assert.strictEqual(mockRedis.quit.mock.calls.length, 1);
});

test('queue can add jobs', async () => {
    mockQueue.add.mock.resetCalls();
    
    const jobData = { issueNumber: 123 };
    const result = await issueQueue.add('testJob', jobData);
    
    assert.strictEqual(mockQueue.add.mock.calls.length, 1);
    assert.strictEqual(mockQueue.add.mock.calls[0].arguments[0], 'testJob');
    assert.deepStrictEqual(mockQueue.add.mock.calls[0].arguments[1], jobData);
    assert.deepStrictEqual(result, { id: 'test-job-id' });
});
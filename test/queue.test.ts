import { test, mock } from 'node:test';
import assert from 'node:assert';
import type { Queue, Worker, Job } from 'bullmq';
import type { IssueJobData, JobResult, WorkerOptions, ProcessorFunction } from '../src/queue/taskQueue.js';

interface MockRedis {
    on: ReturnType<typeof mock.fn>;
    quit: ReturnType<typeof mock.fn>;
}

interface MockQueue {
    add: ReturnType<typeof mock.fn>;
    close: ReturnType<typeof mock.fn>;
    on: ReturnType<typeof mock.fn>;
}

interface MockWorker {
    on: ReturnType<typeof mock.fn>;
    close: ReturnType<typeof mock.fn>;
    opts: { concurrency: number };
    processor?: ProcessorFunction<IssueJobData>;
    name?: string;
}

const mockRedis: MockRedis = {
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

const mockQueue: MockQueue = {
    add: mock.fn(async () => ({ id: 'test-job-id' })),
    close: mock.fn(async () => {}),
    on: mock.fn(),
};

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
        Worker: function Worker(name: string, processor: ProcessorFunction<IssueJobData>, opts?: WorkerOptions) {
            mockWorker.processor = processor;
            mockWorker.name = name;
            mockWorker.opts = { ...mockWorker.opts, ...opts };
            return mockWorker;
        }
    }
});

const { issueQueue, createWorker, shutdownQueue } = await import('../src/queue/taskQueue.js');

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
    const processorFn: ProcessorFunction<IssueJobData> = async (job: Job<IssueJobData>): Promise<JobResult> => {
        return { status: 'complete', issueNumber: job.data.number };
    };
    const worker = createWorker<IssueJobData>('test-queue', processorFn);
    
    assert.ok(worker);
    assert.strictEqual(mockWorker.name, 'test-queue');
    assert.strictEqual(mockWorker.processor, processorFn);
    assert.strictEqual(mockWorker.opts.concurrency, 5);
    
    const eventNames = mockWorker.on.mock.calls.map((call: { arguments: string[] }) => call.arguments[0]);
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

test('queue can add jobs with typed data', async () => {
    mockQueue.add.mock.resetCalls();
    
    const jobData: IssueJobData = { 
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        number: 123,
        modelName: 'claude-sonnet'
    };
    const result = await issueQueue.add('testJob', jobData);
    
    assert.strictEqual(mockQueue.add.mock.calls.length, 1);
    assert.strictEqual(mockQueue.add.mock.calls[0].arguments[0], 'testJob');
    assert.deepStrictEqual(mockQueue.add.mock.calls[0].arguments[1], jobData);
    assert.deepStrictEqual(result, { id: 'test-job-id' });
});

test('IssueJobData interface has required fields', () => {
    const validJobData: IssueJobData = {
        repoOwner: 'owner',
        repoName: 'repo',
        number: 1
    };
    
    assert.strictEqual(validJobData.repoOwner, 'owner');
    assert.strictEqual(validJobData.repoName, 'repo');
    assert.strictEqual(validJobData.number, 1);
});

test('IssueJobData interface supports optional fields', () => {
    const fullJobData: IssueJobData = {
        repoOwner: 'owner',
        repoName: 'repo',
        number: 1,
        installationId: 12345,
        modelName: 'claude-sonnet',
        correlationId: 'corr-123',
        triggeringLabel: 'AI',
        baseBranch: 'main',
        baseLabel: 'base-main',
        modelLabel: 'llm-claude-sonnet',
        isChildJob: true,
        issuePayload: { title: 'Test issue' },
        repoPayload: { defaultBranch: 'main' },
        title: 'Test Title',
        subtitle: 'Test Subtitle'
    };
    
    assert.strictEqual(fullJobData.installationId, 12345);
    assert.strictEqual(fullJobData.modelName, 'claude-sonnet');
    assert.strictEqual(fullJobData.isChildJob, true);
});

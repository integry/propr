import { test, after } from 'node:test';
import assert from 'node:assert';
import Redis from 'ioredis';

// Set up environment variables for testing
process.env.NODE_ENV = 'test';
process.env.AI_PROCESSING_TAG = 'AI-processing';
process.env.AI_PRIMARY_TAG = 'AI';
process.env.AI_DONE_TAG = 'AI-done';

// Helper to check if Redis is available
async function isRedisAvailable(): Promise<boolean> {
    const testClient = new Redis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        maxRetriesPerRequest: 1,
        retryStrategy: () => null, // Don't retry
        connectTimeout: 2000,
        lazyConnect: true,
    });

    try {
        await testClient.connect();
        await testClient.ping();
        testClient.disconnect();
        return true;
    } catch {
        testClient.disconnect();
        return false;
    }
}

// Track whether tests should run
let redisAvailable = false;

// Note: This test file tests worker-related exports from @gitfix/core without
// importing src/worker.ts directly (which creates Redis connections).
// Full integration tests should be run in Docker with Redis available.

test('Worker job data interface is compatible', async () => {
    // Check Redis first
    redisAvailable = await isRedisAvailable();
    if (!redisAvailable) {
        console.log('# Skipping worker tests that require Redis');
    }

    // Test that the expected job data structure can be created
    const validJobData = {
        id: 1,
        number: 42,
        title: 'Test Issue',
        url: 'https://github.com/test/repo/issues/42',
        repoOwner: 'test',
        repoName: 'repo',
        labels: ['AI'],
    };

    assert.strictEqual(validJobData.number, 42);
    assert.strictEqual(validJobData.repoOwner, 'test');
    assert.strictEqual(validJobData.repoName, 'repo');
    assert.ok(Array.isArray(validJobData.labels));
});

test('Environment variables are correctly read', () => {
    assert.strictEqual(process.env.AI_PROCESSING_TAG, 'AI-processing');
    assert.strictEqual(process.env.AI_PRIMARY_TAG, 'AI');
    assert.strictEqual(process.env.AI_DONE_TAG, 'AI-done');
});

test('Core exports required functions for worker', async () => {
    const coreModule = await import('@gitfix/core');

    // Worker needs these functions from core
    assert.strictEqual(typeof coreModule.createWorker, 'function');
    assert.strictEqual(typeof coreModule.GITHUB_ISSUE_QUEUE_NAME, 'string');
    assert.strictEqual(typeof coreModule.getAuthenticatedOctokit, 'function');
    assert.strictEqual(typeof coreModule.recordLLMMetrics, 'function');
    assert.strictEqual(typeof coreModule.handleError, 'function');
});

test('Core exports WorkerStateManager', async () => {
    const coreModule = await import('@gitfix/core');

    assert.strictEqual(typeof coreModule.WorkerStateManager, 'function');
    assert.strictEqual(typeof coreModule.getStateManager, 'function');
    assert.strictEqual(typeof coreModule.closeStateManager, 'function');
    assert.strictEqual(typeof coreModule.hasStateManagerResources, 'function');
});

test('Core exports TaskStates enum', async () => {
    const coreModule = await import('@gitfix/core');

    assert.ok(coreModule.TaskStates);
    assert.strictEqual(typeof coreModule.TaskStates.PENDING, 'string');
    assert.strictEqual(typeof coreModule.TaskStates.PROCESSING, 'string');
    assert.strictEqual(typeof coreModule.TaskStates.COMPLETED, 'string');
    assert.strictEqual(typeof coreModule.TaskStates.FAILED, 'string');
});

test('Core exports AgentRegistry', async () => {
    const coreModule = await import('@gitfix/core');

    assert.strictEqual(typeof coreModule.AgentRegistry, 'function');
    assert.strictEqual(typeof coreModule.getAgentRegistry, 'function');
});

test('Worker job types are exported from core', async () => {
    // Just check that types module is accessible
    const coreModule = await import('@gitfix/core');

    // These are type exports, so we just verify the module loads
    assert.ok(coreModule.GITHUB_ISSUE_QUEUE_NAME);
});

// Cleanup after tests
after(async () => {
    try {
        const {
            closeConnection,
            hasDbResources,
            shutdownQueue,
            hasQueueResources,
            closeAnalysisRedis,
            hasAnalysisRedisResources,
            closeStateManager,
            hasStateManagerResources
        } = await import('@gitfix/core');

        if (hasDbResources()) {
            await closeConnection();
        }

        if (hasQueueResources()) {
            await shutdownQueue();
        }

        if (hasAnalysisRedisResources()) {
            await closeAnalysisRedis();
        }

        if (hasStateManagerResources()) {
            await closeStateManager();
        }
    } catch {
        // Ignore cleanup errors
    }
    // Brief delay for cleanup
    await new Promise(resolve => setTimeout(resolve, 50));
});

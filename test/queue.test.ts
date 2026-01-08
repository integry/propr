import { test, after } from 'node:test';
import assert from 'node:assert';
import Redis from 'ioredis';

// Set test environment before imports
process.env.NODE_ENV = 'test';

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

// Module imports (will be loaded dynamically)
let GITHUB_ISSUE_QUEUE_NAME: string;
let ANALYSIS_QUEUE_NAME: string;
let INDEXING_QUEUE_NAME: string;
let hasQueueResources: () => boolean;

test('Queue module exports required constants', async (t) => {
    // Check Redis first
    redisAvailable = await isRedisAvailable();
    if (!redisAvailable) {
        console.log('# Skipping queue tests that require Redis');
    }

    // These exports should work regardless of Redis
    const queueModule = await import('@gitfix/core');
    GITHUB_ISSUE_QUEUE_NAME = queueModule.GITHUB_ISSUE_QUEUE_NAME;
    ANALYSIS_QUEUE_NAME = queueModule.ANALYSIS_QUEUE_NAME;
    INDEXING_QUEUE_NAME = queueModule.INDEXING_QUEUE_NAME;
    hasQueueResources = queueModule.hasQueueResources;

    assert.strictEqual(typeof GITHUB_ISSUE_QUEUE_NAME, 'string');
    assert.strictEqual(typeof ANALYSIS_QUEUE_NAME, 'string');
    assert.strictEqual(typeof INDEXING_QUEUE_NAME, 'string');
    assert.ok(GITHUB_ISSUE_QUEUE_NAME.length > 0);
    assert.ok(ANALYSIS_QUEUE_NAME.length > 0);
    assert.ok(INDEXING_QUEUE_NAME.length > 0);
});

test('Queue names have expected default values', async () => {
    assert.strictEqual(GITHUB_ISSUE_QUEUE_NAME, process.env.GITHUB_ISSUE_QUEUE_NAME || 'github-issue-processor');
    assert.strictEqual(ANALYSIS_QUEUE_NAME, process.env.ANALYSIS_QUEUE_NAME || 'analysis-processor');
    assert.strictEqual(INDEXING_QUEUE_NAME, process.env.INDEXING_QUEUE_NAME || 'indexing-processor');
});

test('hasQueueResources returns boolean', async () => {
    assert.strictEqual(typeof hasQueueResources(), 'boolean');
});

test('Queue getters lazily create queues with Redis', async (t) => {
    if (!redisAvailable) {
        t.skip('Redis not available');
        return;
    }

    const { getIssueQueue, getAnalysisQueue, getIndexingQueue } = await import('@gitfix/core');

    // Queues should be lazy - not created until accessed
    // After calling getters, they should be created
    const issueQueue = getIssueQueue();
    assert.ok(issueQueue, 'Issue queue should be created');
    assert.strictEqual(typeof issueQueue.add, 'function');

    const analysisQueue = getAnalysisQueue();
    assert.ok(analysisQueue, 'Analysis queue should be created');
    assert.strictEqual(typeof analysisQueue.add, 'function');

    const indexingQueue = getIndexingQueue();
    assert.ok(indexingQueue, 'Indexing queue should be created');
    assert.strictEqual(typeof indexingQueue.add, 'function');

    // After accessing queues, resources should be tracked
    assert.strictEqual(hasQueueResources(), true);
});

test('createWorker function is exported', async () => {
    const { createWorker } = await import('@gitfix/core');
    assert.strictEqual(typeof createWorker, 'function');
});

test('shutdownQueue function is exported', async () => {
    const { shutdownQueue } = await import('@gitfix/core');
    assert.strictEqual(typeof shutdownQueue, 'function');
});

test('COMMENT_BATCH_DELAY_MS constant is exported', async () => {
    const { COMMENT_BATCH_DELAY_MS } = await import('@gitfix/core');
    assert.strictEqual(typeof COMMENT_BATCH_DELAY_MS, 'number');
    assert.ok(COMMENT_BATCH_DELAY_MS >= 0);
});

// Cleanup after tests
after(async () => {
    if (redisAvailable) {
        try {
            const {
                closeConnection,
                hasDbResources,
                shutdownQueue,
                hasQueueResources: checkQueueResources,
                closeAnalysisRedis,
                hasAnalysisRedisResources,
                closeStateManager,
                hasStateManagerResources
            } = await import('@gitfix/core');

            if (hasDbResources()) {
                await closeConnection();
            }

            if (checkQueueResources()) {
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
    }
    // Brief delay for cleanup
    await new Promise(resolve => setTimeout(resolve, 50));
});

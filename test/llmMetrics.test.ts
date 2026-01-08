import { describe, it, before, after } from 'node:test';
import assert from 'assert';
import Redis from 'ioredis';

// Set test environment before imports
process.env.NODE_ENV = 'test';

// Dynamic imports to control module initialization
let recordLLMMetrics: typeof import('@gitfix/core').recordLLMMetrics;
let getLLMMetricsSummary: typeof import('@gitfix/core').getLLMMetricsSummary;
let getLLMMetricsByCorrelationId: typeof import('@gitfix/core').getLLMMetricsByCorrelationId;

interface ClaudeResultLike {
    success: boolean;
    executionTime?: number;
    model?: string;
    sessionId?: string;
    conversationId?: string;
    error?: string;
    finalResult?: {
        num_turns?: number;
        cost_usd?: number;
    };
    conversationLog?: unknown[];
}

interface IssueRefLike {
    number: number;
    repoOwner: string;
    repoName: string;
}

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

describe('LLM Metrics Tests', () => {
    let redisClient: Redis | null = null;
    const testCorrelationId = 'test-correlation-' + Date.now();

    before(async () => {
        // Check Redis availability first
        redisAvailable = await isRedisAvailable();
        if (!redisAvailable) {
            console.log('# Skipping LLM Metrics tests: Redis not available');
            return;
        }

        // Load core module dynamically
        const coreModule = await import('@gitfix/core');
        recordLLMMetrics = coreModule.recordLLMMetrics;
        getLLMMetricsSummary = coreModule.getLLMMetricsSummary;
        getLLMMetricsByCorrelationId = coreModule.getLLMMetricsByCorrelationId;

        redisClient = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
        });

        // Clean up any existing test data
        const keys = await redisClient.keys('llm:metrics:*');
        if (keys.length > 0) {
            await redisClient.del(...keys);
        }
    });

    after(async () => {
        try {
            // Clean up test data
            if (redisClient) {
                const keys = await redisClient.keys('llm:metrics:*');
                if (keys.length > 0) {
                    await redisClient.del(...keys);
                }
                redisClient.disconnect();
            }
        } catch {
            // Ignore errors
        }

        // Close core connections only if they were potentially created
        if (redisAvailable) {
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
        }
        // Brief delay for cleanup
        await new Promise(resolve => setTimeout(resolve, 50));
    });

    it('should record LLM metrics successfully', async (t) => {
        if (!redisAvailable) { t.skip('Redis not available'); return; }
        const mockClaudeResult: ClaudeResultLike = {
            success: true,
            executionTime: 45000, // 45 seconds
            model: 'claude-3-opus-20240229',
            sessionId: 'test-session-123',
            conversationId: 'test-conv-456',
            finalResult: {
                num_turns: 5,
                cost_usd: 2.50
            }
        };

        const issueRef: IssueRefLike = {
            number: 123,
            repoOwner: 'testowner',
            repoName: 'testrepo'
        };

        await recordLLMMetrics(mockClaudeResult as Parameters<typeof recordLLMMetrics>[0], issueRef, { jobType: 'issue', correlationId: testCorrelationId });

        // Verify metrics were stored
        const storedMetrics = await redisClient.get(`llm:metrics:${testCorrelationId}`);
        assert.ok(storedMetrics, 'Metrics should be stored');

        const parsedMetrics = JSON.parse(storedMetrics);
        assert.equal(parsedMetrics.correlationId, testCorrelationId);
        assert.equal(parsedMetrics.success, true);
        assert.equal(parsedMetrics.costUsd, 2.50);
        assert.equal(parsedMetrics.numTurns, 5);
        assert.equal(parsedMetrics.model, 'claude-3-opus-20240229');
    });

    it('should aggregate metrics correctly', async (t) => {
        if (!redisAvailable) { t.skip('Redis not available'); return; }
        // Add another successful request
        const mockClaudeResult2: ClaudeResultLike = {
            success: true,
            executionTime: 30000,
            model: 'claude-3-opus-20240229',
            sessionId: 'test-session-456',
            finalResult: {
                num_turns: 3,
                cost_usd: 1.50
            }
        };

        await recordLLMMetrics(mockClaudeResult2 as Parameters<typeof recordLLMMetrics>[0], {
            number: 124,
            repoOwner: 'testowner',
            repoName: 'testrepo'
        }, { jobType: 'issue', correlationId: 'test-correlation-2' });

        // Add a failed request
        const mockClaudeResult3: ClaudeResultLike = {
            success: false,
            executionTime: 10000,
            model: 'claude-3-sonnet-20240229',
            error: 'Test error',
            sessionId: 'test-session-789',
            finalResult: {
                num_turns: 2,
                cost_usd: 0.50
            }
        };

        await recordLLMMetrics(mockClaudeResult3 as Parameters<typeof recordLLMMetrics>[0], {
            number: 125,
            repoOwner: 'testowner',
            repoName: 'testrepo'
        }, { jobType: 'issue', correlationId: 'test-correlation-3' });

        // Get summary
        const summary = await getLLMMetricsSummary();

        assert.equal(summary.summary.totalRequests, 3, 'Should have 3 total requests');
        assert.equal(summary.summary.totalSuccessful, 2, 'Should have 2 successful requests');
        assert.equal(summary.summary.totalFailed, 1, 'Should have 1 failed request');
        assert.equal(summary.summary.totalCostUsd, 4.50, 'Total cost should be 4.50');
        assert.ok(summary.summary.successRate > 0.6 && summary.summary.successRate < 0.7, 'Success rate should be ~66%');

        // Check model breakdown
        assert.ok(summary.modelBreakdown['claude-3-opus-20240229'], 'Should have Opus metrics');
        assert.ok(summary.modelBreakdown['claude-3-sonnet-20240229'], 'Should have Sonnet metrics');
        assert.equal(summary.modelBreakdown['claude-3-opus-20240229'].totalRequests, 2);
        assert.equal(summary.modelBreakdown['claude-3-sonnet-20240229'].totalRequests, 1);
    });

    it('should retrieve metrics by correlation ID', async (t) => {
        if (!redisAvailable) { t.skip('Redis not available'); return; }
        const metrics = await getLLMMetricsByCorrelationId(testCorrelationId);

        assert.ok(metrics, 'Should retrieve metrics');
        assert.equal(metrics.correlationId, testCorrelationId);
        assert.equal(metrics.issueNumber, 123);
        assert.equal(metrics.repository, 'testowner/testrepo');
    });

    it('should handle high cost alerts', async (t) => {
        if (!redisAvailable) { t.skip('Redis not available'); return; }
        // Set a low threshold for testing
        process.env.LLM_COST_THRESHOLD_USD = '5.00';

        const highCostResult: ClaudeResultLike = {
            success: true,
            executionTime: 120000,
            model: 'claude-3-opus-20240229',
            sessionId: 'test-session-high-cost',
            finalResult: {
                num_turns: 20,
                cost_usd: 15.00 // Above threshold
            }
        };

        await recordLLMMetrics(highCostResult as Parameters<typeof recordLLMMetrics>[0], {
            number: 999,
            repoOwner: 'testowner',
            repoName: 'testrepo'
        }, { jobType: 'issue', correlationId: 'test-correlation-high-cost' });

        const summary = await getLLMMetricsSummary();
        assert.ok(summary.recentHighCostAlerts.length > 0, 'Should have high cost alerts');

        const alert = summary.recentHighCostAlerts[0];
        assert.equal(alert.costUsd, 15.00);
        assert.equal(alert.threshold, 5.00);
        assert.equal(alert.issueNumber, 999);

        // Clean up
        delete process.env.LLM_COST_THRESHOLD_USD;
    });

    it('should handle missing or null values gracefully', async (t) => {
        if (!redisAvailable) { t.skip('Redis not available'); return; }
        const incompleteResult: ClaudeResultLike = {
            success: false,
            // Missing most fields
        };

        await recordLLMMetrics(incompleteResult as Parameters<typeof recordLLMMetrics>[0], {
            number: 126,
            repoOwner: 'testowner',
            repoName: 'testrepo'
        }, { jobType: 'issue', correlationId: 'test-correlation-incomplete' });

        const metrics = await getLLMMetricsByCorrelationId('test-correlation-incomplete');
        assert.ok(metrics, 'Should store metrics even with missing data');
        assert.equal(metrics.success, false);
        assert.equal(metrics.costUsd, 0);
        assert.equal(metrics.numTurns, 0);
        assert.equal(metrics.model, 'unknown');
    });
});

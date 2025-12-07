import { describe, it, before, after } from 'node:test';
import assert from 'assert';
import Redis from 'ioredis';
import { recordLLMMetrics, getLLMMetricsSummary, getLLMMetricsByCorrelationId } from '../src/utils/llmMetrics.ts';

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

describe('LLM Metrics Tests', () => {
    let redisClient: Redis;
    const testCorrelationId = 'test-correlation-' + Date.now();

    before(async () => {
        redisClient = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
        });
        
        const keys = await redisClient.keys('llm:metrics:*');
        if (keys.length > 0) {
            await redisClient.del(...keys);
        }
    });

    after(async () => {
        const keys = await redisClient.keys('llm:metrics:*');
        if (keys.length > 0) {
            await redisClient.del(...keys);
        }
        await redisClient.quit();
    });

    it('should record LLM metrics successfully', async () => {
        const mockClaudeResult: ClaudeResultLike = {
            success: true,
            executionTime: 45000,
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

        const storedMetrics = await redisClient.get(`llm:metrics:${testCorrelationId}`);
        assert.ok(storedMetrics, 'Metrics should be stored');

        const parsedMetrics = JSON.parse(storedMetrics);
        assert.equal(parsedMetrics.correlationId, testCorrelationId);
        assert.equal(parsedMetrics.success, true);
    });

    it('should aggregate metrics correctly', async () => {
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

        const summary = await getLLMMetricsSummary();
        assert.ok(summary, 'Summary should be returned');
    });

    it('should retrieve metrics by correlation ID', async () => {
        const metrics = await getLLMMetricsByCorrelationId(testCorrelationId);
        
        assert.ok(metrics, 'Should retrieve metrics');
        assert.equal(metrics.correlationId, testCorrelationId);
    });

    it('should handle missing or null values gracefully', async () => {
        const incompleteResult: ClaudeResultLike = {
            success: false,
        };

        await recordLLMMetrics(incompleteResult as Parameters<typeof recordLLMMetrics>[0], {
            number: 126,
            repoOwner: 'testowner',
            repoName: 'testrepo'
        }, { jobType: 'issue', correlationId: 'test-correlation-incomplete' });

        const metrics = await getLLMMetricsByCorrelationId('test-correlation-incomplete');
        assert.ok(metrics, 'Should store metrics even with missing data');
        assert.equal(metrics.success, false);
    });
});

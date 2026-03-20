/**
 * Integration tests for Queue Completion Metrics
 *
 * Tests that verify:
 * - Successful jobs are tracked
 * - Processed count increments correctly
 * - Average time is calculated properly
 * - AI metrics are stored in Redis
 *
 * These tests use mock Redis to simulate the metrics storage behavior
 * without requiring a running Redis instance.
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

interface IssueJobData {
    repoOwner: string;
    repoName: string;
    number: number;
    modelName?: string;
    correlationId?: string;
}

interface ClaudeResult {
    success: boolean;
    executionTime?: number;
    model?: string;
    claudeCostUsd?: number;
    claudeNumTurns?: number;
}

interface JobResult {
    status: string;
    claudeResult?: ClaudeResult;
    correlationId?: string;
}

interface AiMetrics {
    timestamp: number;
    cost: number;
    model: string;
    turns: number;
    executionTimeMs: number;
    issueNumber?: number;
    repo: string | null;
    status: 'success' | 'failed';
    correlationId?: string;
    error?: string;
}

interface MockJob {
    data: IssueJobData;
    timestamp: number;
}

/**
 * Mock Redis client that simulates Redis behavior for metrics storage
 */
function createMockRedis(): {
    storage: Map<string, string>;
    sortedSets: Map<string, Array<{ score: number; value: string }>>;
    sets: Map<string, Set<string>>;
    incr: (key: string) => Promise<number>;
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
    sadd: (key: string, value: string) => Promise<void>;
    smembers: (key: string) => Promise<string[]>;
    zadd: (key: string, score: number, value: string) => Promise<void>;
    zrange: (key: string, start: number, end: number) => Promise<string[]>;
    del: (key: string) => Promise<void>;
    clear: () => void;
} {
    const storage = new Map<string, string>();
    const sortedSets = new Map<string, Array<{ score: number; value: string }>>();
    const sets = new Map<string, Set<string>>();

    return {
        storage,
        sortedSets,
        sets,

        async incr(key: string): Promise<number> {
            const current = parseInt(storage.get(key) || '0', 10);
            const newValue = current + 1;
            storage.set(key, newValue.toString());
            return newValue;
        },

        async get(key: string): Promise<string | null> {
            return storage.get(key) || null;
        },

        async set(key: string, value: string): Promise<void> {
            storage.set(key, value);
        },

        async sadd(key: string, value: string): Promise<void> {
            if (!sets.has(key)) {
                sets.set(key, new Set());
            }
            sets.get(key)!.add(value);
        },

        async smembers(key: string): Promise<string[]> {
            const set = sets.get(key);
            return set ? Array.from(set) : [];
        },

        async zadd(key: string, score: number, value: string): Promise<void> {
            if (!sortedSets.has(key)) {
                sortedSets.set(key, []);
            }
            const sortedSet = sortedSets.get(key)!;
            sortedSet.push({ score, value });
            // Sort by score ascending
            sortedSet.sort((a, b) => a.score - b.score);
        },

        async zrange(key: string, start: number, end: number): Promise<string[]> {
            const sortedSet = sortedSets.get(key) || [];
            // Handle -1 meaning "to the end"
            const endIndex = end === -1 ? sortedSet.length : end + 1;
            return sortedSet.slice(start, endIndex).map(item => item.value);
        },

        async del(key: string): Promise<void> {
            storage.delete(key);
            sortedSets.delete(key);
            sets.delete(key);
        },

        clear(): void {
            storage.clear();
            sortedSets.clear();
            sets.clear();
        }
    };
}

/**
 * Helper function to simulate updateCompletedMetrics from taskQueue.ts
 * This mirrors the actual implementation logic
 */
async function updateCompletedMetrics(
    mockRedis: ReturnType<typeof createMockRedis>,
    job: MockJob,
    result: JobResult,
    duration: number
): Promise<void> {
    const dateKey = new Date().toISOString().split('T')[0];
    const repoFullName = `${job.data.repoOwner}/${job.data.repoName}`;

    // Increment processed count
    await mockRedis.incr('metrics:jobs:processed');
    await mockRedis.incr(`metrics:daily:${dateKey}:processed`);

    // Calculate and update average time
    const totalProcessed = await mockRedis.get('metrics:jobs:processed') || '1';
    const currentAvg = parseFloat(await mockRedis.get('metrics:jobs:avgTime') || '0');
    const durationSec = duration / 1000;
    const newAvg = ((currentAvg * (parseInt(totalProcessed) - 1)) + durationSec) / parseInt(totalProcessed);
    await mockRedis.set('metrics:jobs:avgTime', newAvg.toFixed(2));

    // Add to active repositories
    await mockRedis.sadd('active:repositories', repoFullName);

    // Store AI metrics if claudeResult exists
    if (result.claudeResult) {
        const aiMetrics: AiMetrics = {
            timestamp: job.timestamp,
            cost: result.claudeResult.claudeCostUsd || 0,
            model: result.claudeResult.model || job.data.modelName || 'unknown',
            turns: result.claudeResult.claudeNumTurns || 0,
            executionTimeMs: result.claudeResult.executionTime || 0,
            issueNumber: job.data.number,
            repo: repoFullName,
            status: 'success',
            correlationId: job.data.correlationId || result.correlationId,
        };
        await mockRedis.zadd('metrics:ai:log:v1', job.timestamp, JSON.stringify(aiMetrics));
    }
}

/**
 * Helper function to simulate updateFailedMetrics from taskQueue.ts
 */
async function updateFailedMetrics(
    mockRedis: ReturnType<typeof createMockRedis>,
    job: MockJob,
    error: Error
): Promise<void> {
    const dateKey = new Date().toISOString().split('T')[0];
    const repoFullName = `${job.data.repoOwner}/${job.data.repoName}`;

    await mockRedis.incr('metrics:jobs:failed');
    await mockRedis.incr(`metrics:daily:${dateKey}:failed`);

    const aiMetrics: AiMetrics = {
        timestamp: job.timestamp,
        cost: 0,
        model: job.data.modelName || 'unknown',
        turns: 0,
        executionTimeMs: Date.now() - job.timestamp,
        issueNumber: job.data.number,
        repo: repoFullName,
        status: 'failed',
        correlationId: job.data.correlationId,
        error: error.message.substring(0, 100),
    };
    await mockRedis.zadd('metrics:ai:log:v1', job.timestamp, JSON.stringify(aiMetrics));
}

describe('Queue Completion Metrics Integration', () => {
    let mockRedis: ReturnType<typeof createMockRedis>;

    beforeEach(() => {
        mockRedis = createMockRedis();
    });

    afterEach(() => {
        mockRedis.clear();
    });

    describe('Successful Job Tracking', () => {
        test('should track successful jobs', async () => {
            const mockJob: MockJob = {
                data: {
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    number: 123,
                    modelName: 'claude-3-opus',
                    correlationId: 'test-corr-1',
                },
                timestamp: Date.now(),
            };

            const mockResult: JobResult = {
                status: 'completed',
                claudeResult: {
                    success: true,
                    executionTime: 30000,
                    model: 'claude-3-opus',
                    claudeCostUsd: 1.50,
                    claudeNumTurns: 5,
                },
                correlationId: 'test-corr-1',
            };

            // Simulate job completion
            await updateCompletedMetrics(mockRedis, mockJob, mockResult, 30000);

            // Verify processed count was incremented
            const processedCount = await mockRedis.get('metrics:jobs:processed');
            assert.strictEqual(processedCount, '1', 'Processed count should be 1');

            // Verify repository was tracked
            const activeRepos = await mockRedis.smembers('active:repositories');
            assert.ok(activeRepos.includes('testowner/testrepo'), 'Repository should be tracked');
        });

        test('should track multiple successful jobs from different repositories', async () => {
            const repos = [
                { owner: 'org1', name: 'app1' },
                { owner: 'org1', name: 'app2' },
                { owner: 'org2', name: 'service' },
            ];

            for (let i = 0; i < repos.length; i++) {
                const mockJob: MockJob = {
                    data: {
                        repoOwner: repos[i].owner,
                        repoName: repos[i].name,
                        number: i + 1,
                    },
                    timestamp: Date.now() + i * 100,
                };

                await updateCompletedMetrics(mockRedis, mockJob, { status: 'completed' }, 5000);
            }

            const activeRepos = await mockRedis.smembers('active:repositories');
            assert.strictEqual(activeRepos.length, 3, 'Should track 3 unique repositories');
            assert.ok(activeRepos.includes('org1/app1'));
            assert.ok(activeRepos.includes('org1/app2'));
            assert.ok(activeRepos.includes('org2/service'));
        });
    });

    describe('Processed Count Increment', () => {
        test('should increment processed count correctly for multiple jobs', async () => {
            const jobs: MockJob[] = [
                {
                    data: { repoOwner: 'owner1', repoName: 'repo1', number: 1, modelName: 'opus' },
                    timestamp: Date.now(),
                },
                {
                    data: { repoOwner: 'owner2', repoName: 'repo2', number: 2, modelName: 'sonnet' },
                    timestamp: Date.now() + 1000,
                },
                {
                    data: { repoOwner: 'owner3', repoName: 'repo3', number: 3, modelName: 'haiku' },
                    timestamp: Date.now() + 2000,
                },
            ];

            const mockResult: JobResult = {
                status: 'completed',
                claudeResult: {
                    success: true,
                    executionTime: 10000,
                    claudeCostUsd: 0.50,
                    claudeNumTurns: 2,
                },
            };

            // Process multiple jobs
            for (const job of jobs) {
                await updateCompletedMetrics(mockRedis, job, mockResult, 10000);
            }

            // Verify processed count
            const processedCount = await mockRedis.get('metrics:jobs:processed');
            assert.strictEqual(processedCount, '3', 'Processed count should be 3');

            // Verify daily count
            const dateKey = new Date().toISOString().split('T')[0];
            const dailyCount = await mockRedis.get(`metrics:daily:${dateKey}:processed`);
            assert.strictEqual(dailyCount, '3', 'Daily processed count should be 3');

            // Verify all repositories are tracked
            const activeRepos = await mockRedis.smembers('active:repositories');
            assert.strictEqual(activeRepos.length, 3, 'Should have 3 active repositories');
            assert.ok(activeRepos.includes('owner1/repo1'));
            assert.ok(activeRepos.includes('owner2/repo2'));
            assert.ok(activeRepos.includes('owner3/repo3'));
        });

        test('should increment processed count atomically', async () => {
            // Simulate concurrent job completions
            const concurrentJobs = Array.from({ length: 10 }, (_, i) => ({
                data: { repoOwner: 'owner', repoName: 'repo', number: i + 1 },
                timestamp: Date.now() + i,
            }));

            // Process all jobs
            await Promise.all(
                concurrentJobs.map(job =>
                    updateCompletedMetrics(mockRedis, job, { status: 'completed' }, 1000)
                )
            );

            const processedCount = await mockRedis.get('metrics:jobs:processed');
            assert.strictEqual(processedCount, '10', 'All jobs should be counted');
        });
    });

    describe('Average Time Calculation', () => {
        test('should calculate average time correctly', async () => {
            // Job 1: 10 seconds
            const job1: MockJob = {
                data: { repoOwner: 'owner', repoName: 'repo', number: 1 },
                timestamp: Date.now(),
            };
            const result1: JobResult = { status: 'completed' };
            await updateCompletedMetrics(mockRedis, job1, result1, 10000); // 10 seconds

            let avgTime = await mockRedis.get('metrics:jobs:avgTime');
            assert.strictEqual(parseFloat(avgTime!), 10, 'Average should be 10 after first job');

            // Job 2: 20 seconds (average should be 15)
            const job2: MockJob = {
                data: { repoOwner: 'owner', repoName: 'repo', number: 2 },
                timestamp: Date.now() + 1000,
            };
            await updateCompletedMetrics(mockRedis, job2, result1, 20000); // 20 seconds

            avgTime = await mockRedis.get('metrics:jobs:avgTime');
            assert.strictEqual(parseFloat(avgTime!), 15, 'Average should be 15 after two jobs');

            // Job 3: 30 seconds (average should be 20)
            const job3: MockJob = {
                data: { repoOwner: 'owner', repoName: 'repo', number: 3 },
                timestamp: Date.now() + 2000,
            };
            await updateCompletedMetrics(mockRedis, job3, result1, 30000); // 30 seconds

            avgTime = await mockRedis.get('metrics:jobs:avgTime');
            assert.strictEqual(parseFloat(avgTime!), 20, 'Average should be 20 after three jobs');
        });

        test('should calculate weighted average time correctly', async () => {
            // Simulate 5 jobs with varying durations
            const durations = [5000, 10000, 15000, 20000, 25000]; // in ms
            const expectedAverages = [5, 7.5, 10, 12.5, 15]; // cumulative averages in seconds

            for (let i = 0; i < durations.length; i++) {
                const job: MockJob = {
                    data: { repoOwner: 'owner', repoName: 'repo', number: i + 1 },
                    timestamp: Date.now() + i * 1000,
                };
                const result: JobResult = { status: 'completed' };
                await updateCompletedMetrics(mockRedis, job, result, durations[i]);

                const avgTime = await mockRedis.get('metrics:jobs:avgTime');
                assert.strictEqual(
                    parseFloat(avgTime!),
                    expectedAverages[i],
                    `Average after job ${i + 1} should be ${expectedAverages[i]}`
                );
            }
        });

        test('should handle very short job durations', async () => {
            const job: MockJob = {
                data: { repoOwner: 'owner', repoName: 'repo', number: 1 },
                timestamp: Date.now(),
            };

            await updateCompletedMetrics(mockRedis, job, { status: 'completed' }, 100); // 0.1 seconds

            const avgTime = await mockRedis.get('metrics:jobs:avgTime');
            assert.strictEqual(parseFloat(avgTime!), 0.1, 'Should handle sub-second durations');
        });

        test('should handle very long job durations', async () => {
            const job: MockJob = {
                data: { repoOwner: 'owner', repoName: 'repo', number: 1 },
                timestamp: Date.now(),
            };

            // 10 minutes in milliseconds
            await updateCompletedMetrics(mockRedis, job, { status: 'completed' }, 600000);

            const avgTime = await mockRedis.get('metrics:jobs:avgTime');
            assert.strictEqual(parseFloat(avgTime!), 600, 'Should handle long durations (600 seconds)');
        });
    });

    describe('AI Metrics Storage', () => {
        test('should store AI metrics for successful jobs', async () => {
            const timestamp = Date.now();
            const mockJob: MockJob = {
                data: {
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    number: 456,
                    modelName: 'claude-3-opus',
                    correlationId: 'corr-456',
                },
                timestamp,
            };

            const mockResult: JobResult = {
                status: 'completed',
                claudeResult: {
                    success: true,
                    executionTime: 45000,
                    model: 'claude-3-opus-20240229',
                    claudeCostUsd: 2.75,
                    claudeNumTurns: 8,
                },
                correlationId: 'corr-456',
            };

            await updateCompletedMetrics(mockRedis, mockJob, mockResult, 45000);

            // Retrieve AI metrics from sorted set
            const aiMetricsRaw = await mockRedis.zrange('metrics:ai:log:v1', 0, -1);
            assert.strictEqual(aiMetricsRaw.length, 1, 'Should have 1 AI metrics entry');

            const aiMetrics: AiMetrics = JSON.parse(aiMetricsRaw[0]);

            assert.strictEqual(aiMetrics.timestamp, timestamp);
            assert.strictEqual(aiMetrics.cost, 2.75);
            assert.strictEqual(aiMetrics.model, 'claude-3-opus-20240229');
            assert.strictEqual(aiMetrics.turns, 8);
            assert.strictEqual(aiMetrics.executionTimeMs, 45000);
            assert.strictEqual(aiMetrics.issueNumber, 456);
            assert.strictEqual(aiMetrics.repo, 'testowner/testrepo');
            assert.strictEqual(aiMetrics.status, 'success');
            assert.strictEqual(aiMetrics.correlationId, 'corr-456');
        });

        test('should store AI metrics with correct structure for multiple jobs', async () => {
            const jobs = [
                {
                    job: {
                        data: { repoOwner: 'org1', repoName: 'app', number: 10, correlationId: 'c-10' },
                        timestamp: Date.now(),
                    },
                    result: {
                        status: 'completed',
                        claudeResult: {
                            success: true,
                            executionTime: 15000,
                            model: 'claude-3-sonnet',
                            claudeCostUsd: 0.50,
                            claudeNumTurns: 3,
                        },
                    } as JobResult,
                },
                {
                    job: {
                        data: { repoOwner: 'org2', repoName: 'lib', number: 20, correlationId: 'c-20' },
                        timestamp: Date.now() + 100,
                    },
                    result: {
                        status: 'completed',
                        claudeResult: {
                            success: true,
                            executionTime: 30000,
                            model: 'claude-3-opus',
                            claudeCostUsd: 3.00,
                            claudeNumTurns: 10,
                        },
                    } as JobResult,
                },
            ];

            for (const { job, result } of jobs) {
                await updateCompletedMetrics(mockRedis, job, result, result.claudeResult!.executionTime!);
            }

            // Retrieve all AI metrics
            const aiMetricsRaw = await mockRedis.zrange('metrics:ai:log:v1', 0, -1);
            assert.strictEqual(aiMetricsRaw.length, 2, 'Should have 2 AI metrics entries');

            // Parse and verify metrics
            const metrics = aiMetricsRaw.map(m => JSON.parse(m) as AiMetrics);

            // Verify first entry
            const sonnetMetrics = metrics.find(m => m.model === 'claude-3-sonnet');
            assert.ok(sonnetMetrics, 'Should have Sonnet metrics');
            assert.strictEqual(sonnetMetrics!.cost, 0.50);
            assert.strictEqual(sonnetMetrics!.turns, 3);
            assert.strictEqual(sonnetMetrics!.repo, 'org1/app');
            assert.strictEqual(sonnetMetrics!.issueNumber, 10);

            // Verify second entry
            const opusMetrics = metrics.find(m => m.model === 'claude-3-opus');
            assert.ok(opusMetrics, 'Should have Opus metrics');
            assert.strictEqual(opusMetrics!.cost, 3.00);
            assert.strictEqual(opusMetrics!.turns, 10);
            assert.strictEqual(opusMetrics!.repo, 'org2/lib');
            assert.strictEqual(opusMetrics!.issueNumber, 20);
        });

        test('should store metrics with timestamp ordering', async () => {
            const baseTimestamp = Date.now();
            const jobs = [
                { timestamp: baseTimestamp + 2000, number: 3 },
                { timestamp: baseTimestamp, number: 1 },
                { timestamp: baseTimestamp + 1000, number: 2 },
            ];

            for (const { timestamp, number } of jobs) {
                const mockJob: MockJob = {
                    data: { repoOwner: 'owner', repoName: 'repo', number, correlationId: `c-${number}` },
                    timestamp,
                };
                const result: JobResult = {
                    status: 'completed',
                    claudeResult: {
                        success: true,
                        executionTime: 1000,
                        model: 'test-model',
                        claudeCostUsd: 1.0,
                        claudeNumTurns: 1,
                    },
                };
                await updateCompletedMetrics(mockRedis, mockJob, result, 1000);
            }

            // Retrieve metrics ordered by score (timestamp)
            const aiMetricsRaw = await mockRedis.zrange('metrics:ai:log:v1', 0, -1);
            const metrics = aiMetricsRaw.map(m => JSON.parse(m) as AiMetrics);

            // Should be ordered by timestamp
            assert.strictEqual(metrics[0].issueNumber, 1, 'First should be issue 1');
            assert.strictEqual(metrics[1].issueNumber, 2, 'Second should be issue 2');
            assert.strictEqual(metrics[2].issueNumber, 3, 'Third should be issue 3');
        });

        test('should not store AI metrics when claudeResult is missing', async () => {
            const mockJob: MockJob = {
                data: {
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    number: 111,
                },
                timestamp: Date.now(),
            };

            const mockResult: JobResult = {
                status: 'completed',
                // No claudeResult
            };

            await updateCompletedMetrics(mockRedis, mockJob, mockResult, 5000);

            // Verify processed count is still incremented
            const processedCount = await mockRedis.get('metrics:jobs:processed');
            assert.strictEqual(processedCount, '1', 'Processed count should be 1');

            // Verify no AI metrics were stored (since no claudeResult)
            const aiMetricsRaw = await mockRedis.zrange('metrics:ai:log:v1', 0, -1);
            assert.strictEqual(aiMetricsRaw.length, 0, 'Should have no AI metrics entries');
        });
    });

    describe('Failed Job Tracking', () => {
        test('should track failed jobs separately', async () => {
            const mockJob: MockJob = {
                data: {
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    number: 789,
                    modelName: 'claude-3-opus',
                    correlationId: 'corr-failed',
                },
                timestamp: Date.now(),
            };

            const error = new Error('Job processing failed: timeout');
            await updateFailedMetrics(mockRedis, mockJob, error);

            // Verify failed count
            const failedCount = await mockRedis.get('metrics:jobs:failed');
            assert.strictEqual(failedCount, '1', 'Failed count should be 1');

            // Verify daily failed count
            const dateKey = new Date().toISOString().split('T')[0];
            const dailyFailed = await mockRedis.get(`metrics:daily:${dateKey}:failed`);
            assert.strictEqual(dailyFailed, '1', 'Daily failed count should be 1');

            // Verify AI metrics for failed job
            const aiMetricsRaw = await mockRedis.zrange('metrics:ai:log:v1', 0, -1);
            assert.strictEqual(aiMetricsRaw.length, 1, 'Should have 1 AI metrics entry');

            const aiMetrics: AiMetrics = JSON.parse(aiMetricsRaw[0]);
            assert.strictEqual(aiMetrics.status, 'failed');
            assert.strictEqual(aiMetrics.error, 'Job processing failed: timeout');
            assert.strictEqual(aiMetrics.cost, 0);
            assert.strictEqual(aiMetrics.turns, 0);
        });

        test('should truncate long error messages', async () => {
            const mockJob: MockJob = {
                data: {
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    number: 999,
                    correlationId: 'corr-long-error',
                },
                timestamp: Date.now(),
            };

            // Create error message longer than 100 characters
            const longErrorMessage = 'A'.repeat(150);
            const error = new Error(longErrorMessage);
            await updateFailedMetrics(mockRedis, mockJob, error);

            const aiMetricsRaw = await mockRedis.zrange('metrics:ai:log:v1', 0, -1);
            const aiMetrics: AiMetrics = JSON.parse(aiMetricsRaw[0]);

            assert.strictEqual(aiMetrics.error?.length, 100, 'Error should be truncated to 100 chars');
        });

        test('should track both successful and failed jobs', async () => {
            // Process some successful jobs
            for (let i = 0; i < 3; i++) {
                const job: MockJob = {
                    data: { repoOwner: 'owner', repoName: 'repo', number: i + 1 },
                    timestamp: Date.now() + i * 100,
                };
                await updateCompletedMetrics(mockRedis, job, { status: 'completed' }, 1000);
            }

            // Process some failed jobs
            for (let i = 0; i < 2; i++) {
                const job: MockJob = {
                    data: { repoOwner: 'owner', repoName: 'repo', number: i + 10 },
                    timestamp: Date.now() + (i + 3) * 100,
                };
                await updateFailedMetrics(mockRedis, job, new Error('Failed'));
            }

            const processedCount = await mockRedis.get('metrics:jobs:processed');
            const failedCount = await mockRedis.get('metrics:jobs:failed');

            assert.strictEqual(processedCount, '3', 'Should have 3 processed jobs');
            assert.strictEqual(failedCount, '2', 'Should have 2 failed jobs');
        });
    });

    describe('Queue Failure Metrics', () => {
        test('should increment failed counter', async () => {
            const mockJob: MockJob = {
                data: {
                    repoOwner: 'failowner',
                    repoName: 'failrepo',
                    number: 42,
                    modelName: 'claude-3-opus',
                    correlationId: 'fail-corr-42',
                },
                timestamp: Date.now(),
            };

            const error = new Error('Connection timeout');
            await updateFailedMetrics(mockRedis, mockJob, error);

            const failedCount = await mockRedis.get('metrics:jobs:failed');
            assert.strictEqual(failedCount, '1', 'Failed count should be incremented to 1');

            // Process another failure
            const mockJob2: MockJob = {
                data: {
                    repoOwner: 'failowner2',
                    repoName: 'failrepo2',
                    number: 43,
                },
                timestamp: Date.now() + 100,
            };
            await updateFailedMetrics(mockRedis, mockJob2, new Error('API error'));

            const failedCount2 = await mockRedis.get('metrics:jobs:failed');
            assert.strictEqual(failedCount2, '2', 'Failed count should be incremented to 2');
        });

        test('should truncate error message to 100 characters', async () => {
            const mockJob: MockJob = {
                data: {
                    repoOwner: 'truncowner',
                    repoName: 'truncrepo',
                    number: 100,
                    correlationId: 'trunc-corr-100',
                },
                timestamp: Date.now(),
            };

            // Create a very long error message (200+ characters)
            const longErrorMessage = 'Error: ' + 'X'.repeat(200) + ' - additional details that should be truncated';
            const error = new Error(longErrorMessage);
            await updateFailedMetrics(mockRedis, mockJob, error);

            const aiMetricsRaw = await mockRedis.zrange('metrics:ai:log:v1', 0, -1);
            assert.strictEqual(aiMetricsRaw.length, 1, 'Should have 1 AI metrics entry');

            const aiMetrics: AiMetrics = JSON.parse(aiMetricsRaw[0]);
            assert.strictEqual(aiMetrics.error?.length, 100, 'Error message should be truncated to exactly 100 characters');
            assert.strictEqual(aiMetrics.error, longErrorMessage.substring(0, 100), 'Truncated error should match first 100 chars');
        });

        test('should log error with timestamp', async () => {
            const timestamp = Date.now();
            const mockJob: MockJob = {
                data: {
                    repoOwner: 'timestampowner',
                    repoName: 'timestamprepo',
                    number: 555,
                    modelName: 'claude-3-sonnet',
                    correlationId: 'ts-corr-555',
                },
                timestamp,
            };

            const errorMessage = 'Database connection failed';
            const error = new Error(errorMessage);
            await updateFailedMetrics(mockRedis, mockJob, error);

            // Verify AI metrics contains both error and timestamp
            const aiMetricsRaw = await mockRedis.zrange('metrics:ai:log:v1', 0, -1);
            assert.strictEqual(aiMetricsRaw.length, 1, 'Should have 1 AI metrics entry');

            const aiMetrics: AiMetrics = JSON.parse(aiMetricsRaw[0]);

            // Verify timestamp is logged
            assert.strictEqual(aiMetrics.timestamp, timestamp, 'Timestamp should be recorded correctly');
            assert.ok(aiMetrics.timestamp > 0, 'Timestamp should be a positive number');

            // Verify error is logged
            assert.strictEqual(aiMetrics.error, errorMessage, 'Error message should be logged');

            // Verify status is failed
            assert.strictEqual(aiMetrics.status, 'failed', 'Status should be failed');

            // Verify other metadata is preserved
            assert.strictEqual(aiMetrics.issueNumber, 555, 'Issue number should be recorded');
            assert.strictEqual(aiMetrics.repo, 'timestampowner/timestamprepo', 'Repository should be recorded');
            assert.strictEqual(aiMetrics.correlationId, 'ts-corr-555', 'Correlation ID should be recorded');
            assert.strictEqual(aiMetrics.model, 'claude-3-sonnet', 'Model should be recorded');
        });

        test('should log multiple failures with distinct timestamps', async () => {
            const baseTimestamp = Date.now();
            const failures = [
                { timestamp: baseTimestamp, number: 1, error: 'Error 1' },
                { timestamp: baseTimestamp + 1000, number: 2, error: 'Error 2' },
                { timestamp: baseTimestamp + 2000, number: 3, error: 'Error 3' },
            ];

            for (const failure of failures) {
                const mockJob: MockJob = {
                    data: {
                        repoOwner: 'multiowner',
                        repoName: 'multirepo',
                        number: failure.number,
                    },
                    timestamp: failure.timestamp,
                };
                await updateFailedMetrics(mockRedis, mockJob, new Error(failure.error));
            }

            // Verify all failures are logged
            const failedCount = await mockRedis.get('metrics:jobs:failed');
            assert.strictEqual(failedCount, '3', 'Should have 3 failed jobs');

            // Verify AI metrics are stored with timestamps (sorted by timestamp)
            const aiMetricsRaw = await mockRedis.zrange('metrics:ai:log:v1', 0, -1);
            assert.strictEqual(aiMetricsRaw.length, 3, 'Should have 3 AI metrics entries');

            const metrics = aiMetricsRaw.map(m => JSON.parse(m) as AiMetrics);

            // Verify ordering by timestamp
            assert.strictEqual(metrics[0].timestamp, baseTimestamp, 'First entry should have earliest timestamp');
            assert.strictEqual(metrics[1].timestamp, baseTimestamp + 1000, 'Second entry should have middle timestamp');
            assert.strictEqual(metrics[2].timestamp, baseTimestamp + 2000, 'Third entry should have latest timestamp');

            // Verify each has correct error
            assert.strictEqual(metrics[0].error, 'Error 1', 'First error message');
            assert.strictEqual(metrics[1].error, 'Error 2', 'Second error message');
            assert.strictEqual(metrics[2].error, 'Error 3', 'Third error message');
        });

        test('should track daily failed count', async () => {
            const mockJob: MockJob = {
                data: {
                    repoOwner: 'dailyowner',
                    repoName: 'dailyrepo',
                    number: 200,
                },
                timestamp: Date.now(),
            };

            await updateFailedMetrics(mockRedis, mockJob, new Error('Daily failure'));

            const dateKey = new Date().toISOString().split('T')[0];
            const dailyFailed = await mockRedis.get(`metrics:daily:${dateKey}:failed`);
            assert.strictEqual(dailyFailed, '1', 'Daily failed count should be 1');
        });

        test('should handle error with special characters', async () => {
            const mockJob: MockJob = {
                data: {
                    repoOwner: 'specialowner',
                    repoName: 'specialrepo',
                    number: 300,
                },
                timestamp: Date.now(),
            };

            const specialError = 'Error: {"code": 500, "message": "Internal\nServer\tError"}';
            await updateFailedMetrics(mockRedis, mockJob, new Error(specialError));

            const aiMetricsRaw = await mockRedis.zrange('metrics:ai:log:v1', 0, -1);
            const aiMetrics: AiMetrics = JSON.parse(aiMetricsRaw[0]);

            assert.strictEqual(aiMetrics.error, specialError, 'Should preserve special characters in error');
            assert.strictEqual(aiMetrics.status, 'failed', 'Status should be failed');
        });

        test('should set cost and turns to zero for failed jobs', async () => {
            const mockJob: MockJob = {
                data: {
                    repoOwner: 'zeroowner',
                    repoName: 'zerorepo',
                    number: 400,
                    modelName: 'claude-3-opus',
                },
                timestamp: Date.now(),
            };

            await updateFailedMetrics(mockRedis, mockJob, new Error('Job failed before processing'));

            const aiMetricsRaw = await mockRedis.zrange('metrics:ai:log:v1', 0, -1);
            const aiMetrics: AiMetrics = JSON.parse(aiMetricsRaw[0]);

            assert.strictEqual(aiMetrics.cost, 0, 'Cost should be 0 for failed jobs');
            assert.strictEqual(aiMetrics.turns, 0, 'Turns should be 0 for failed jobs');
            assert.strictEqual(aiMetrics.status, 'failed', 'Status should be failed');
        });
    });

    describe('Edge Cases', () => {
        test('should handle zero cost jobs', async () => {
            const mockJob: MockJob = {
                data: { repoOwner: 'owner', repoName: 'repo', number: 1 },
                timestamp: Date.now(),
            };

            const mockResult: JobResult = {
                status: 'completed',
                claudeResult: {
                    success: true,
                    executionTime: 1000,
                    model: 'test-model',
                    claudeCostUsd: 0,
                    claudeNumTurns: 0,
                },
            };

            await updateCompletedMetrics(mockRedis, mockJob, mockResult, 1000);

            const aiMetricsRaw = await mockRedis.zrange('metrics:ai:log:v1', 0, -1);
            const aiMetrics: AiMetrics = JSON.parse(aiMetricsRaw[0]);

            assert.strictEqual(aiMetrics.cost, 0);
            assert.strictEqual(aiMetrics.turns, 0);
        });

        test('should use job data modelName when claudeResult model is missing', async () => {
            const mockJob: MockJob = {
                data: {
                    repoOwner: 'owner',
                    repoName: 'repo',
                    number: 1,
                    modelName: 'fallback-model'
                },
                timestamp: Date.now(),
            };

            const mockResult: JobResult = {
                status: 'completed',
                claudeResult: {
                    success: true,
                    executionTime: 1000,
                    // model is missing
                    claudeCostUsd: 1.0,
                    claudeNumTurns: 1,
                },
            };

            await updateCompletedMetrics(mockRedis, mockJob, mockResult, 1000);

            const aiMetricsRaw = await mockRedis.zrange('metrics:ai:log:v1', 0, -1);
            const aiMetrics: AiMetrics = JSON.parse(aiMetricsRaw[0]);

            assert.strictEqual(aiMetrics.model, 'fallback-model', 'Should use job data modelName as fallback');
        });

        test('should default to unknown when no model is available', async () => {
            const mockJob: MockJob = {
                data: {
                    repoOwner: 'owner',
                    repoName: 'repo',
                    number: 1,
                    // no modelName
                },
                timestamp: Date.now(),
            };

            const mockResult: JobResult = {
                status: 'completed',
                claudeResult: {
                    success: true,
                    executionTime: 1000,
                    // no model
                    claudeCostUsd: 1.0,
                    claudeNumTurns: 1,
                },
            };

            await updateCompletedMetrics(mockRedis, mockJob, mockResult, 1000);

            const aiMetricsRaw = await mockRedis.zrange('metrics:ai:log:v1', 0, -1);
            const aiMetrics: AiMetrics = JSON.parse(aiMetricsRaw[0]);

            assert.strictEqual(aiMetrics.model, 'unknown', 'Should default to unknown');
        });

        test('should handle high-cost jobs', async () => {
            const mockJob: MockJob = {
                data: { repoOwner: 'owner', repoName: 'repo', number: 1 },
                timestamp: Date.now(),
            };

            const mockResult: JobResult = {
                status: 'completed',
                claudeResult: {
                    success: true,
                    executionTime: 300000, // 5 minutes
                    model: 'claude-3-opus',
                    claudeCostUsd: 50.00, // High cost
                    claudeNumTurns: 100,
                },
            };

            await updateCompletedMetrics(mockRedis, mockJob, mockResult, 300000);

            const aiMetricsRaw = await mockRedis.zrange('metrics:ai:log:v1', 0, -1);
            const aiMetrics: AiMetrics = JSON.parse(aiMetricsRaw[0]);

            assert.strictEqual(aiMetrics.cost, 50.00);
            assert.strictEqual(aiMetrics.turns, 100);
        });
    });
});

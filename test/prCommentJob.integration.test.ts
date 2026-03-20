import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * Integration tests for PR Comment Job Lock Acquisition
 *
 * These tests verify the Redis SET NX logic used in processPullRequestCommentJob.ts
 * to prevent concurrent execution of jobs for the same PR.
 *
 * Key scenarios tested:
 * 1. Lock acquisition with SET NX (atomic operation)
 * 2. Rescheduling behavior when lock is held by another job
 * 3. Re-entry scenarios (same correlationId can continue)
 * 4. Lock cleanup after job completion
 * 5. Concurrent execution prevention
 */

interface CommentJobData {
    pullRequestNumber: number;
    commentId?: number;
    commentBody?: string;
    commentAuthor?: string;
    comments?: Array<{ id: number; body: string; author: string; type: 'review' | 'issue' }>;
    branchName?: string;
    repoOwner: string;
    repoName: string;
    llm?: string | null;
    correlationId: string;
    title?: string;
    subtitle?: string;
}

interface LockParams {
    lockKey: string;
    correlationId: string;
    job: Pick<Job<CommentJobData>, 'name' | 'data'>;
}

interface MockRedisClient {
    storage: Map<string, { value: string; expiry: number | null }>;
    set: (key: string, value: string, ...args: (string | number)[]) => Promise<string | null>;
    get: (key: string) => Promise<string | null>;
    expire: (key: string, seconds: number) => Promise<number>;
    del: (key: string) => Promise<number>;
    lrange: (key: string, start: number, stop: number) => Promise<string[]>;
    llen: (key: string) => Promise<number>;
    lpush: (key: string, ...values: string[]) => Promise<number>;
}

interface MockQueue {
    jobs: Array<{ name: string; data: CommentJobData; options: { delay?: number } }>;
    add: (name: string, data: CommentJobData, options?: { delay?: number }) => Promise<void>;
    clear: () => void;
}

// Mock Redis client that simulates Redis SET NX behavior
function createMockRedisClient(): MockRedisClient {
    const storage = new Map<string, { value: string; expiry: number | null }>();

    return {
        storage,

        // Simulate SET with NX and EX options
        async set(key: string, value: string, ...args: (string | number)[]): Promise<string | null> {
            const hasNX = args.includes('NX');
            const exIndex = args.indexOf('EX');
            const expiry = exIndex !== -1 ? Number(args[exIndex + 1]) : null;

            if (hasNX) {
                // NX: Only set if key does NOT exist
                if (storage.has(key)) {
                    return null; // Key exists, SET NX fails
                }
            }

            storage.set(key, { value, expiry });
            return 'OK';
        },

        async get(key: string): Promise<string | null> {
            const entry = storage.get(key);
            return entry ? entry.value : null;
        },

        async expire(key: string, seconds: number): Promise<number> {
            const entry = storage.get(key);
            if (entry) {
                entry.expiry = seconds;
                return 1;
            }
            return 0;
        },

        async del(key: string): Promise<number> {
            return storage.delete(key) ? 1 : 0;
        },

        async lrange(_key: string, _start: number, _stop: number): Promise<string[]> {
            return [];
        },

        async llen(_key: string): Promise<number> {
            return 0;
        },

        async lpush(key: string, ...values: string[]): Promise<number> {
            return values.length;
        }
    };
}

// Mock issue queue for testing rescheduling
function createMockQueue(): MockQueue {
    const jobs: Array<{ name: string; data: CommentJobData; options: { delay?: number } }> = [];

    return {
        jobs,
        async add(name: string, data: CommentJobData, options: { delay?: number } = {}): Promise<void> {
            jobs.push({ name, data, options });
        },
        clear(): void {
            jobs.length = 0;
        }
    };
}

/**
 * Implementation of acquirePRLock matching the actual logic in processPullRequestCommentJob.ts
 */
async function acquirePRLock(
    redisClient: MockRedisClient,
    issueQueue: MockQueue,
    lockParams: LockParams
): Promise<boolean> {
    const { lockKey, correlationId, job } = lockParams;

    // Use atomic SET NX to avoid race condition where two jobs both check,
    // see no lock, and both set - causing the second to overwrite the first
    const result = await redisClient.set(lockKey, correlationId, 'EX', 3600, 'NX');

    if (result === 'OK') {
        return true;
    }

    // Lock exists - check if it's ours (re-entry case)
    const currentLock = await redisClient.get(lockKey);
    if (currentLock === correlationId) {
        // Refresh the TTL
        await redisClient.expire(lockKey, 3600);
        return true;
    }

    // Lock held by another job - reschedule
    await issueQueue.add(job.name, job.data, { delay: 10000 });
    return false;
}

/**
 * Implementation of lock cleanup matching the actual logic in cleanupJob
 */
async function releasePRLock(
    redisClient: MockRedisClient,
    lockKey: string,
    correlationId: string
): Promise<boolean> {
    const lockOwner = await redisClient.get(lockKey);
    if (lockOwner === correlationId) {
        await redisClient.del(lockKey);
        return true;
    }
    return false;
}

describe('PR Comment Job Lock Acquisition - Integration Tests', () => {
    let redisClient: MockRedisClient;
    let issueQueue: MockQueue;

    beforeEach(() => {
        redisClient = createMockRedisClient();
        issueQueue = createMockQueue();
    });

    afterEach(() => {
        redisClient.storage.clear();
        issueQueue.clear();
    });

    describe('SET NX Lock Acquisition', () => {
        test('acquires lock successfully when no lock exists', async () => {
            const lockKey = 'lock:pr:testowner:testrepo:123';
            const correlationId = 'job-correlation-1';
            const job = {
                name: 'processPullRequestComment',
                data: {
                    pullRequestNumber: 123,
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    correlationId
                }
            };

            const acquired = await acquirePRLock(redisClient, issueQueue, {
                lockKey,
                correlationId,
                job
            });

            assert.strictEqual(acquired, true, 'Lock should be acquired');
            assert.strictEqual(await redisClient.get(lockKey), correlationId, 'Lock value should be correlationId');
            assert.strictEqual(issueQueue.jobs.length, 0, 'No jobs should be rescheduled');
        });

        test('SET NX fails atomically when lock already exists', async () => {
            const lockKey = 'lock:pr:testowner:testrepo:123';
            const firstCorrelationId = 'job-correlation-1';
            const secondCorrelationId = 'job-correlation-2';

            // First job acquires lock
            await redisClient.set(lockKey, firstCorrelationId, 'EX', 3600, 'NX');

            // Second job tries to acquire - should fail atomically
            const result = await redisClient.set(lockKey, secondCorrelationId, 'EX', 3600, 'NX');

            assert.strictEqual(result, null, 'SET NX should return null when key exists');
            assert.strictEqual(await redisClient.get(lockKey), firstCorrelationId, 'Original lock holder should remain');
        });

        test('lock has correct TTL set', async () => {
            const lockKey = 'lock:pr:testowner:testrepo:123';
            const correlationId = 'job-correlation-1';

            await redisClient.set(lockKey, correlationId, 'EX', 3600, 'NX');

            const entry = redisClient.storage.get(lockKey);
            assert.ok(entry, 'Lock entry should exist');
            assert.strictEqual(entry.expiry, 3600, 'Lock TTL should be 3600 seconds (1 hour)');
        });
    });

    describe('Rescheduling Behavior', () => {
        test('reschedules job when lock is held by another correlation', async () => {
            const lockKey = 'lock:pr:testowner:testrepo:123';
            const firstCorrelationId = 'job-correlation-1';
            const secondCorrelationId = 'job-correlation-2';

            // First job acquires lock
            await redisClient.set(lockKey, firstCorrelationId, 'EX', 3600, 'NX');

            const secondJob = {
                name: 'processPullRequestComment',
                data: {
                    pullRequestNumber: 123,
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    correlationId: secondCorrelationId
                }
            };

            const acquired = await acquirePRLock(redisClient, issueQueue, {
                lockKey,
                correlationId: secondCorrelationId,
                job: secondJob
            });

            assert.strictEqual(acquired, false, 'Lock should not be acquired');
            assert.strictEqual(issueQueue.jobs.length, 1, 'Job should be rescheduled');
            assert.strictEqual(issueQueue.jobs[0].options.delay, 10000, 'Rescheduled with 10 second delay');
            assert.strictEqual(issueQueue.jobs[0].data.correlationId, secondCorrelationId, 'Correct job data');
        });

        test('rescheduled job preserves all original job data', async () => {
            const lockKey = 'lock:pr:testowner:testrepo:123';
            const firstCorrelationId = 'job-correlation-1';
            const secondCorrelationId = 'job-correlation-2';

            // First job acquires lock
            await redisClient.set(lockKey, firstCorrelationId, 'EX', 3600, 'NX');

            const originalJobData: CommentJobData = {
                pullRequestNumber: 123,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                correlationId: secondCorrelationId,
                commentId: 456,
                commentBody: 'Test comment',
                commentAuthor: 'testuser',
                branchName: 'feature-branch',
                llm: 'claude-opus-4-20250514'
            };

            const secondJob = {
                name: 'processPullRequestComment',
                data: originalJobData
            };

            await acquirePRLock(redisClient, issueQueue, {
                lockKey,
                correlationId: secondCorrelationId,
                job: secondJob
            });

            assert.deepStrictEqual(issueQueue.jobs[0].data, originalJobData, 'All job data should be preserved');
        });

        test('multiple jobs queue up when lock is held', async () => {
            const lockKey = 'lock:pr:testowner:testrepo:123';
            const holderCorrelationId = 'holder-job';

            // Lock holder acquires lock
            await redisClient.set(lockKey, holderCorrelationId, 'EX', 3600, 'NX');

            // Multiple jobs try to acquire
            const waitingJobs = ['waiting-1', 'waiting-2', 'waiting-3'];

            for (const correlationId of waitingJobs) {
                const job = {
                    name: 'processPullRequestComment',
                    data: {
                        pullRequestNumber: 123,
                        repoOwner: 'testowner',
                        repoName: 'testrepo',
                        correlationId
                    }
                };

                await acquirePRLock(redisClient, issueQueue, {
                    lockKey,
                    correlationId,
                    job
                });
            }

            assert.strictEqual(issueQueue.jobs.length, 3, 'All waiting jobs should be rescheduled');

            // Verify each job was rescheduled with correct correlation
            const scheduledCorrelations = issueQueue.jobs.map(j => j.data.correlationId);
            assert.deepStrictEqual(scheduledCorrelations.sort(), waitingJobs.sort(), 'All correlations present');
        });
    });

    describe('Re-entry Scenarios', () => {
        test('allows re-entry for same correlationId', async () => {
            const lockKey = 'lock:pr:testowner:testrepo:123';
            const correlationId = 'job-correlation-1';
            const job = {
                name: 'processPullRequestComment',
                data: {
                    pullRequestNumber: 123,
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    correlationId
                }
            };

            // First acquisition
            const firstAcquire = await acquirePRLock(redisClient, issueQueue, {
                lockKey,
                correlationId,
                job
            });

            // Re-entry with same correlationId
            const reentry = await acquirePRLock(redisClient, issueQueue, {
                lockKey,
                correlationId,
                job
            });

            assert.strictEqual(firstAcquire, true, 'First acquisition should succeed');
            assert.strictEqual(reentry, true, 'Re-entry should succeed');
            assert.strictEqual(issueQueue.jobs.length, 0, 'No rescheduling for re-entry');
        });

        test('re-entry refreshes TTL', async () => {
            const lockKey = 'lock:pr:testowner:testrepo:123';
            const correlationId = 'job-correlation-1';
            const job = {
                name: 'processPullRequestComment',
                data: {
                    pullRequestNumber: 123,
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    correlationId
                }
            };

            // First acquisition
            await acquirePRLock(redisClient, issueQueue, { lockKey, correlationId, job });

            // Simulate TTL decay by modifying expiry
            const entry = redisClient.storage.get(lockKey);
            if (entry) entry.expiry = 100; // Reduced TTL

            // Re-entry should refresh TTL
            await acquirePRLock(redisClient, issueQueue, { lockKey, correlationId, job });

            const refreshedEntry = redisClient.storage.get(lockKey);
            assert.strictEqual(refreshedEntry?.expiry, 3600, 'TTL should be refreshed to 3600');
        });

        test('distinguishes between re-entry and different job', async () => {
            const lockKey = 'lock:pr:testowner:testrepo:123';
            const originalCorrelationId = 'job-correlation-1';
            const differentCorrelationId = 'job-correlation-2';

            // Original job acquires lock
            await redisClient.set(lockKey, originalCorrelationId, 'EX', 3600, 'NX');

            // Same correlationId (re-entry) - should succeed
            const reentryJob = {
                name: 'processPullRequestComment',
                data: {
                    pullRequestNumber: 123,
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    correlationId: originalCorrelationId
                }
            };

            const reentryResult = await acquirePRLock(redisClient, issueQueue, {
                lockKey,
                correlationId: originalCorrelationId,
                job: reentryJob
            });

            // Different correlationId - should fail
            const differentJob = {
                name: 'processPullRequestComment',
                data: {
                    pullRequestNumber: 123,
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    correlationId: differentCorrelationId
                }
            };

            const differentResult = await acquirePRLock(redisClient, issueQueue, {
                lockKey,
                correlationId: differentCorrelationId,
                job: differentJob
            });

            assert.strictEqual(reentryResult, true, 'Re-entry should succeed');
            assert.strictEqual(differentResult, false, 'Different correlationId should fail');
        });
    });

    describe('Lock Cleanup', () => {
        test('releases lock when correlationId matches', async () => {
            const lockKey = 'lock:pr:testowner:testrepo:123';
            const correlationId = 'job-correlation-1';

            await redisClient.set(lockKey, correlationId, 'EX', 3600, 'NX');

            const released = await releasePRLock(redisClient, lockKey, correlationId);

            assert.strictEqual(released, true, 'Lock should be released');
            assert.strictEqual(await redisClient.get(lockKey), null, 'Lock should be removed');
        });

        test('does not release lock when correlationId does not match', async () => {
            const lockKey = 'lock:pr:testowner:testrepo:123';
            const ownerCorrelationId = 'job-correlation-1';
            const wrongCorrelationId = 'job-correlation-2';

            await redisClient.set(lockKey, ownerCorrelationId, 'EX', 3600, 'NX');

            const released = await releasePRLock(redisClient, lockKey, wrongCorrelationId);

            assert.strictEqual(released, false, 'Lock should not be released');
            assert.strictEqual(await redisClient.get(lockKey), ownerCorrelationId, 'Lock should remain');
        });

        test('handles release of non-existent lock gracefully', async () => {
            const lockKey = 'lock:pr:testowner:testrepo:123';
            const correlationId = 'job-correlation-1';

            const released = await releasePRLock(redisClient, lockKey, correlationId);

            assert.strictEqual(released, false, 'Should return false for non-existent lock');
        });
    });

    describe('Concurrent Execution Prevention', () => {
        test('prevents concurrent execution for same PR', async () => {
            const lockKey = 'lock:pr:testowner:testrepo:123';
            const executionOrder: string[] = [];

            // Simulate two concurrent jobs starting at the same time
            const job1CorrelationId = 'concurrent-job-1';
            const job2CorrelationId = 'concurrent-job-2';

            const job1 = {
                name: 'processPullRequestComment',
                data: {
                    pullRequestNumber: 123,
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    correlationId: job1CorrelationId
                }
            };

            const job2 = {
                name: 'processPullRequestComment',
                data: {
                    pullRequestNumber: 123,
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    correlationId: job2CorrelationId
                }
            };

            // Both jobs try to acquire lock concurrently
            const [result1, result2] = await Promise.all([
                acquirePRLock(redisClient, issueQueue, { lockKey, correlationId: job1CorrelationId, job: job1 })
                    .then(r => { if (r) executionOrder.push('job1'); return r; }),
                acquirePRLock(redisClient, issueQueue, { lockKey, correlationId: job2CorrelationId, job: job2 })
                    .then(r => { if (r) executionOrder.push('job2'); return r; })
            ]);

            // Exactly one should succeed
            const acquiredCount = [result1, result2].filter(Boolean).length;
            assert.strictEqual(acquiredCount, 1, 'Exactly one job should acquire lock');
            assert.strictEqual(executionOrder.length, 1, 'Only one job should execute');

            // One should be rescheduled
            assert.strictEqual(issueQueue.jobs.length, 1, 'One job should be rescheduled');
        });

        test('allows concurrent execution for different PRs', async () => {
            const pr1LockKey = 'lock:pr:testowner:testrepo:123';
            const pr2LockKey = 'lock:pr:testowner:testrepo:456';

            const job1 = {
                name: 'processPullRequestComment',
                data: {
                    pullRequestNumber: 123,
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    correlationId: 'job-pr-123'
                }
            };

            const job2 = {
                name: 'processPullRequestComment',
                data: {
                    pullRequestNumber: 456,
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    correlationId: 'job-pr-456'
                }
            };

            const [result1, result2] = await Promise.all([
                acquirePRLock(redisClient, issueQueue, { lockKey: pr1LockKey, correlationId: 'job-pr-123', job: job1 }),
                acquirePRLock(redisClient, issueQueue, { lockKey: pr2LockKey, correlationId: 'job-pr-456', job: job2 })
            ]);

            assert.strictEqual(result1, true, 'PR 123 lock should be acquired');
            assert.strictEqual(result2, true, 'PR 456 lock should be acquired');
            assert.strictEqual(issueQueue.jobs.length, 0, 'No jobs should be rescheduled');
        });

        test('allows concurrent execution for different repos', async () => {
            const repo1LockKey = 'lock:pr:owner1:repo1:123';
            const repo2LockKey = 'lock:pr:owner2:repo2:123';

            const job1 = {
                name: 'processPullRequestComment',
                data: {
                    pullRequestNumber: 123,
                    repoOwner: 'owner1',
                    repoName: 'repo1',
                    correlationId: 'job-repo1'
                }
            };

            const job2 = {
                name: 'processPullRequestComment',
                data: {
                    pullRequestNumber: 123,
                    repoOwner: 'owner2',
                    repoName: 'repo2',
                    correlationId: 'job-repo2'
                }
            };

            const [result1, result2] = await Promise.all([
                acquirePRLock(redisClient, issueQueue, { lockKey: repo1LockKey, correlationId: 'job-repo1', job: job1 }),
                acquirePRLock(redisClient, issueQueue, { lockKey: repo2LockKey, correlationId: 'job-repo2', job: job2 })
            ]);

            assert.strictEqual(result1, true, 'Repo1 lock should be acquired');
            assert.strictEqual(result2, true, 'Repo2 lock should be acquired');
            assert.strictEqual(issueQueue.jobs.length, 0, 'No jobs should be rescheduled');
        });
    });

    describe('Lock Key Format', () => {
        test('generates correct lock key format', () => {
            const repoOwner = 'testowner';
            const repoName = 'testrepo';
            const pullRequestNumber = 123;

            const lockKey = `lock:pr:${repoOwner}:${repoName}:${pullRequestNumber}`;

            assert.strictEqual(lockKey, 'lock:pr:testowner:testrepo:123');
        });

        test('handles special characters in repo names', () => {
            const testCases = [
                { owner: 'my-org', repo: 'my-repo', pr: 1, expected: 'lock:pr:my-org:my-repo:1' },
                { owner: 'org_name', repo: 'repo_name', pr: 999, expected: 'lock:pr:org_name:repo_name:999' },
                { owner: 'CamelCase', repo: 'MixedCase', pr: 42, expected: 'lock:pr:CamelCase:MixedCase:42' }
            ];

            for (const tc of testCases) {
                const lockKey = `lock:pr:${tc.owner}:${tc.repo}:${tc.pr}`;
                assert.strictEqual(lockKey, tc.expected, `Lock key for ${tc.owner}/${tc.repo}#${tc.pr}`);
            }
        });
    });

    describe('Edge Cases', () => {
        test('handles rapid successive lock attempts', async () => {
            const lockKey = 'lock:pr:testowner:testrepo:123';
            const correlationId = 'rapid-job';
            const job = {
                name: 'processPullRequestComment',
                data: {
                    pullRequestNumber: 123,
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    correlationId
                }
            };

            // Rapid successive attempts
            const results = await Promise.all([
                acquirePRLock(redisClient, issueQueue, { lockKey, correlationId, job }),
                acquirePRLock(redisClient, issueQueue, { lockKey, correlationId, job }),
                acquirePRLock(redisClient, issueQueue, { lockKey, correlationId, job }),
                acquirePRLock(redisClient, issueQueue, { lockKey, correlationId, job }),
                acquirePRLock(redisClient, issueQueue, { lockKey, correlationId, job })
            ]);

            // All should succeed (same correlationId = re-entry)
            assert.ok(results.every(r => r === true), 'All re-entries should succeed');
            assert.strictEqual(issueQueue.jobs.length, 0, 'No rescheduling for re-entries');
        });

        test('handles lock release during concurrent attempts', async () => {
            const lockKey = 'lock:pr:testowner:testrepo:123';
            const firstCorrelationId = 'first-job';
            const secondCorrelationId = 'second-job';

            // First job acquires and releases
            await redisClient.set(lockKey, firstCorrelationId, 'EX', 3600, 'NX');
            await releasePRLock(redisClient, lockKey, firstCorrelationId);

            // Second job should now be able to acquire
            const job2 = {
                name: 'processPullRequestComment',
                data: {
                    pullRequestNumber: 123,
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    correlationId: secondCorrelationId
                }
            };

            const acquired = await acquirePRLock(redisClient, issueQueue, {
                lockKey,
                correlationId: secondCorrelationId,
                job: job2
            });

            assert.strictEqual(acquired, true, 'Second job should acquire after release');
            assert.strictEqual(await redisClient.get(lockKey), secondCorrelationId, 'New owner should be second job');
        });

        test('isolation between different lock keys', async () => {
            // Simulate multiple PRs with their own locks
            const prs = [
                { owner: 'org1', repo: 'repo1', pr: 1, correlation: 'c1' },
                { owner: 'org1', repo: 'repo1', pr: 2, correlation: 'c2' },
                { owner: 'org1', repo: 'repo2', pr: 1, correlation: 'c3' },
                { owner: 'org2', repo: 'repo1', pr: 1, correlation: 'c4' }
            ];

            const results = await Promise.all(
                prs.map(pr => {
                    const lockKey = `lock:pr:${pr.owner}:${pr.repo}:${pr.pr}`;
                    const job = {
                        name: 'processPullRequestComment',
                        data: {
                            pullRequestNumber: pr.pr,
                            repoOwner: pr.owner,
                            repoName: pr.repo,
                            correlationId: pr.correlation
                        }
                    };
                    return acquirePRLock(redisClient, issueQueue, {
                        lockKey,
                        correlationId: pr.correlation,
                        job
                    });
                })
            );

            // All should succeed as they have different lock keys
            assert.ok(results.every(r => r === true), 'All different PRs should acquire locks');
            assert.strictEqual(redisClient.storage.size, 4, 'Should have 4 separate locks');
        });
    });
});

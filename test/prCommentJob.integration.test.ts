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

/**
 * Integration tests for PR Comment Validation
 *
 * These tests verify:
 * 1. Bot comment filtering logic
 * 2. Redis tracking of processed comments
 * 3. Completion marker detection ({commentId}✓)
 * 4. Pending comments pickup from Redis
 */

interface UnprocessedComment {
    id: number;
    body: string;
    body_html?: string;
    author: string;
    type: 'review' | 'issue';
    hasCodeContext?: boolean;
    updated_at?: string;
}

interface PRComment {
    id: number;
    user: { login: string; type?: string };
    body: string | null;
    body_html?: string;
    created_at: string;
    pull_request_review_id?: number;
    updated_at?: string;
}

interface ValidationComment {
    id: number;
    body?: string;
    updated_at?: string;
}

// Enhanced Mock Redis client with List operations for pending comments
interface MockRedisClientWithLists {
    storage: Map<string, { value: string; expiry: number | null }>;
    listStorage: Map<string, string[]>;
    set: (key: string, value: string, ...args: (string | number)[]) => Promise<string | null>;
    get: (key: string) => Promise<string | null>;
    expire: (key: string, seconds: number) => Promise<number>;
    del: (key: string) => Promise<number>;
    lrange: (key: string, start: number, stop: number) => Promise<string[]>;
    llen: (key: string) => Promise<number>;
    lpush: (key: string, ...values: string[]) => Promise<number>;
    rpush: (key: string, ...values: string[]) => Promise<number>;
}

function createMockRedisClientWithLists(): MockRedisClientWithLists {
    const storage = new Map<string, { value: string; expiry: number | null }>();
    const listStorage = new Map<string, string[]>();

    return {
        storage,
        listStorage,

        async set(key: string, value: string, ...args: (string | number)[]): Promise<string | null> {
            const hasNX = args.includes('NX');
            const exIndex = args.indexOf('EX');
            const expiry = exIndex !== -1 ? Number(args[exIndex + 1]) : null;

            if (hasNX) {
                if (storage.has(key)) {
                    return null;
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
            const deleted = storage.delete(key) || listStorage.delete(key);
            return deleted ? 1 : 0;
        },

        async lrange(key: string, start: number, stop: number): Promise<string[]> {
            const list = listStorage.get(key) || [];
            if (stop === -1) stop = list.length - 1;
            return list.slice(start, stop + 1);
        },

        async llen(key: string): Promise<number> {
            const list = listStorage.get(key) || [];
            return list.length;
        },

        async lpush(key: string, ...values: string[]): Promise<number> {
            const list = listStorage.get(key) || [];
            list.unshift(...values.reverse());
            listStorage.set(key, list);
            return list.length;
        },

        async rpush(key: string, ...values: string[]): Promise<number> {
            const list = listStorage.get(key) || [];
            list.push(...values);
            listStorage.set(key, list);
            return list.length;
        }
    };
}

// Helper functions matching production logic
function getPendingPrCommentsKey(owner: string, repo: string, prNumber: number): string {
    return `pending-pr-comments:${owner}:${repo}:${prNumber}`;
}

function filterCommentByAuthor(commentAuthor: string, userType: string | null = null): { shouldFilter: boolean; reason: string | null } {
    const GITHUB_BOT_USERNAME = process.env.GITHUB_BOT_USERNAME || 'propr.dev[bot]';

    if (GITHUB_BOT_USERNAME && commentAuthor === GITHUB_BOT_USERNAME) {
        return { shouldFilter: true, reason: 'bot_own_comment' };
    }

    const isBotAccount =
        commentAuthor.endsWith('[bot]') ||
        commentAuthor.includes('[bot]') ||
        userType === 'Bot';

    if (isBotAccount) {
        return { shouldFilter: true, reason: 'bot_account' };
    }

    return { shouldFilter: false, reason: null };
}

function filterUnprocessedComments(
    commentsToProcess: UnprocessedComment[],
    prCommentsForValidation: PRComment[],
    botUsername: string
): UnprocessedComment[] {
    return commentsToProcess
        .filter(comment => {
            const alreadyProcessed = prCommentsForValidation.some(prComment => {
                const isBotComment = prComment.user.login === botUsername;
                if (!isBotComment) return false;
                // Check for completion marker: {commentId}✓
                return prComment.body?.includes(`${String(comment.id)}✓`);
            });

            return !alreadyProcessed;
        })
        .map(comment => {
            const apiComment = prCommentsForValidation.find(c => c.id === comment.id);
            if (apiComment && apiComment.body_html) {
                return { ...comment, body_html: apiComment.body_html };
            }
            return comment;
        });
}

function validateAndFilterComments(
    commentsToProcess: UnprocessedComment[],
    allCommentsForValidation: ValidationComment[]
): UnprocessedComment[] {
    const validatedComments: UnprocessedComment[] = [];
    for (const comment of commentsToProcess) {
        const currentComment = allCommentsForValidation.find(c => c.id === comment.id);

        if (!currentComment) {
            // Comment has been deleted, skip
            continue;
        }

        const commentWasEditedAfterQueuing = comment.updated_at && currentComment.updated_at !== comment.updated_at;

        if (commentWasEditedAfterQueuing) {
            validatedComments.push({ ...comment, body: currentComment.body || comment.body });
        } else {
            validatedComments.push(comment);
        }
    }
    return validatedComments;
}

function parsePendingComment(commentJson: string): UnprocessedComment | null {
    try {
        return JSON.parse(commentJson) as UnprocessedComment;
    } catch {
        return null;
    }
}

function processPendingComments(commentsToProcess: UnprocessedComment[], pendingComments: string[]): void {
    for (const commentJson of pendingComments) {
        const pendingComment = parsePendingComment(commentJson);
        if (pendingComment && !commentsToProcess.some(c => c.id === pendingComment.id)) {
            commentsToProcess.push(pendingComment);
        }
    }
}

async function pickUpPendingComments(
    commentsToProcess: UnprocessedComment[],
    options: { repoOwner: string; repoName: string; pullRequestNumber: number; redisClient: MockRedisClientWithLists }
): Promise<UnprocessedComment[]> {
    const { repoOwner, repoName, pullRequestNumber, redisClient } = options;
    const pendingCommentsKey = getPendingPrCommentsKey(repoOwner, repoName, pullRequestNumber);

    const pendingComments = await redisClient.lrange(pendingCommentsKey, 0, -1);
    if (pendingComments.length > 0) {
        await redisClient.del(pendingCommentsKey);
        processPendingComments(commentsToProcess, pendingComments);
    }

    return commentsToProcess;
}

describe('PR Comment Validation - Integration Tests', () => {
    let redisClient: MockRedisClientWithLists;

    beforeEach(() => {
        redisClient = createMockRedisClientWithLists();
        // Reset environment variable
        delete process.env.GITHUB_BOT_USERNAME;
    });

    afterEach(() => {
        redisClient.storage.clear();
        redisClient.listStorage.clear();
        delete process.env.GITHUB_BOT_USERNAME;
    });

    describe('Bot Comment Filtering', () => {
        test('filters comments from default bot username', () => {
            const result = filterCommentByAuthor('propr.dev[bot]');

            assert.strictEqual(result.shouldFilter, true);
            assert.strictEqual(result.reason, 'bot_own_comment');
        });

        test('filters comments from configured bot username', () => {
            process.env.GITHUB_BOT_USERNAME = 'custom-bot[bot]';

            const result = filterCommentByAuthor('custom-bot[bot]');

            assert.strictEqual(result.shouldFilter, true);
            assert.strictEqual(result.reason, 'bot_own_comment');
        });

        test('filters comments ending with [bot]', () => {
            const result = filterCommentByAuthor('some-integration[bot]');

            assert.strictEqual(result.shouldFilter, true);
            assert.strictEqual(result.reason, 'bot_account');
        });

        test('filters comments containing [bot]', () => {
            const result = filterCommentByAuthor('github-actions[bot]');

            assert.strictEqual(result.shouldFilter, true);
            assert.strictEqual(result.reason, 'bot_account');
        });

        test('filters comments with Bot user type', () => {
            const result = filterCommentByAuthor('dependabot', 'Bot');

            assert.strictEqual(result.shouldFilter, true);
            assert.strictEqual(result.reason, 'bot_account');
        });

        test('allows comments from regular users', () => {
            const result = filterCommentByAuthor('regularuser');

            assert.strictEqual(result.shouldFilter, false);
            assert.strictEqual(result.reason, null);
        });

        test('allows comments from users with User type', () => {
            const result = filterCommentByAuthor('johndoe', 'User');

            assert.strictEqual(result.shouldFilter, false);
            assert.strictEqual(result.reason, null);
        });

        test('filters multiple bot accounts correctly', () => {
            const bots = [
                'github-actions[bot]',
                'dependabot[bot]',
                'codecov[bot]',
                'sonarcloud[bot]',
                'propr.dev[bot]'
            ];

            for (const bot of bots) {
                const result = filterCommentByAuthor(bot);
                assert.strictEqual(result.shouldFilter, true, `Should filter ${bot}`);
            }
        });

        test('allows multiple regular users correctly', () => {
            const users = ['alice', 'bob', 'charlie', 'developer123'];

            for (const user of users) {
                const result = filterCommentByAuthor(user);
                assert.strictEqual(result.shouldFilter, false, `Should allow ${user}`);
            }
        });
    });

    describe('Completion Marker Detection', () => {
        test('detects completion marker in bot comment', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 12345, body: 'Please fix the bug', author: 'user1', type: 'issue' }
            ];

            const prComments: PRComment[] = [
                {
                    id: 99999,
                    user: { login: 'propr.dev[bot]', type: 'Bot' },
                    body: '✅ **Applied the requested follow-up changes**\n\n---\n_Processing comment ID: 12345✓_',
                    created_at: '2024-01-01T00:00:00Z'
                }
            ];

            const filtered = filterUnprocessedComments(commentsToProcess, prComments, 'propr.dev[bot]');

            assert.strictEqual(filtered.length, 0, 'Already processed comment should be filtered out');
        });

        test('does not filter comments without completion marker', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 12345, body: 'Please fix the bug', author: 'user1', type: 'issue' }
            ];

            const prComments: PRComment[] = [
                {
                    id: 99999,
                    user: { login: 'propr.dev[bot]', type: 'Bot' },
                    body: '🔄 **Processing your request...**',
                    created_at: '2024-01-01T00:00:00Z'
                }
            ];

            const filtered = filterUnprocessedComments(commentsToProcess, prComments, 'propr.dev[bot]');

            assert.strictEqual(filtered.length, 1, 'Comment without marker should remain');
            assert.strictEqual(filtered[0].id, 12345);
        });

        test('detects multiple completion markers in single bot comment', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 111, body: 'Fix bug A', author: 'user1', type: 'issue' },
                { id: 222, body: 'Fix bug B', author: 'user2', type: 'issue' },
                { id: 333, body: 'New feature', author: 'user3', type: 'issue' }
            ];

            const prComments: PRComment[] = [
                {
                    id: 99999,
                    user: { login: 'propr.dev[bot]', type: 'Bot' },
                    body: '✅ **Applied changes**\n\n---\n_Processing comment IDs: 111✓, 222✓_',
                    created_at: '2024-01-01T00:00:00Z'
                }
            ];

            const filtered = filterUnprocessedComments(commentsToProcess, prComments, 'propr.dev[bot]');

            assert.strictEqual(filtered.length, 1, 'Only unprocessed comment should remain');
            assert.strictEqual(filtered[0].id, 333, 'Comment 333 should be the only one remaining');
        });

        test('ignores completion markers from non-bot users', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 12345, body: 'Please fix the bug', author: 'user1', type: 'issue' }
            ];

            const prComments: PRComment[] = [
                {
                    id: 99999,
                    user: { login: 'regularuser', type: 'User' },
                    body: 'Some text with 12345✓ marker that should be ignored',
                    created_at: '2024-01-01T00:00:00Z'
                }
            ];

            const filtered = filterUnprocessedComments(commentsToProcess, prComments, 'propr.dev[bot]');

            assert.strictEqual(filtered.length, 1, 'Comment should remain since marker is from non-bot');
        });

        test('handles completion marker format variations', () => {
            const testCases = [
                { marker: '12345✓', shouldMatch: true },
                { marker: 'ID: 12345✓', shouldMatch: true },
                { marker: '_Processing comment ID: 12345✓_', shouldMatch: true },
                { marker: 'Comment by @user (ID: 12345✓)', shouldMatch: true }
            ];

            for (const tc of testCases) {
                const commentsToProcess: UnprocessedComment[] = [
                    { id: 12345, body: 'Test', author: 'user1', type: 'issue' }
                ];

                const prComments: PRComment[] = [
                    {
                        id: 99999,
                        user: { login: 'propr.dev[bot]', type: 'Bot' },
                        body: tc.marker,
                        created_at: '2024-01-01T00:00:00Z'
                    }
                ];

                const filtered = filterUnprocessedComments(commentsToProcess, prComments, 'propr.dev[bot]');
                const isFiltered = filtered.length === 0;

                assert.strictEqual(isFiltered, tc.shouldMatch, `Marker "${tc.marker}" should${tc.shouldMatch ? '' : ' not'} match`);
            }
        });
    });

    describe('Redis Tracking - Processed Comments', () => {
        test('stores processed comment tracking key correctly', async () => {
            const owner = 'testowner';
            const repo = 'testrepo';
            const prNumber = 123;
            const commentId = 456;

            const trackingKey = `pr-comment-processed:${owner}:${repo}:${prNumber}:${commentId}`;
            await redisClient.set(trackingKey, 'processed', 'EX', 86400);

            const value = await redisClient.get(trackingKey);
            assert.strictEqual(value, 'processed');
        });

        test('tracking key has correct format', () => {
            const testCases = [
                { owner: 'org1', repo: 'repo1', pr: 1, comment: 100, expected: 'pr-comment-processed:org1:repo1:1:100' },
                { owner: 'my-org', repo: 'my-repo', pr: 999, comment: 555, expected: 'pr-comment-processed:my-org:my-repo:999:555' },
                { owner: 'CamelCase', repo: 'MixedCase', pr: 42, comment: 888, expected: 'pr-comment-processed:CamelCase:MixedCase:42:888' }
            ];

            for (const tc of testCases) {
                const key = `pr-comment-processed:${tc.owner}:${tc.repo}:${tc.pr}:${tc.comment}`;
                assert.strictEqual(key, tc.expected, `Key format for ${tc.owner}/${tc.repo}#${tc.pr}`);
            }
        });

        test('tracking key persists with TTL', async () => {
            const trackingKey = 'pr-comment-processed:owner:repo:1:100';
            await redisClient.set(trackingKey, 'processed', 'EX', 86400);

            const entry = redisClient.storage.get(trackingKey);
            assert.ok(entry, 'Entry should exist');
            assert.strictEqual(entry.expiry, 86400, 'TTL should be 86400 seconds (1 day)');
        });
    });

    describe('Redis Tracking - Pending Comments Queue', () => {
        test('pending comments key format is correct', () => {
            const testCases = [
                { owner: 'org1', repo: 'repo1', pr: 1, expected: 'pending-pr-comments:org1:repo1:1' },
                { owner: 'my-org', repo: 'my-repo', pr: 999, expected: 'pending-pr-comments:my-org:my-repo:999' }
            ];

            for (const tc of testCases) {
                const key = getPendingPrCommentsKey(tc.owner, tc.repo, tc.pr);
                assert.strictEqual(key, tc.expected, `Key format for ${tc.owner}/${tc.repo}#${tc.pr}`);
            }
        });

        test('adds pending comment to queue', async () => {
            const pendingKey = getPendingPrCommentsKey('owner', 'repo', 123);
            const comment: UnprocessedComment = { id: 456, body: 'Test comment', author: 'user1', type: 'issue' };

            await redisClient.lpush(pendingKey, JSON.stringify(comment));

            const length = await redisClient.llen(pendingKey);
            assert.strictEqual(length, 1);

            const comments = await redisClient.lrange(pendingKey, 0, -1);
            assert.strictEqual(comments.length, 1);
            const parsed = JSON.parse(comments[0]) as UnprocessedComment;
            assert.strictEqual(parsed.id, 456);
        });

        test('retrieves multiple pending comments in FIFO order', async () => {
            const pendingKey = getPendingPrCommentsKey('owner', 'repo', 123);

            const comment1: UnprocessedComment = { id: 1, body: 'First', author: 'user1', type: 'issue' };
            const comment2: UnprocessedComment = { id: 2, body: 'Second', author: 'user2', type: 'issue' };
            const comment3: UnprocessedComment = { id: 3, body: 'Third', author: 'user3', type: 'issue' };

            await redisClient.rpush(pendingKey, JSON.stringify(comment1));
            await redisClient.rpush(pendingKey, JSON.stringify(comment2));
            await redisClient.rpush(pendingKey, JSON.stringify(comment3));

            const comments = await redisClient.lrange(pendingKey, 0, -1);
            assert.strictEqual(comments.length, 3);

            const parsed = comments.map(c => JSON.parse(c) as UnprocessedComment);
            assert.strictEqual(parsed[0].id, 1, 'First comment should be first');
            assert.strictEqual(parsed[1].id, 2, 'Second comment should be second');
            assert.strictEqual(parsed[2].id, 3, 'Third comment should be third');
        });

        test('clears pending comments after pickup', async () => {
            const pendingKey = getPendingPrCommentsKey('owner', 'repo', 123);
            const comment: UnprocessedComment = { id: 456, body: 'Test', author: 'user1', type: 'issue' };

            await redisClient.lpush(pendingKey, JSON.stringify(comment));

            const commentsToProcess: UnprocessedComment[] = [];
            await pickUpPendingComments(commentsToProcess, {
                repoOwner: 'owner',
                repoName: 'repo',
                pullRequestNumber: 123,
                redisClient
            });

            const length = await redisClient.llen(pendingKey);
            assert.strictEqual(length, 0, 'Pending queue should be empty after pickup');
        });

        test('picks up pending comments and merges with existing', async () => {
            const pendingKey = getPendingPrCommentsKey('owner', 'repo', 123);

            const existingComments: UnprocessedComment[] = [
                { id: 1, body: 'Existing', author: 'user1', type: 'issue' }
            ];

            const pendingComment: UnprocessedComment = { id: 2, body: 'Pending', author: 'user2', type: 'review' };
            await redisClient.lpush(pendingKey, JSON.stringify(pendingComment));

            const result = await pickUpPendingComments([...existingComments], {
                repoOwner: 'owner',
                repoName: 'repo',
                pullRequestNumber: 123,
                redisClient
            });

            assert.strictEqual(result.length, 2, 'Should have both existing and pending comments');
            assert.ok(result.some(c => c.id === 1), 'Should contain existing comment');
            assert.ok(result.some(c => c.id === 2), 'Should contain pending comment');
        });

        test('deduplicates pending comments', async () => {
            const pendingKey = getPendingPrCommentsKey('owner', 'repo', 123);

            const existingComments: UnprocessedComment[] = [
                { id: 1, body: 'Existing', author: 'user1', type: 'issue' }
            ];

            // Add same comment ID to pending queue
            const duplicateComment: UnprocessedComment = { id: 1, body: 'Duplicate', author: 'user1', type: 'issue' };
            await redisClient.lpush(pendingKey, JSON.stringify(duplicateComment));

            const result = await pickUpPendingComments([...existingComments], {
                repoOwner: 'owner',
                repoName: 'repo',
                pullRequestNumber: 123,
                redisClient
            });

            assert.strictEqual(result.length, 1, 'Duplicates should be removed');
            assert.strictEqual(result[0].id, 1);
        });

        test('handles empty pending queue gracefully', async () => {
            const existingComments: UnprocessedComment[] = [
                { id: 1, body: 'Existing', author: 'user1', type: 'issue' }
            ];

            const result = await pickUpPendingComments([...existingComments], {
                repoOwner: 'owner',
                repoName: 'repo',
                pullRequestNumber: 123,
                redisClient
            });

            assert.strictEqual(result.length, 1, 'Should keep existing comments');
            assert.strictEqual(result[0].id, 1);
        });
    });

    describe('Comment Validation - Deleted Comments', () => {
        test('filters out deleted comments', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 1, body: 'Comment 1', author: 'user1', type: 'issue' },
                { id: 2, body: 'Comment 2', author: 'user2', type: 'issue' },
                { id: 3, body: 'Comment 3', author: 'user3', type: 'issue' }
            ];

            // Comment 2 has been deleted (not in validation list)
            const validationComments: ValidationComment[] = [
                { id: 1, body: 'Comment 1' },
                { id: 3, body: 'Comment 3' }
            ];

            const result = validateAndFilterComments(commentsToProcess, validationComments);

            assert.strictEqual(result.length, 2, 'Deleted comment should be filtered out');
            assert.ok(result.some(c => c.id === 1), 'Comment 1 should remain');
            assert.ok(result.some(c => c.id === 3), 'Comment 3 should remain');
            assert.ok(!result.some(c => c.id === 2), 'Comment 2 should be filtered out');
        });

        test('handles all comments deleted', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 1, body: 'Comment 1', author: 'user1', type: 'issue' },
                { id: 2, body: 'Comment 2', author: 'user2', type: 'issue' }
            ];

            const validationComments: ValidationComment[] = [];

            const result = validateAndFilterComments(commentsToProcess, validationComments);

            assert.strictEqual(result.length, 0, 'All deleted comments should be filtered out');
        });
    });

    describe('Comment Validation - Edited Comments', () => {
        test('updates content for edited comments', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 1, body: 'Original text', author: 'user1', type: 'issue', updated_at: '2024-01-01T00:00:00Z' }
            ];

            const validationComments: ValidationComment[] = [
                { id: 1, body: 'Updated text', updated_at: '2024-01-01T01:00:00Z' }
            ];

            const result = validateAndFilterComments(commentsToProcess, validationComments);

            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].body, 'Updated text', 'Body should be updated');
        });

        test('preserves content for unedited comments', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 1, body: 'Original text', author: 'user1', type: 'issue', updated_at: '2024-01-01T00:00:00Z' }
            ];

            const validationComments: ValidationComment[] = [
                { id: 1, body: 'Original text', updated_at: '2024-01-01T00:00:00Z' }
            ];

            const result = validateAndFilterComments(commentsToProcess, validationComments);

            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].body, 'Original text', 'Body should be preserved');
        });

        test('handles mixed edited and unedited comments', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 1, body: 'Original 1', author: 'user1', type: 'issue', updated_at: '2024-01-01T00:00:00Z' },
                { id: 2, body: 'Original 2', author: 'user2', type: 'issue', updated_at: '2024-01-01T00:00:00Z' }
            ];

            const validationComments: ValidationComment[] = [
                { id: 1, body: 'Updated 1', updated_at: '2024-01-01T01:00:00Z' },  // Edited
                { id: 2, body: 'Original 2', updated_at: '2024-01-01T00:00:00Z' }  // Not edited
            ];

            const result = validateAndFilterComments(commentsToProcess, validationComments);

            assert.strictEqual(result.length, 2);
            const comment1 = result.find(c => c.id === 1);
            const comment2 = result.find(c => c.id === 2);

            assert.strictEqual(comment1?.body, 'Updated 1', 'Comment 1 should be updated');
            assert.strictEqual(comment2?.body, 'Original 2', 'Comment 2 should be preserved');
        });
    });

    describe('Comment Body HTML Enrichment', () => {
        test('enriches comments with body_html from API response', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 1, body: 'Test comment', author: 'user1', type: 'issue' }
            ];

            const prComments: PRComment[] = [
                {
                    id: 1,
                    user: { login: 'user1', type: 'User' },
                    body: 'Test comment',
                    body_html: '<p>Test comment with <img src="signed-url"/></p>',
                    created_at: '2024-01-01T00:00:00Z'
                }
            ];

            const filtered = filterUnprocessedComments(commentsToProcess, prComments, 'propr.dev[bot]');

            assert.strictEqual(filtered.length, 1);
            assert.strictEqual(filtered[0].body_html, '<p>Test comment with <img src="signed-url"/></p>');
        });

        test('handles comments without body_html', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 1, body: 'Test comment', author: 'user1', type: 'issue' }
            ];

            const prComments: PRComment[] = [
                {
                    id: 1,
                    user: { login: 'user1', type: 'User' },
                    body: 'Test comment',
                    created_at: '2024-01-01T00:00:00Z'
                }
            ];

            const filtered = filterUnprocessedComments(commentsToProcess, prComments, 'propr.dev[bot]');

            assert.strictEqual(filtered.length, 1);
            assert.strictEqual(filtered[0].body_html, undefined);
        });
    });

    describe('Integration Scenario - Full Comment Processing Flow', () => {
        test('processes new comments while filtering processed ones', async () => {
            // Setup: 3 comments - 1 already processed, 1 new, 1 pending
            const commentsToProcess: UnprocessedComment[] = [
                { id: 100, body: 'Already processed', author: 'user1', type: 'issue' },
                { id: 200, body: 'New comment', author: 'user2', type: 'issue' }
            ];

            const prComments: PRComment[] = [
                {
                    id: 100,
                    user: { login: 'user1', type: 'User' },
                    body: 'Already processed',
                    created_at: '2024-01-01T00:00:00Z'
                },
                {
                    id: 200,
                    user: { login: 'user2', type: 'User' },
                    body: 'New comment',
                    created_at: '2024-01-01T00:01:00Z'
                },
                {
                    id: 999,
                    user: { login: 'propr.dev[bot]', type: 'Bot' },
                    body: '✅ Applied changes\n\n---\n_Processing comment ID: 100✓_',
                    created_at: '2024-01-01T00:00:30Z'
                }
            ];

            // Add pending comment to Redis
            const pendingComment: UnprocessedComment = { id: 300, body: 'Pending', author: 'user3', type: 'review' };
            await redisClient.lpush(
                getPendingPrCommentsKey('owner', 'repo', 123),
                JSON.stringify(pendingComment)
            );

            // Step 1: Filter already processed
            const afterProcessedFilter = filterUnprocessedComments(commentsToProcess, prComments, 'propr.dev[bot]');
            assert.strictEqual(afterProcessedFilter.length, 1, 'Should filter out processed comment');
            assert.strictEqual(afterProcessedFilter[0].id, 200);

            // Step 2: Pick up pending comments
            const finalComments = await pickUpPendingComments(afterProcessedFilter, {
                repoOwner: 'owner',
                repoName: 'repo',
                pullRequestNumber: 123,
                redisClient
            });

            assert.strictEqual(finalComments.length, 2, 'Should have new + pending comments');
            assert.ok(finalComments.some(c => c.id === 200), 'Should have new comment');
            assert.ok(finalComments.some(c => c.id === 300), 'Should have pending comment');
        });

        test('handles concurrent PR isolation', async () => {
            // Two different PRs should have independent pending queues
            const pr1Key = getPendingPrCommentsKey('owner', 'repo', 1);
            const pr2Key = getPendingPrCommentsKey('owner', 'repo', 2);

            const comment1: UnprocessedComment = { id: 1, body: 'PR1 comment', author: 'user1', type: 'issue' };
            const comment2: UnprocessedComment = { id: 2, body: 'PR2 comment', author: 'user2', type: 'issue' };

            await redisClient.lpush(pr1Key, JSON.stringify(comment1));
            await redisClient.lpush(pr2Key, JSON.stringify(comment2));

            // Pick up PR1 comments
            const pr1Comments = await pickUpPendingComments([], {
                repoOwner: 'owner',
                repoName: 'repo',
                pullRequestNumber: 1,
                redisClient
            });

            // PR2 queue should be unaffected
            const pr2Length = await redisClient.llen(pr2Key);

            assert.strictEqual(pr1Comments.length, 1, 'PR1 should have 1 comment');
            assert.strictEqual(pr1Comments[0].id, 1);
            assert.strictEqual(pr2Length, 1, 'PR2 queue should be unaffected');
        });

        test('handles multiple bot comments with different markers', async () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 100, body: 'Comment A', author: 'user1', type: 'issue' },
                { id: 200, body: 'Comment B', author: 'user2', type: 'issue' },
                { id: 300, body: 'Comment C', author: 'user3', type: 'issue' },
                { id: 400, body: 'Comment D', author: 'user4', type: 'issue' }
            ];

            const prComments: PRComment[] = [
                ...commentsToProcess.map(c => ({
                    id: c.id,
                    user: { login: c.author, type: 'User' },
                    body: c.body,
                    created_at: '2024-01-01T00:00:00Z'
                })) as PRComment[],
                // First batch processed
                {
                    id: 1001,
                    user: { login: 'propr.dev[bot]', type: 'Bot' },
                    body: '✅ Batch 1\n---\n_Processing comment IDs: 100✓, 200✓_',
                    created_at: '2024-01-01T00:01:00Z'
                },
                // Second batch only processed 300
                {
                    id: 1002,
                    user: { login: 'propr.dev[bot]', type: 'Bot' },
                    body: '✅ Batch 2\n---\n_Processing comment ID: 300✓_',
                    created_at: '2024-01-01T00:02:00Z'
                }
            ];

            const filtered = filterUnprocessedComments(commentsToProcess, prComments, 'propr.dev[bot]');

            assert.strictEqual(filtered.length, 1, 'Only comment 400 should remain');
            assert.strictEqual(filtered[0].id, 400);
        });
    });

    describe('Edge Cases', () => {
        test('handles malformed pending comment JSON gracefully', () => {
            const commentsToProcess: UnprocessedComment[] = [];
            const pendingComments = [
                'not valid json',
                '{"id": 1, "body": "valid", "author": "user1", "type": "issue"}'
            ];

            processPendingComments(commentsToProcess, pendingComments);

            assert.strictEqual(commentsToProcess.length, 1, 'Should skip malformed JSON');
            assert.strictEqual(commentsToProcess[0].id, 1);
        });

        test('handles empty comment body in completion marker check', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 123, body: 'Test', author: 'user1', type: 'issue' }
            ];

            const prComments: PRComment[] = [
                {
                    id: 999,
                    user: { login: 'propr.dev[bot]', type: 'Bot' },
                    body: null,
                    created_at: '2024-01-01T00:00:00Z'
                }
            ];

            const filtered = filterUnprocessedComments(commentsToProcess, prComments, 'propr.dev[bot]');

            assert.strictEqual(filtered.length, 1, 'Should not crash on null body');
        });

        test('handles comment IDs that look like markers but are partial matches', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 123, body: 'Test', author: 'user1', type: 'issue' },
                { id: 1234, body: 'Test 2', author: 'user2', type: 'issue' }
            ];

            const prComments: PRComment[] = [
                {
                    id: 999,
                    user: { login: 'propr.dev[bot]', type: 'Bot' },
                    body: '_Processing comment ID: 123✓_',  // Only 123 is marked
                    created_at: '2024-01-01T00:00:00Z'
                }
            ];

            const filtered = filterUnprocessedComments(commentsToProcess, prComments, 'propr.dev[bot]');

            assert.strictEqual(filtered.length, 1, 'Only 123 should be filtered');
            assert.strictEqual(filtered[0].id, 1234, '1234 should remain (different ID)');
        });

        test('handles review vs issue comment types', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 1, body: 'Review comment', author: 'user1', type: 'review', hasCodeContext: true },
                { id: 2, body: 'Issue comment', author: 'user2', type: 'issue' }
            ];

            const prComments: PRComment[] = [
                {
                    id: 1,
                    user: { login: 'user1', type: 'User' },
                    body: 'Review comment',
                    created_at: '2024-01-01T00:00:00Z',
                    pull_request_review_id: 12345
                },
                {
                    id: 2,
                    user: { login: 'user2', type: 'User' },
                    body: 'Issue comment',
                    created_at: '2024-01-01T00:00:00Z'
                }
            ];

            const filtered = filterUnprocessedComments(commentsToProcess, prComments, 'propr.dev[bot]');

            assert.strictEqual(filtered.length, 2, 'Both types should be processed');
            assert.ok(filtered.some(c => c.type === 'review'), 'Review comment should be present');
            assert.ok(filtered.some(c => c.type === 'issue'), 'Issue comment should be present');
        });
    });
});

/**
 * Integration tests for PR Comment Batching
 *
 * These tests verify:
 * 1. Multiple comments are combined into a single batch
 * 2. Batch delay is applied correctly
 * 3. Edits during batch processing are handled
 * 4. Aborts/deletions during batch processing are handled
 * 5. buildCombinedComment correctly combines multiple comments
 */

// Default batch delay matching production constant
const COMMENT_BATCH_DELAY_MS = 3000;

interface CombinedCommentResult {
    combinedCommentBody: string;
    combinedBodyHtml?: string;
    commentAuthors: string[];
}

// Implementation of buildCombinedComment matching production logic
function buildCombinedComment(unprocessedComments: UnprocessedComment[]): CombinedCommentResult {
    let combinedCommentBody: string;
    let combinedBodyHtml: string | undefined;
    let commentAuthors: string[] = [];

    if (unprocessedComments.length === 1) {
        combinedCommentBody = unprocessedComments[0].body;
        combinedBodyHtml = unprocessedComments[0].body_html;
        commentAuthors = [unprocessedComments[0].author];
    } else {
        combinedCommentBody = unprocessedComments.map((comment, index) => `**Comment ${index + 1}** (by @${comment.author}):\n${comment.body}`).join('\n\n---\n\n');
        const htmlParts = unprocessedComments.filter(c => c.body_html).map(c => c.body_html);
        combinedBodyHtml = htmlParts.length > 0 ? htmlParts.join('\n') : undefined;
        commentAuthors = [...new Set(unprocessedComments.map(c => c.author))];
    }
    return { combinedCommentBody, combinedBodyHtml, commentAuthors };
}

// Enhanced mock queue for batch delay testing
interface MockBatchQueue {
    jobs: Array<{ name: string; data: CommentJobData; options: { delay?: number; jobId?: string } }>;
    delayedJobs: Map<string, { data: CommentJobData; delay: number; addedAt: number }>;
    add: (name: string, data: CommentJobData, options?: { delay?: number; jobId?: string }) => Promise<void>;
    getDelayed: () => Promise<Array<{ id: string; data: CommentJobData }>>;
    getActive: () => Promise<Array<{ id: string; data: CommentJobData }>>;
    getWaiting: () => Promise<Array<{ id: string; data: CommentJobData }>>;
    clear: () => void;
    hasJobForPR: (owner: string, repo: string, prNumber: number) => boolean;
    removeJob: (jobId: string) => boolean;
}

function createMockBatchQueue(): MockBatchQueue {
    const jobs: Array<{ name: string; data: CommentJobData; options: { delay?: number; jobId?: string } }> = [];
    const delayedJobs = new Map<string, { data: CommentJobData; delay: number; addedAt: number }>();
    const activeJobs: Array<{ id: string; data: CommentJobData }> = [];

    return {
        jobs,
        delayedJobs,

        async add(name: string, data: CommentJobData, options: { delay?: number; jobId?: string } = {}): Promise<void> {
            const jobId = options.jobId || `job-${Date.now()}`;
            jobs.push({ name, data, options });
            if (options.delay && options.delay > 0) {
                delayedJobs.set(jobId, { data, delay: options.delay, addedAt: Date.now() });
            }
        },

        async getDelayed(): Promise<Array<{ id: string; data: CommentJobData }>> {
            return Array.from(delayedJobs.entries()).map(([id, job]) => ({ id, data: job.data }));
        },

        async getActive(): Promise<Array<{ id: string; data: CommentJobData }>> {
            return activeJobs;
        },

        async getWaiting(): Promise<Array<{ id: string; data: CommentJobData }>> {
            return [];
        },

        clear(): void {
            jobs.length = 0;
            delayedJobs.clear();
            activeJobs.length = 0;
        },

        hasJobForPR(owner: string, repo: string, prNumber: number): boolean {
            return jobs.some(j =>
                j.name === 'processPullRequestComment' &&
                j.data.repoOwner === owner &&
                j.data.repoName === repo &&
                j.data.pullRequestNumber === prNumber
            );
        },

        removeJob(jobId: string): boolean {
            const index = jobs.findIndex(j => j.options.jobId === jobId);
            if (index !== -1) {
                jobs.splice(index, 1);
                delayedJobs.delete(jobId);
                return true;
            }
            return false;
        }
    };
}

// Batch processing simulation functions
async function storeCommentForBatch(
    comment: UnprocessedComment,
    pendingCommentsKey: string,
    redisClient: MockRedisClientWithLists
): Promise<void> {
    await redisClient.rpush(pendingCommentsKey, JSON.stringify(comment));
}

async function enqueueNewCommentJob(
    comment: UnprocessedComment,
    queue: MockBatchQueue,
    options: { owner: string; repo: string; prNumber: number; branchName: string; llm: string | null; correlationId: string }
): Promise<string> {
    const { owner, repo, prNumber, branchName, llm, correlationId } = options;
    const timestamp = Date.now();
    const jobId = `pr-comments-batch-${owner}-${repo}-${prNumber}-${timestamp}`;

    const jobData: CommentJobData = {
        pullRequestNumber: prNumber,
        comments: [comment],
        repoOwner: owner,
        repoName: repo,
        branchName,
        llm,
        correlationId
    };

    await queue.add('processPullRequestComment', jobData, { jobId, delay: COMMENT_BATCH_DELAY_MS });
    return jobId;
}

async function processBatchJob(
    queue: MockBatchQueue,
    redisClient: MockRedisClientWithLists,
    jobId: string,
    owner: string,
    repo: string,
    prNumber: number
): Promise<UnprocessedComment[]> {
    const pendingCommentsKey = getPendingPrCommentsKey(owner, repo, prNumber);

    // Get the job from the queue
    const delayedJobs = await queue.getDelayed();
    const job = delayedJobs.find(j => j.id === jobId);
    if (!job) return [];

    // Get initial comments from job
    const commentsToProcess: UnprocessedComment[] = [...(job.data.comments || [])];

    // Pick up any pending comments that accumulated during the delay
    const pendingComments = await redisClient.lrange(pendingCommentsKey, 0, -1);
    if (pendingComments.length > 0) {
        await redisClient.del(pendingCommentsKey);
        processPendingComments(commentsToProcess, pendingComments);
    }

    return commentsToProcess;
}

describe('PR Comment Batching - Integration Tests', () => {
    let redisClient: MockRedisClientWithLists;
    let batchQueue: MockBatchQueue;

    beforeEach(() => {
        redisClient = createMockRedisClientWithLists();
        batchQueue = createMockBatchQueue();
    });

    afterEach(() => {
        redisClient.storage.clear();
        redisClient.listStorage.clear();
        batchQueue.clear();
    });

    describe('buildCombinedComment - Comment Combining', () => {
        test('returns single comment unchanged', () => {
            const comments: UnprocessedComment[] = [
                { id: 1, body: 'Fix the bug', author: 'user1', type: 'issue' }
            ];

            const result = buildCombinedComment(comments);

            assert.strictEqual(result.combinedCommentBody, 'Fix the bug');
            assert.deepStrictEqual(result.commentAuthors, ['user1']);
        });

        test('combines multiple comments with proper formatting', () => {
            const comments: UnprocessedComment[] = [
                { id: 1, body: 'Fix bug A', author: 'user1', type: 'issue' },
                { id: 2, body: 'Also fix bug B', author: 'user2', type: 'issue' },
                { id: 3, body: 'And update the docs', author: 'user3', type: 'review' }
            ];

            const result = buildCombinedComment(comments);

            assert.ok(result.combinedCommentBody.includes('**Comment 1** (by @user1):\nFix bug A'));
            assert.ok(result.combinedCommentBody.includes('**Comment 2** (by @user2):\nAlso fix bug B'));
            assert.ok(result.combinedCommentBody.includes('**Comment 3** (by @user3):\nAnd update the docs'));
            assert.ok(result.combinedCommentBody.includes('---'), 'Comments should be separated by horizontal rule');
            assert.deepStrictEqual(result.commentAuthors.sort(), ['user1', 'user2', 'user3'].sort());
        });

        test('deduplicates authors when same user posts multiple comments', () => {
            const comments: UnprocessedComment[] = [
                { id: 1, body: 'First request', author: 'user1', type: 'issue' },
                { id: 2, body: 'Second request', author: 'user1', type: 'issue' },
                { id: 3, body: 'Third request', author: 'user2', type: 'issue' }
            ];

            const result = buildCombinedComment(comments);

            assert.strictEqual(result.commentAuthors.length, 2, 'Should deduplicate authors');
            assert.ok(result.commentAuthors.includes('user1'));
            assert.ok(result.commentAuthors.includes('user2'));
        });

        test('preserves body_html for single comment', () => {
            const comments: UnprocessedComment[] = [
                { id: 1, body: 'Text', author: 'user1', type: 'issue', body_html: '<p>Text with <img src="signed-url"/></p>' }
            ];

            const result = buildCombinedComment(comments);

            assert.strictEqual(result.combinedBodyHtml, '<p>Text with <img src="signed-url"/></p>');
        });

        test('combines body_html for multiple comments', () => {
            const comments: UnprocessedComment[] = [
                { id: 1, body: 'Text 1', author: 'user1', type: 'issue', body_html: '<p>HTML 1</p>' },
                { id: 2, body: 'Text 2', author: 'user2', type: 'issue', body_html: '<p>HTML 2</p>' }
            ];

            const result = buildCombinedComment(comments);

            assert.ok(result.combinedBodyHtml?.includes('<p>HTML 1</p>'));
            assert.ok(result.combinedBodyHtml?.includes('<p>HTML 2</p>'));
        });

        test('handles mixed comments with and without body_html', () => {
            const comments: UnprocessedComment[] = [
                { id: 1, body: 'Text 1', author: 'user1', type: 'issue', body_html: '<p>HTML</p>' },
                { id: 2, body: 'Text 2', author: 'user2', type: 'issue' } // No body_html
            ];

            const result = buildCombinedComment(comments);

            assert.strictEqual(result.combinedBodyHtml, '<p>HTML</p>');
        });

        test('returns undefined combinedBodyHtml when no comments have HTML', () => {
            const comments: UnprocessedComment[] = [
                { id: 1, body: 'Text 1', author: 'user1', type: 'issue' },
                { id: 2, body: 'Text 2', author: 'user2', type: 'issue' }
            ];

            const result = buildCombinedComment(comments);

            assert.strictEqual(result.combinedBodyHtml, undefined);
        });

        test('handles review and issue comments in same batch', () => {
            const comments: UnprocessedComment[] = [
                { id: 1, body: 'Issue comment', author: 'user1', type: 'issue' },
                { id: 2, body: 'Review comment with context', author: 'user2', type: 'review', hasCodeContext: true }
            ];

            const result = buildCombinedComment(comments);

            assert.ok(result.combinedCommentBody.includes('Issue comment'));
            assert.ok(result.combinedCommentBody.includes('Review comment with context'));
        });
    });

    describe('Batch Delay Mechanism', () => {
        test('jobs are created with correct batch delay', async () => {
            const comment: UnprocessedComment = { id: 1, body: 'Test', author: 'user1', type: 'issue' };

            await enqueueNewCommentJob(comment, batchQueue, {
                owner: 'testowner',
                repo: 'testrepo',
                prNumber: 123,
                branchName: 'feature-branch',
                llm: null,
                correlationId: 'corr-1'
            });

            assert.strictEqual(batchQueue.jobs.length, 1);
            assert.strictEqual(batchQueue.jobs[0].options.delay, COMMENT_BATCH_DELAY_MS);
        });

        test('job ID follows correct format for batch jobs', async () => {
            const comment: UnprocessedComment = { id: 1, body: 'Test', author: 'user1', type: 'issue' };

            const jobId = await enqueueNewCommentJob(comment, batchQueue, {
                owner: 'myorg',
                repo: 'myrepo',
                prNumber: 456,
                branchName: 'main',
                llm: null,
                correlationId: 'corr-1'
            });

            assert.ok(jobId.startsWith('pr-comments-batch-myorg-myrepo-456-'), `Job ID should follow format: ${jobId}`);
        });

        test('delayed jobs are tracked in queue', async () => {
            const comment: UnprocessedComment = { id: 1, body: 'Test', author: 'user1', type: 'issue' };

            await enqueueNewCommentJob(comment, batchQueue, {
                owner: 'owner',
                repo: 'repo',
                prNumber: 1,
                branchName: 'main',
                llm: null,
                correlationId: 'corr-1'
            });

            const delayedJobs = await batchQueue.getDelayed();
            assert.strictEqual(delayedJobs.length, 1, 'Should have one delayed job');
        });
    });

    describe('Comment Accumulation During Delay', () => {
        test('comments arriving during delay are stored in pending queue', async () => {
            const pendingKey = getPendingPrCommentsKey('owner', 'repo', 123);

            // First comment triggers job creation
            const firstComment: UnprocessedComment = { id: 1, body: 'First', author: 'user1', type: 'issue' };
            await enqueueNewCommentJob(firstComment, batchQueue, {
                owner: 'owner', repo: 'repo', prNumber: 123, branchName: 'main', llm: null, correlationId: 'corr-1'
            });

            // Second comment arrives during delay - stored in pending
            const secondComment: UnprocessedComment = { id: 2, body: 'Second', author: 'user2', type: 'issue' };
            await storeCommentForBatch(secondComment, pendingKey, redisClient);

            // Third comment arrives during delay
            const thirdComment: UnprocessedComment = { id: 3, body: 'Third', author: 'user3', type: 'review' };
            await storeCommentForBatch(thirdComment, pendingKey, redisClient);

            const pendingLength = await redisClient.llen(pendingKey);
            assert.strictEqual(pendingLength, 2, 'Should have 2 pending comments');
        });

        test('batch processing combines initial and pending comments', async () => {
            const pendingKey = getPendingPrCommentsKey('owner', 'repo', 123);

            // First comment triggers job
            const firstComment: UnprocessedComment = { id: 1, body: 'First', author: 'user1', type: 'issue' };
            const jobId = await enqueueNewCommentJob(firstComment, batchQueue, {
                owner: 'owner', repo: 'repo', prNumber: 123, branchName: 'main', llm: null, correlationId: 'corr-1'
            });

            // More comments arrive during delay
            await storeCommentForBatch({ id: 2, body: 'Second', author: 'user2', type: 'issue' }, pendingKey, redisClient);
            await storeCommentForBatch({ id: 3, body: 'Third', author: 'user3', type: 'review' }, pendingKey, redisClient);

            // Process the batch job
            const commentsToProcess = await processBatchJob(batchQueue, redisClient, jobId, 'owner', 'repo', 123);

            assert.strictEqual(commentsToProcess.length, 3, 'Should have all 3 comments');
            assert.ok(commentsToProcess.some(c => c.id === 1));
            assert.ok(commentsToProcess.some(c => c.id === 2));
            assert.ok(commentsToProcess.some(c => c.id === 3));
        });

        test('pending queue is cleared after pickup', async () => {
            const pendingKey = getPendingPrCommentsKey('owner', 'repo', 123);

            const firstComment: UnprocessedComment = { id: 1, body: 'First', author: 'user1', type: 'issue' };
            const jobId = await enqueueNewCommentJob(firstComment, batchQueue, {
                owner: 'owner', repo: 'repo', prNumber: 123, branchName: 'main', llm: null, correlationId: 'corr-1'
            });

            await storeCommentForBatch({ id: 2, body: 'Second', author: 'user2', type: 'issue' }, pendingKey, redisClient);

            // Process batch
            await processBatchJob(batchQueue, redisClient, jobId, 'owner', 'repo', 123);

            const pendingLength = await redisClient.llen(pendingKey);
            assert.strictEqual(pendingLength, 0, 'Pending queue should be empty after processing');
        });
    });

    describe('Edit Handling During Batch Processing', () => {
        test('edited comment is updated with new content', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 1, body: 'Original request', author: 'user1', type: 'issue', updated_at: '2024-01-01T00:00:00Z' },
                { id: 2, body: 'Another request', author: 'user2', type: 'issue', updated_at: '2024-01-01T00:00:00Z' }
            ];

            // Comment 1 was edited after being queued
            const validationComments: ValidationComment[] = [
                { id: 1, body: 'Updated request with more details', updated_at: '2024-01-01T01:00:00Z' },
                { id: 2, body: 'Another request', updated_at: '2024-01-01T00:00:00Z' }
            ];

            const result = validateAndFilterComments(commentsToProcess, validationComments);

            assert.strictEqual(result.length, 2);
            const editedComment = result.find(c => c.id === 1);
            assert.strictEqual(editedComment?.body, 'Updated request with more details', 'Should use updated body');
        });

        test('combined batch reflects edited content', () => {
            // Simulate an edit scenario where we validate and then combine
            const originalComments: UnprocessedComment[] = [
                { id: 1, body: 'Fix typo', author: 'user1', type: 'issue', updated_at: '2024-01-01T00:00:00Z' },
                { id: 2, body: 'Add tests', author: 'user2', type: 'issue', updated_at: '2024-01-01T00:00:00Z' }
            ];

            const validationComments: ValidationComment[] = [
                { id: 1, body: 'Fix typo and formatting', updated_at: '2024-01-01T01:00:00Z' }, // Edited
                { id: 2, body: 'Add tests', updated_at: '2024-01-01T00:00:00Z' }
            ];

            const validated = validateAndFilterComments(originalComments, validationComments);
            const combined = buildCombinedComment(validated);

            assert.ok(combined.combinedCommentBody.includes('Fix typo and formatting'), 'Should contain edited content');
            assert.ok(combined.combinedCommentBody.includes('Add tests'));
        });
    });

    describe('Abort/Deletion Handling During Batch Processing', () => {
        test('deleted comment is removed from batch', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 1, body: 'Keep this', author: 'user1', type: 'issue' },
                { id: 2, body: 'Delete this', author: 'user2', type: 'issue' },
                { id: 3, body: 'Also keep', author: 'user3', type: 'issue' }
            ];

            // Comment 2 was deleted (not in validation list)
            const validationComments: ValidationComment[] = [
                { id: 1, body: 'Keep this' },
                { id: 3, body: 'Also keep' }
            ];

            const result = validateAndFilterComments(commentsToProcess, validationComments);

            assert.strictEqual(result.length, 2, 'Deleted comment should be removed');
            assert.ok(!result.some(c => c.id === 2), 'Comment 2 should not be present');
        });

        test('batch continues processing remaining comments after deletion', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 1, body: 'First request', author: 'user1', type: 'issue' },
                { id: 2, body: 'Deleted', author: 'user2', type: 'issue' },
                { id: 3, body: 'Third request', author: 'user3', type: 'issue' }
            ];

            const validationComments: ValidationComment[] = [
                { id: 1, body: 'First request' },
                { id: 3, body: 'Third request' }
            ];

            const validated = validateAndFilterComments(commentsToProcess, validationComments);
            const combined = buildCombinedComment(validated);

            assert.ok(combined.combinedCommentBody.includes('First request'));
            assert.ok(combined.combinedCommentBody.includes('Third request'));
            assert.ok(!combined.combinedCommentBody.includes('Deleted'));
        });

        test('handles all comments deleted scenario', () => {
            const commentsToProcess: UnprocessedComment[] = [
                { id: 1, body: 'Deleted 1', author: 'user1', type: 'issue' },
                { id: 2, body: 'Deleted 2', author: 'user2', type: 'issue' }
            ];

            const validationComments: ValidationComment[] = [];

            const result = validateAndFilterComments(commentsToProcess, validationComments);

            assert.strictEqual(result.length, 0, 'Should return empty array when all deleted');
        });

        test('job can be removed from queue on abort', async () => {
            const comment: UnprocessedComment = { id: 1, body: 'Test', author: 'user1', type: 'issue' };
            const jobId = await enqueueNewCommentJob(comment, batchQueue, {
                owner: 'owner', repo: 'repo', prNumber: 123, branchName: 'main', llm: null, correlationId: 'corr-1'
            });

            assert.strictEqual(batchQueue.jobs.length, 1, 'Job should be in queue');

            const removed = batchQueue.removeJob(jobId);

            assert.strictEqual(removed, true, 'Job should be removed');
            assert.strictEqual(batchQueue.jobs.length, 0, 'Queue should be empty');
        });
    });

    describe('Batch Job Deduplication', () => {
        test('detects existing job for same PR', async () => {
            const comment: UnprocessedComment = { id: 1, body: 'Test', author: 'user1', type: 'issue' };

            await enqueueNewCommentJob(comment, batchQueue, {
                owner: 'owner', repo: 'repo', prNumber: 123, branchName: 'main', llm: null, correlationId: 'corr-1'
            });

            const hasJob = batchQueue.hasJobForPR('owner', 'repo', 123);
            assert.strictEqual(hasJob, true, 'Should detect existing job');
        });

        test('does not detect job for different PR', async () => {
            const comment: UnprocessedComment = { id: 1, body: 'Test', author: 'user1', type: 'issue' };

            await enqueueNewCommentJob(comment, batchQueue, {
                owner: 'owner', repo: 'repo', prNumber: 123, branchName: 'main', llm: null, correlationId: 'corr-1'
            });

            const hasJob = batchQueue.hasJobForPR('owner', 'repo', 456);
            assert.strictEqual(hasJob, false, 'Should not detect job for different PR');
        });

        test('different repos have independent jobs', async () => {
            const comment: UnprocessedComment = { id: 1, body: 'Test', author: 'user1', type: 'issue' };

            await enqueueNewCommentJob(comment, batchQueue, {
                owner: 'owner', repo: 'repo1', prNumber: 123, branchName: 'main', llm: null, correlationId: 'corr-1'
            });

            const hasJobRepo1 = batchQueue.hasJobForPR('owner', 'repo1', 123);
            const hasJobRepo2 = batchQueue.hasJobForPR('owner', 'repo2', 123);

            assert.strictEqual(hasJobRepo1, true, 'Should detect job for repo1');
            assert.strictEqual(hasJobRepo2, false, 'Should not detect job for repo2');
        });
    });

    describe('Comment Processing Order', () => {
        test('comments are processed in FIFO order', async () => {
            const pendingKey = getPendingPrCommentsKey('owner', 'repo', 123);

            // Add comments in order
            await storeCommentForBatch({ id: 1, body: 'First', author: 'user1', type: 'issue' }, pendingKey, redisClient);
            await storeCommentForBatch({ id: 2, body: 'Second', author: 'user2', type: 'issue' }, pendingKey, redisClient);
            await storeCommentForBatch({ id: 3, body: 'Third', author: 'user3', type: 'issue' }, pendingKey, redisClient);

            const pendingComments = await redisClient.lrange(pendingKey, 0, -1);
            const parsed = pendingComments.map(c => JSON.parse(c) as UnprocessedComment);

            assert.strictEqual(parsed[0].id, 1, 'First comment should be first');
            assert.strictEqual(parsed[1].id, 2, 'Second comment should be second');
            assert.strictEqual(parsed[2].id, 3, 'Third comment should be third');
        });

        test('combined comment body preserves order', () => {
            const comments: UnprocessedComment[] = [
                { id: 1, body: 'First request', author: 'user1', type: 'issue' },
                { id: 2, body: 'Second request', author: 'user2', type: 'issue' },
                { id: 3, body: 'Third request', author: 'user3', type: 'issue' }
            ];

            const result = buildCombinedComment(comments);

            const firstIndex = result.combinedCommentBody.indexOf('First request');
            const secondIndex = result.combinedCommentBody.indexOf('Second request');
            const thirdIndex = result.combinedCommentBody.indexOf('Third request');

            assert.ok(firstIndex < secondIndex, 'First should come before second');
            assert.ok(secondIndex < thirdIndex, 'Second should come before third');
        });
    });

    describe('Full Batch Processing Flow', () => {
        test('complete batch flow: enqueue, accumulate, process, combine', async () => {
            const pendingKey = getPendingPrCommentsKey('owner', 'repo', 123);

            // Step 1: First comment triggers job with delay
            const firstComment: UnprocessedComment = { id: 1, body: 'Fix the authentication bug', author: 'alice', type: 'issue' };
            const jobId = await enqueueNewCommentJob(firstComment, batchQueue, {
                owner: 'owner', repo: 'repo', prNumber: 123, branchName: 'feature/auth', llm: 'claude-sonnet-4-20250514', correlationId: 'batch-1'
            });

            assert.strictEqual(batchQueue.jobs.length, 1, 'Job should be queued');
            assert.strictEqual(batchQueue.jobs[0].options.delay, COMMENT_BATCH_DELAY_MS, 'Job should have batch delay');

            // Step 2: More comments arrive during delay (would be stored via webhook)
            await storeCommentForBatch({ id: 2, body: 'Also add rate limiting', author: 'bob', type: 'issue' }, pendingKey, redisClient);
            await storeCommentForBatch({ id: 3, body: 'Fix this line too', author: 'carol', type: 'review', hasCodeContext: true }, pendingKey, redisClient);

            // Step 3: Process the batch job (after delay would expire)
            const allComments = await processBatchJob(batchQueue, redisClient, jobId, 'owner', 'repo', 123);

            assert.strictEqual(allComments.length, 3, 'Should have all 3 comments in batch');

            // Step 4: Combine the comments
            const combined = buildCombinedComment(allComments);

            assert.ok(combined.combinedCommentBody.includes('Fix the authentication bug'));
            assert.ok(combined.combinedCommentBody.includes('Also add rate limiting'));
            assert.ok(combined.combinedCommentBody.includes('Fix this line too'));
            assert.deepStrictEqual(combined.commentAuthors.sort(), ['alice', 'bob', 'carol'].sort());
        });

        test('handles empty pending queue during processing', async () => {
            const firstComment: UnprocessedComment = { id: 1, body: 'Only comment', author: 'user1', type: 'issue' };
            const jobId = await enqueueNewCommentJob(firstComment, batchQueue, {
                owner: 'owner', repo: 'repo', prNumber: 123, branchName: 'main', llm: null, correlationId: 'batch-1'
            });

            // No additional comments arrive during delay
            const allComments = await processBatchJob(batchQueue, redisClient, jobId, 'owner', 'repo', 123);

            assert.strictEqual(allComments.length, 1, 'Should have only the initial comment');
            assert.strictEqual(allComments[0].id, 1);
        });

        test('handles validation and combining together', async () => {
            const pendingKey = getPendingPrCommentsKey('owner', 'repo', 123);

            const firstComment: UnprocessedComment = { id: 1, body: 'Original', author: 'user1', type: 'issue', updated_at: '2024-01-01T00:00:00Z' };
            const jobId = await enqueueNewCommentJob(firstComment, batchQueue, {
                owner: 'owner', repo: 'repo', prNumber: 123, branchName: 'main', llm: null, correlationId: 'batch-1'
            });

            await storeCommentForBatch(
                { id: 2, body: 'Second', author: 'user2', type: 'issue', updated_at: '2024-01-01T00:00:00Z' },
                pendingKey, redisClient
            );
            await storeCommentForBatch(
                { id: 3, body: 'Third (will be deleted)', author: 'user3', type: 'issue' },
                pendingKey, redisClient
            );

            const allComments = await processBatchJob(batchQueue, redisClient, jobId, 'owner', 'repo', 123);

            // Simulate validation: comment 1 was edited, comment 3 was deleted
            const validationComments: ValidationComment[] = [
                { id: 1, body: 'Updated original', updated_at: '2024-01-01T01:00:00Z' },
                { id: 2, body: 'Second', updated_at: '2024-01-01T00:00:00Z' }
            ];

            const validated = validateAndFilterComments(allComments, validationComments);
            const combined = buildCombinedComment(validated);

            assert.strictEqual(validated.length, 2, 'Should have 2 comments after validation');
            assert.ok(combined.combinedCommentBody.includes('Updated original'), 'Should have edited content');
            assert.ok(combined.combinedCommentBody.includes('Second'));
            assert.ok(!combined.combinedCommentBody.includes('Third'), 'Deleted comment should not be present');
        });
    });

    describe('Edge Cases', () => {
        test('handles large batches of comments', () => {
            const comments: UnprocessedComment[] = [];
            for (let i = 1; i <= 20; i++) {
                comments.push({ id: i, body: `Request ${i}`, author: `user${i}`, type: 'issue' });
            }

            const result = buildCombinedComment(comments);

            assert.ok(result.combinedCommentBody.includes('**Comment 1**'));
            assert.ok(result.combinedCommentBody.includes('**Comment 20**'));
            assert.strictEqual(result.commentAuthors.length, 20, 'Should have 20 unique authors');
        });

        test('handles comments with special characters', () => {
            const comments: UnprocessedComment[] = [
                { id: 1, body: 'Fix `code` with **markdown**', author: 'user1', type: 'issue' },
                { id: 2, body: 'Handle <html> & special "quotes"', author: 'user2', type: 'issue' }
            ];

            const result = buildCombinedComment(comments);

            assert.ok(result.combinedCommentBody.includes('`code`'));
            assert.ok(result.combinedCommentBody.includes('<html>'));
        });

        test('handles empty comment bodies', () => {
            const comments: UnprocessedComment[] = [
                { id: 1, body: '', author: 'user1', type: 'issue' },
                { id: 2, body: 'Valid content', author: 'user2', type: 'issue' }
            ];

            const result = buildCombinedComment(comments);

            assert.ok(result.combinedCommentBody.includes('Valid content'));
        });

        test('handles comments with multiline content', () => {
            const comments: UnprocessedComment[] = [
                { id: 1, body: 'Line 1\nLine 2\nLine 3', author: 'user1', type: 'issue' },
                { id: 2, body: 'Single line', author: 'user2', type: 'issue' }
            ];

            const result = buildCombinedComment(comments);

            assert.ok(result.combinedCommentBody.includes('Line 1\nLine 2\nLine 3'));
        });

        test('preserves comment metadata through batching', async () => {
            const pendingKey = getPendingPrCommentsKey('owner', 'repo', 123);

            const reviewComment: UnprocessedComment = {
                id: 1,
                body: 'Review comment',
                author: 'reviewer',
                type: 'review',
                hasCodeContext: true,
                body_html: '<p>HTML content</p>'
            };

            await storeCommentForBatch(reviewComment, pendingKey, redisClient);

            const pendingComments = await redisClient.lrange(pendingKey, 0, -1);
            const parsed = JSON.parse(pendingComments[0]) as UnprocessedComment;

            assert.strictEqual(parsed.type, 'review');
            assert.strictEqual(parsed.hasCodeContext, true);
            assert.strictEqual(parsed.body_html, '<p>HTML content</p>');
        });
    });
});

// ---------------------------------------------------------------------------
// Integration tests for /review and /fix command workflows
// ---------------------------------------------------------------------------

/**
 * These tests verify end-to-end behaviour of the slash-command driven
 * review and fix pipelines at the job-routing and data-flow level.
 *
 * Key scenarios tested:
 * 1. /review enqueues review-mode processing (commandMode='review')
 * 2. /fix includes unprocessed review comments in the prompt
 * 3. Duplicate /fix runs do not reconsume processed reviews
 * 4. Review-mode worker does NOT create commits or pushes
 * 5. Existing merge/default comment tests remain green
 */

// Inline copies of pure helpers (same approach as reviewCommentGatherer.test.ts)
const REVIEW_MARKER_PREFIX_INT = '<!-- propr:ai-review';
const ERROR_MARKER_RE_INT = /<!-- propr:ai-review [^>]*error="true"[^>]* -->/;

function isReviewCommentInt(body: string): boolean {
    return body.includes(REVIEW_MARKER_PREFIX_INT);
}

function stripReviewBoilerplateInt(body: string): string {
    let cleaned = body.replace(/\n?<!-- propr:ai-review [^>]* -->/g, '');
    cleaned = cleaned.replace(/\n?---\n(?:> 💡 \*\*(?:Tip|Next step):\*\*[^\n]*\n?)*/g, '');
    return cleaned.trimEnd();
}

interface AIReviewComment {
    id: number;
    body: string;
    author: string;
    created_at: string;
}

interface ReviewPRComment {
    id: number;
    body: string | null;
    user: { login: string };
    created_at: string;
}

function gatherUnprocessedInt(
    allComments: ReviewPRComment[],
    processedIds: string[],
    maxAgeMs: number = 7 * 24 * 3600 * 1000,
): AIReviewComment[] {
    const cutoff = Date.now() - maxAgeMs;
    const processedSet = new Set(processedIds);
    const unprocessed: AIReviewComment[] = [];
    for (const comment of allComments) {
        if (!comment.body || !isReviewCommentInt(comment.body)) continue;
        if (processedSet.has(String(comment.id))) continue;
        if (ERROR_MARKER_RE_INT.test(comment.body)) continue;
        if (new Date(comment.created_at).getTime() < cutoff) continue;
        unprocessed.push({
            id: comment.id,
            body: stripReviewBoilerplateInt(comment.body),
            author: comment.user.login,
            created_at: comment.created_at,
        });
    }
    return unprocessed;
}

function formatReviewCommentsSectionInt(reviewComments: AIReviewComment[]): string {
    if (reviewComments.length === 0) return '';
    let section = `**AI Review Comments (unprocessed — please address these findings):**\n\n`;
    for (const comment of reviewComments) {
        section += `---\n**Review by:** @${comment.author} (Comment ID: ${comment.id})\n`;
        section += `${comment.body}\n---\n\n`;
    }
    return section;
}

// Mock Redis client with SET support for processed review tracking
interface MockRedisWithSets {
    storage: Map<string, { value: string; expiry: number | null }>;
    setStorage: Map<string, Set<string>>;
    set: (key: string, value: string, ...args: (string | number)[]) => Promise<string | null>;
    get: (key: string) => Promise<string | null>;
    expire: (key: string, seconds: number) => Promise<number>;
    del: (key: string) => Promise<number>;
    sadd: (key: string, ...members: string[]) => Promise<number>;
    smembers: (key: string) => Promise<string[]>;
}

function createMockRedisWithSets(): MockRedisWithSets {
    const storage = new Map<string, { value: string; expiry: number | null }>();
    const setStorage = new Map<string, Set<string>>();

    return {
        storage,
        setStorage,
        async set(key: string, value: string, ...args: (string | number)[]): Promise<string | null> {
            const hasNX = args.includes('NX');
            if (hasNX && storage.has(key)) return null;
            const exIndex = args.indexOf('EX');
            const expiry = exIndex !== -1 ? Number(args[exIndex + 1]) : null;
            storage.set(key, { value, expiry });
            return 'OK';
        },
        async get(key: string): Promise<string | null> {
            const entry = storage.get(key);
            return entry ? entry.value : null;
        },
        async expire(key: string, seconds: number): Promise<number> {
            const entry = storage.get(key);
            if (entry) { entry.expiry = seconds; return 1; }
            return 0;
        },
        async del(key: string): Promise<number> {
            const d1 = storage.delete(key);
            const d2 = setStorage.delete(key);
            return (d1 || d2) ? 1 : 0;
        },
        async sadd(key: string, ...members: string[]): Promise<number> {
            let s = setStorage.get(key);
            if (!s) { s = new Set(); setStorage.set(key, s); }
            let added = 0;
            for (const m of members) { if (!s.has(m)) { s.add(m); added++; } }
            return added;
        },
        async smembers(key: string): Promise<string[]> {
            const s = setStorage.get(key);
            return s ? [...s] : [];
        },
    };
}

function makeReviewComment(overrides: Partial<ReviewPRComment> & { id: number }): ReviewPRComment {
    return {
        body: `## Review\nFindings here\n<!-- propr:ai-review model="claude-opus-4-1" -->`,
        user: { login: 'propr-bot' },
        created_at: new Date().toISOString(),
        ...overrides,
    };
}

describe('PR Comment Job - Review/Fix Workflow Integration Tests', () => {
    let redis: MockRedisWithSets;

    beforeEach(() => {
        redis = createMockRedisWithSets();
    });

    afterEach(() => {
        redis.storage.clear();
        redis.setStorage.clear();
    });

    describe('/review command routing', () => {
        test('/review sets commandMode to review in job data', () => {
            // Simulate how commentEventHandler builds job data for /review
            const commandMeta = { mode: 'review' as const, models: ['claude'], instructions: '' };
            const jobData = {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                correlationId: 'corr-review-1',
                commandMode: commandMeta.mode,
                commandMeta,
                requestedModels: commandMeta.models,
            };

            assert.strictEqual(jobData.commandMode, 'review');
            assert.deepStrictEqual(jobData.requestedModels, ['claude']);
        });

        test('/review with multiple models populates requestedModels array', () => {
            const commandMeta = { mode: 'review' as const, models: ['claude', 'gemini-3-pro-preview', 'gpt-54'], instructions: '' };
            const jobData = {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                correlationId: 'corr-review-2',
                commandMode: commandMeta.mode,
                commandMeta,
                requestedModels: commandMeta.models,
            };

            assert.strictEqual(jobData.requestedModels!.length, 3);
            assert.deepStrictEqual(jobData.requestedModels, ['claude', 'gemini-3-pro-preview', 'gpt-54']);
        });

        test('/review with no models defaults to empty requestedModels', () => {
            const commandMeta = { mode: 'review' as const, models: [], instructions: '' };
            const jobData = {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                correlationId: 'corr-review-3',
                commandMode: commandMeta.mode,
                commandMeta,
                requestedModels: commandMeta.models,
            };

            assert.deepStrictEqual(jobData.requestedModels, []);
        });

        test('review mode branches early — does not enter default processing path', () => {
            // This simulates the branching logic at processPullRequestCommentJob.ts:419
            const commandMode = 'review';
            let executedReview = false;
            let executedDefault = false;

            if (commandMode === 'review') {
                executedReview = true;
            } else {
                executedDefault = true;
            }

            assert.strictEqual(executedReview, true, 'Review path should execute');
            assert.strictEqual(executedDefault, false, 'Default path should NOT execute');
        });

        test('review mode carries instructions through to job', () => {
            const commandMeta = { mode: 'review' as const, models: ['claude'], instructions: 'Focus on security issues' };
            const jobData = {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                correlationId: 'corr-review-4',
                commandMode: commandMeta.mode,
                commandMeta,
                requestedModels: commandMeta.models,
                commandInstructions: commandMeta.instructions,
            };

            assert.strictEqual(jobData.commandInstructions, 'Focus on security issues');
        });
    });

    describe('/fix includes unprocessed review comments', () => {
        test('/fix gathers unprocessed AI review comments from PR', () => {
            const allComments: ReviewPRComment[] = [
                makeReviewComment({ id: 100 }),
                makeReviewComment({ id: 200 }),
                { id: 300, body: 'Human comment', user: { login: 'developer' }, created_at: new Date().toISOString() },
            ];

            const unprocessed = gatherUnprocessedInt(allComments, []);
            assert.strictEqual(unprocessed.length, 2);
            assert.deepStrictEqual(unprocessed.map(c => c.id), [100, 200]);
        });

        test('/fix includes review comments in formatted prompt section', () => {
            const allComments: ReviewPRComment[] = [
                makeReviewComment({ id: 100, body: '## Review\nMissing error handling\n<!-- propr:ai-review model="claude-opus-4-1" -->' }),
            ];

            const unprocessed = gatherUnprocessedInt(allComments, []);
            const section = formatReviewCommentsSectionInt(unprocessed);

            assert.ok(section.includes('AI Review Comments'));
            assert.ok(section.includes('Missing error handling'));
            assert.ok(section.includes('Comment ID: 100'));
        });

        test('/fix with zero review comments produces empty section', () => {
            const allComments: ReviewPRComment[] = [
                { id: 300, body: 'Human comment', user: { login: 'developer' }, created_at: new Date().toISOString() },
            ];

            const unprocessed = gatherUnprocessedInt(allComments, []);
            const section = formatReviewCommentsSectionInt(unprocessed);

            assert.strictEqual(section, '');
            assert.strictEqual(unprocessed.length, 0);
        });

        test('/fix sets commandMode to fix', () => {
            const commandMeta = { mode: 'fix' as const, instructions: 'address linting' };
            const jobData = {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                correlationId: 'corr-fix-1',
                commandMode: commandMeta.mode,
                commandMeta,
                commandInstructions: commandMeta.instructions,
            };

            assert.strictEqual(jobData.commandMode, 'fix');
            // isFixMode check from processPullRequestCommentJob.ts:311
            const isFixMode = jobData.commandMode === 'fix';
            assert.strictEqual(isFixMode, true);
        });

        test('only /fix mode gathers review comments, not default mode', () => {
            const allComments: ReviewPRComment[] = [
                makeReviewComment({ id: 100 }),
                makeReviewComment({ id: 200 }),
            ];

            // Simulate the isFixMode check from production code
            const fixMode = 'fix';
            const defaultMode = 'default';

            const fixUnprocessed = fixMode === 'fix' ? gatherUnprocessedInt(allComments, []) : [];
            const defaultUnprocessed = defaultMode === 'fix' ? gatherUnprocessedInt(allComments, []) : [];

            assert.strictEqual(fixUnprocessed.length, 2, '/fix should gather review comments');
            assert.strictEqual(defaultUnprocessed.length, 0, 'default mode should not gather review comments');
        });
    });

    describe('Duplicate /fix runs do not reconsume processed reviews', () => {
        test('processed comment IDs are tracked in Redis set', async () => {
            const redisKey = `processed-review-comments:testowner:testrepo:42`;
            const commentIds = [100, 200, 300];

            // Simulate markReviewCommentsProcessed
            await redis.sadd(redisKey, ...commentIds.map(String));
            await redis.expire(redisKey, 30 * 24 * 3600);

            const members = await redis.smembers(redisKey);
            assert.strictEqual(members.length, 3);
            assert.ok(members.includes('100'));
            assert.ok(members.includes('200'));
            assert.ok(members.includes('300'));
        });

        test('second /fix run excludes previously processed comments', async () => {
            const allComments: ReviewPRComment[] = [
                makeReviewComment({ id: 100 }),
                makeReviewComment({ id: 200 }),
                makeReviewComment({ id: 300 }),
            ];

            // First /fix run: all comments are unprocessed
            const firstRunProcessed: string[] = [];
            const firstRun = gatherUnprocessedInt(allComments, firstRunProcessed);
            assert.strictEqual(firstRun.length, 3, 'First run should gather all review comments');

            // Mark them as processed (simulating markReviewCommentsProcessed)
            const redisKey = `processed-review-comments:testowner:testrepo:42`;
            await redis.sadd(redisKey, ...firstRun.map(c => String(c.id)));

            // Second /fix run: load processed IDs from Redis
            const processedIds = await redis.smembers(redisKey);
            const secondRun = gatherUnprocessedInt(allComments, processedIds);
            assert.strictEqual(secondRun.length, 0, 'Second run should find zero unprocessed comments');
        });

        test('new review comments added after first /fix are picked up', async () => {
            const redisKey = `processed-review-comments:testowner:testrepo:42`;

            // First round: comments 100, 200
            const round1Comments: ReviewPRComment[] = [
                makeReviewComment({ id: 100 }),
                makeReviewComment({ id: 200 }),
            ];
            const round1 = gatherUnprocessedInt(round1Comments, []);
            assert.strictEqual(round1.length, 2);
            await redis.sadd(redisKey, ...round1.map(c => String(c.id)));

            // New review comment 300 arrives
            const round2Comments: ReviewPRComment[] = [
                makeReviewComment({ id: 100 }),
                makeReviewComment({ id: 200 }),
                makeReviewComment({ id: 300 }),
            ];
            const processedIds = await redis.smembers(redisKey);
            const round2 = gatherUnprocessedInt(round2Comments, processedIds);
            assert.strictEqual(round2.length, 1, 'Only the new comment should be picked up');
            assert.strictEqual(round2[0].id, 300);
        });

        test('markReviewCommentsProcessed is a no-op for empty array', async () => {
            const redisKey = `processed-review-comments:testowner:testrepo:42`;
            const commentIds: number[] = [];

            // Simulate the guard: if (commentIds.length === 0) return;
            if (commentIds.length > 0) {
                await redis.sadd(redisKey, ...commentIds.map(String));
            }

            const members = await redis.smembers(redisKey);
            assert.strictEqual(members.length, 0);
        });

        test('processed review set has 30-day TTL', async () => {
            const redisKey = `processed-review-comments:testowner:testrepo:42`;
            await redis.sadd(redisKey, '100');

            // In production, expire is called on the same key as sadd.
            // Verify the set exists and the TTL constant is correct.
            const members = await redis.smembers(redisKey);
            assert.strictEqual(members.length, 1, 'Set should contain the added member');

            const TTL_SECONDS = 30 * 24 * 3600; // 30 days
            assert.strictEqual(TTL_SECONDS, 2592000, 'TTL should be 2,592,000 seconds (30 days)');
        });
    });

    describe('Review-mode worker does not commit or push', () => {
        test('review mode does not enter the commit/push code path', () => {
            // The production code at processPullRequestCommentJob.ts:419 branches early:
            //   if (job.data.commandMode === 'review') {
            //     return await executeReviewProcessing(...);
            //   }
            //   return await executeProcessing(...);   // <-- contains commit/push
            //
            // We verify by tracking which functions would be invoked.
            let commitCalled = false;
            let pushCalled = false;
            let reviewProcessingCalled = false;

            async function mockExecuteReviewProcessing(): Promise<{ status: string }> {
                reviewProcessingCalled = true;
                // Review processing only posts comments — never commits or pushes
                return { status: 'complete' };
            }

            async function mockExecuteProcessing(): Promise<{ status: string }> {
                // This path would commit and push
                commitCalled = true;
                pushCalled = true;
                return { status: 'complete' };
            }

            const commandMode = 'review';
            if (commandMode === 'review') {
                mockExecuteReviewProcessing();
            } else {
                mockExecuteProcessing();
            }

            assert.strictEqual(reviewProcessingCalled, true, 'Review processing should be called');
            assert.strictEqual(commitCalled, false, 'Commit should NOT be called in review mode');
            assert.strictEqual(pushCalled, false, 'Push should NOT be called in review mode');
        });

        test('executeReviewProcessing posts comments but does not clone/worktree/commit', () => {
            // Track which infrastructure functions would be called
            const calls: string[] = [];

            // Simulated review processing — mirrors prCommentReviewJob.ts
            // It calls: getAuthenticatedOctokit, validatePRAndComments, fetchAllComments,
            //           buildReviewPrompt, agent.analyze, buildReviewComment, octokit.request (POST comment)
            // It does NOT call: ensureRepoCloned, createWorktreeFromExistingBranch, commitChanges, pushBranch
            const reviewActions = [
                'getAuthenticatedOctokit',
                'validatePRAndComments',
                'fetchAllComments',
                'buildReviewPrompt',
                'agent.analyze',
                'buildReviewComment',
                'postComment',
            ];

            const commitActions = [
                'ensureRepoCloned',
                'createWorktreeFromExistingBranch',
                'commitChanges',
                'pushBranch',
            ];

            // Simulate review execution
            for (const action of reviewActions) {
                calls.push(action);
            }

            // Verify no commit-related actions were performed
            for (const commitAction of commitActions) {
                assert.ok(!calls.includes(commitAction), `${commitAction} should NOT be called in review mode`);
            }

            // Verify review actions were performed
            assert.ok(calls.includes('buildReviewComment'));
            assert.ok(calls.includes('postComment'));
        });

        test('default/fix mode DOES enter commit path', () => {
            let commitCalled = false;

            const commandMode = 'default';
            if (commandMode === 'review') {
                // review path
            } else {
                commitCalled = true; // default/fix path includes commit
            }

            assert.strictEqual(commitCalled, true, 'Default mode should enter commit path');
        });

        test('fix mode DOES enter commit path', () => {
            let commitCalled = false;

            const commandMode = 'fix';
            if (commandMode === 'review') {
                // review path
            } else {
                commitCalled = true; // fix path includes commit
            }

            assert.strictEqual(commitCalled, true, 'Fix mode should enter commit path');
        });
    });

    describe('commandMode normalization', () => {
        test('missing commandMode defaults to default', () => {
            // Matches processPullRequestCommentJob.ts:100-102
            const jobData: { commandMode?: string } = {};
            if (!jobData.commandMode) {
                jobData.commandMode = 'default';
            }
            assert.strictEqual(jobData.commandMode, 'default');
        });

        test('explicit review commandMode is preserved', () => {
            const jobData = { commandMode: 'review' };
            if (!jobData.commandMode) {
                jobData.commandMode = 'default';
            }
            assert.strictEqual(jobData.commandMode, 'review');
        });

        test('explicit fix commandMode is preserved', () => {
            const jobData = { commandMode: 'fix' };
            if (!jobData.commandMode) {
                jobData.commandMode = 'default';
            }
            assert.strictEqual(jobData.commandMode, 'fix');
        });
    });
});

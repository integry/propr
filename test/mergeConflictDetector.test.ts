import { test, mock, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { PullRequestEvent, PushEvent } from '@octokit/webhooks-types';

// Mock Octokit used by all helper functions
const mockOctokit = {
    request: mock.fn()
};

// Mock simple-git (transitive dependency)
await mock.module('simple-git', {
    namedExports: {
        simpleGit: mock.fn(() => ({})),
        SimpleGit: class {}
    }
});

// Mock ioredis
await mock.module('ioredis', {
    defaultExport: function Redis() {
        return { on: mock.fn(), quit: mock.fn(async () => {}) };
    }
});

// Mock bullmq
const mockQueueAdd = mock.fn(async () => {});
await mock.module('bullmq', {
    namedExports: {
        Queue: function Queue() {
            return { add: mockQueueAdd, close: mock.fn(), on: mock.fn() };
        },
        Worker: function Worker() {
            return { on: mock.fn(), close: mock.fn() };
        }
    }
});

// Mock better-sqlite3
await mock.module('better-sqlite3', {
    defaultExport: function Database() {
        return {
            exec: mock.fn(),
            prepare: mock.fn(() => ({ run: mock.fn(), get: mock.fn(), all: mock.fn(() => []) })),
            close: mock.fn(),
            pragma: mock.fn(),
        };
    }
});

// Mock GitHub auth
await mock.module('../packages/core/src/auth/githubAuth.js', {
    namedExports: {
        getAuthenticatedOctokit: mock.fn(async () => mockOctokit),
        getGitHubInstallationToken: mock.fn(async () => 'mock-token'),
    }
});

// Mock logger
const mockLoggerInstance = {
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    debug: mock.fn(),
};

await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: {
        info: mock.fn(),
        warn: mock.fn(),
        error: mock.fn(),
        debug: mock.fn(),
        withCorrelation: mock.fn(() => mockLoggerInstance),
    },
    namedExports: {
        generateCorrelationId: mock.fn(() => 'test-correlation-id'),
        default: {
            info: mock.fn(),
            warn: mock.fn(),
            error: mock.fn(),
            debug: mock.fn(),
            withCorrelation: mock.fn(() => mockLoggerInstance),
        },
    }
});

// Mock configManager
const mockLoadAutoResolve = mock.fn(async () => false);
await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: {
        loadAutoResolveMergeConflicts: mockLoadAutoResolve,
        getConfig: mock.fn(async () => false),
        saveConfig: mock.fn(async () => true),
    }
});

// Mock taskQueue
const mockGetIssueQueue = mock.fn(async () => ({ add: mockQueueAdd }));
await mock.module('../packages/core/src/queue/taskQueue.js', {
    namedExports: {
        getIssueQueue: mockGetIssueQueue,
    }
});

// Import the module under test
const { handlePullRequestConflictDetection, handlePushConflictDetection } = await import('../packages/core/src/webhook/mergeConflictDetector.js');

// Mock Redis client factory
function createMockRedis() {
    const store = new Map<string, string>();
    return {
        get: mock.fn(async (key: string) => store.get(key) ?? null),
        setex: mock.fn(async (key: string, _ttl: number, value: string) => { store.set(key, value); }),
        set: mock.fn(async (key: string, value: string) => { store.set(key, value); }),
        del: mock.fn(async (key: string) => { store.delete(key); }),
        _store: store,
    };
}

// Helper to create a mock PullRequestEvent
function createMockPREvent(options: {
    action?: string;
    prNumber?: number;
    repoFullName?: string;
}): PullRequestEvent {
    const {
        action = 'synchronize',
        prNumber = 42,
        repoFullName = 'test-owner/test-repo',
    } = options;

    return {
        action,
        pull_request: {
            number: prNumber,
            state: 'open',
            draft: false,
            head: { ref: 'feature-branch', sha: 'head-sha-123' },
            base: { ref: 'main', sha: 'base-sha-456' },
            labels: [],
            merged: false,
        },
        repository: {
            id: 1,
            node_id: 'R_1',
            name: repoFullName.split('/')[1],
            full_name: repoFullName,
            private: false,
            owner: { login: repoFullName.split('/')[0] },
        },
    } as unknown as PullRequestEvent;
}

// Helper to create a mock PushEvent
function createMockPushEvent(options: {
    ref?: string;
    repoFullName?: string;
}): PushEvent {
    const {
        ref = 'refs/heads/main',
        repoFullName = 'test-owner/test-repo',
    } = options;

    return {
        ref,
        commits: [{ id: 'commit-sha-1', message: 'test commit' }],
        repository: {
            id: 1,
            node_id: 'R_1',
            name: repoFullName.split('/')[1],
            full_name: repoFullName,
            private: false,
            owner: { login: repoFullName.split('/')[0] },
        },
    } as unknown as PushEvent;
}

// Helper to set up Octokit mock PR responses
function mockPRResponse(options: {
    prNumber?: number;
    state?: string;
    mergeable?: boolean | null;
    mergeableState?: string;
    draft?: boolean;
    headSha?: string;
    baseSha?: string;
}) {
    const {
        prNumber = 42,
        state = 'open',
        mergeable = false,
        mergeableState = 'dirty',
        draft = false,
        headSha = 'head-sha-123',
        baseSha = 'base-sha-456',
    } = options;

    return {
        data: {
            number: prNumber,
            state,
            mergeable,
            mergeable_state: mergeableState,
            draft,
            head: { ref: 'feature-branch', sha: headSha },
            base: { ref: 'main', sha: baseSha },
            labels: [],
        }
    };
}

function resetMocks() {
    mockOctokit.request.mock.resetCalls();
    mockQueueAdd.mock.resetCalls();
    mockLoadAutoResolve.mock.resetCalls();
    mockLoggerInstance.info.mock.resetCalls();
    mockLoggerInstance.debug.mock.resetCalls();
}

// --- Pull Request Triggered Tests ---

describe('mergeConflictDetector - pull_request events', () => {
    beforeEach(() => resetMocks());

    test('no job queued when feature flag is disabled', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => false);
        const redis = createMockRedis();
        const payload = createMockPREvent({ action: 'synchronize' });

        const result = await handlePullRequestConflictDetection(payload, redis as never, 'corr-1');

        assert.ok(result);
        assert.strictEqual(result.outcome, 'skipped_disabled');
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('irrelevant actions are ignored', async () => {
        const redis = createMockRedis();
        const payload = createMockPREvent({ action: 'closed' });

        const result = await handlePullRequestConflictDetection(payload, redis as never, 'corr-2');
        assert.strictEqual(result, null);
    });

    test('no job queued for draft PRs', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => true);
        const redis = createMockRedis();
        const payload = createMockPREvent({ action: 'opened' });

        mockOctokit.request.mock.mockImplementation(async () => mockPRResponse({ draft: true, mergeable: false, mergeableState: 'dirty' }));

        const result = await handlePullRequestConflictDetection(payload, redis as never, 'corr-3');

        assert.ok(result);
        assert.strictEqual(result.outcome, 'skipped_draft');
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('no job queued for clean PRs', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => true);
        const redis = createMockRedis();
        const payload = createMockPREvent({ action: 'synchronize' });

        mockOctokit.request.mock.mockImplementation(async () => mockPRResponse({ mergeable: true, mergeableState: 'clean' }));

        const result = await handlePullRequestConflictDetection(payload, redis as never, 'corr-4');

        assert.ok(result);
        assert.strictEqual(result.outcome, 'skipped_not_conflicted');
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('conflicted PR is queued once per unique conflict state', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => true);
        const redis = createMockRedis();
        const payload = createMockPREvent({ action: 'synchronize' });

        mockOctokit.request.mock.mockImplementation(async () => mockPRResponse({ mergeable: false, mergeableState: 'dirty' }));

        // First call: should queue
        const result1 = await handlePullRequestConflictDetection(payload, redis as never, 'corr-5');
        assert.ok(result1);
        assert.strictEqual(result1.outcome, 'queued');
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);

        // Verify job payload
        const addCall = mockQueueAdd.mock.calls[0];
        assert.strictEqual(addCall.arguments[0], 'processMergeConflict');
        const jobData = addCall.arguments[1];
        assert.strictEqual(jobData.pullRequestNumber, 42);
        assert.strictEqual(jobData.triggerSource, 'pull_request');
        assert.strictEqual(jobData.systemGenerated, true);
        assert.strictEqual(jobData.headBranch, 'feature-branch');
        assert.strictEqual(jobData.baseBranch, 'main');

        // Second call with same SHAs: should be duplicate
        const result2 = await handlePullRequestConflictDetection(payload, redis as never, 'corr-6');
        assert.ok(result2);
        assert.strictEqual(result2.outcome, 'skipped_duplicate');
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1); // Still 1
    });

    test('new job queued when conflict state changes (different base SHA)', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => true);
        const redis = createMockRedis();
        const payload = createMockPREvent({ action: 'synchronize' });

        // First: conflict with base-sha-456
        mockOctokit.request.mock.mockImplementation(async () => mockPRResponse({ mergeable: false, mergeableState: 'dirty', headSha: 'head-sha-123', baseSha: 'base-sha-456' }));
        const result1 = await handlePullRequestConflictDetection(payload, redis as never, 'corr-7');
        assert.strictEqual(result1?.outcome, 'queued');

        // Second: conflict with new base-sha-789 (base branch updated)
        mockOctokit.request.mock.mockImplementation(async () => mockPRResponse({ mergeable: false, mergeableState: 'dirty', headSha: 'head-sha-123', baseSha: 'base-sha-789' }));
        const result2 = await handlePullRequestConflictDetection(payload, redis as never, 'corr-8');
        assert.strictEqual(result2?.outcome, 'queued');
        assert.strictEqual(mockQueueAdd.mock.callCount(), 2);
    });

    test('removes a freshly queued merge-conflict job if the PR merges during enqueue', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => true);
        const redis = createMockRedis();
        const payload = createMockPREvent({ action: 'synchronize' });
        const remove = mock.fn(async () => undefined);

        mockOctokit.request.mock.mockImplementation(async () => mockPRResponse({
            mergeable: false,
            mergeableState: 'dirty',
            headSha: 'head-sha-123',
            baseSha: 'base-sha-456',
        }));
        mockQueueAdd.mock.mockImplementationOnce(async () => {
            redis._store.set('pr-merged:test-owner/test-repo:42', new Date().toISOString());
            return { remove };
        });

        const result = await handlePullRequestConflictDetection(payload, redis as never, 'corr-merged-race');

        assert.strictEqual(result?.outcome, 'skipped_merged');
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(remove.mock.calls.length, 1);
    });

    test('queues conflicted PRs when merged-state verification fails before enqueue', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => true);
        const redis = createMockRedis();
        const payload = createMockPREvent({ action: 'synchronize' });

        mockOctokit.request.mock
            .mockImplementationOnce(async () => mockPRResponse({
                mergeable: false,
                mergeableState: 'dirty',
                headSha: 'head-sha-123',
                baseSha: 'base-sha-456',
            }))
            .mockImplementationOnce(async () => {
                throw new Error('github unavailable');
            });

        const result = await handlePullRequestConflictDetection(payload, redis as never, 'corr-merged-lookup-failure');

        assert.strictEqual(result?.outcome, 'queued');
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
    });

    test('logs clearly distinguish outcomes', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => false);
        const redis = createMockRedis();
        const payload = createMockPREvent({ action: 'synchronize' });

        await handlePullRequestConflictDetection(payload, redis as never, 'corr-log');

        // Should have logged with skipped_disabled outcome
        const infoCalls = mockLoggerInstance.info.mock.calls;
        const disabledLog = infoCalls.find((c: { arguments: [Record<string, unknown>, string] }) =>
            (c.arguments[0] as Record<string, unknown>).outcome === 'skipped_disabled'
        );
        assert.ok(disabledLog, 'Expected a log entry with outcome skipped_disabled');
    });
});

// --- Push-Triggered Tests ---

describe('mergeConflictDetector - push events', () => {
    beforeEach(() => resetMocks());

    test('no jobs queued when feature flag is disabled', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => false);
        const redis = createMockRedis();
        const payload = createMockPushEvent({ ref: 'refs/heads/main' });

        const results = await handlePushConflictDetection(payload, redis as never, 'corr-20');

        assert.strictEqual(results.length, 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('skips non-branch refs (tags)', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => true);
        const redis = createMockRedis();
        const payload = createMockPushEvent({ ref: 'refs/tags/v1.0' });

        const results = await handlePushConflictDetection(payload, redis as never, 'corr-21');

        assert.strictEqual(results.length, 0);
    });

    test('skips when no open PRs target the pushed branch', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => true);
        const redis = createMockRedis();
        const payload = createMockPushEvent({ ref: 'refs/heads/main' });

        mockOctokit.request.mock.mockImplementation(async () => ({ data: [] }));

        const results = await handlePushConflictDetection(payload, redis as never, 'corr-22');

        assert.strictEqual(results.length, 0);
    });

    test('checks open PRs and queues only conflicted ones', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => true);
        const redis = createMockRedis();
        const payload = createMockPushEvent({ ref: 'refs/heads/main' });

        let callCount = 0;
        mockOctokit.request.mock.mockImplementation(async (url: string) => {
            if (url === 'GET /repos/{owner}/{repo}/pulls') {
                return {
                    data: [
                        { number: 10, state: 'open' },
                        { number: 20, state: 'open' },
                    ]
                };
            }
            // Individual PR details
            callCount++;
            if (callCount <= 1) {
                return mockPRResponse({ prNumber: 10, mergeable: false, mergeableState: 'dirty', headSha: 'pr10-head', baseSha: 'pr10-base' });
            } else {
                return mockPRResponse({ prNumber: 20, mergeable: true, mergeableState: 'clean', headSha: 'pr20-head', baseSha: 'pr20-base' });
            }
        });

        const results = await handlePushConflictDetection(payload, redis as never, 'corr-23');

        assert.strictEqual(results.length, 2);
        const queued = results.filter(r => r.outcome === 'queued');
        const clean = results.filter(r => r.outcome === 'skipped_not_conflicted');
        assert.strictEqual(queued.length, 1);
        assert.strictEqual(queued[0].prNumber, 10);
        assert.strictEqual(clean.length, 1);
        assert.strictEqual(clean[0].prNumber, 20);
    });

    test('push-triggered job has correct triggerSource', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => true);
        const redis = createMockRedis();
        const payload = createMockPushEvent({ ref: 'refs/heads/main' });

        mockOctokit.request.mock.mockImplementation(async (url: string) => {
            if (url === 'GET /repos/{owner}/{repo}/pulls') {
                return { data: [{ number: 10, state: 'open' }] };
            }
            return mockPRResponse({ prNumber: 10, mergeable: false, mergeableState: 'dirty', headSha: 'pr10-head', baseSha: 'pr10-base' });
        });

        await handlePushConflictDetection(payload, redis as never, 'corr-24');

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1];
        assert.strictEqual(jobData.triggerSource, 'push');
        assert.strictEqual(jobData.systemGenerated, true);
    });
});

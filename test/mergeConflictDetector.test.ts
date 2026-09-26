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
    namedExports: {
        Redis: function Redis() {
            return { on: mock.fn(), quit: mock.fn(async () => {}) };
        }
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
    }
});

// Mock configManager
const VALID_TRIGGER_LABELS = ['AI', 'propr'];
const mockLoadAutoResolve = mock.fn(async () => false);
const mockLoadPrimaryProcessingLabels = mock.fn(async () => ['AI']);
const mockLoadPrLabel = mock.fn(async () => 'propr');
const mockLoadAiPrimaryTag = mock.fn(async () => 'AI');
const mockLoadValidTriggerLabels = mock.fn(async () => VALID_TRIGGER_LABELS);
const mockHasValidTriggerLabel = mock.fn(async (labels: Array<{ name: string } | string> | null | undefined) => {
    if (!Array.isArray(labels)) return false;
    return labels.some(label => VALID_TRIGGER_LABELS.includes(typeof label === 'string' ? label : label.name));
});
await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: {
        loadAutoResolveMergeConflicts: mockLoadAutoResolve,
        loadPrimaryProcessingLabels: mockLoadPrimaryProcessingLabels,
        loadPrLabel: mockLoadPrLabel,
        loadAiPrimaryTag: mockLoadAiPrimaryTag,
        loadValidTriggerLabels: mockLoadValidTriggerLabels,
        hasValidTriggerLabel: mockHasValidTriggerLabel,
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
const { handlePullRequestConflictDetection, handlePushConflictDetection, handleMergeCommand } = await import('../packages/core/src/webhook/mergeConflictDetector.js');

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
    labels?: Array<{ name: string }>;
}): PullRequestEvent {
    const {
        action = 'synchronize',
        prNumber = 42,
        repoFullName = 'test-owner/test-repo',
        labels = [{ name: 'AI' }],
    } = options;

    return {
        action,
        pull_request: {
            number: prNumber,
            state: 'open',
            draft: false,
            head: { ref: 'feature-branch', sha: 'head-sha-123' },
            base: { ref: 'main', sha: 'base-sha-456' },
            labels,
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
    labels?: Array<{ name: string }>;
}) {
    const {
        prNumber = 42,
        state = 'open',
        mergeable = false,
        mergeableState = 'dirty',
        draft = false,
        headSha = 'head-sha-123',
        baseSha = 'base-sha-456',
        labels = [{ name: 'AI' }],
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
            labels,
        }
    };
}

// Labelled PR summary as returned by the pull list endpoint
function mockPRSummary(prNumber: number, labels: Array<{ name: string }> = [{ name: 'AI' }]) {
    return { number: prNumber, state: 'open', labels };
}

function resetMocks() {
    mockOctokit.request.mock.resetCalls();
    mockQueueAdd.mock.resetCalls();
    mockLoadAutoResolve.mock.resetCalls();
    mockLoggerInstance.info.mock.resetCalls();
    mockLoggerInstance.debug.mock.resetCalls();
    mockHasValidTriggerLabel.mock.resetCalls();
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

    test('unlabelled PR is skipped with skipped_no_trigger_label before any API request', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => true);
        const redis = createMockRedis();
        const payload = createMockPREvent({ action: 'synchronize', labels: [] });

        mockOctokit.request.mock.mockImplementation(async () => mockPRResponse({ mergeable: false, mergeableState: 'dirty', labels: [] }));

        const result = await handlePullRequestConflictDetection(payload, redis as never, 'corr-9');

        assert.ok(result);
        assert.strictEqual(result.outcome, 'skipped_no_trigger_label');
        assert.strictEqual(result.prNumber, 42);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        assert.strictEqual(mockOctokit.request.mock.callCount(), 0, 'should not fetch PR details for unlabelled PRs');

        const skipLog = mockLoggerInstance.info.mock.calls.find((c: { arguments: [Record<string, unknown>, string] }) =>
            (c.arguments[0] as Record<string, unknown>).outcome === 'skipped_no_trigger_label'
        );
        assert.ok(skipLog, 'Expected a log entry with outcome skipped_no_trigger_label');
    });

    test('PR with unrelated labels only is skipped with skipped_no_trigger_label', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => true);
        const redis = createMockRedis();
        const payload = createMockPREvent({ action: 'opened', labels: [{ name: 'bug' }, { name: 'help wanted' }] });

        const result = await handlePullRequestConflictDetection(payload, redis as never, 'corr-10');

        assert.strictEqual(result?.outcome, 'skipped_no_trigger_label');
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('conflicted PR with the configured PR label (propr) is queued', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => true);
        const redis = createMockRedis();
        const payload = createMockPREvent({ action: 'synchronize', labels: [{ name: 'propr' }] });

        mockOctokit.request.mock.mockImplementation(async () => mockPRResponse({ mergeable: false, mergeableState: 'dirty', labels: [{ name: 'propr' }] }));

        const result = await handlePullRequestConflictDetection(payload, redis as never, 'corr-11');

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
                        mockPRSummary(10),
                        mockPRSummary(20),
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
                return { data: [mockPRSummary(10)] };
            }
            return mockPRResponse({ prNumber: 10, mergeable: false, mergeableState: 'dirty', headSha: 'pr10-head', baseSha: 'pr10-base' });
        });

        await handlePushConflictDetection(payload, redis as never, 'corr-24');

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1];
        assert.strictEqual(jobData.triggerSource, 'push');
        assert.strictEqual(jobData.systemGenerated, true);
    });

    test('unlabelled open PRs are skipped and never fetched or queued', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => true);
        const redis = createMockRedis();
        const payload = createMockPushEvent({ ref: 'refs/heads/main' });

        const detailRequests: number[] = [];
        mockOctokit.request.mock.mockImplementation(async (url: string, params: { pull_number?: number }) => {
            if (url === 'GET /repos/{owner}/{repo}/pulls') {
                return {
                    data: [
                        mockPRSummary(10, [{ name: 'AI' }]),
                        mockPRSummary(20, []),
                        mockPRSummary(30, [{ name: 'enhancement' }]),
                    ]
                };
            }
            detailRequests.push(params.pull_number as number);
            return mockPRResponse({ prNumber: params.pull_number, mergeable: false, mergeableState: 'dirty', headSha: `pr${params.pull_number}-head`, baseSha: `pr${params.pull_number}-base` });
        });

        const results = await handlePushConflictDetection(payload, redis as never, 'corr-25');

        assert.strictEqual(results.length, 3);
        const queued = results.filter(r => r.outcome === 'queued');
        const skipped = results.filter(r => r.outcome === 'skipped_no_trigger_label');
        assert.strictEqual(queued.length, 1);
        assert.strictEqual(queued[0].prNumber, 10);
        assert.deepStrictEqual(skipped.map(r => r.prNumber).sort(), [20, 30]);
        assert.deepStrictEqual(detailRequests, [10], 'only the labelled PR should be fetched');
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(mockQueueAdd.mock.calls[0].arguments[1].pullRequestNumber, 10);
    });

    test('no jobs queued when none of the open PRs carry a trigger label', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => true);
        const redis = createMockRedis();
        const payload = createMockPushEvent({ ref: 'refs/heads/main' });

        mockOctokit.request.mock.mockImplementation(async (url: string) => {
            if (url === 'GET /repos/{owner}/{repo}/pulls') {
                return { data: [mockPRSummary(10, []), mockPRSummary(20, [])] };
            }
            throw new Error('PR details should not be fetched for unlabelled PRs');
        });

        const results = await handlePushConflictDetection(payload, redis as never, 'corr-26');

        assert.strictEqual(results.length, 2);
        assert.ok(results.every(r => r.outcome === 'skipped_no_trigger_label'));
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });
});

// --- /merge Command Tests ---

describe('mergeConflictDetector - handleMergeCommand', () => {
    beforeEach(() => resetMocks());

    const baseOptions = { owner: 'test-owner', repoName: 'test-repo', prNumber: 42, correlationId: 'corr-merge' };

    test('labelled PR is queued regardless of the auto-resolve flag', async () => {
        mockLoadAutoResolve.mock.mockImplementation(async () => false);
        const redis = createMockRedis();

        mockOctokit.request.mock.mockImplementation(async () => mockPRResponse({ mergeable: true, mergeableState: 'clean', labels: [{ name: 'AI' }] }));

        const result = await handleMergeCommand({ ...baseOptions, userId: '7', redisClient: redis as never });

        assert.strictEqual(result?.outcome, 'queued');
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1];
        assert.strictEqual(jobData.triggerSource, 'comment');
        assert.strictEqual(jobData.userId, '7');
        assert.strictEqual(jobData.pullRequestNumber, 42);
    });

    test('PR labelled with the configured PR label (propr) is queued', async () => {
        const redis = createMockRedis();
        mockOctokit.request.mock.mockImplementation(async () => mockPRResponse({ labels: [{ name: 'propr' }] }));

        const result = await handleMergeCommand({ ...baseOptions, redisClient: redis as never });

        assert.strictEqual(result?.outcome, 'queued');
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
    });

    test('unlabelled PR returns skipped_no_trigger_label and nothing is queued', async () => {
        const redis = createMockRedis();
        mockOctokit.request.mock.mockImplementation(async () => mockPRResponse({ labels: [] }));

        const result = await handleMergeCommand({ ...baseOptions, redisClient: redis as never });

        assert.ok(result);
        assert.strictEqual(result.outcome, 'skipped_no_trigger_label');
        assert.strictEqual(result.prNumber, 42);
        assert.strictEqual(result.repository, 'test-owner/test-repo');
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);

        const skipLog = mockLoggerInstance.info.mock.calls.find((c: { arguments: [Record<string, unknown>, string] }) =>
            (c.arguments[0] as Record<string, unknown>).outcome === 'skipped_no_trigger_label'
        );
        assert.ok(skipLog, 'Expected a log entry with outcome skipped_no_trigger_label');
    });

    test('PR with only non-trigger labels returns skipped_no_trigger_label', async () => {
        const redis = createMockRedis();
        mockOctokit.request.mock.mockImplementation(async () => mockPRResponse({ labels: [{ name: 'bug' }, { name: 'llm-claude' }] }));

        const result = await handleMergeCommand({ ...baseOptions, redisClient: redis as never });

        assert.strictEqual(result?.outcome, 'skipped_no_trigger_label');
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('closed PR returns null without checking labels', async () => {
        const redis = createMockRedis();
        mockOctokit.request.mock.mockImplementation(async () => mockPRResponse({ state: 'closed', labels: [] }));

        const result = await handleMergeCommand({ ...baseOptions, redisClient: redis as never });

        assert.strictEqual(result, null);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });
});

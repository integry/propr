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
const mockQueueAdd = mock.fn(async (..._args: unknown[]) => {});
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

// Stored configuration: the instance default row and the monitored repositories.
const storedConfig = new Map<string, unknown>();
await mock.module('../packages/core/src/config/configStore.js', {
    namedExports: {
        getConfig: mock.fn(async (key: string, fallback: unknown) => (storedConfig.has(key) ? storedConfig.get(key) : fallback)),
        getConfigStrict: mock.fn(async (key: string, fallback: unknown) => (storedConfig.has(key) ? storedConfig.get(key) : fallback)),
        getConfigWithClient: mock.fn(async (_key: string, fallback: unknown) => fallback),
        saveConfig: mock.fn(async () => true),
    }
});

// Trigger labels: processing label `AI`, PR label `propr`.
await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: {
        loadValidTriggerLabels: mock.fn(async () => ['AI', 'propr']),
    }
});

// ProPR task rows (repository + pr_number)
const taskRows: Array<{ repository: string; pr_number: number }> = [];
function createTaskQuery() {
    let repository = '';
    let prNumber = -1;
    const query = {
        whereRaw: (_sql: string, bindings: string[]) => { repository = bindings[0]; return query; },
        andWhere: (where: { pr_number: number }) => { prNumber = where.pr_number; return query; },
        first: async () => taskRows.find(row => row.repository.toLowerCase() === repository && row.pr_number === prNumber),
    };
    return query;
}
await mock.module('../packages/core/src/db/connection.js', {
    namedExports: { db: mock.fn(() => createTaskQuery()) }
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
const { sweepConflictedPullRequests, getMergeConflictSweepIntervalMs, classifyMergeability } = await import('../packages/core/src/webhook/mergeConflictAutoResolve.js');

const sleeps: number[] = [];
const deps = { sleep: async (ms: number) => { sleeps.push(ms); } };

// Mock Redis client factory supporting SET NX EX, INCR/DECR and EXPIRE
function createMockRedis() {
    const store = new Map<string, string>();
    const ttls = new Map<string, number>();
    return {
        get: mock.fn(async (key: string) => store.get(key) ?? null),
        set: mock.fn(async (key: string, value: string, _ex: 'EX', seconds: number, nx: 'NX') => {
            if (nx === 'NX' && store.has(key)) return null;
            store.set(key, value);
            ttls.set(key, seconds);
            return 'OK';
        }),
        del: mock.fn(async (key: string) => { store.delete(key); }),
        incr: mock.fn(async (key: string) => { const next = Number(store.get(key) ?? 0) + 1; store.set(key, String(next)); return next; }),
        decr: mock.fn(async (key: string) => { const next = Number(store.get(key) ?? 0) - 1; store.set(key, String(next)); return next; }),
        expire: mock.fn(async (key: string, seconds: number) => { ttls.set(key, seconds); }),
        _store: store,
        _ttls: ttls,
    };
}

function createMockPREvent(options: { action?: string; prNumber?: number; repoFullName?: string } = {}): PullRequestEvent {
    const { action = 'synchronize', prNumber = 42, repoFullName = 'test-owner/test-repo' } = options;
    return {
        action,
        pull_request: { number: prNumber, state: 'open', draft: false, labels: [] },
        repository: { full_name: repoFullName, name: repoFullName.split('/')[1], owner: { login: repoFullName.split('/')[0] } },
    } as unknown as PullRequestEvent;
}

function createMockPushEvent(options: { ref?: string; repoFullName?: string; deleted?: boolean } = {}): PushEvent {
    const { ref = 'refs/heads/main', repoFullName = 'test-owner/test-repo', deleted = false } = options;
    return {
        ref,
        deleted,
        commits: [{ id: 'commit-sha-1', message: 'test commit' }],
        repository: { full_name: repoFullName, name: repoFullName.split('/')[1], owner: { login: repoFullName.split('/')[0] } },
    } as unknown as PushEvent;
}

interface PullRequestState {
    number?: number;
    state?: string;
    mergeable?: boolean | null;
    mergeableState?: string;
    draft?: boolean;
    headSha?: string;
    baseSha?: string;
    labels?: Array<{ name: string }>;
    headRepo?: { full_name: string } | null;
}

function pullRequest(options: PullRequestState = {}) {
    return {
        number: options.number ?? 42,
        state: options.state ?? 'open',
        mergeable: options.mergeable === undefined ? false : options.mergeable,
        mergeable_state: options.mergeableState ?? (options.mergeable === null ? 'unknown' : 'dirty'),
        draft: options.draft ?? false,
        head: { ref: 'feature-branch', sha: options.headSha ?? 'head-sha-123', repo: options.headRepo === undefined ? { full_name: 'test-owner/test-repo' } : options.headRepo },
        base: { ref: 'main', sha: options.baseSha ?? 'base-sha-456' },
        labels: options.labels ?? [{ name: 'AI' }],
    };
}

/**
 * Routes Octokit requests: `GET /pulls` returns the list; `GET /pulls/{n}` returns
 * successive reads for that PR (the last one repeats).
 */
function routeGitHub(reads: Record<number, PullRequestState[]>, list: number[] = Object.keys(reads).map(Number)) {
    const counters = new Map<number, number>();
    mockOctokit.request.mock.mockImplementation(async (route: string, params: { pull_number?: number }) => {
        if (route === 'GET /repos/{owner}/{repo}/pulls') {
            return { data: list.map(number => ({ number })) };
        }
        if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
            const number = params.pull_number as number;
            const sequence = reads[number] ?? [{ state: 'closed' }];
            const index = counters.get(number) ?? 0;
            counters.set(number, index + 1);
            return { data: pullRequest({ number, ...sequence[Math.min(index, sequence.length - 1)] }) };
        }
        throw new Error(`Unexpected route ${route}`);
    });
}

function skipReasons(level: 'info' | 'warn' = 'info'): string[] {
    return mockLoggerInstance[level].mock.calls
        .map(call => (call.arguments[0] as { reason?: string }).reason)
        .filter((reason): reason is string => typeof reason === 'string');
}

function enableInstance(enabled: boolean) {
    storedConfig.set('auto_resolve_merge_conflicts', enabled);
}

function resetMocks() {
    mockOctokit.request.mock.resetCalls();
    mockOctokit.request.mock.mockImplementation(async () => { throw new Error('unexpected GitHub call'); });
    mockQueueAdd.mock.resetCalls();
    mockQueueAdd.mock.mockImplementation(async () => {});
    for (const fn of Object.values(mockLoggerInstance)) fn.mock.resetCalls();
    storedConfig.clear();
    taskRows.length = 0;
    sleeps.length = 0;
    enableInstance(true);
}

describe('mergeConflictDetector - classification', () => {
    test('mergeable false or a dirty state is conflicted; null is unknown', () => {
        assert.equal(classifyMergeability({ mergeable: false, mergeable_state: 'dirty' }), 'conflicted');
        assert.equal(classifyMergeability({ mergeable: null, mergeable_state: 'dirty' }), 'conflicted');
        assert.equal(classifyMergeability({ mergeable: true, mergeable_state: 'clean' }), 'clean');
        assert.equal(classifyMergeability({ mergeable: null, mergeable_state: 'unknown' }), 'unknown');
    });
});

describe('mergeConflictDetector - pull_request events', () => {
    beforeEach(resetMocks);

    test('disabled setting skips with auto_resolve_disabled before any GitHub call', async () => {
        enableInstance(false);
        const result = await handlePullRequestConflictDetection(createMockPREvent(), createMockRedis(), 'cid', deps);
        assert.deepEqual({ outcome: result?.outcome, reason: result?.reason }, { outcome: 'skipped', reason: 'auto_resolve_disabled' });
        assert.equal(mockOctokit.request.mock.callCount(), 0);
        assert.deepEqual(skipReasons(), ['auto_resolve_disabled']);
    });

    test('a repository override enables the feature when the instance default is off', async () => {
        enableInstance(false);
        storedConfig.set('repos_to_monitor', [{ id: '1', name: 'Test-Owner/Test-Repo', enabled: true, autoResolveMergeConflicts: true }]);
        routeGitHub({ 42: [{}] });
        const result = await handlePullRequestConflictDetection(createMockPREvent(), createMockRedis(), 'cid', deps);
        assert.equal(result?.outcome, 'queued');
    });

    test('a repository override disables the feature when the instance default is on', async () => {
        storedConfig.set('repos_to_monitor', [{ id: '1', name: 'test-owner/test-repo', enabled: true, autoResolveMergeConflicts: false }]);
        const result = await handlePullRequestConflictDetection(createMockPREvent(), createMockRedis(), 'cid', deps);
        assert.equal(result?.reason, 'auto_resolve_disabled');
        assert.equal(mockOctokit.request.mock.callCount(), 0);
    });

    test('irrelevant actions are ignored', async () => {
        const result = await handlePullRequestConflictDetection(createMockPREvent({ action: 'labeled' }), createMockRedis(), 'cid', deps);
        assert.equal(result, null);
    });

    test('closed and draft PRs are skipped with a reason', async () => {
        routeGitHub({ 42: [{ state: 'closed' }], 43: [{ draft: true }] });
        const closed = await handlePullRequestConflictDetection(createMockPREvent(), createMockRedis(), 'cid', deps);
        const draft = await handlePullRequestConflictDetection(createMockPREvent({ prNumber: 43 }), createMockRedis(), 'cid', deps);
        assert.equal(closed?.reason, 'pull_request_closed');
        assert.equal(draft?.reason, 'draft_pull_request');
        assert.equal(mockQueueAdd.mock.callCount(), 0);
    });

    test('a clean PR is skipped with not_conflicted', async () => {
        routeGitHub({ 42: [{ mergeable: true, mergeableState: 'clean' }] });
        const result = await handlePullRequestConflictDetection(createMockPREvent(), createMockRedis(), 'cid', deps);
        assert.equal(result?.reason, 'not_conflicted');
        assert.equal(mockQueueAdd.mock.callCount(), 0);
    });

    test('mergeable: null is re-read on the 2s/5s/10s/20s schedule until GitHub reports the conflict', async () => {
        routeGitHub({ 42: [{ mergeable: null }, { mergeable: null }, { mergeable: false }] });
        const result = await handlePullRequestConflictDetection(createMockPREvent(), createMockRedis(), 'cid', deps);
        assert.equal(result?.outcome, 'queued');
        assert.deepEqual(sleeps, [2000, 5000]);
    });

    test('mergeability that never resolves is skipped with a warning (mergeability_unknown)', async () => {
        routeGitHub({ 42: [{ mergeable: null }] });
        const result = await handlePullRequestConflictDetection(createMockPREvent(), createMockRedis(), 'cid', deps);
        assert.equal(result?.reason, 'mergeability_unknown');
        assert.deepEqual(sleeps, [2000, 5000, 10000, 20000]);
        assert.deepEqual(skipReasons('warn'), ['mergeability_unknown']);
    });

    test('a PR identified only by the pr_label, an llm-* label or a tasks row is eligible', async () => {
        taskRows.push({ repository: 'test-owner/test-repo', pr_number: 44 });
        routeGitHub({ 42: [{ labels: [{ name: 'propr' }] }], 43: [{ labels: [{ name: 'llm-claude-opus55' }] }], 44: [{ labels: [] }] });
        for (const prNumber of [42, 43, 44]) {
            const result = await handlePullRequestConflictDetection(createMockPREvent({ prNumber }), createMockRedis(), 'cid', deps);
            assert.equal(result?.outcome, 'queued', `PR #${prNumber} should be queued`);
        }
    });

    test('a human PR without ProPR signals is skipped with not_propr_pull_request', async () => {
        routeGitHub({ 42: [{ labels: [{ name: 'bug' }] }] });
        const result = await handlePullRequestConflictDetection(createMockPREvent(), createMockRedis(), 'cid', deps);
        assert.equal(result?.reason, 'not_propr_pull_request');
        assert.equal(mockQueueAdd.mock.callCount(), 0);
        assert.deepEqual(skipReasons(), ['not_propr_pull_request']);
    });

    test('a PR whose head repository was deleted is skipped with fork_pull_request', async () => {
        routeGitHub({ 42: [{ headRepo: null }] });
        const result = await handlePullRequestConflictDetection(createMockPREvent(), createMockRedis(), 'cid', deps);
        assert.equal(result?.reason, 'fork_pull_request');
    });

    test('the same head+base pair is queued once with a 30-minute dedup key', async () => {
        routeGitHub({ 42: [{}] });
        const redis = createMockRedis();
        const first = await handlePullRequestConflictDetection(createMockPREvent(), redis, 'cid', deps);
        const second = await handlePullRequestConflictDetection(createMockPREvent(), redis, 'cid', deps);
        assert.equal(first?.outcome, 'queued');
        assert.equal(second?.reason, 'already_queued');
        assert.equal(mockQueueAdd.mock.callCount(), 1);
        const dedupKey = 'merge-conflict-queued:test-owner/test-repo#42:head-sha-123:base-sha-456';
        assert.equal(redis._ttls.get(dedupKey), 1800);

        const [name, data] = mockQueueAdd.mock.calls[0].arguments as [string, Record<string, unknown>];
        assert.equal(name, 'processMergeConflict');
        assert.equal(data.triggerSource, 'pull_request');
        assert.equal(data.headSha, 'head-sha-123');
        assert.equal(data.baseSha, 'base-sha-456');
    });

    test('a new head SHA after an earlier attempt is queued again', async () => {
        const redis = createMockRedis();
        routeGitHub({ 42: [{ headSha: 'head-1' }] });
        await handlePullRequestConflictDetection(createMockPREvent(), redis, 'cid', deps);
        routeGitHub({ 42: [{ headSha: 'head-2' }] });
        const result = await handlePullRequestConflictDetection(createMockPREvent(), redis, 'cid', deps);
        assert.equal(result?.outcome, 'queued');
        assert.equal(mockQueueAdd.mock.callCount(), 2);
    });

    test('an enqueue failure releases the dedup key so the next event can retry', async () => {
        routeGitHub({ 42: [{}] });
        const redis = createMockRedis();
        mockQueueAdd.mock.mockImplementationOnce(async () => { throw new Error('redis down'); });
        await assert.rejects(handlePullRequestConflictDetection(createMockPREvent(), redis, 'cid', deps), /redis down/);
        assert.equal(redis._store.has('merge-conflict-queued:test-owner/test-repo#42:head-sha-123:base-sha-456'), false);
        const retry = await handlePullRequestConflictDetection(createMockPREvent(), redis, 'cid', deps);
        assert.equal(retry?.outcome, 'queued');
    });

    test('more than 3 attempts within 24h are refused with attempt_limit', async () => {
        const redis = createMockRedis();
        for (let attempt = 1; attempt <= 3; attempt++) {
            routeGitHub({ 42: [{ baseSha: `base-${attempt}` }] });
            const result = await handlePullRequestConflictDetection(createMockPREvent(), redis, 'cid', deps);
            assert.equal(result?.outcome, 'queued');
        }
        assert.equal(redis._ttls.get('merge-conflict-attempts:test-owner/test-repo#42'), 24 * 3600);
        routeGitHub({ 42: [{ baseSha: 'base-4' }] });
        const limited = await handlePullRequestConflictDetection(createMockPREvent(), redis, 'cid', deps);
        assert.equal(limited?.reason, 'attempt_limit');
        assert.equal(mockQueueAdd.mock.callCount(), 3);
        assert.deepEqual(skipReasons('warn'), ['attempt_limit']);
    });
});

describe('mergeConflictDetector - push events', () => {
    beforeEach(resetMocks);

    test('disabled setting costs no GitHub calls', async () => {
        enableInstance(false);
        const results = await handlePushConflictDetection(createMockPushEvent(), createMockRedis(), 'cid', deps);
        assert.deepEqual(results, []);
        assert.equal(mockOctokit.request.mock.callCount(), 0);
        assert.deepEqual(skipReasons(), ['auto_resolve_disabled']);
    });

    test('tags, deleted branches and push salvage rescue refs are ignored', async () => {
        assert.deepEqual(await handlePushConflictDetection(createMockPushEvent({ ref: 'refs/tags/v1.0' }), createMockRedis(), 'cid', deps), []);
        assert.deepEqual(await handlePushConflictDetection(createMockPushEvent({ deleted: true }), createMockRedis(), 'cid', deps), []);
        assert.deepEqual(await handlePushConflictDetection(createMockPushEvent({ ref: 'refs/heads/propr/rescue/task-1' }), createMockRedis(), 'cid', deps), []);
        assert.equal(mockOctokit.request.mock.callCount(), 0);
    });

    test('a base advance queues a resolution even though GitHub first reports mergeable: null', async () => {
        routeGitHub({ 42: [{ mergeable: null }, { mergeable: null }, { mergeable: false }] });
        const results = await handlePushConflictDetection(createMockPushEvent(), createMockRedis(), 'cid', deps);
        assert.deepEqual(results.map(result => result.outcome), ['queued']);
        const [, data] = mockQueueAdd.mock.calls[0].arguments as [string, Record<string, unknown>];
        assert.equal(data.triggerSource, 'push');

        const listCall = mockOctokit.request.mock.calls.find(call => call.arguments[0] === 'GET /repos/{owner}/{repo}/pulls');
        assert.deepEqual(
            { base: (listCall?.arguments[1] as Record<string, unknown>).base, per_page: (listCall?.arguments[1] as Record<string, unknown>).per_page },
            { base: 'main', per_page: 30 }
        );
    });

    test('every open PR is primed before any is polled, then each is evaluated', async () => {
        routeGitHub({ 1: [{ mergeable: null }, { mergeable: false }], 2: [{ mergeable: true, mergeableState: 'clean' }], 3: [{ labels: [] }] });
        const results = await handlePushConflictDetection(createMockPushEvent(), createMockRedis(), 'cid', deps);
        assert.deepEqual(results.map(result => result.reason ?? result.outcome), ['queued', 'not_conflicted', 'not_propr_pull_request']);
        const reads = mockOctokit.request.mock.calls
            .filter(call => call.arguments[0] === 'GET /repos/{owner}/{repo}/pulls/{pull_number}')
            .map(call => (call.arguments[1] as { pull_number: number }).pull_number);
        assert.deepEqual(reads.slice(0, 3), [1, 2, 3], 'all PRs are read once before polling starts');
    });
});

describe('mergeConflictDetector - sweep', () => {
    beforeEach(resetMocks);

    test('evaluates open PRs only for repositories whose effective setting is on', async () => {
        enableInstance(false);
        storedConfig.set('repos_to_monitor', [
            { id: '1', name: 'test-owner/on', enabled: true, autoResolveMergeConflicts: true },
            { id: '2', name: 'test-owner/off', enabled: true },
        ]);
        routeGitHub({ 42: [{}] });
        const results = await sweepConflictedPullRequests({ repositories: ['test-owner/on', 'test-owner/off'], redisClient: createMockRedis(), deps });
        assert.deepEqual(results.map(result => [result.repository, result.outcome]), [['test-owner/on', 'queued']]);
        const [, data] = mockQueueAdd.mock.calls[0].arguments as [string, Record<string, unknown>];
        assert.equal(data.triggerSource, 'sweep');
        assert.ok(mockOctokit.request.mock.calls.every(call => (call.arguments[1] as { repo: string }).repo === 'on'));
    });

    test('runs every 5 minutes in polling mode and every 15 minutes otherwise', () => {
        assert.equal(getMergeConflictSweepIntervalMs('polling', {}), 5 * 60 * 1000);
        assert.equal(getMergeConflictSweepIntervalMs('routing_websocket', {}), 15 * 60 * 1000);
        assert.equal(getMergeConflictSweepIntervalMs('direct_webhook', { MERGE_CONFLICT_SWEEP_INTERVAL_MS: '60000' }), 60000);
    });
});

describe('mergeConflictDetector - handleMergeCommand', () => {
    beforeEach(resetMocks);

    test('queues a ProPR PR regardless of the auto-resolve setting', async () => {
        enableInstance(false);
        routeGitHub({ 42: [{ mergeable: true, mergeableState: 'clean' }] });
        const result = await handleMergeCommand({ owner: 'test-owner', repoName: 'test-repo', prNumber: 42, redisClient: createMockRedis(), correlationId: 'cid', userId: '7' });
        assert.equal(result?.outcome, 'queued');
        const [, data] = mockQueueAdd.mock.calls[0].arguments as [string, Record<string, unknown>];
        assert.equal(data.triggerSource, 'comment');
        assert.equal(data.userId, '7');
    });

    test('a human PR is refused with not_propr_pull_request', async () => {
        routeGitHub({ 42: [{ labels: [{ name: 'bug' }] }] });
        const result = await handleMergeCommand({ owner: 'test-owner', repoName: 'test-repo', prNumber: 42, redisClient: createMockRedis(), correlationId: 'cid' });
        assert.deepEqual({ outcome: result?.outcome, reason: result?.reason }, { outcome: 'skipped', reason: 'not_propr_pull_request' });
        assert.equal(mockQueueAdd.mock.callCount(), 0);
    });

    test('a closed PR returns null', async () => {
        routeGitHub({ 42: [{ state: 'closed' }] });
        const result = await handleMergeCommand({ owner: 'test-owner', repoName: 'test-repo', prNumber: 42, redisClient: createMockRedis(), correlationId: 'cid' });
        assert.equal(result, null);
    });
});

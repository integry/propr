import { test, mock, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

// --- Mock Setup ---

const mockOctokit = {
    request: mock.fn(async () => ({ data: { id: 100, html_url: 'https://github.com/test' } })),
    auth: mock.fn(async () => ({ token: 'mock-github-token' })),
};

const mockStateManager = {
    createTaskState: mock.fn(async () => {}),
    updateTaskState: mock.fn(async () => {}),
    getTaskState: mock.fn(async () => null),
    updateHistoryMetadata: mock.fn(async () => {}),
    getTaskKey: mock.fn(() => 'task:test'),
};

// Mock ioredis
const mockRedisStore = new Map<string, string>();
const mockRedisClient = {
    set: mock.fn(async (_key: string, _value: string, ..._args: unknown[]) => {
        mockRedisStore.set(_key, _value);
        return 'OK';
    }),
    get: mock.fn(async (key: string) => mockRedisStore.get(key) ?? null),
    del: mock.fn(async (key: string) => { mockRedisStore.delete(key); }),
    setex: mock.fn(async (key: string, _ttl: number, value: string) => { mockRedisStore.set(key, value); }),
    on: mock.fn(),
    quit: mock.fn(async () => {}),
};

await mock.module('ioredis', {
    namedExports: {
        Redis: function Redis() {
            return mockRedisClient;
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
        },
        Job: class {}
    }
});

// Mock simple-git
await mock.module('simple-git', {
    namedExports: {
        simpleGit: mock.fn(() => ({
            raw: mock.fn(async () => ''),
            status: mock.fn(async () => ({ conflicted: [], files: [] })),
            add: mock.fn(async () => {}),
            commit: mock.fn(async () => ({ commit: 'abc123' })),
            push: mock.fn(async () => {}),
        })),
        SimpleGit: class {}
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

// Track merge result to control flow
let mockMergeResult = { outcome: 'clean' as const };
const mockMergeBaseIntoBranch = mock.fn(async () => mockMergeResult);
const mockCommitChanges = mock.fn(async () => ({ commitHash: 'abc1234567890', commitMessage: 'test commit' }));
const mockPushBranch = mock.fn(async () => {});
const mockEnsureRepoCloned = mock.fn(async () => '/tmp/repos/test');
const mockCreateWorktreeFromExistingBranch = mock.fn(async () => ({ worktreePath: '/tmp/worktrees/test', branchName: 'feature-branch' }));
const mockCleanupWorktree = mock.fn(async () => {});
const mockEnsureGitRepository = mock.fn(async () => {});
const mockGetRepoUrl = mock.fn(() => 'https://github.com/test-owner/test-repo.git');

// Mock agent
const mockAgentResult = {
    success: true,
    modelUsed: 'claude-sonnet-4-20250514',
    executionTimeMs: 30000,
    sessionId: 'session-123',
    conversationId: 'conv-123',
    summary: 'Resolved merge conflicts',
    rawOutput: '',
    logs: [],
    modifiedFiles: ['src/index.ts'],
    conversationLog: [],
};

const mockAgent = {
    config: { alias: 'claude', type: 'claude', enabled: true, defaultModel: 'claude-sonnet-4-20250514', dockerImage: 'test' },
    executeTask: mock.fn(async () => mockAgentResult),
};

const mockRegistry = {
    ensureInitialized: mock.fn(async () => {}),
    getDefaultAgent: mock.fn(() => mockAgent),
    getAgentByAlias: mock.fn(() => mockAgent),
    getAllAgents: mock.fn(() => [mockAgent]),
};

// Mock @propr/core
await mock.module('@propr/core', {
    namedExports: {
        logger: {
            info: mock.fn(),
            warn: mock.fn(),
            error: mock.fn(),
            debug: mock.fn(),
            withCorrelation: mock.fn(() => mockLoggerInstance),
        },
        getAuthenticatedOctokit: mock.fn(async () => mockOctokit),
        withRetry: mock.fn(async (fn: () => Promise<unknown>) => fn()),
        retryConfigs: { githubApi: {} },
        getStateManager: mock.fn(() => mockStateManager),
        TaskStates: { PROCESSING: 'processing', CLAUDE_EXECUTION: 'claude_execution', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
        ensureRepoCloned: mockEnsureRepoCloned,
        createWorktreeFromExistingBranch: mockCreateWorktreeFromExistingBranch,
        getRepoUrl: mockGetRepoUrl,
        commitChanges: mockCommitChanges,
        pushBranch: mockPushBranch,
        mergeBaseIntoBranch: mockMergeBaseIntoBranch,
        ensureGitRepository: mockEnsureGitRepository,
        createLogFiles: mock.fn(async () => {}),
        UsageLimitError: class UsageLimitError extends Error { name = 'UsageLimitError'; },
        AgentRegistry: { getInstance: mock.fn(() => mockRegistry) },
        resolveLlmLabel: mock.fn(async (label: string) => ({ agentAlias: 'claude', model: label })),
        recordLLMMetrics: mock.fn(async () => {}),
        issueQueue: { add: mockQueueAdd },
        getDefaultModel: mock.fn(() => 'claude-sonnet-4-20250514'),
        loadSettings: mock.fn(async () => ({})),
        db: Object.assign(mock.fn(() => ({ where: mock.fn(() => ({ update: mock.fn(async () => {}) })) })), {
            migrate: { latest: mock.fn(async () => {}) }
        }),
        cleanupWorktree: mockCleanupWorktree,
        generateCorrelationId: mock.fn(() => 'test-correlation-id'),
    }
});

// Mock helpers
await mock.module('../src/jobs/prCommentJobHelpers.js', {
    namedExports: {
        createSessionIdCallbackForPR: mock.fn(() => async () => {}),
        createContainerIdCallbackForPR: mock.fn(() => async () => {}),
    }
});

await mock.module('../src/jobs/prCommentJobUtils.js', {
    namedExports: {
        toClaudeResult: mock.fn((r: unknown) => r),
        agentResultToClaudeResponse: mock.fn((r: Record<string, unknown>) => ({
            success: r.success,
            model: r.modelUsed,
            executionTime: r.executionTimeMs,
            sessionId: r.sessionId,
            conversationId: r.conversationId,
            summary: r.summary,
            error: r.error,
            finalResult: r.summary ? { type: 'result', result: r.summary } : null,
            conversationLog: r.conversationLog,
            tokenUsage: r.tokenUsage,
        })),
    }
});

// Import the module under test
const { processMergeConflictJob } = await import('../src/jobs/processMergeConflictJob.js');

function createMockJob(overrides: Partial<{
    pullRequestNumber: number;
    headBranch: string;
    baseBranch: string;
}> = {}) {
    return {
        id: 'test-job-123',
        name: 'processMergeConflict',
        data: {
            pullRequestNumber: overrides.pullRequestNumber ?? 42,
            repoOwner: 'test-owner',
            repoName: 'test-repo',
            headBranch: overrides.headBranch ?? 'feature-branch',
            baseBranch: overrides.baseBranch ?? 'main',
            headSha: 'head-sha-123',
            baseSha: 'base-sha-456',
            triggerSource: 'push' as const,
            correlationId: 'test-corr-123',
            systemGenerated: true as const,
        },
    } as never;
}

function resetAllMocks() {
    mockOctokit.request.mock.resetCalls();
    mockOctokit.auth.mock.resetCalls();
    mockStateManager.createTaskState.mock.resetCalls();
    mockStateManager.updateTaskState.mock.resetCalls();
    mockMergeBaseIntoBranch.mock.resetCalls();
    mockCommitChanges.mock.resetCalls();
    mockPushBranch.mock.resetCalls();
    mockAgent.executeTask.mock.resetCalls();
    mockRedisStore.clear();
}

describe('processMergeConflictJob', () => {
    beforeEach(() => {
        resetAllMocks();
        // Default: clean merge
        mockMergeResult = { outcome: 'clean' as const };
        mockMergeBaseIntoBranch.mock.mockImplementation(async () => mockMergeResult);
        mockOctokit.request.mock.mockImplementation(async () => ({ data: { id: 100, html_url: 'https://github.com/test' } }));
    });

    test('clean merge: commits and pushes without invoking agent', async () => {
        const job = createMockJob();
        const result = await processMergeConflictJob(job);

        assert.strictEqual(result.status, 'complete');
        assert.strictEqual((result as Record<string, unknown>).mergeType, 'clean');

        // Verify agent was NOT called
        assert.strictEqual(mockAgent.executeTask.mock.callCount(), 0);

        // Verify commit and push were called
        assert.strictEqual(mockCommitChanges.mock.callCount(), 1);
        assert.strictEqual(mockPushBranch.mock.callCount(), 1);

        // Verify starting comment was posted and then updated
        const requestCalls = mockOctokit.request.mock.calls;
        assert.ok(requestCalls.length >= 2); // POST starting comment + PATCH completion
        const postCall = requestCalls.find((c: { arguments: [string, Record<string, unknown>] }) =>
            c.arguments[0] === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments'
        );
        assert.ok(postCall, 'Expected starting work comment to be posted');

        const patchCall = requestCalls.find((c: { arguments: [string, Record<string, unknown>] }) =>
            c.arguments[0] === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}'
        );
        assert.ok(patchCall, 'Expected completion comment to be updated');
        const patchBody = patchCall.arguments[1].body as string;
        assert.ok(patchBody.includes('Auto-merged'), 'Expected clean merge message');

        // Verify state was set to COMPLETED
        const completedCalls = mockStateManager.updateTaskState.mock.calls.filter(
            (c: { arguments: [string, string] }) => c.arguments[1] === 'completed'
        );
        assert.ok(completedCalls.length >= 1, 'Expected task state to be set to COMPLETED');
    });

    test('conflict merge: invokes agent and pushes resolved conflicts', async () => {
        mockMergeResult = { outcome: 'conflicts' as never, conflictedFiles: ['src/index.ts', 'src/app.ts'] } as never;
        mockMergeBaseIntoBranch.mock.mockImplementation(async () => mockMergeResult);

        const job = createMockJob();
        const result = await processMergeConflictJob(job);

        assert.strictEqual(result.status, 'complete');
        assert.strictEqual((result as Record<string, unknown>).mergeType, 'conflict_resolved');

        // Verify agent WAS called
        assert.strictEqual(mockAgent.executeTask.mock.callCount(), 1);

        // Verify the prompt includes conflict info
        const executeCall = mockAgent.executeTask.mock.calls[0];
        const prompt = executeCall.arguments[0].prompt as string;
        assert.ok(prompt.includes('src/index.ts'), 'Prompt should include conflicted files');
        assert.ok(prompt.includes('src/app.ts'), 'Prompt should include conflicted files');
        assert.ok(prompt.includes('main'), 'Prompt should include base branch');

        // Verify commit and push were called
        assert.strictEqual(mockCommitChanges.mock.callCount(), 1);
        assert.strictEqual(mockPushBranch.mock.callCount(), 1);

        // Verify completion comment mentions conflicts resolved
        const patchCall = mockOctokit.request.mock.calls.find(
            (c: { arguments: [string, Record<string, unknown>] }) =>
                c.arguments[0] === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}'
        );
        assert.ok(patchCall);
        const body = patchCall.arguments[1].body as string;
        assert.ok(body.includes('Resolved merge conflicts'));
    });

    test('failed merge: reports error and sets FAILED state', async () => {
        mockMergeResult = { outcome: 'failed' as never, error: 'fatal: not a git repository' } as never;
        mockMergeBaseIntoBranch.mock.mockImplementation(async () => mockMergeResult);

        const job = createMockJob();

        await assert.rejects(
            async () => processMergeConflictJob(job),
            (err: Error) => {
                assert.ok(err.message.includes('Merge failed'));
                return true;
            }
        );

        // Verify agent was NOT called
        assert.strictEqual(mockAgent.executeTask.mock.callCount(), 0);

        // Verify state was set to FAILED
        const failedCalls = mockStateManager.updateTaskState.mock.calls.filter(
            (c: { arguments: [string, string] }) => c.arguments[1] === 'failed'
        );
        assert.ok(failedCalls.length >= 1, 'Expected task state to be set to FAILED');

        // Verify error comment was posted
        const patchCall = mockOctokit.request.mock.calls.find(
            (c: { arguments: [string, Record<string, unknown>] }) =>
                c.arguments[0] === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}'
        );
        assert.ok(patchCall);
        const body = patchCall.arguments[1].body as string;
        assert.ok(body.includes('Failed to resolve merge conflicts'));
        assert.ok(body.includes('not a git repository'));
    });

    test('reschedules if PR is locked by another job', async () => {
        // Pre-lock the PR with a different correlation ID
        mockRedisStore.set('lock:pr:test-owner:test-repo:42', 'other-correlation-id');
        mockRedisClient.set.mock.mockImplementation(async (_key: string, _value: string, ..._args: unknown[]) => {
            // NX fails because key exists
            return null;
        });

        const job = createMockJob();
        const result = await processMergeConflictJob(job);

        assert.strictEqual(result.status, 'rescheduled');
        assert.strictEqual((result as Record<string, unknown>).reason, 'pr_locked_by_other_job');

        // Reset the mock
        mockRedisClient.set.mock.mockImplementation(async (key: string, value: string) => {
            mockRedisStore.set(key, value);
            return 'OK';
        });
    });

    test('posts system-triggered starting comment', async () => {
        const job = createMockJob();
        await processMergeConflictJob(job);

        const postCalls = mockOctokit.request.mock.calls.filter(
            (c: { arguments: [string, Record<string, unknown>] }) =>
                c.arguments[0] === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments'
        );
        assert.ok(postCalls.length >= 1);
        const body = postCalls[0].arguments[1].body as string;
        assert.ok(body.includes('Auto-resolving merge conflicts'));
        assert.ok(body.includes('system-triggered'));
    });

    test('cleans up worktree and releases lock in finally block', async () => {
        const job = createMockJob();
        await processMergeConflictJob(job);

        // Lock should be released
        assert.ok(!mockRedisStore.has('lock:pr:test-owner:test-repo:42'));

        // Worktree should be cleaned up
        assert.strictEqual(mockCleanupWorktree.mock.callCount(), 1);
    });
});

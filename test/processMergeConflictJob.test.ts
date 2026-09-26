import { test, mock, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { sanitizeAgentReport } from '../packages/core/src/agents/agentReportSanitizer.js';

// --- Mock Setup ---

function defaultOctokitRequest(route: string) {
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return {
            data: {
                head: mockPullRequestHead,
                base: { ref: 'main' },
                title: 'Contribution',
                body: 'PR body',
                user: { login: 'contributor' },
            },
        };
    }
    return { data: { id: 100, html_url: 'https://github.com/test' } };
}

const mockOctokit = {
    request: mock.fn(async (route: string, ..._args: unknown[]) => defaultOctokitRequest(route)),
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
let mockMergeResult: {
    outcome: 'clean' | 'conflicts' | 'failed';
    baseCommit?: string;
    conflictedFiles?: string[];
    error?: string;
} = { outcome: 'clean', baseCommit: 'base-sha-456' };
const mockMergeBaseIntoBranch = mock.fn(async () => mockMergeResult);
const mockCommitChanges = mock.fn(async () => ({ commitHash: 'abc1234567890', commitMessage: 'test commit' }));
const mockPushBranch = mock.fn(async () => ({ commitHash: 'abc1234567890', rebased: false }));
const mockAssertCommitIsAncestor = mock.fn(async () => {});
const mockStageChanges = mock.fn(async () => {});
const mockEnsureRepoCloned = mock.fn(async (_options?: Record<string, unknown>) => '/tmp/repos/test');
const mockCreateWorktreeFromExistingBranch = mock.fn(async (..._args: unknown[]) => ({ worktreePath: '/tmp/worktrees/test', branchName: 'feature-branch' }));

// The live PR head decides which repository merge work is prepared in and pushed to.
let mockPullRequestHead: {
    ref: string;
    sha: string;
    repo: { name: string; full_name: string; owner: { login: string } } | null;
} = {
    ref: 'feature-branch',
    sha: 'head-sha-123',
    repo: { name: 'test-repo', full_name: 'test-owner/test-repo', owner: { login: 'test-owner' } },
};
let mockGitRawImplementation: (args: string[]) => Promise<string> = async (args: string[]) =>
    args[0] === 'merge-base' ? args[1] : '';
const mockGitRaw = mock.fn(async (args: string[]) => mockGitRawImplementation(args));
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
const mockConfiguredAgent = {
    config: { alias: 'codex', type: 'codex', enabled: true, defaultModel: 'gpt-5.5', dockerImage: 'test' },
    executeTask: mock.fn(async () => ({ ...mockAgentResult, modelUsed: 'gpt-5.5' })),
};
let mockSettings: Record<string, unknown> = {};

const mockRegistry = {
    ensureInitialized: mock.fn(async () => {}),
    getDefaultAgent: mock.fn(() => mockAgent),
    getAgentByAlias: mock.fn((alias: string) => alias === 'codex' ? mockConfiguredAgent : mockAgent),
    getAllAgents: mock.fn(() => [mockAgent, mockConfiguredAgent]),
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
        createHooklessGit: mock.fn(() => ({ add: mockStageChanges, raw: mockGitRaw })),
        pushBranch: mockPushBranch,
        assertCommitIsAncestor: mockAssertCommitIsAncestor,
        mergeBaseIntoBranch: mockMergeBaseIntoBranch,
        ensureGitRepository: mockEnsureGitRepository,
        createLogFiles: mock.fn(async () => {}),
        UsageLimitError: class UsageLimitError extends Error { name = 'UsageLimitError'; },
        AgentRegistry: { getInstance: mock.fn(() => mockRegistry) },
        resolveConfiguredModel: mock.fn(async (model: string) => model),
        resolveLlmLabel: mock.fn(async (label: string) => ({ agentAlias: 'claude', model: label })),
        recordLLMMetrics: mock.fn(async () => {}),
        issueQueue: { add: mockQueueAdd },
        getDefaultModel: mock.fn(() => 'claude-sonnet-4-20250514'),
        NoDefaultModelConfiguredError: class NoDefaultModelConfiguredError extends Error { name = 'NoDefaultModelConfiguredError'; },
        loadSettings: mock.fn(async () => mockSettings),
        loadSummarizationSettings: mock.fn(async () => ({ agent_alias: '' })),
        runLightweightLLMAnalysis: mock.fn(async () => 'Resolve merge conflicts'),
        db: Object.assign(mock.fn(() => ({ where: mock.fn(() => ({ update: mock.fn(async () => {}) })) })), {
            migrate: { latest: mock.fn(async () => {}) }
        }),
        cleanupWorktree: mockCleanupWorktree,
        sanitizeAgentReport,
        generateCorrelationId: mock.fn(() => 'test-correlation-id'),
        AI_COMMIT_AUTHOR: { name: 'ProPR AI', email: 'ai@propr.dev' },
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
        fetchAllComments: mock.fn(async () => []),
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
            logs: r.logs,
            rawOutput: r.rawOutput,
        })),
    }
});

function isMockPublicationPermissionDenied(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /write access to repository not granted|resource not accessible by integration|refusing to allow a GitHub App to create or update workflow .+ without [`'"]?workflows[`'"]? permission/i.test(message);
}

class MockPullRequestPublication {
    target: { repoOwner: string; repoName: string; branchName: string; isFork: boolean };
    status = '';

    constructor(
        private readonly _octokit: unknown,
        private readonly ref: { repoOwner: string; repoName: string; pullRequestNumber: number },
        private readonly source: { head: typeof mockPullRequestHead },
    ) {
        const [fullNameOwner, fullNameRepo] = source.head.repo?.full_name.split('/', 2) ?? [];
        this.target = {
            repoOwner: source.head.repo?.owner.login || fullNameOwner,
            repoName: source.head.repo?.name || fullNameRepo,
            branchName: source.head.ref,
            isFork: source.head.repo?.owner.login !== ref.repoOwner || source.head.repo?.name !== ref.repoName,
        };
    }

    private async createWorktree(worktreeDirName: string) {
        const localRepoPath = await mockEnsureRepoCloned({
            owner: this.target.repoOwner,
            repoName: this.target.repoName,
            authToken: 'mock-github-token',
        });
        const worktreeInfo = await mockCreateWorktreeFromExistingBranch(localRepoPath, this.target.branchName, {
            worktreeDirName,
            owner: this.target.repoOwner,
            repoName: this.target.repoName,
        });
        const mergeBase = await mockGitRaw(['merge-base', this.source.head.sha, 'HEAD']);
        if (mergeBase.trim() !== this.source.head.sha.toLowerCase()) {
            await mockCleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName);
            throw new Error(`Prepared ${this.target.repoOwner}/${this.target.repoName} branch ${this.target.branchName} does not contain the pull request head ${this.source.head.sha}`);
        }
        return { localRepoPath, worktreeInfo };
    }

    private adoptContinuation() {
        this.target = {
            repoOwner: this.ref.repoOwner,
            repoName: this.ref.repoName,
            branchName: `propr/continuation-pr-${this.ref.pullRequestNumber}`,
            isFork: false,
        };
        this.status = `Implementation destination: [continuation PR #100](https://github.com/${this.ref.repoOwner}/${this.ref.repoName}/pull/100).`;
    }

    async prepare(worktreeDirName: string) {
        let prepared = await this.createWorktree(worktreeDirName);
        if (!this.target.isFork) return prepared;
        try {
            await mockGitRaw(['push', '--dry-run', '--porcelain', 'mock-fork-url', `HEAD:refs/heads/${this.target.branchName}`]);
            return prepared;
        } catch (error) {
            if (!isMockPublicationPermissionDenied(error)) throw error;
            await mockCleanupWorktree(prepared.localRepoPath, prepared.worktreeInfo.worktreePath, prepared.worktreeInfo.branchName);
            this.adoptContinuation();
            prepared = await this.createWorktree(worktreeDirName);
            return prepared;
        }
    }

    async push(worktreePath: string) {
        const push = () => mockPushBranch(worktreePath, this.target.branchName, {
            repoUrl: `https://github.com/${this.target.repoOwner}/${this.target.repoName}.git`,
            authToken: 'mock-github-token',
            rebaseOnNonFastForward: false,
        });
        try {
            return await push();
        } catch (error) {
            if (!this.target.isFork || !isMockPublicationPermissionDenied(error)) throw error;
            this.adoptContinuation();
            return push();
        }
    }
}

await mock.module('../src/jobs/prPublication.js', {
    namedExports: { PullRequestPublication: MockPullRequestPublication },
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
    mockPushBranch.mock.mockImplementation(async () => ({ commitHash: 'abc1234567890', rebased: false }));
    mockAssertCommitIsAncestor.mock.resetCalls();
    mockStageChanges.mock.resetCalls();
    mockAgent.executeTask.mock.resetCalls();
    mockConfiguredAgent.executeTask.mock.resetCalls();
    mockCleanupWorktree.mock.resetCalls();
    mockEnsureRepoCloned.mock.resetCalls();
    mockCreateWorktreeFromExistingBranch.mock.resetCalls();
    mockGitRaw.mock.resetCalls();
    mockGitRawImplementation = async (args: string[]) => (args[0] === 'merge-base' ? args[1] : '');
    mockPullRequestHead = {
        ref: 'feature-branch',
        sha: 'head-sha-123',
        repo: { name: 'test-repo', full_name: 'test-owner/test-repo', owner: { login: 'test-owner' } },
    };
    mockRedisStore.clear();
    mockSettings = {};
}

describe('processMergeConflictJob', () => {
    beforeEach(() => {
        resetAllMocks();
        // Default: clean merge
        mockMergeResult = { outcome: 'clean', baseCommit: 'base-sha-456' };
        mockMergeBaseIntoBranch.mock.mockImplementation(async () => mockMergeResult);
        mockStateManager.getTaskState.mock.mockImplementation(async () => null);
        mockOctokit.request.mock.mockImplementation(async (route: string) => defaultOctokitRequest(route));
    });

    test('clean merge: commits and pushes after agent verification', async () => {
        const job = createMockJob();
        const result = await processMergeConflictJob(job);

        assert.strictEqual(result.status, 'complete');
        assert.strictEqual((result as Record<string, unknown>).mergeType, 'clean');

        // Clean merges still run through the agent path for verification and summary generation.
        assert.strictEqual(mockAgent.executeTask.mock.callCount(), 1);

        // Verify commit and push were called
        assert.strictEqual(mockCommitChanges.mock.callCount(), 1);
        assert.strictEqual(mockAssertCommitIsAncestor.mock.callCount(), 1);
        assert.strictEqual(mockAssertCommitIsAncestor.mock.calls[0].arguments[1], 'base-sha-456');
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
        mockMergeResult = { outcome: 'conflicts', baseCommit: 'base-sha-456', conflictedFiles: ['src/index.ts', 'src/app.ts'] };
        mockMergeBaseIntoBranch.mock.mockImplementation(async () => mockMergeResult);

        const job = createMockJob();
        const result = await processMergeConflictJob(job);

        assert.strictEqual(result.status, 'complete');
        assert.strictEqual((result as Record<string, unknown>).mergeType, 'conflict_resolved');

        // Verify agent WAS called
        assert.strictEqual(mockAgent.executeTask.mock.callCount(), 1);

        // Verify the prompt includes conflict info
        const executeCall = mockAgent.executeTask.mock.calls[0];
        const executeOptions = executeCall.arguments[0] as { prompt: string; environment?: Record<string, string> };
        const prompt = executeOptions.prompt;
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

    test('does not push or report success when the fetched base is not incorporated', async () => {
        mockAssertCommitIsAncestor.mock.mockImplementationOnce(async () => {
            throw new Error('Requested base commit base-sha-456 is not incorporated into HEAD');
        });

        await assert.rejects(
            async () => processMergeConflictJob(createMockJob()),
            /base-sha-456 is not incorporated into HEAD/
        );

        assert.strictEqual(mockPushBranch.mock.callCount(), 0);
        const completedCalls = mockStateManager.updateTaskState.mock.calls.filter(
            (c: { arguments: [string, string] }) => c.arguments[1] === 'completed'
        );
        assert.strictEqual(completedCalls.length, 0);

        const successComment = mockOctokit.request.mock.calls.find(
            (c: { arguments: [string, Record<string, unknown>] }) =>
                c.arguments[0] === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}' &&
                (c.arguments[1].body as string).includes('Auto-merged')
        );
        assert.strictEqual(successComment, undefined);
    });

    test('conflict merge: preserves title metadata in completion history', async () => {
        mockMergeResult = { outcome: 'conflicts', baseCommit: 'base-sha-456', conflictedFiles: ['src/index.ts'] };
        mockMergeBaseIntoBranch.mock.mockImplementation(async () => mockMergeResult);
        mockStateManager.getTaskState.mock.mockImplementation(async () => ({
            issueRef: {
                title: 'Merge PR #42: Resolve auth conflict',
                subtitle: 'Resolve src/index.ts conflict',
                issueNumber: 1478,
            },
            history: [{
                state: 'claude_execution',
                timestamp: '2026-05-29T00:00:00.000Z',
                reason: 'agent completed',
                metadata: {
                    sessionId: 'session-123',
                    conversationId: 'conv-123',
                    model: 'claude-sonnet-4-20250514',
                },
            }],
        }));

        await processMergeConflictJob(createMockJob());

        const completedCall = mockStateManager.updateTaskState.mock.calls.find(
            (c: { arguments: [string, string] }) => c.arguments[1] === 'completed'
        );
        assert.ok(completedCall, 'Expected completed state update');
        const metadata = completedCall.arguments[2].historyMetadata as Record<string, unknown>;
        assert.strictEqual(metadata.commandMode, 'merge');
        assert.strictEqual(metadata.title, 'Merge PR #42: Resolve auth conflict');
        assert.strictEqual(metadata.subtitle, 'Resolve src/index.ts conflict');
        assert.strictEqual(metadata.issueNumber, 1478);
        assert.strictEqual(metadata.sessionId, 'session-123');
        assert.strictEqual(metadata.conversationId, 'conv-123');
        assert.strictEqual(metadata.commitHash, 'abc1234567890');
        assert.strictEqual(
            metadata.notificationRecap,
            'Merged main into feature-branch and resolved conflicts in 1 file. Resolved merge conflicts'
        );
    });

    test('records the model from configured default agent in initial task state', async () => {
        mockSettings = { default_agent_alias: 'codex' };
        mockMergeResult = { outcome: 'conflicts', baseCommit: 'base-sha-456', conflictedFiles: ['src/index.ts'] };
        mockMergeBaseIntoBranch.mock.mockImplementation(async () => mockMergeResult);

        await processMergeConflictJob(createMockJob());

        const createCall = mockStateManager.createTaskState.mock.calls[0];
        assert.strictEqual(createCall.arguments[1].modelName, 'gpt-5.5');
        assert.strictEqual(mockConfiguredAgent.executeTask.mock.callCount(), 1);
    });

    test('failed merge: reports error and sets FAILED state', async () => {
        mockMergeResult = { outcome: 'failed', error: 'fatal: not a git repository' };
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

    test('agent failure: keeps stderr/log details out of public errors', async () => {
        mockMergeResult = { outcome: 'conflicts', baseCommit: 'base-sha-456', conflictedFiles: ['.propr/setup.sh'] };
        mockMergeBaseIntoBranch.mock.mockImplementation(async () => mockMergeResult);
        mockAgent.executeTask.mock.mockImplementationOnce(async () => ({
            ...mockAgentResult,
            success: false,
            error: '',
            logs: 'Running ProPR repo setup hook\n.propr/setup.sh: line 1: <<<<<<< HEAD',
        }));

        const job = createMockJob();

        await assert.rejects(
            async () => processMergeConflictJob(job),
            /detailed output is available in restricted logs/
        );

        const patchCall = mockOctokit.request.mock.calls.find(
            (c: { arguments: [string, Record<string, unknown>] }) =>
                c.arguments[0] === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}' &&
                (c.arguments[1].body as string).includes('Failed to resolve merge conflicts')
        );
        assert.ok(patchCall);
        const body = patchCall.arguments[1].body as string;
        assert.ok(body.includes('detailed output is available in restricted logs'));
        assert.ok(!body.includes('setup.sh: line 1'));
        assert.ok(!body.includes('Unknown error'));
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
        assert.strictEqual(mockCleanupWorktree.mock.calls[0].arguments[3].success, true);
    });

    test('fork head: prepares, merges and pushes in the contributor repository', async () => {
        mockPullRequestHead = {
            ref: 'feature-branch',
            sha: 'fork-head-sha',
            repo: { name: 'test-repo', full_name: 'contributor/test-repo', owner: { login: 'contributor' } },
        };

        const result = await processMergeConflictJob(createMockJob());

        assert.strictEqual(result.status, 'complete');
        // The clone and worktree come from the fork, never from the base repository.
        assert.strictEqual(mockEnsureRepoCloned.mock.calls[0].arguments[0].owner, 'contributor');
        assert.strictEqual(mockEnsureRepoCloned.mock.calls[0].arguments[0].repoName, 'test-repo');
        assert.deepStrictEqual(mockCreateWorktreeFromExistingBranch.mock.calls[0].arguments[2], {
            worktreeDirName: mockCreateWorktreeFromExistingBranch.mock.calls[0].arguments[2].worktreeDirName,
            owner: 'contributor',
            repoName: 'test-repo',
        });
        // The base branch is fetched from the base repository, not from the fork's origin.
        const mergeOptions = mockMergeBaseIntoBranch.mock.calls[0].arguments[2] as { baseRepoUrl?: string; authToken?: string };
        assert.strictEqual(mergeOptions.baseRepoUrl, 'https://github.com/test-owner/test-repo.git');
        assert.strictEqual(mergeOptions.authToken, 'mock-github-token');
        assert.strictEqual(mockPushBranch.mock.callCount(), 1);
        // A merge commit cannot be replayed by rebase, so a diverged head must fail loudly.
        assert.strictEqual(mockPushBranch.mock.calls[0].arguments[2].rebaseOnNonFastForward, false);
    });

    test('same-repository head: keeps fetching the base branch from origin', async () => {
        await processMergeConflictJob(createMockJob());

        assert.deepStrictEqual(mockMergeBaseIntoBranch.mock.calls[0].arguments[2], {});
        assert.strictEqual(mockEnsureRepoCloned.mock.calls[0].arguments[0].owner, 'test-owner');
    });

    test('fails without running the agent when the prepared branch lacks the PR head', async () => {
        mockPullRequestHead = {
            ref: 'feature-branch',
            sha: 'fork-head-sha',
            repo: { name: 'test-repo', full_name: 'contributor/test-repo', owner: { login: 'contributor' } },
        };
        // A same-named branch in an unrelated repository does not contain the PR head.
        mockGitRawImplementation = async (args: string[]) => (args[0] === 'merge-base' ? 'unrelated-sha' : '');

        await assert.rejects(
            async () => processMergeConflictJob(createMockJob()),
            /does not contain the pull request head fork-head-sha/
        );

        assert.strictEqual(mockAgent.executeTask.mock.callCount(), 0);
        assert.strictEqual(mockMergeBaseIntoBranch.mock.callCount(), 0);
        assert.strictEqual(mockPushBranch.mock.callCount(), 0);
    });

    test('preflight permission denial adopts a self-owned continuation before the agent runs', async () => {
        mockPullRequestHead = {
            ref: 'feature-branch',
            sha: 'fork-head-sha',
            repo: { name: 'test-repo', full_name: 'contributor/test-repo', owner: { login: 'contributor' } },
        };
        mockGitRawImplementation = async (args: string[]) => {
            if (args[0] === 'merge-base') return args[1];
            if (args[0] === 'push') throw new Error('remote: Write access to repository not granted.');
            return '';
        };

        const result = await processMergeConflictJob(createMockJob());

        assert.strictEqual(result.status, 'complete');
        assert.strictEqual(mockAgent.executeTask.mock.callCount(), 1);
        assert.strictEqual(mockPushBranch.mock.callCount(), 1);
        assert.strictEqual(mockPushBranch.mock.calls[0].arguments[1], 'propr/continuation-pr-42');
        const completionComment = mockOctokit.request.mock.calls.find(
            (c: { arguments: [string, Record<string, unknown>] }) =>
                c.arguments[0] === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}' &&
                (c.arguments[1].body as string).includes('continuation PR #100')
        );
        assert.ok(completionComment, 'Expected the successful continuation destination to be reported on the PR');
    });

    test('workflow-permission rejection on final fork push preserves the resolved merge in a continuation', async () => {
        mockPullRequestHead = {
            ref: 'feature-branch',
            sha: 'fork-head-sha',
            repo: { name: 'test-repo', full_name: 'contributor/test-repo', owner: { login: 'contributor' } },
        };
        mockMergeResult = { outcome: 'conflicts', baseCommit: 'base-sha-456', conflictedFiles: ['src/index.ts'] };
        mockMergeBaseIntoBranch.mock.mockImplementation(async () => mockMergeResult);
        mockPushBranch.mock.mockImplementationOnce(async () => {
            throw new Error("remote: refusing to allow a GitHub App to create or update workflow `.github/workflows/pr-build-check.yml` without `workflows` permission");
        });

        const result = await processMergeConflictJob(createMockJob());

        assert.strictEqual(result.status, 'complete');
        assert.strictEqual(mockAgent.executeTask.mock.callCount(), 1, 'the resolved merge must not be regenerated');
        assert.strictEqual(mockCommitChanges.mock.callCount(), 1, 'the resolved merge must be committed once');
        assert.strictEqual(mockPushBranch.mock.callCount(), 2);
        assert.strictEqual(mockPushBranch.mock.calls[0].arguments[1], 'feature-branch');
        assert.strictEqual(mockPushBranch.mock.calls[1].arguments[1], 'propr/continuation-pr-42');
        const completionComment = mockOctokit.request.mock.calls.find(
            (c: { arguments: [string, Record<string, unknown>] }) =>
                c.arguments[0] === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}' &&
                (c.arguments[1].body as string).includes('continuation PR #100')
        );
        assert.ok(completionComment);
    });

    test('fails when the head repository has been deleted', async () => {
        mockPullRequestHead = { ref: 'feature-branch', sha: 'fork-head-sha', repo: null };

        await assert.rejects(
            async () => processMergeConflictJob(createMockJob()),
            /head repository is unavailable or has been deleted/
        );

        assert.strictEqual(mockEnsureRepoCloned.mock.callCount(), 0);
        assert.strictEqual(mockAgent.executeTask.mock.callCount(), 0);
    });

    test('failed merge: marks cleanup as unsuccessful', async () => {
        mockMergeResult = { outcome: 'failed', error: 'fatal: merge failed' };
        mockMergeBaseIntoBranch.mock.mockImplementation(async () => mockMergeResult);

        await assert.rejects(async () => processMergeConflictJob(createMockJob()));

        assert.strictEqual(mockCleanupWorktree.mock.callCount(), 1);
        assert.strictEqual(mockCleanupWorktree.mock.calls[0].arguments[3].success, false);
    });
});

import { test, mock, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import type { IssueCommentEvent, Label } from '@octokit/webhooks-types';
import { buildDynamicLlmLabel, shortHash } from '@propr/shared';
import { createWebhookIssueCommentCreatedEvent, createWebhookPRReviewCommentCreatedEvent, createMockLabel } from './testHelpers.js';

function manualRevisionIdentity(updatedAt: string, body: string, eventType = 'issue_comment'): string {
    const digest = createHash('sha256').update(`${eventType}\0${body}`).digest('hex').slice(0, 12);
    return `${updatedAt}:${digest}`;
}

function manualRevisionSlug(updatedAt: string, body: string, eventType = 'issue_comment'): string {
    return manualRevisionIdentity(updatedAt, body, eventType).replace(/[^a-zA-Z0-9_-]/g, '-');
}

// ========== Mocks ==========

const mockOctokit = {
    request: mock.fn(async () => ({ data: {} })),
};

function getLabelReplacementCalls() {
    return mockOctokit.request.mock.calls.filter(
        (call: { arguments: unknown[] }) => call.arguments[0] === 'PUT /repos/{owner}/{repo}/issues/{issue_number}/labels',
    );
}

function assertSingleLabelReplacement(labels: string[]) {
    const replacementCalls = getLabelReplacementCalls();
    assert.strictEqual(replacementCalls.length, 1);
    assert.deepStrictEqual((replacementCalls[0].arguments[1] as { labels: string[] }).labels, labels);
}

// Mock simple-git
await mock.module('simple-git', {
    namedExports: {
        simpleGit: mock.fn(() => ({})),
        SimpleGit: class {},
    },
});

// Mock ioredis
await mock.module('ioredis', {
    namedExports: {
        Redis: function Redis() {
            return {
                on: mock.fn(),
                connect: mock.fn(async () => {}),
                quit: mock.fn(async () => {}),
            };
        },
    },
});

// Mock bullmq — allow tests to inject active/waiting/delayed jobs
const mockQueueAdd = mock.fn(async () => {});
let mockActiveJobs: unknown[] = [];
let mockWaitingJobs: unknown[] = [];
let mockDelayedJobs: unknown[] = [];
await mock.module('bullmq', {
    namedExports: {
        Queue: function Queue() {
            return {
                add: mockQueueAdd,
                close: mock.fn(),
                on: mock.fn(),
                getActive: mock.fn(async () => mockActiveJobs),
                getWaiting: mock.fn(async () => mockWaitingJobs),
                getDelayed: mock.fn(async () => mockDelayedJobs),
            };
        },
        Worker: function Worker() {
            return { on: mock.fn(), close: mock.fn() };
        },
    },
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
    },
});

// Mock GitHub auth
await mock.module('../packages/core/src/auth/githubAuth.js', {
    namedExports: {
        getAuthenticatedOctokit: mock.fn(async () => mockOctokit),
        getGitHubInstallationToken: mock.fn(async () => 'mock-token'),
        validateGithubIntakePrerequisites: mock.fn(() => {}),
    },
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
        createCorrelatedLogger: mock.fn(() => mockLoggerInstance),
    },
});

// Keep model resolution isolated from the full agent runtime. This mock must be
// installed before configManager is imported because that graph loads the
// canonical model resolver.
type MockAgent = {
    config: {
        alias: string;
        type: 'claude' | 'codex' | 'antigravity' | 'opencode' | 'vibe';
        enabled: boolean;
        supportedModels: string[];
        defaultModel?: string;
    };
};

const defaultMockAgents: MockAgent[] = [
    {
        config: {
            alias: 'claude',
            type: 'claude' as const,
            enabled: true,
            supportedModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
            defaultModel: 'claude-sonnet-5',
        },
    },
    {
        config: {
            alias: 'codex',
            type: 'codex' as const,
            enabled: true,
            supportedModels: ['gpt-5.6-sol'],
            defaultModel: 'gpt-5.6-sol',
        },
    },
];
let mockAgents = defaultMockAgents;
const mockAgentRegistry = {
    ensureInitialized: mock.fn(async () => {}),
    getAllAgents: mock.fn(() => mockAgents),
    getAgentByAlias: mock.fn((alias: string) => mockAgents.find(agent => agent.config.alias === alias)),
    getDefaultAgent: mock.fn(() => mockAgents.find(agent => agent.config.enabled)),
};
await mock.module('../packages/core/src/agents/AgentRegistry.js', {
    namedExports: {
        AgentRegistry: class AgentRegistry {
            static getInstance() {
                return mockAgentRegistry;
            }
        },
        getAgentRegistry: mock.fn(() => mockAgentRegistry),
    },
});

// Mock configManager
const actualConfigManager = await import('../packages/core/src/config/configManager.js');
await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: {
        ...actualConfigManager,
        loadFollowupIgnoreKeywords: mock.fn(async () => []),
        loadMonitoredRepos: mock.fn(async () => []),
        loadAiPrimaryTag: mock.fn(async () => 'AI'),
        loadPrimaryProcessingLabels: mock.fn(async () => ['AI']),
        loadSettings: mock.fn(async () => ({})),
        loadAgentTankSettings: mock.fn(async () => ({})),
        getConfig: mock.fn(async () => null),
        saveConfig: mock.fn(async () => true),
    },
});

// Mock commentFilters
await mock.module('../packages/core/src/utils/commentFilters.js', {
    namedExports: {
        filterCommentByAuthor: mock.fn(() => ({ shouldFilter: false })),
        checkCommentTrigger: mock.fn(() => ({ isTriggered: true })),
        checkCommentIgnore: mock.fn(() => ({ shouldIgnore: false })),
    },
});

// Mock safeUpdateLabels — capture calls for assertions
const mockSafeUpdateLabels = mock.fn(async (_context: unknown, labelsToRemove: string[] = [], labelsToAdd: string[] = []) => ({
    success: true,
    removed: labelsToRemove,
    added: labelsToAdd,
    errors: [],
}));
await mock.module('../packages/core/src/utils/github/labelOperations.js', {
    namedExports: {
        safeRemoveLabel: mock.fn(async () => true),
        safeAddLabel: mock.fn(async () => true),
        safeUpdateLabels: mockSafeUpdateLabels,
    },
});

// Mock mergeConflictDetector
await mock.module('../packages/core/src/webhook/mergeConflictDetector.js', {
    namedExports: {
        handleMergeCommand: mock.fn(async () => {}),
        handlePullRequestConflictDetection: mock.fn(async () => {}),
        handlePushConflictDetection: mock.fn(async () => {}),
    },
});

// Mock retryHandler
const actualRetryHandler = await import('../packages/core/src/utils/retryHandler.js');
const { default: retryHandlerDefault, ...retryHandlerNamedExports } = actualRetryHandler;
await mock.module('../packages/core/src/utils/retryHandler.js', {
    defaultExport: retryHandlerDefault,
    namedExports: {
        ...retryHandlerNamedExports,
        withRetry: mock.fn(async (fn: () => Promise<unknown>) => fn()),
        retryConfigs: { githubApi: {} },
    },
});

// Import module under test AFTER mocks
const { processCommentEvent, handleCommentDeleted, handleCommentEdited, setUltrafixDeps } = await import(
    '../packages/core/src/webhook/commentEventHandler.js'
);
const { resolveLlmLabel } = await import('../packages/core/src/config/modelAliases.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
const { shutdownQueue } = await import('../packages/core/src/queue/taskQueue.js');
const { applyPendingCommentCommandContext } = await import(
    '../src/jobs/prPendingComments.js'
);

const mockInvalidateAutomaticWork = mock.fn(async () => ({ workEpoch: 1, hadAutomaticWork: false }));
const mockHasAutomaticWork = mock.fn(async () => false);
setUltrafixDeps({
    loadUltrafixRatingGoal: mock.fn(async () => 7),
    loadUltrafixMaxCycles: mock.fn(async () => 5),
    loadUltrafixPauseSeconds: mock.fn(async () => 60),
    loadPrReviewModel: mock.fn(async () => ''),
    startLoop: mock.fn(async () => ({ state: {}, initialAction: 'review' as const })),
    clearStateIfCurrent: mock.fn(async () => true),
    hasAutomaticWork: mockHasAutomaticWork,
    reserveAutomaticWork: mock.fn(async () => 1),
    invalidateAutomaticWork: mockInvalidateAutomaticWork,
    getPendingReviewState: mock.fn(async () => ({ hasPendingReview: false })),
});

beforeEach(() => {
    mockAgents = defaultMockAgents;
    mockSafeUpdateLabels.mock.mockImplementation(async (_context: unknown, labelsToRemove: string[] = [], labelsToAdd: string[] = []) => ({
        success: true,
        removed: labelsToRemove,
        added: labelsToAdd,
        errors: [],
    }));
    mockInvalidateAutomaticWork.mock.resetCalls();
    mockInvalidateAutomaticWork.mock.mockImplementation(async () => ({ workEpoch: 1, hadAutomaticWork: false }));
    mockHasAutomaticWork.mock.resetCalls();
    mockHasAutomaticWork.mock.mockImplementation(async () => false);
});

after(async () => {
    await shutdownQueue();
    await closeConnection();
});

// ========== Helpers ==========

function createMockRedis() {
    const store = new Map<string, string>();
    return {
        get: mock.fn(async (key: string) => store.get(key) ?? null),
        setex: mock.fn(async (key: string, _ttl: number, value: string) => {
            store.set(key, value);
        }),
        set: mock.fn(async (key: string, value: string, ...args: string[]) => {
            if (args.includes('NX') && store.has(key)) return null;
            store.set(key, value);
            return 'OK';
        }),
        del: mock.fn(async (key: string) => {
            store.delete(key);
        }),
        eval: mock.fn(async (_script: string, _keyCount: number, key: string, token: string) => {
            if (store.get(key) !== token) return 0;
            store.delete(key);
            return 1;
        }),
        rpush: mock.fn(async () => {}),
        expire: mock.fn(async () => {}),
        _store: store,
    };
}

function createTestConfig(overrides: Record<string, unknown> = {}) {
    return {
        redisClient: createMockRedis(),
        PR_FOLLOWUP_TRIGGER_KEYWORDS: ['propr'],
        MODEL_LABEL_PATTERN: '^llm-(.+)$',
        ...overrides,
    };
}

/** Create an issue comment event with a PR attached (pull_request field present) */
function createPRCommentEvent(body: string, labels: Label[] = []) {
    const event = createWebhookIssueCommentCreatedEvent({
        comment: { body },
        issue: { number: 42, labels: labels.map(l => ({ name: l.name })) },
    });
    // Ensure pull_request is set so the handler knows it's a PR comment
    (event.issue as Record<string, unknown>).pull_request = { url: 'https://api.github.com/repos/test/repo/pulls/42' };
    return event;
}

function createPRReviewCommentEvent(body: string, overrides: Record<string, unknown> = {}) {
    return createWebhookPRReviewCommentCreatedEvent({
        comment: {
            body,
            path: 'src/auth.ts',
            line: 27,
            ...overrides,
        },
        pullRequest: { number: 42 },
    });
}

// ========== Tests ==========

describe('commentEventHandler — /switch command', () => {
    beforeEach(() => {
        mockSafeUpdateLabels.mock.resetCalls();
        mockQueueAdd.mock.resetCalls();
        mockOctokit.request.mock.resetCalls();
        mockLoggerInstance.info.mock.resetCalls();
        mockLoggerInstance.warn.mock.resetCalls();
        mockActiveJobs = [];
        mockWaitingJobs = [];
        mockDelayedJobs = [];

        // Default: Octokit returns a PR with no labels
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [],
            },
        }));
    });

    test('/switch with alias canonicalizes label via resolveModelAlias', async () => {
        const event = createPRCommentEvent('/switch opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-1', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        const call = mockSafeUpdateLabels.mock.calls[0];
        const newLabels = call.arguments[2] as string[];
        // "opus" should be resolved via the current configured alias.
        assert.deepStrictEqual(newLabels, ['llm-claude-opus-5']);
    });

    test('/switch with full model ID preserves it in label', async () => {
        const event = createPRCommentEvent('/switch claude-sonnet-4-6');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-2', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        const newLabels = mockSafeUpdateLabels.mock.calls[0].arguments[2] as string[];
        assert.deepStrictEqual(newLabels, ['llm-claude-sonnet-4-6']);
    });

    test('/switch removes existing LLM labels and adds new one', async () => {
        // Simulate PR already having an llm label
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [
                    { id: 1, name: 'llm-claude-opus-4-6', color: '000', default: false, description: null, node_id: 'L_1', url: '' },
                    { id: 2, name: 'bug', color: 'fff', default: false, description: null, node_id: 'L_2', url: '' },
                ],
            },
        }));

        const event = createPRCommentEvent('/switch sonnet');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-3', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        const [, existingLlmLabels, newLabels] = mockSafeUpdateLabels.mock.calls[0].arguments;
        assert.deepStrictEqual(existingLlmLabels, ['llm-claude-opus-4-6']);
        assert.deepStrictEqual(newLabels, ['llm-claude-sonnet-5']);
    });

    test('/switch without model argument warns and returns early', async () => {
        const event = createPRCommentEvent('/switch');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-4', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        // Should have logged a warning
        const warnCalls = mockLoggerInstance.warn.mock.calls;
        const switchWarn = warnCalls.find(
            (c: { arguments: unknown[] }) => typeof c.arguments[1] === 'string' && c.arguments[1].includes('/switch command requires a model argument')
        );
        assert.ok(switchWarn, 'Expected a warning about missing model argument');
    });

    test('/switch with unrecognized model warns and returns early', async () => {
        const event = createPRCommentEvent('/switch nonexistent-model');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-invalid-model', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        assert.strictEqual(mockOctokit.request.mock.callCount(), 0);
        const warnCalls = mockLoggerInstance.warn.mock.calls;
        const invalidWarn = warnCalls.find(
            (c: { arguments: unknown[] }) => typeof c.arguments[1] === 'string' && c.arguments[1].includes('unrecognized model')
        );
        assert.ok(invalidWarn, 'Expected a warning about unrecognized model');
    });

    test('/switch without instructions does not enqueue a job', async () => {
        const event = createPRCommentEvent('/switch opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-5', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/switch with instructions enqueues a follow-up job with stripped body', async () => {
        const event = createPRCommentEvent('/switch opus\nPlease review the auth module');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-6', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.commandMode, 'switch');
        // The enqueued job body must contain only the user instructions,
        // NOT the /switch command line.
        const comments = jobData.comments as Array<{ body: string }>;
        assert.ok(comments.length > 0, 'Expected at least one comment in job data');
        assert.ok(!comments[0].body.includes('/switch'), 'Comment body should not contain /switch command text');
        assert.ok(comments[0].body.includes('Please review the auth module'), 'Comment body should contain the user instructions');
    });

    test('/switch with custom MODEL_LABEL_PATTERN uses pattern-derived prefix for new labels', async () => {
        // Simulate PR with a custom-prefixed model label
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [
                    { id: 1, name: 'ai-model-claude-opus-4-6', color: '000', default: false, description: null, node_id: 'L_1', url: '' },
                ],
            },
        }));

        const event = createPRCommentEvent('/switch sonnet');
        const config = createTestConfig({ MODEL_LABEL_PATTERN: '^ai-model-(.+)$' });

        await processCommentEvent(event, 'issue_comment', 'corr-custom-pattern', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        const [, existingLlmLabels, newLabels] = mockSafeUpdateLabels.mock.calls[0].arguments;
        assert.deepStrictEqual(existingLlmLabels, ['ai-model-claude-opus-4-6']);
        // New label should use the custom prefix, not hardcoded 'llm-'
        assert.deepStrictEqual(newLabels, ['ai-model-claude-sonnet-5']);
    });

    test('/switch with llm- prefixed argument strips prefix before resolving', async () => {
        const event = createPRCommentEvent('/switch llm-haiku');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-7', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        const newLabels = mockSafeUpdateLabels.mock.calls[0].arguments[2] as string[];
        // "llm-haiku" → normalizeModelLabel strips "llm-" → "haiku" → resolveModelAlias → "claude-haiku-4-5-20251001"
        assert.deepStrictEqual(newLabels, ['llm-claude-haiku-4-5-20251001']);
    });

    test('/switch removes multiple existing LLM labels', async () => {
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [
                    { id: 1, name: 'llm-claude-opus-4-6', color: '000', default: false, description: null, node_id: 'L_1', url: '' },
                    { id: 2, name: 'llm-claude-sonnet-4-6', color: '000', default: false, description: null, node_id: 'L_2', url: '' },
                    { id: 3, name: 'bug', color: 'fff', default: false, description: null, node_id: 'L_3', url: '' },
                ],
            },
        }));

        const event = createPRCommentEvent('/switch haiku');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-multi-label', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        const [, existingLlmLabels, newLabels] = mockSafeUpdateLabels.mock.calls[0].arguments;
        assert.deepStrictEqual(existingLlmLabels, ['llm-claude-opus-4-6', 'llm-claude-sonnet-4-6']);
        assert.deepStrictEqual(newLabels, ['llm-claude-haiku-4-5-20251001']);
    });

    test('/switch works with escaped metacharacters in MODEL_LABEL_PATTERN like ^model\\-(.+)$', async () => {
        // Escaped metacharacters like \- should be handled correctly by modelLabelPrefix,
        // deriving the literal prefix 'model-' which produces labels matching the pattern.
        const event = createPRCommentEvent('/switch opus');
        const config = createTestConfig({ MODEL_LABEL_PATTERN: '^model\\-(.+)$' });

        await processCommentEvent(event, 'issue_comment', 'corr-escaped', config);

        // Should call safeUpdateLabels with the derived prefix 'model-'
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        const newLabels = mockSafeUpdateLabels.mock.calls[0].arguments[2] as string[];
        assert.deepStrictEqual(newLabels, ['model-claude-opus-5']);
    });

    test('/switch aborts when derived label prefix would not match MODEL_LABEL_PATTERN', async () => {
        // Use a pattern with unescaped metacharacters that modelLabelPrefix cannot
        // derive — the fallback 'llm-' prefix won't match the pattern, so the
        // new labels would be invisible to future /switch calls.
        const event = createPRCommentEvent('/switch opus');
        const config = createTestConfig({ MODEL_LABEL_PATTERN: '^model.*(.+)$' });

        await processCommentEvent(event, 'issue_comment', 'corr-mismatch', config);

        // Should NOT call safeUpdateLabels — the mismatch is detected and aborted
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/switch with extra models logs a warning but uses first model', async () => {
        const event = createPRCommentEvent('/switch opus sonnet');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-extra-args', config);

        // Should still update labels using the first model
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        const newLabels = mockSafeUpdateLabels.mock.calls[0].arguments[2] as string[];
        assert.deepStrictEqual(newLabels, ['llm-claude-opus-5']);
        // Should have logged a warning about extra arguments
        const warnCalls = mockLoggerInstance.warn.mock.calls;
        const extraWarn = warnCalls.find(
            (c: { arguments: unknown[] }) => typeof c.arguments[1] === 'string' && c.arguments[1].includes('extra arguments were ignored')
        );
        assert.ok(extraWarn, 'Expected a warning about extra arguments');
    });

    test('/switch with multiline instructions preserves all instruction lines', async () => {
        const event = createPRCommentEvent('/switch opus\nFirst line\nSecond line\nThird line');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-multiline', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        const comments = jobData.comments as Array<{ body: string }>;
        assert.ok(comments[0].body.includes('First line'));
        assert.ok(comments[0].body.includes('Second line'));
        assert.ok(comments[0].body.includes('Third line'));
    });
});

describe('commentEventHandler — /use command', () => {
    beforeEach(() => {
        mockSafeUpdateLabels.mock.resetCalls();
        mockQueueAdd.mock.resetCalls();
        mockOctokit.request.mock.resetCalls();
        mockLoggerInstance.info.mock.resetCalls();
        mockLoggerInstance.warn.mock.resetCalls();
        mockLoggerInstance.error.mock.resetCalls();
        mockActiveJobs = [];
        mockWaitingJobs = [];
        mockDelayedJobs = [];

        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [],
            },
        }));
    });

    test('/use resolves a short alias to its canonical label and preserves unrelated labels', async () => {
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [
                    createMockLabel({ name: 'AI' }),
                    createMockLabel({ name: 'bug' }),
                    createMockLabel({ name: 'release:next' }),
                    createMockLabel({ name: 'llm-claude-sonnet5' }),
                ],
            },
        }));
        const event = createPRCommentEvent('/use opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-alias', config);

        assertSingleLabelReplacement(['AI', 'bug', 'release:next', 'llm-claude-opus5']);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/use removes all llm-prefixed labels regardless of MODEL_LABEL_PATTERN', async () => {
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [
                    createMockLabel({ name: 'AI' }),
                    createMockLabel({ name: 'llm-claude-sonnet5' }),
                    createMockLabel({ name: 'release:next' }),
                ],
            },
        }));
        const event = createPRCommentEvent('/use llm-codex-gpt56-sol');
        const config = createTestConfig({ MODEL_LABEL_PATTERN: '^llm-(codex-.+)$' });

        await processCommentEvent(event, 'issue_comment', 'corr-use-literal-llm-prefix', config);

        assertSingleLabelReplacement(['AI', 'release:next', 'llm-codex-gpt56-sol']);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/use on a review comment replaces labels from the live PR instead of the stale payload', async () => {
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [
                    createMockLabel({ name: 'AI' }),
                    createMockLabel({ name: 'llm-claude-sonnet5' }),
                ],
            },
        }));
        const event = createPRReviewCommentEvent('/use opus');
        event.pull_request.labels = [createMockLabel({ name: 'llm-payload-stale' })];
        const config = createTestConfig();

        await processCommentEvent(event, 'pull_request_review_comment', 'corr-use-review-live-labels', config);

        assert.strictEqual(mockOctokit.request.mock.callCount(), 2);
        assert.strictEqual(
            mockOctokit.request.mock.calls[0].arguments[0],
            'GET /repos/{owner}/{repo}/pulls/{pull_number}',
        );
        const replacementCalls = getLabelReplacementCalls();
        assert.strictEqual(replacementCalls.length, 1);
        assert.deepStrictEqual((replacementCalls[0].arguments[1] as { labels: string[] }).labels, [
            'AI',
            'llm-claude-opus5',
        ]);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 0);
    });

    test('/use accepts a full model label and selects the same canonical label', async () => {
        const event = createPRCommentEvent('/use llm-codex-gpt56-sol');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-full-label', config);

        assertSingleLabelReplacement(['llm-codex-gpt56-sol']);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/use accepts an active full model label with a configured prefix as an idempotent no-op', async () => {
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [createMockLabel({ name: 'ai-model-codex-gpt56-sol' })],
            },
        }));
        const event = createPRCommentEvent('/use ai-model-codex-gpt56-sol');
        const config = createTestConfig({ MODEL_LABEL_PATTERN: '^ai-model-(.+)$' });

        await processCommentEvent(event, 'issue_comment', 'corr-use-custom-prefix-full-label', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/use resolves a configured agent alias to its default model label', async () => {
        mockAgents = defaultMockAgents.map(agent => agent.config.type === 'codex'
            ? { config: { ...agent.config, alias: 'custom-codex' } }
            : agent);
        const event = createPRCommentEvent('/use custom-codex');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-agent-alias', config);

        assertSingleLabelReplacement(['llm-custom-codex-gpt56-sol']);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/use resolves supported model IDs case-insensitively', async () => {
        const event = createPRCommentEvent('/use GPT-5.6-SOL');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-model-id-case', config);

        assertSingleLabelReplacement(['llm-codex-gpt56-sol']);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/use round-trips a dynamic full label through the canonical resolver', async () => {
        const dynamicModel = 'opencode-openai/gpt-5.5';
        const dynamicLabel = buildDynamicLlmLabel('custom-opencode', dynamicModel);
        mockAgents = [{
            config: {
                alias: 'custom-opencode',
                type: 'opencode',
                enabled: true,
                supportedModels: [dynamicModel],
                defaultModel: dynamicModel,
            },
        }];
        const event = createPRCommentEvent(`/use ${dynamicLabel}`);
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-dynamic-label', config);

        assertSingleLabelReplacement([dynamicLabel]);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/use round-trips a hashed dynamic full label through the canonical resolver', async () => {
        const dynamicModel = 'opencode-provider-with-an-extremely-long-name/model-with-an-extremely-long-name';
        const dynamicLabel = buildDynamicLlmLabel('custom-opencode', dynamicModel);
        assert.ok(dynamicLabel.length <= 50);
        mockAgents = [{
            config: {
                alias: 'custom-opencode',
                type: 'opencode',
                enabled: true,
                supportedModels: [dynamicModel],
                defaultModel: dynamicModel,
            },
        }];
        const event = createPRCommentEvent(`/use ${dynamicLabel}`);
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-hashed-label', config);

        assertSingleLabelReplacement([dynamicLabel]);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/use budgets a hashed dynamic label against a longer custom prefix', async () => {
        const dynamicModel = 'opencode-provider-with-an-extremely-long-name/model-with-an-extremely-long-name';
        const dynamicLabel = buildDynamicLlmLabel('custom-opencode', dynamicModel);
        mockAgents = [{
            config: {
                alias: 'custom-opencode',
                type: 'opencode',
                enabled: true,
                supportedModels: [dynamicModel],
                defaultModel: dynamicModel,
            },
        }];
        const event = createPRCommentEvent(`/use ${dynamicLabel}`);
        const config = createTestConfig({ MODEL_LABEL_PATTERN: '^ai-model-(.+)$' });

        await processCommentEvent(event, 'issue_comment', 'corr-use-custom-prefix-hashed-label', config);

        const replacementCalls = getLabelReplacementCalls();
        assert.strictEqual(replacementCalls.length, 1);
        const canonicalLabel = ((replacementCalls[0].arguments[1] as { labels: string[] }).labels)[0];
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.ok(canonicalLabel.length <= 50, `Label should fit in 50 chars, got ${canonicalLabel.length}`);
        assert.match(canonicalLabel, /^ai-model-(.+)$/);
        assert.ok(canonicalLabel.endsWith(`-${shortHash(dynamicModel)}`), 'Expected the stable model hash to be preserved');

        const routingToken = canonicalLabel.match(/^ai-model-(.+)$/)?.[1];
        assert.ok(routingToken);
        const roundTrip = await resolveLlmLabel(routingToken);
        assert.deepStrictEqual(roundTrip, { agentAlias: 'custom-opencode', model: dynamicModel });
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/use rejects a generated label with an ambiguous truncated agent alias', async () => {
        const dynamicModel = 'opencode-openai/gpt-5.5';
        const sharedAliasPrefix = 'custom-opencode-agent-with-a-shared-prefix-';
        const selectedAlias = `${sharedAliasPrefix}alpha`;
        const collidingAlias = `${sharedAliasPrefix}beta`;
        assert.strictEqual(
            buildDynamicLlmLabel(selectedAlias, dynamicModel),
            buildDynamicLlmLabel(collidingAlias, dynamicModel),
        );
        mockAgents = [
            {
                config: {
                    alias: selectedAlias,
                    type: 'opencode',
                    enabled: true,
                    supportedModels: [dynamicModel],
                    defaultModel: dynamicModel,
                },
            },
            {
                config: {
                    alias: collidingAlias,
                    type: 'opencode',
                    enabled: true,
                    supportedModels: [dynamicModel],
                    defaultModel: dynamicModel,
                },
            },
        ];
        const event = createPRCommentEvent(`/use ${selectedAlias}`);
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-ambiguous-truncated-alias', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockOctokit.request.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/use without model argument warns and returns early', async () => {
        const event = createPRCommentEvent('/use');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-nomodel', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        // Should have logged a warning
        const warnCalls = mockLoggerInstance.warn.mock.calls;
        const useWarn = warnCalls.find(
            (c: { arguments: unknown[] }) => typeof c.arguments[1] === 'string' && c.arguments[1].includes('/use command requires a model argument')
        );
        assert.ok(useWarn, 'Expected a warning about missing model argument');
    });

    test('/use with trailing text only changes the label', async () => {
        const event = createPRCommentEvent('/use sonnet extra inline text\nRefactor the utils');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-trailing-text', config);

        assertSingleLabelReplacement(['llm-claude-sonnet5']);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 0);
    });

    test('/use selecting the active label is an idempotent no-op', async () => {
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [createMockLabel({ name: 'AI' }), createMockLabel({ name: 'llm-claude-opus5' })],
            },
        }));
        const event = createPRCommentEvent('/use opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-idempotent', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/use selecting a differently-cased active label is an idempotent no-op', async () => {
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [createMockLabel({ name: 'llm-Claude-Opus5' })],
            },
        }));
        const event = createPRCommentEvent('/use opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-idempotent-case-insensitive', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/use removes stale managed labels when the target label is already present', async () => {
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [
                    createMockLabel({ name: 'llm-claude-opus5' }),
                    createMockLabel({ name: 'llm-claude-sonnet5' }),
                    createMockLabel({ name: 'reviewed' }),
                ],
            },
        }));
        const event = createPRCommentEvent('/use opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-converge', config);

        assertSingleLabelReplacement(['reviewed', 'llm-claude-opus5']);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/use with unrecognized model warns and returns early', async () => {
        const event = createPRCommentEvent('/use nonexistent-model');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-invalid-model', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        const warnCalls = mockLoggerInstance.warn.mock.calls;
        const invalidWarn = warnCalls.find(
            (c: { arguments: unknown[] }) => typeof c.arguments[1] === 'string' && c.arguments[1].includes('unknown, disabled, or unsupported')
        );
        assert.ok(invalidWarn, 'Expected a warning about an unknown model');
    });

    test('/use rejects a target supported only by a disabled agent', async () => {
        mockAgents = defaultMockAgents.map(agent => agent.config.type === 'claude'
            ? { config: { ...agent.config, enabled: false } }
            : agent);
        const event = createPRCommentEvent('/use opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-disabled', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/use label-update failure does not enqueue work or claim success', async () => {
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint === 'PUT /repos/{owner}/{repo}/issues/{issue_number}/labels') {
                throw new Error('GitHub unavailable');
            }
            return { data: { head: { ref: 'feature-branch' }, labels: [] } };
        });
        const event = createPRCommentEvent('/use opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-update-failure', config);

        assert.strictEqual(getLabelReplacementCalls().length, 1);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        const successLog = mockLoggerInstance.info.mock.calls.find(
            (call: { arguments: unknown[] }) => call.arguments[1] === '/use updated the PR model label',
        );
        assert.strictEqual(successLog, undefined);
    });

    test('/use replacement failure does not remove the existing managed label', async () => {
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint === 'PUT /repos/{owner}/{repo}/issues/{issue_number}/labels') {
                throw new Error('Failed to replace labels');
            }
            return {
                data: {
                    head: { ref: 'feature-branch' },
                    labels: [createMockLabel({ name: 'llm-claude-sonnet5' })],
                },
            };
        });
        const event = createPRCommentEvent('/use opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-add-failure-preserves-old', config);

        assertSingleLabelReplacement(['llm-claude-opus5']);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(
            mockOctokit.request.mock.calls.some(
                (call: { arguments: unknown[] }) => call.arguments[0] === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}',
            ),
            false,
        );
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 0);
        const failureLog = mockLoggerInstance.error.mock.calls.find(
            (call: { arguments: unknown[] }) => call.arguments[1] === '/use failed to update the PR model label',
        );
        assert.ok(failureLog, 'Expected the failed target addition to be logged');
        const successLog = mockLoggerInstance.info.mock.calls.find(
            (call: { arguments: unknown[] }) => call.arguments[1] === '/use updated the PR model label',
        );
        assert.strictEqual(successLog, undefined);
    });

    test('/use converges multiple managed labels to only the selected label in one replacement', async () => {
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [
                    createMockLabel({ name: 'AI' }),
                    createMockLabel({ name: 'llm-claude-sonnet5' }),
                    createMockLabel({ name: 'llm-codex-gpt56-sol' }),
                ],
            },
        }));
        const event = createPRCommentEvent('/use opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-single-managed-label', config);

        assertSingleLabelReplacement(['AI', 'llm-claude-opus5']);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });
});

describe('commentEventHandler — commandMode serialization in job data', () => {
    beforeEach(() => {
        mockSafeUpdateLabels.mock.resetCalls();
        mockQueueAdd.mock.resetCalls();
        mockOctokit.request.mock.resetCalls();
        mockLoggerInstance.info.mock.resetCalls();
        mockLoggerInstance.warn.mock.resetCalls();
        mockActiveJobs = [];
        mockWaitingJobs = [];
        mockDelayedJobs = [];

        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [
                    { id: 1, name: 'llm-claude-opus-4-6', color: '000', default: false, description: null, node_id: 'L_1', url: '' },
                ],
            },
        }));
    });

    test('/switch follow-up job has commandMode "switch" and commandMeta', async () => {
        const event = createPRCommentEvent('/switch sonnet\nDo a review');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-mode-switch', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.commandMode, 'switch');
        const meta = jobData.commandMeta as { mode: string; models: string[]; instructions: string };
        assert.strictEqual(meta.mode, 'switch');
        assert.deepStrictEqual(meta.models, ['sonnet']);
        assert.strictEqual(meta.instructions, 'Do a review');
        assert.strictEqual(jobData.commandInstructions, 'Do a review');
    });

    test('/use does not serialize command or model fields into a job', async () => {
        const event = createPRCommentEvent('/use haiku\nSummarize changes');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-mode-use', config);

        assertSingleLabelReplacement(['llm-claude-haiku']);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 0);
    });

    test('/switch follow-up job does not include requestedModels (only /review uses that)', async () => {
        const event = createPRCommentEvent('/switch opus\nCheck the tests');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-mode-no-req', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.requestedModels, undefined);
    });

    test('/use does not persist requestedModels or command context', async () => {
        const event = createPRCommentEvent('/use sonnet\nDo something');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-no-req', config);

        assertSingleLabelReplacement(['llm-claude-sonnet5']);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 0);
    });

    test('/review job includes requestedModels from command args', async () => {
        const event = createPRCommentEvent('/review claude sonnet');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-review-models', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.commandMode, 'review');
        assert.deepStrictEqual(jobData.requestedModels, ['claude', 'sonnet']);
    });

    test('/review without instructions queues empty body, not the command text', async () => {
        const event = createPRCommentEvent('/review claude-sonnet');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-review-empty-body', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        const comments = jobData.comments as Array<{ body: string }>;
        assert.ok(comments.length > 0, 'Expected at least one comment in job data');
        assert.ok(!comments[0].body.includes('/review'), 'Bare /review should not pass command text as body');
        assert.strictEqual(comments[0].body, '', 'Bare /review should queue an empty body');
    });

    test('/fix job has commandMode "fix" and instructions', async () => {
        const event = createPRCommentEvent('/fix\nFix the broken tests');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-fix-mode', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.commandMode, 'fix');
        assert.strictEqual(jobData.commandInstructions, 'Fix the broken tests');
    });

    test('/switch job sets correct repo context fields', async () => {
        const event = createPRCommentEvent('/switch opus\nReview this');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-switch-ctx', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.pullRequestNumber, 42);
        assert.strictEqual(jobData.repoOwner, 'testowner');
        assert.strictEqual(jobData.repoName, 'testrepo');
    });
});

describe('commentEventHandler — slash command dedup protection', () => {
    beforeEach(() => {
        mockSafeUpdateLabels.mock.resetCalls();
        mockQueueAdd.mock.resetCalls();
        mockOctokit.request.mock.resetCalls();
        mockLoggerInstance.info.mock.resetCalls();
        mockLoggerInstance.warn.mock.resetCalls();
        mockLoggerInstance.debug.mock.resetCalls();
        mockActiveJobs = [];
        mockWaitingJobs = [];
        mockDelayedJobs = [];

        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [],
            },
        }));
    });

    test('redelivered /use webhook is skipped when comment already processed', async () => {
        const event = createPRCommentEvent('/use opus');
        const config = createTestConfig();

        // First delivery changes the label without enqueuing.
        await processCommentEvent(event, 'issue_comment', 'corr-dedup-1', config);
        assertSingleLabelReplacement(['llm-claude-opus5']);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);

        // Simulate redelivery — same event, same comment id
        await processCommentEvent(event, 'issue_comment', 'corr-dedup-2', config);
        assert.strictEqual(getLabelReplacementCalls().length, 1);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('redelivered /switch webhook is skipped and labels are not mutated again', async () => {
        const event = createPRCommentEvent('/switch opus');
        const config = createTestConfig();

        // First delivery
        await processCommentEvent(event, 'issue_comment', 'corr-dedup-3', config);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);

        // Redelivery
        await processCommentEvent(event, 'issue_comment', 'corr-dedup-4', config);
        // Labels should NOT be updated again
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
    });

    test('redelivered /review webhook is skipped', async () => {
        const event = createPRCommentEvent('/review codex');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-dedup-5', config);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);

        await processCommentEvent(event, 'issue_comment', 'corr-dedup-6', config);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
    });
});

describe('commentEventHandler — slash command batching/concurrency guard', () => {
    beforeEach(() => {
        mockSafeUpdateLabels.mock.resetCalls();
        mockQueueAdd.mock.resetCalls();
        mockOctokit.request.mock.resetCalls();
        mockLoggerInstance.info.mock.resetCalls();
        mockLoggerInstance.warn.mock.resetCalls();
        mockActiveJobs = [];
        mockWaitingJobs = [];
        mockDelayedJobs = [];

        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [],
            },
        }));
    });

    test('/use only changes the label when an existing job is active for the same PR', async () => {
        // Simulate an active job for PR 42
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];

        const event = createPRCommentEvent('/use opus\nFix the bug');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-batch-1', config);

        assertSingleLabelReplacement(['llm-claude-opus5']);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 0);
    });

    test('/switch with instructions is batched when an existing job is active', async () => {
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];

        const event = createPRCommentEvent('/switch opus\nReview the code');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-batch-2', config);

        // Labels should still be updated (label mutation happens before batching check)
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        // But the follow-up job should NOT be enqueued
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        // Comment should be stored for batch
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 1);
        const pendingComment = JSON.parse(config.redisClient.rpush.mock.calls[0].arguments[1] as string) as Record<string, unknown>;
        assert.strictEqual(pendingComment.commandMode, 'switch');
        assert.strictEqual(pendingComment.commandInstructions, 'Review the code');
        assert.strictEqual(pendingComment.llmOverride, 'claude-opus-5');
    });

    test('/use changes only the label when no existing job is active', async () => {
        // No active jobs (default)
        const event = createPRCommentEvent('/use opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-batch-3', config);

        assertSingleLabelReplacement(['llm-claude-opus5']);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 0);
    });

    test('/review is batched when a waiting job exists for the same PR', async () => {
        mockWaitingJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];

        const event = createPRCommentEvent('/review codex');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-batch-4', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 1);
        const pendingComment = JSON.parse(config.redisClient.rpush.mock.calls[0].arguments[1] as string) as Record<string, unknown>;
        assert.strictEqual(pendingComment.body, '');
        assert.strictEqual(pendingComment.commandMode, 'review');
        assert.deepStrictEqual(pendingComment.requestedModels, ['codex']);
        assert.deepStrictEqual(
            mockInvalidateAutomaticWork.mock.calls[0].arguments.slice(1),
            [{ owner: 'testowner', repo: 'testrepo', pr: 42, sourceCommentId: event.comment.id, sourceCommentRevision: manualRevisionIdentity(event.comment.updated_at, event.comment.body) }],
        );
    });

    test('tail-active automatic work gets a durable manual takeover after loop state becomes inactive', async () => {
        const takeoverSteps: string[] = [];
        mockQueueAdd.mock.mockImplementationOnce(async () => { takeoverSteps.push('enqueue'); });
        mockInvalidateAutomaticWork.mock.mockImplementationOnce(async () => {
            takeoverSteps.push('invalidate');
            return { workEpoch: 1, hadAutomaticWork: false };
        });
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                ultrafixMeta: { mode: 'ultrafix', instructions: '', workEpoch: 0 },
            },
        }];

        const event = createPRCommentEvent('/review codex');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-ultrafix-takeover', config);

        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.commandMode, 'review');
        assert.deepStrictEqual(jobData.requestedModels, ['codex']);
        assert.strictEqual(mockInvalidateAutomaticWork.mock.callCount(), 1);
        const revisionSlug = manualRevisionSlug(event.comment.updated_at, event.comment.body);
        assert.strictEqual(
            mockQueueAdd.mock.calls[0].arguments[2].jobId,
            `pr-comments-batch-testowner-testrepo-42-${event.comment.id}-${revisionSlug}`,
        );
        assert.deepStrictEqual(takeoverSteps, ['invalidate', 'enqueue']);
    });

    test('failed manual takeover enqueue remains observable after automatic work is fenced', async () => {
        const enqueueError = new Error('queue unavailable');
        mockInvalidateAutomaticWork.mock.mockImplementationOnce(async () => ({ workEpoch: 1, hadAutomaticWork: true }));
        mockQueueAdd.mock.mockImplementationOnce(async () => { throw enqueueError; });
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                ultrafixMeta: { mode: 'ultrafix', instructions: '', workEpoch: 0 },
            },
        }];

        const event = createPRCommentEvent('/fix address the findings');
        const config = createTestConfig();

        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-ultrafix-takeover-failure', config),
            enqueueError,
        );

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(mockInvalidateAutomaticWork.mock.callCount(), 1);
    });

    test('tracking refresh failure preserves the fenced job and suppresses redelivery', async () => {
        mockInvalidateAutomaticWork.mock.mockImplementation(async () => ({ workEpoch: 1, hadAutomaticWork: true }));
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                ultrafixMeta: { mode: 'ultrafix', instructions: '', workEpoch: 0 },
            },
        }];

        const event = createPRCommentEvent('/fix address the findings');
        const config = createTestConfig();
        config.redisClient.setex.mock.mockImplementationOnce(async () => {
            throw new Error('tracking write response lost');
        });

        await processCommentEvent(event, 'issue_comment', 'corr-takeover-lost-response', config);
        const redelivery = await processCommentEvent(event, 'issue_comment', 'corr-takeover-redelivery', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(mockInvalidateAutomaticWork.mock.callCount(), 1);
        assert.deepStrictEqual(redelivery, { status: 'ignored', reason: 'duplicate_delivery' });
        const revisionSlug = manualRevisionSlug(event.comment.updated_at, event.comment.body);
        assert.strictEqual(
            mockQueueAdd.mock.calls[0].arguments[2].jobId,
            `pr-comments-batch-testowner-testrepo-42-${event.comment.id}-${revisionSlug}`,
        );
    });

    test('an edited manual command fences and enqueues once under its new revision after the original job is terminal', async () => {
        const event = createPRCommentEvent('/fix original instructions');
        event.comment.id = 12345;
        event.comment.updated_at = '2026-08-09T10:00:00Z';
        const config = createTestConfig({ processCommentEvent });

        await processCommentEvent(event, 'issue_comment', 'corr-original-revision', config);

        // No active/waiting/delayed job represents the original BullMQ job having
        // reached a retained completed or failed state.
        event.comment.body = '/fix edited instructions';
        event.comment.updated_at = '2026-08-09T10:05:00Z';
        await handleCommentEdited(event, 'issue_comment', 'corr-edited-revision', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 2);
        const originalRevision = manualRevisionIdentity('2026-08-09T10:00:00Z', '/fix original instructions');
        const editedRevision = manualRevisionIdentity('2026-08-09T10:05:00Z', '/fix edited instructions');
        assert.deepStrictEqual(
            mockQueueAdd.mock.calls.map(call => call.arguments[2].jobId),
            [
                `pr-comments-batch-testowner-testrepo-42-12345-${originalRevision.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
                `pr-comments-batch-testowner-testrepo-42-12345-${editedRevision.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
            ],
        );
        assert.deepStrictEqual(
            mockInvalidateAutomaticWork.mock.calls.map(call => call.arguments[1]),
            [
                { owner: 'testowner', repo: 'testrepo', pr: 42, sourceCommentId: 12345, sourceCommentRevision: originalRevision },
                { owner: 'testowner', repo: 'testrepo', pr: 42, sourceCommentId: 12345, sourceCommentRevision: editedRevision },
            ],
        );
    });

    test('same-timestamp edits use distinct deterministic takeover and job identities', async () => {
        const event = createPRCommentEvent('/fix original instructions');
        event.comment.id = 12345;
        event.comment.updated_at = '2026-08-09T10:00:00Z';
        const config = createTestConfig({ processCommentEvent });

        await processCommentEvent(event, 'issue_comment', 'corr-same-second-original', config);
        event.comment.body = '/fix edited within the same second';
        await handleCommentEdited(event, 'issue_comment', 'corr-same-second-edit', config);

        const jobIds = mockQueueAdd.mock.calls.map(call => call.arguments[2].jobId);
        const takeoverIdentities = mockInvalidateAutomaticWork.mock.calls.map(call => call.arguments[1].sourceCommentRevision);
        assert.strictEqual(jobIds.length, 2);
        assert.notStrictEqual(jobIds[0], jobIds[1]);
        assert.notStrictEqual(takeoverIdentities[0], takeoverIdentities[1]);
        assert.match(jobIds[0] as string, /2026-08-09T10-00-00Z-[a-f0-9]{12}$/);
        assert.match(jobIds[1] as string, /2026-08-09T10-00-00Z-[a-f0-9]{12}$/);
    });

    test('later manual commands resume normal batching after an Ultrafix takeover', async () => {
        let workEpoch = 0;
        mockInvalidateAutomaticWork.mock.mockImplementation(async () => {
            workEpoch += 1;
            return { workEpoch, hadAutomaticWork: workEpoch === 1 };
        });
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                ultrafixMeta: { mode: 'ultrafix', instructions: '', workEpoch: 0 },
            },
        }];
        const takeover = createPRCommentEvent('/review codex');
        const laterCommand = createPRCommentEvent('/review codex');
        laterCommand.comment.id = takeover.comment.id + 1;
        const config = createTestConfig();

        await processCommentEvent(takeover, 'issue_comment', 'corr-first-takeover', config);
        mockActiveJobs = [
            ...mockActiveJobs,
            {
                name: 'processPullRequestComment',
                data: {
                    pullRequestNumber: 42,
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    commandMode: 'review',
                },
            },
        ];
        await processCommentEvent(laterCommand, 'issue_comment', 'corr-later-batch', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 1);
        const pendingComment = JSON.parse(
            config.redisClient.rpush.mock.calls[0].arguments[1] as string,
        ) as Record<string, unknown>;
        assert.strictEqual(pendingComment.commandMode, 'review');
    });

    test('/use on a review comment changes only the label and ignores review context', async () => {
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];

        const event = createPRReviewCommentEvent('/use opus\nPlease fix this line');
        const config = createTestConfig();

        await processCommentEvent(event, 'pull_request_review_comment', 'corr-batch-review', config);

        assertSingleLabelReplacement(['llm-claude-opus5']);
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 0);
    });
});

describe('commentEventHandler — comment revision cancellation', () => {
    beforeEach(() => {
        mockLoggerInstance.info.mock.resetCalls();
        mockActiveJobs = [];
        mockWaitingJobs = [];
        mockDelayedJobs = [];
    });

    test('deleting an active revision-based manual job uses its exact worker abort key', async () => {
        const remove = mock.fn(async () => {});
        mockActiveJobs = [{
            id: 'pr-comments-batch-testowner-testrepo-42-123-2026-08-09T10-00-00Z',
            name: 'processPullRequestComment',
            data: {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                commandMode: 'fix',
                comments: [{ id: 123, body: 'please fix this', author: 'integry', type: 'issue' }],
            },
            remove,
        }];
        const event = createPRCommentEvent('please fix this');
        event.comment.id = 123;
        const config = createTestConfig();

        await handleCommentDeleted(event, 'issue_comment', 'corr-delete-delayed', config);

        assert.strictEqual(remove.mock.callCount(), 1);
        assert.strictEqual(config.redisClient.set.mock.calls[0].arguments[0], 'worker:abort:pr-comments-batch-testowner-testrepo-42-123-2026-08-09T10-00-00Z');
        assert.strictEqual(config.redisClient.del.mock.callCount(), 1);
        assert.strictEqual(
            config.redisClient.del.mock.calls[0].arguments[0],
            'pr-comment-processed:testowner:testrepo:42:123'
        );
    });

    test('editing an active revision-based manual job uses its exact worker abort key', async () => {
        const remove = mock.fn(async () => {});
        mockActiveJobs = [{
            id: 'pr-comments-batch-testowner-testrepo-42-123-2026-08-09T10-00-00Z',
            name: 'processPullRequestComment',
            data: {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                commandMode: 'review',
                comments: [{ id: 123, body: 'please review this', author: 'integry', type: 'issue' }],
            },
            remove,
        }];
        const event = createPRCommentEvent('/review codex');
        event.comment.id = 123;
        const config = createTestConfig();

        await handleCommentEdited(event, 'issue_comment', 'corr-edit-active-manual', config);

        assert.strictEqual(remove.mock.callCount(), 1);
        assert.strictEqual(config.redisClient.set.mock.calls[0].arguments[0], 'worker:abort:pr-comments-batch-testowner-testrepo-42-123-2026-08-09T10-00-00Z');
        assert.strictEqual(config.redisClient.del.mock.calls[0].arguments[0], 'pr-comment-processed:testowner:testrepo:42:123');
    });
});

describe('applyPendingCommentCommandContext', () => {
    test('selects the same pending command for every mixed-timestamp input permutation', () => {
        const comments = [
            {
                id: 300,
                createdAt: '2026-08-09T10:00:00Z',
                body: '',
                author: 'alice',
                type: 'issue' as const,
                commandMode: 'fix' as const,
                commandInstructions: 'selected by legacy ID ordering',
            },
            {
                id: 200,
                body: '',
                author: 'alice',
                type: 'issue' as const,
                commandMode: 'review' as const,
                commandInstructions: '',
            },
            {
                id: 100,
                createdAt: '2026-08-09T11:00:00Z',
                body: '',
                author: 'alice',
                type: 'issue' as const,
                commandMode: 'switch' as const,
                commandInstructions: '',
            },
        ];
        const permutations = [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ];

        for (const permutation of permutations) {
            const jobData = {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                correlationId: 'corr-mixed-command-chronology',
                commandMode: 'default' as const,
                commandCommentId: undefined as number | undefined,
            };

            applyPendingCommentCommandContext(
                jobData,
                permutation.map(index => comments[index]),
                mockLoggerInstance as never,
            );

            assert.strictEqual(jobData.commandCommentId, 300, `permutation ${permutation.join(',')}`);
        }
    });

    test('selects the same model override for every mixed-timestamp input permutation', () => {
        const comments = [
            {
                id: 300,
                createdAt: '2026-08-09T10:00:00Z',
                body: '',
                author: 'alice',
                type: 'issue' as const,
                llmOverride: 'claude-opus-4-6',
            },
            {
                id: 200,
                body: '',
                author: 'alice',
                type: 'issue' as const,
                llmOverride: 'claude-sonnet-4-6',
            },
            {
                id: 100,
                createdAt: '2026-08-09T11:00:00Z',
                body: '',
                author: 'alice',
                type: 'issue' as const,
                llmOverride: 'codex:gpt-5.6-sol',
            },
        ];
        const permutations = [
            [0, 1, 2],
            [0, 2, 1],
            [1, 0, 2],
            [1, 2, 0],
            [2, 0, 1],
            [2, 1, 0],
        ];

        for (const permutation of permutations) {
            const jobData = {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                correlationId: 'corr-mixed-override-chronology',
                commandMode: 'default' as const,
                llm: 'initial-model',
            };

            applyPendingCommentCommandContext(
                jobData,
                permutation.map(index => comments[index]),
                mockLoggerInstance as never,
            );

            assert.strictEqual(jobData.llm, 'claude-opus-4-6', `permutation ${permutation.join(',')}`);
        }
    });

    test('orders issue and review commands by creation time instead of cross-resource IDs', () => {
        const jobData = {
            pullRequestNumber: 42,
            repoOwner: 'testowner',
            repoName: 'testrepo',
            correlationId: 'corr-cross-type-order',
            comments: [{
                id: 900,
                createdAt: '2026-08-09T09:00:00Z',
                body: '',
                author: 'alice',
                type: 'issue' as const,
            }],
            commandCommentId: 900,
            commandCommentCreatedAt: '2026-08-09T09:00:00Z',
            commandCommentType: 'issue' as const,
            commandMode: 'fix' as const,
            commandInstructions: 'queued fix',
        };
        const commentsToProcess = [
            ...jobData.comments,
            {
                id: 10,
                createdAt: '2026-08-09T09:01:00Z',
                body: '',
                author: 'alice',
                type: 'review' as const,
                commandMode: 'review' as const,
                requestedModels: [],
                commandInstructions: '',
            },
        ];

        applyPendingCommentCommandContext(jobData, commentsToProcess, mockLoggerInstance as never);

        assert.strictEqual(jobData.commandMode, 'review');
        assert.strictEqual(jobData.commandCommentId, 10);
        assert.strictEqual(jobData.commandCommentCreatedAt, '2026-08-09T09:01:00Z');
        assert.strictEqual(jobData.commandCommentType, 'review');
    });

    test('ignores an older cross-type override even when its resource ID is larger', () => {
        const jobData = {
            pullRequestNumber: 42,
            repoOwner: 'testowner',
            repoName: 'testrepo',
            correlationId: 'corr-cross-type-cutoff',
            comments: [{
                id: 10,
                createdAt: '2026-08-09T09:01:00Z',
                body: '',
                author: 'alice',
                type: 'issue' as const,
            }],
            commandCommentId: 10,
            commandCommentCreatedAt: '2026-08-09T09:01:00Z',
            commandCommentType: 'issue' as const,
            commandMode: 'review' as const,
            llm: 'codex:gpt-5.6-sol',
        };
        const commentsToProcess = [
            ...jobData.comments,
            {
                id: 900,
                createdAt: '2026-08-09T09:00:00Z',
                body: '',
                author: 'alice',
                type: 'review' as const,
                commandMode: 'use' as const,
                llmOverride: 'claude-opus-4-6',
            },
        ];

        applyPendingCommentCommandContext(jobData, commentsToProcess, mockLoggerInstance as never);

        assert.strictEqual(jobData.llm, 'codex:gpt-5.6-sol');
    });

    test('does not let an older pending command override a newer queued command', () => {
        const jobData = {
            pullRequestNumber: 42,
            repoOwner: 'testowner',
            repoName: 'testrepo',
            correlationId: 'corr-pending-order',
            comments: [{ id: 200, body: '', author: 'alice', type: 'issue' as const }],
            commandCommentId: 200,
            commandMode: 'review' as const,
            ultrafixMeta: { mode: 'ultrafix' as const, instructions: '' },
        };
        const commentsToProcess = [
            ...jobData.comments,
            {
                id: 199,
                body: 'Fix F7',
                author: 'alice',
                type: 'issue' as const,
                commandMode: 'fix' as const,
                commandInstructions: 'Fix F7',
            },
        ];

        applyPendingCommentCommandContext(jobData, commentsToProcess, mockLoggerInstance as never);

        assert.strictEqual(jobData.commandMode, 'review');
        assert.ok(jobData.ultrafixMeta);
    });

    test('does not let an older model override replace a newer queued command model', () => {
        const jobData = {
            pullRequestNumber: 42,
            repoOwner: 'testowner',
            repoName: 'testrepo',
            correlationId: 'corr-pending-model-order',
            comments: [{ id: 200, body: '', author: 'alice', type: 'issue' as const }],
            commandCommentId: 200,
            commandMode: 'review' as const,
            llm: 'codex:gpt-5.6-sol',
        };
        const commentsToProcess = [
            ...jobData.comments,
            {
                id: 199,
                body: '',
                author: 'alice',
                type: 'issue' as const,
                commandMode: 'use' as const,
                llmOverride: 'claude-opus-4-6',
            },
        ];

        applyPendingCommentCommandContext(jobData, commentsToProcess, mockLoggerInstance as never);

        assert.strictEqual(jobData.llm, 'codex:gpt-5.6-sol');
    });

    test('latest manual command clears inherited Ultrafix metadata', () => {
        const jobData = {
            pullRequestNumber: 42,
            repoOwner: 'testowner',
            repoName: 'testrepo',
            correlationId: 'corr-pending-manual',
            comments: [{ id: 98, body: '', author: 'alice', type: 'issue' as const }],
            commandCommentId: 98,
            commandMode: 'review' as const,
            ultrafixMeta: { mode: 'ultrafix' as const, instructions: '' },
        };
        const commentsToProcess = [
            ...jobData.comments,
            {
                id: 99,
                body: 'Fix F3',
                author: 'alice',
                type: 'issue' as const,
                commandMode: 'fix' as const,
                commandInstructions: 'Fix F3',
            },
        ];

        applyPendingCommentCommandContext(jobData, commentsToProcess, mockLoggerInstance as never);

        assert.strictEqual(jobData.commandMode, 'fix');
        assert.strictEqual(jobData.ultrafixMeta, undefined);
        assert.strictEqual(jobData.commandCommentId, 99);
    });

    test('keeps an earlier /use llm override when a later pending /fix becomes the active command', () => {
        const jobData = {
            pullRequestNumber: 42,
            repoOwner: 'testowner',
            repoName: 'testrepo',
            correlationId: 'corr-pending-1',
            commandMode: 'default' as const,
            llm: 'claude-sonnet-4-6',
        };
        const commentsToProcess = [
            {
                id: 100,
                body: 'Use opus',
                author: 'alice',
                type: 'issue' as const,
                commandMode: 'use' as const,
                commandInstructions: '',
                llmOverride: 'claude-opus-4-6',
            },
            {
                id: 101,
                body: 'Fix the auth bug',
                author: 'alice',
                type: 'issue' as const,
                commandMode: 'fix' as const,
                commandInstructions: 'Fix the auth bug',
            },
        ];

        applyPendingCommentCommandContext(jobData, commentsToProcess, mockLoggerInstance as never);

        assert.strictEqual(jobData.commandMode, 'fix');
        assert.strictEqual(jobData.commandInstructions, 'Fix the auth bug');
        assert.strictEqual(jobData.llm, 'claude-opus-4-6');
    });

    test('promotes a /use override when a later model-less /review becomes active', () => {
        const jobData = {
            pullRequestNumber: 42,
            repoOwner: 'testowner',
            repoName: 'testrepo',
            correlationId: 'corr-pending-review',
            commandMode: 'default' as const,
            llm: 'claude-sonnet-4-6',
            requestedModels: undefined as string[] | undefined,
        };
        const commentsToProcess = [
            {
                id: 102,
                body: '',
                author: 'alice',
                type: 'issue' as const,
                commandMode: 'use' as const,
                requestedModels: ['claude-opus-4-6'],
                commandInstructions: '',
                llmOverride: 'claude-opus-4-6',
            },
            {
                id: 103,
                body: '',
                author: 'alice',
                type: 'issue' as const,
                commandMode: 'review' as const,
                requestedModels: [],
                commandInstructions: '',
            },
        ];

        applyPendingCommentCommandContext(jobData, commentsToProcess, mockLoggerInstance as never);

        assert.strictEqual(jobData.commandMode, 'review');
        assert.strictEqual(jobData.llm, 'claude-opus-4-6');
        assert.deepStrictEqual(jobData.requestedModels, ['claude-opus-4-6']);
    });

    test('promotes a queued /use override when a newer model-less /review becomes active', () => {
        const jobData = {
            pullRequestNumber: 42,
            repoOwner: 'testowner',
            repoName: 'testrepo',
            correlationId: 'corr-queued-use-review',
            comments: [{
                id: 800,
                createdAt: '2026-08-09T09:00:00Z',
                body: '',
                author: 'alice',
                type: 'issue' as const,
            }],
            commandCommentId: 800,
            commandCommentCreatedAt: '2026-08-09T09:00:00Z',
            commandCommentType: 'issue' as const,
            commandMode: 'use' as const,
            llm: 'claude-opus-4-6',
            requestedModels: ['claude-opus-4-6'],
        };
        const commentsToProcess = [
            ...jobData.comments,
            {
                id: 20,
                createdAt: '2026-08-09T09:01:00Z',
                body: '',
                author: 'alice',
                type: 'review' as const,
                commandMode: 'review' as const,
                requestedModels: [],
                commandInstructions: '',
            },
        ];

        applyPendingCommentCommandContext(jobData, commentsToProcess, mockLoggerInstance as never);

        assert.strictEqual(jobData.commandMode, 'review');
        assert.strictEqual(jobData.llm, 'claude-opus-4-6');
        assert.deepStrictEqual(jobData.requestedModels, ['claude-opus-4-6']);
    });
});

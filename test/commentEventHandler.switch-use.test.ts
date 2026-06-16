import { test, mock, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { IssueCommentEvent, Label } from '@octokit/webhooks-types';
import { createWebhookIssueCommentCreatedEvent, createWebhookPRReviewCommentCreatedEvent, createMockLabel } from './testHelpers.js';

// ========== Mocks ==========

const mockOctokit = {
    request: mock.fn(async () => ({ data: {} })),
};

// Mock simple-git
await mock.module('simple-git', {
    namedExports: {
        simpleGit: mock.fn(() => ({})),
        SimpleGit: class {},
    },
});

// Mock ioredis
await mock.module('ioredis', {
    defaultExport: function Redis() {
        return { on: mock.fn(), quit: mock.fn(async () => {}) };
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
        default: {
            info: mock.fn(),
            warn: mock.fn(),
            error: mock.fn(),
            debug: mock.fn(),
            withCorrelation: mock.fn(() => mockLoggerInstance),
        },
    },
});

// Mock configManager
await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: {
        loadFollowupIgnoreKeywords: mock.fn(async () => []),
        loadPrimaryProcessingLabels: mock.fn(async () => ['AI']),
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
const mockSafeUpdateLabels = mock.fn(async () => {});
await mock.module('../packages/core/src/utils/github/labelOperations.js', {
    namedExports: {
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
await mock.module('../packages/core/src/utils/retryHandler.js', {
    namedExports: {
        withRetry: mock.fn(async (fn: () => Promise<unknown>) => fn()),
    },
});

// Import module under test AFTER mocks
const { processCommentEvent, handleCommentDeleted } = await import(
    '../packages/core/src/webhook/commentEventHandler.js'
);
const { applyPendingCommentCommandContext } = await import(
    '../src/jobs/prPendingComments.js'
);

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
        // "opus" should be resolved to "claude-opus-4-6" via resolveModelAlias
        assert.deepStrictEqual(newLabels, ['llm-claude-opus-4-6']);
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
        assert.deepStrictEqual(newLabels, ['llm-claude-sonnet-4-6']);
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
        assert.deepStrictEqual(newLabels, ['ai-model-claude-sonnet-4-6']);
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
        assert.deepStrictEqual(newLabels, ['model-claude-opus-4-6']);
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
        assert.deepStrictEqual(newLabels, ['llm-claude-opus-4-6']);
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

    test('/use enqueues a job without updating labels', async () => {
        const event = createPRCommentEvent('/use opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-10', config);

        // /use should NOT update labels
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        // /use SHOULD enqueue a job
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
    });

    test('/use sets commandMode to "use" in job data', async () => {
        const event = createPRCommentEvent('/use sonnet');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-11', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.commandMode, 'use');
    });

    test('/use resolves model alias for LLM override in job data', async () => {
        const event = createPRCommentEvent('/use opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-12', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        // resolveLlm should have resolved "opus" → "claude-opus-4-6"
        assert.strictEqual(jobData.llm, 'claude-opus-4-6');
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

    test('/use with instructions includes them in job data', async () => {
        const event = createPRCommentEvent('/use haiku\nFix the login bug');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-13', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.commandInstructions, 'Fix the login bug');
    });

    test('/use with instructions passes stripped comment body without command text', async () => {
        const event = createPRCommentEvent('/use sonnet\nRefactor the utils');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-body', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        const comments = jobData.comments as Array<{ body: string }>;
        // /use body is stripped like /switch — only user instructions remain
        assert.ok(comments.length > 0);
        assert.strictEqual(comments[0].body, 'Refactor the utils');
    });

    test('/use with llm- prefixed argument strips prefix before resolving', async () => {
        const event = createPRCommentEvent('/use llm-opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-llm-prefix', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        // "llm-opus" → normalizeModelLabel strips "llm-" → "opus" → resolveModelAlias → "claude-opus-4-6"
        assert.strictEqual(jobData.llm, 'claude-opus-4-6');
    });

    test('/use without instructions still enqueues a job with empty body', async () => {
        const event = createPRCommentEvent('/use opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-noinstructions', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.commandMode, 'use');
        // commandInstructions should be empty
        assert.strictEqual(jobData.commandInstructions, '');
        // The queued comment body must NOT contain the slash command text
        const comments = jobData.comments as Array<{ body: string }>;
        assert.ok(comments.length > 0, 'Expected at least one comment in job data');
        assert.strictEqual(comments[0].body, '', 'Bare /use should queue an empty body, not the command text');
    });

    test('/use with unrecognized model warns and returns early', async () => {
        const event = createPRCommentEvent('/use nonexistent-model');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-invalid-model', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        const warnCalls = mockLoggerInstance.warn.mock.calls;
        const invalidWarn = warnCalls.find(
            (c: { arguments: unknown[] }) => typeof c.arguments[1] === 'string' && c.arguments[1].includes('unrecognized model')
        );
        assert.ok(invalidWarn, 'Expected a warning about unrecognized model');
    });

    test('/use with extra models logs warning but uses first model', async () => {
        const event = createPRCommentEvent('/use opus sonnet');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-extra', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.llm, 'claude-opus-4-6');
        // Warning should be logged
        const warnCalls = mockLoggerInstance.warn.mock.calls;
        const extraWarn = warnCalls.find(
            (c: { arguments: unknown[] }) => typeof c.arguments[1] === 'string' && c.arguments[1].includes('extra arguments were ignored')
        );
        assert.ok(extraWarn, 'Expected a warning about extra arguments');
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
        assert.deepStrictEqual(meta.models, ['claude-sonnet-4-6']);
        assert.strictEqual(meta.instructions, 'Do a review');
        assert.strictEqual(jobData.commandInstructions, 'Do a review');
    });

    test('/use job has commandMode "use" and commandMeta with resolved model', async () => {
        const event = createPRCommentEvent('/use haiku\nSummarize changes');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-mode-use', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.commandMode, 'use');
        const meta = jobData.commandMeta as { mode: string; models: string[]; instructions: string };
        assert.strictEqual(meta.mode, 'use');
        assert.deepStrictEqual(meta.models, ['haiku']);
        assert.strictEqual(jobData.commandInstructions, 'Summarize changes');
        // LLM should be resolved from /use command
        assert.strictEqual(jobData.llm, 'claude-haiku-4-5-20251001');
    });

    test('/switch follow-up job does not include requestedModels (only /review uses that)', async () => {
        const event = createPRCommentEvent('/switch opus\nCheck the tests');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-mode-no-req', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.requestedModels, undefined);
    });

    test('/use job does not include requestedModels', async () => {
        const event = createPRCommentEvent('/use sonnet\nDo something');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-no-req', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.requestedModels, undefined);
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

        // First delivery — should enqueue
        await processCommentEvent(event, 'issue_comment', 'corr-dedup-1', config);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);

        // Simulate redelivery — same event, same comment id
        await processCommentEvent(event, 'issue_comment', 'corr-dedup-2', config);
        // Should NOT enqueue a second job
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
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

    test('/use is batched when an existing job is active for the same PR', async () => {
        // Simulate an active job for PR 42
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];

        const event = createPRCommentEvent('/use opus\nFix the bug');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-batch-1', config);

        // Should NOT enqueue a new job
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        // Should store comment for batch via rpush
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 1);
        const pendingComment = JSON.parse(config.redisClient.rpush.mock.calls[0].arguments[1] as string) as Record<string, unknown>;
        assert.strictEqual(pendingComment.body, 'Fix the bug');
        assert.strictEqual(pendingComment.commandMode, 'use');
        assert.strictEqual(pendingComment.commandInstructions, 'Fix the bug');
        assert.strictEqual(pendingComment.llmOverride, 'claude-opus-4-6');
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
        assert.strictEqual(pendingComment.llmOverride, 'claude-opus-4-6');
    });

    test('/use enqueues normally when no existing job is active', async () => {
        // No active jobs (default)
        const event = createPRCommentEvent('/use opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-batch-3', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
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
    });

    test('batched slash commands on review comments preserve code-review context', async () => {
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];

        const event = createPRReviewCommentEvent('/use opus\nPlease fix this line');
        const config = createTestConfig();

        await processCommentEvent(event, 'pull_request_review_comment', 'corr-batch-review', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 1);
        const pendingComment = JSON.parse(config.redisClient.rpush.mock.calls[0].arguments[1] as string) as Record<string, unknown>;
        assert.strictEqual(pendingComment.type, 'review');
        assert.strictEqual(pendingComment.hasCodeContext, true);
        assert.match(pendingComment.body as string, /Please fix this line/);
        assert.match(pendingComment.body as string, /--- Review Comment Context ---/);
        assert.match(pendingComment.body as string, /File: src\/auth\.ts/);
        assert.match(pendingComment.body as string, /Line: 27/);
        assert.match(pendingComment.body as string, /@@ -1,5 \+1,10 @@/);
    });
});

describe('commentEventHandler — comment deletion queue cleanup', () => {
    beforeEach(() => {
        mockLoggerInstance.info.mock.resetCalls();
        mockActiveJobs = [];
        mockWaitingJobs = [];
        mockDelayedJobs = [];
    });

    test('removes delayed PR comment job when the source comment is deleted', async () => {
        const remove = mock.fn(async () => {});
        mockDelayedJobs = [{
            id: 'pr-comments-batch-testowner-testrepo-42-123',
            name: 'processPullRequestComment',
            data: {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                comments: [{ id: 123, body: 'please fix this', author: 'integry', type: 'issue' }],
            },
            remove,
        }];
        const event = createPRCommentEvent('please fix this');
        event.comment.id = 123;
        const config = createTestConfig();

        await handleCommentDeleted(event, 'issue_comment', 'corr-delete-delayed', config);

        assert.strictEqual(remove.mock.callCount(), 1);
        assert.strictEqual(config.redisClient.del.mock.callCount(), 1);
        assert.strictEqual(
            config.redisClient.del.mock.calls[0].arguments[0],
            'pr-comment-processed:testowner:testrepo:42:123'
        );
    });
});

describe('applyPendingCommentCommandContext', () => {
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
});

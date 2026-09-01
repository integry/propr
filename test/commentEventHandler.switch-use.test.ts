import { test, mock, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import type { IssueCommentEvent, Label } from '@octokit/webhooks-types';
import { createWebhookIssueCommentCreatedEvent, createWebhookPRReviewCommentCreatedEvent, createMockLabel } from './testHelpers.js';

const actualLabelOperations = await import('../packages/core/src/utils/github/labelOperations.js');

function manualRevisionIdentity(updatedAt: string, body: string, eventType = 'issue_comment'): string {
    const commentType = eventType === 'pull_request_review_comment' ? 'review' : 'issue';
    const digest = createHash('sha256').update(`${commentType}\0${body}`).digest('hex').slice(0, 12);
    return `${updatedAt}:${digest}`;
}

function manualRevisionSlug(updatedAt: string, body: string, eventType = 'issue_comment'): string {
    return manualRevisionIdentity(updatedAt, body, eventType).replace(/[^a-zA-Z0-9_-]/g, '-');
}

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

// Keep the model-validation fallback isolated from the full agent runtime.
const mockAgentRegistry = {
    ensureInitialized: mock.fn(async () => {}),
    getAllAgents: mock.fn(() => []),
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

// Mock commentFilters
await mock.module('../packages/core/src/utils/commentFilters.js', {
    namedExports: {
        filterCommentByAuthor: mock.fn(() => ({ shouldFilter: false })),
        checkCommentTrigger: mock.fn(() => ({ isTriggered: true })),
        checkCommentIgnore: mock.fn(() => ({ shouldIgnore: false })),
    },
});

// Mock safeUpdateLabels — capture calls for assertions
const defaultSafeUpdateLabels = async (_context: unknown, removed: string[] = [], added: string[] = []) => ({
    success: true,
    removed,
    added,
    errors: [],
});
const mockSafeUpdateLabels = mock.fn(defaultSafeUpdateLabels);
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
const { closeConnection } = await import('../packages/core/src/db/connection.js');
const { shutdownQueue } = await import('../packages/core/src/queue/taskQueue.js');
const { applyPendingCommentCommandContext } = await import(
    '../src/jobs/prPendingComments.js'
);
const { dedupeUnprocessedComments } = await import('../packages/core/src/utils/pendingComments.js');
const { extractModelFromLabels, handleJobError, UsageLimitError } = await import('../src/jobs/prCommentJobUtils.js');

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
    mockSafeUpdateLabels.mock.mockImplementation(defaultSafeUpdateLabels);
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
    const lists = new Map<string, string[]>();
    const counters = new Map<string, number>();
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
        incr: mock.fn(async (key: string) => {
            const next = (counters.get(key) ?? 0) + 1;
            counters.set(key, next);
            return next;
        }),
        lrange: mock.fn(async (key: string) => [...(lists.get(key) ?? [])]),
        eval: mock.fn(async (script: string, _keyCount: number, key: string, ...args: string[]) => {
            if (script.includes("redis.call('LRANGE'")) {
                const list = lists.get(key) ?? [];
                const seen = new Set(list.map(raw => {
                    const comment = JSON.parse(raw) as { type: string; id: number; revisionIdentity?: string; updatedAt?: string; createdAt?: string; body: string };
                    const revision = comment.updatedAt ?? comment.createdAt ?? '';
                    const digest = createHash('sha256').update(`${comment.type}\0${comment.body}`).digest('hex').slice(0, 12);
                    return `${comment.type}:${comment.id}:${comment.revisionIdentity ?? `${revision}:${digest}`}`;
                }));
                const missing: string[] = [];
                for (let index = 0; index < args.length; index += 3) {
                    if (!seen.has(args[index])) {
                        seen.add(args[index]);
                        missing.push(args[index + 2]);
                    }
                }
                lists.set(key, [...missing, ...list]);
                return missing.length;
            }
            const token = args[0];
            if (store.get(key) !== token) return 0;
            if (script.includes("redis.call('PEXPIRE'")) return 1;
            store.delete(key);
            return 1;
        }),
        rpush: mock.fn(async (key: string, ...values: string[]) => {
            lists.set(key, [...(lists.get(key) ?? []), ...values]);
        }),
        expire: mock.fn(async () => {}),
        _store: store,
        _lists: lists,
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
        assert.deepStrictEqual(newLabels, ['llm-claude-opus5']);
    });

    test('/switch with full model ID preserves it in label', async () => {
        const event = createPRCommentEvent('/switch claude-sonnet-4-6');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-2', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        const newLabels = mockSafeUpdateLabels.mock.calls[0].arguments[2] as string[];
        assert.deepStrictEqual(newLabels, ['llm-claude-sonnet46']);
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
        assert.deepStrictEqual(newLabels, ['llm-claude-sonnet5']);
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

    test('/switch derives a validated canonical label for a custom MODEL_LABEL_PATTERN', async () => {
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
        assert.deepStrictEqual(mockSafeUpdateLabels.mock.calls[0].arguments[1], ['ai-model-claude-opus-4-6']);
        assert.deepStrictEqual(mockSafeUpdateLabels.mock.calls[0].arguments[2], ['ai-model-claude-sonnet5']);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
    });

    test('/switch with llm- prefixed argument strips prefix before resolving', async () => {
        const event = createPRCommentEvent('/switch llm-haiku');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-7', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        const newLabels = mockSafeUpdateLabels.mock.calls[0].arguments[2] as string[];
        // "llm-haiku" → normalizeModelLabel strips "llm-" → "haiku" → resolveModelAlias → "claude-haiku-4-5-20251001"
        assert.deepStrictEqual(newLabels, ['llm-claude-haiku']);
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
        assert.deepStrictEqual(newLabels, ['llm-claude-haiku']);
    });

    test('/switch supports a safely derived escaped-pattern label', async () => {
        // Escaped metacharacters like \- should be handled correctly by modelLabelPrefix,
        // deriving the literal prefix 'model-' which produces labels matching the pattern.
        const event = createPRCommentEvent('/switch opus');
        const config = createTestConfig({ MODEL_LABEL_PATTERN: '^model\\-(.+)$' });

        await processCommentEvent(event, 'issue_comment', 'corr-escaped', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        assert.deepStrictEqual(mockSafeUpdateLabels.mock.calls[0].arguments[2], ['model-claude-opus5']);
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
        assert.deepStrictEqual(newLabels, ['llm-claude-opus5']);
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

    test('/use updates the durable model label before enqueueing', async () => {
        const event = createPRCommentEvent('/use opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-10', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        assert.deepStrictEqual(mockSafeUpdateLabels.mock.calls[0].arguments[2], ['llm-claude-opus5']);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
    });

    test('/use queues the validated label derived from a custom MODEL_LABEL_PATTERN', async () => {
        const event = createPRCommentEvent('/use opus\nContinue the fix');
        const config = createTestConfig({ MODEL_LABEL_PATTERN: '^ai-model-(.+)$' });

        await processCommentEvent(event, 'issue_comment', 'corr-use-custom-pattern', config);

        assert.deepStrictEqual(mockSafeUpdateLabels.mock.calls[0].arguments[2], ['ai-model-claude-opus5']);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.modelLabel, 'ai-model-claude-opus5');
        assert.strictEqual(jobData.modelName, 'claude-opus-5');
    });

    test('out-of-order /use revisions keep the durable label aligned with the newest queued routing', async () => {
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];
        const newer = createPRCommentEvent('/use haiku\nUse the newer revision');
        newer.comment.id = 12345;
        newer.comment.created_at = '2026-08-14T10:00:00Z';
        newer.comment.updated_at = '2026-08-14T10:05:00Z';
        const config = createTestConfig({ processCommentEvent });

        await processCommentEvent(newer, 'issue_comment', 'corr-newer-use-revision', config);

        const queuedData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        mockWaitingJobs = [{
            id: mockQueueAdd.mock.calls[0].arguments[2].jobId,
            name: 'processPullRequestComment',
            data: queuedData,
            remove: mock.fn(async () => {}),
        }];
        const older = createPRCommentEvent('/use opus\nUse the older revision');
        older.comment.id = newer.comment.id;
        older.comment.created_at = newer.comment.created_at;
        older.comment.updated_at = '2026-08-14T10:01:00Z';

        await handleCommentEdited(older, 'issue_comment', 'corr-older-use-revision', config);

        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1, 'stale delivery must not mutate the model label');
        assert.deepStrictEqual(mockSafeUpdateLabels.mock.calls[0].arguments[2], ['llm-claude-haiku']);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1, 'stale delivery must not enqueue different routing');
        assert.strictEqual(queuedData.agentAlias, 'default');
        assert.strictEqual(queuedData.modelName, 'claude-haiku-4-5-20251001');
        assert.strictEqual(queuedData.modelLabel, 'llm-claude-haiku');
    });

    test('concurrent older and newer /use commands reject the stale transition after lease acquisition', async () => {
        mockSafeUpdateLabels.mock.mockImplementation(actualLabelOperations.safeUpdateLabels);
        const liveLabels = ['AI', 'llm-claude-sonnet5'];
        let releaseOlderPullRead!: () => void;
        let olderReachedPullRead!: () => void;
        const olderPullRead = new Promise<void>(resolve => { olderReachedPullRead = resolve; });
        const olderPullGate = new Promise<void>(resolve => { releaseOlderPullRead = resolve; });
        let pullReads = 0;
        mockOctokit.request.mock.mockImplementation(async (endpoint: string, options: Record<string, unknown>) => {
            if (endpoint === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                pullReads += 1;
                if (pullReads === 1) {
                    olderReachedPullRead();
                    await olderPullGate;
                }
                return { data: { head: { ref: 'feature-branch' }, labels: liveLabels.map(name => ({ name })) } };
            }
            if (endpoint === 'GET /repos/{owner}/{repo}/issues/{issue_number}') {
                return { data: { labels: liveLabels.map(name => ({ name })) } };
            }
            if (endpoint === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}') {
                const index = liveLabels.findIndex(name => name.toLowerCase() === String(options.name).toLowerCase());
                if (index >= 0) liveLabels.splice(index, 1);
                return { data: {} };
            }
            if (endpoint === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
                for (const name of options.labels as string[]) if (!liveLabels.includes(name)) liveLabels.push(name);
                return { data: {} };
            }
            return { data: {} };
        });
        const config = createTestConfig();
        const older = createPRCommentEvent('/use opus\nOlder command');
        older.comment.id = 100;
        older.comment.created_at = '2026-08-14T10:00:00Z';
        older.comment.updated_at = older.comment.created_at;
        const newer = createPRCommentEvent('/use haiku\nNewer command');
        newer.comment.id = 101;
        newer.comment.created_at = '2026-08-14T10:01:00Z';
        newer.comment.updated_at = newer.comment.created_at;

        const olderProcessing = processCommentEvent(older, 'issue_comment', 'corr-concurrent-older', config);
        await olderPullRead;
        await processCommentEvent(newer, 'issue_comment', 'corr-concurrent-newer', config);
        const claimedRevision = JSON.parse(
            config.redisClient._store.get('pr-model-command-revision:testowner:testrepo:42') ?? 'null',
        ) as { id: number } | null;
        assert.strictEqual(claimedRevision?.id, newer.comment.id);
        releaseOlderPullRead();
        await olderProcessing;
        const finalClaimedRevision = JSON.parse(
            config.redisClient._store.get('pr-model-command-revision:testowner:testrepo:42') ?? 'null',
        ) as { id: number; createdAt?: string } | null;
        assert.strictEqual(finalClaimedRevision?.id, newer.comment.id, JSON.stringify(finalClaimedRevision));

        assert.deepStrictEqual(liveLabels, ['AI', 'llm-claude-haiku']);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const queued = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(queued.commandCommentId, newer.comment.id);
        assert.strictEqual(queued.modelName, 'claude-haiku-4-5-20251001');
    });

    test('queue publication stays inside the model transition lease so a newer /use becomes the only executable routing', async () => {
        mockSafeUpdateLabels.mock.mockImplementation(actualLabelOperations.safeUpdateLabels);
        const liveLabels = ['AI', 'llm-claude-sonnet5'];
        mockOctokit.request.mock.mockImplementation(async (endpoint: string, options: Record<string, unknown>) => {
            if (endpoint === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                return { data: { head: { ref: 'feature-branch' }, labels: liveLabels.map(name => ({ name })) } };
            }
            if (endpoint === 'GET /repos/{owner}/{repo}/issues/{issue_number}') {
                return { data: { labels: liveLabels.map(name => ({ name })) } };
            }
            if (endpoint === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}') {
                const index = liveLabels.findIndex(name => name.toLowerCase() === String(options.name).toLowerCase());
                if (index >= 0) liveLabels.splice(index, 1);
                return { data: {} };
            }
            if (endpoint === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
                for (const name of options.labels as string[]) if (!liveLabels.includes(name)) liveLabels.push(name);
                return { data: {} };
            }
            return { data: {} };
        });

        const config = createTestConfig();
        let observeLeaseWait!: () => void;
        const leaseWaitObserved = new Promise<void>(resolve => { observeLeaseWait = resolve; });
        let leaseWaitSignalled = false;
        config.redisClient.set.mock.mockImplementation(async (key: string, value: string, ...args: string[]) => {
            if (args.includes('NX') && config.redisClient._store.has(key)) {
                if (key.startsWith('ultrafix:label-transition:') && !leaseWaitSignalled) {
                    leaseWaitSignalled = true;
                    observeLeaseWait();
                }
                return null;
            }
            config.redisClient._store.set(key, value);
            return 'OK';
        });

        let releaseOlderQueue!: () => void;
        let observeOlderQueue!: () => void;
        const olderQueueReached = new Promise<void>(resolve => { observeOlderQueue = resolve; });
        const olderQueueGate = new Promise<void>(resolve => { releaseOlderQueue = resolve; });
        const durableJobs: Array<{ id: string; name: string; data: Record<string, unknown>; remove: ReturnType<typeof mock.fn> }> = [];
        mockQueueAdd.mock.mockImplementationOnce(async (_name: string, data: Record<string, unknown>, options: { jobId: string }) => {
            observeOlderQueue();
            await olderQueueGate;
            const job = { id: options.jobId, name: 'processPullRequestComment', data, remove: mock.fn(async () => {}) };
            durableJobs.push(job);
            mockWaitingJobs = [...durableJobs];
        });

        const older = createPRCommentEvent('/use opus\nOlder follow-up');
        older.comment.id = 100;
        older.comment.created_at = '2026-08-14T10:00:00Z';
        older.comment.updated_at = older.comment.created_at;
        const newer = createPRCommentEvent('/use haiku\nNewer follow-up');
        newer.comment.id = 101;
        newer.comment.created_at = '2026-08-14T10:01:00Z';
        newer.comment.updated_at = newer.comment.created_at;

        const olderProcessing = processCommentEvent(older, 'issue_comment', 'corr-publication-older', config);
        await olderQueueReached;
        let newerCompleted = false;
        const newerProcessing = processCommentEvent(newer, 'issue_comment', 'corr-publication-newer', config)
            .then(() => { newerCompleted = true; });
        await leaseWaitObserved;
        assert.strictEqual(newerCompleted, false, 'newer delivery must wait while the older queue publication owns the PR lease');

        releaseOlderQueue();
        await Promise.all([olderProcessing, newerProcessing]);

        assert.deepStrictEqual(liveLabels, ['AI', 'llm-claude-haiku']);
        assert.strictEqual(durableJobs.length, 1, 'serialized publication must not create a second explicit job');
        const pending = (config.redisClient._lists.get('pending-pr-comments:testowner:testrepo:42') ?? [])
            .map(raw => JSON.parse(raw));
        assert.deepStrictEqual(pending.map(comment => comment.id), [newer.comment.id]);

        const executableData = { ...durableJobs[0].data };
        const executableComments = [
            ...((durableJobs[0].data.comments as unknown[]) ?? []),
            ...pending,
        ];
        const commentsForExecution = applyPendingCommentCommandContext(
            executableData,
            executableComments,
            mockLoggerInstance as never,
        );
        assert.strictEqual(executableData.agentAlias, 'default');
        assert.strictEqual(executableData.modelName, 'claude-haiku-4-5-20251001');
        assert.strictEqual(executableData.modelLabel, 'llm-claude-haiku');
        assert.deepStrictEqual(commentsForExecution.map(comment => comment.id), [older.comment.id, newer.comment.id]);
        assert.deepStrictEqual(
            (executableData.comments as Array<{ id: number }>).map(comment => comment.id),
            [older.comment.id, newer.comment.id],
            'both comments must remain durable exactly once',
        );
    });

    test('same-timestamp edits that only change /use routing keep distinct original-body revisions', async () => {
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];
        const original = createPRCommentEvent('/use opus\nFix this');
        original.comment.id = 12345;
        original.comment.updated_at = '2026-08-14T10:00:00Z';
        const config = createTestConfig({ processCommentEvent });

        await processCommentEvent(original, 'issue_comment', 'corr-use-original-routing', config);
        const edited = createPRCommentEvent('/use haiku\nFix this');
        edited.comment.id = original.comment.id;
        edited.comment.created_at = original.comment.created_at;
        edited.comment.updated_at = original.comment.updated_at;
        await handleCommentEdited(edited, 'issue_comment', 'corr-use-edited-routing', config);

        const pending = [...config.redisClient._lists.values()].flat().map((raw: string) => JSON.parse(raw));
        assert.strictEqual(pending.length, 2);
        assert.deepStrictEqual(pending.map((comment: { body: string }) => comment.body), ['Fix this', 'Fix this']);
        assert.deepStrictEqual(
            pending.map((comment: { revisionIdentity: string }) => comment.revisionIdentity),
            [
                manualRevisionIdentity(original.comment.updated_at, original.comment.body),
                manualRevisionIdentity(edited.comment.updated_at, edited.comment.body),
            ],
        );
        assert.strictEqual(dedupeUnprocessedComments(pending).length, 2);
        assert.deepStrictEqual(pending.map((comment: { modelName: string }) => comment.modelName), [
            'claude-opus-5',
            'claude-haiku-4-5-20251001',
        ]);
    });

    test('issue-comment transition preserves unrelated labels added and removed between live reads and writes', async () => {
        mockSafeUpdateLabels.mock.mockImplementationOnce(actualLabelOperations.safeUpdateLabels);
        const liveLabels = ['AI', 'security', 'workflow-ready', 'llm-claude-opus48'];
        let issueReads = 0;
        const endpoints: string[] = [];
        mockOctokit.request.mock.mockImplementation(async (endpoint: string, options: Record<string, unknown>) => {
            endpoints.push(endpoint);
            if (endpoint === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                return { data: { head: { ref: 'feature-branch' }, labels: liveLabels.map(name => ({ name })) } };
            }
            if (endpoint === 'GET /repos/{owner}/{repo}/issues/{issue_number}') {
                issueReads += 1;
                const snapshot = [...liveLabels];
                if (issueReads === 1) {
                    liveLabels.push('release-blocker');
                    liveLabels.splice(liveLabels.indexOf('workflow-ready'), 1);
                }
                return { data: { labels: snapshot.map(name => ({ name })) } };
            }
            if (endpoint === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}') {
                const index = liveLabels.findIndex(name => name.toLowerCase() === String(options.name).toLowerCase());
                if (index >= 0) liveLabels.splice(index, 1);
                return { data: {} };
            }
            if (endpoint === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
                for (const name of options.labels as string[]) if (!liveLabels.includes(name)) liveLabels.push(name);
                return { data: {} };
            }
            return { data: {} };
        });

        await processCommentEvent(createPRCommentEvent('/use opus'), 'issue_comment', 'corr-live-label-race', createTestConfig());

        assert.deepStrictEqual(liveLabels, ['AI', 'security', 'release-blocker', 'llm-claude-opus5']);
        assert.ok(!endpoints.some(endpoint => endpoint.startsWith('PUT ')), 'model transition must not replace the complete label set');
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
    });

    test('stale review-comment payload uses live labels and retries a concurrent competing model label', async () => {
        mockSafeUpdateLabels.mock.mockImplementationOnce(actualLabelOperations.safeUpdateLabels);
        const liveLabels = ['AI', 'release-blocker', 'llm-claude-opus48'];
        let issueReads = 0;
        mockOctokit.request.mock.mockImplementation(async (endpoint: string, options: Record<string, unknown>) => {
            if (endpoint === 'GET /repos/{owner}/{repo}/issues/{issue_number}') {
                issueReads += 1;
                if (issueReads === 2) liveLabels.push('llm-claude-haiku');
                return { data: { labels: liveLabels.map(name => ({ name })) } };
            }
            if (endpoint === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}') {
                const index = liveLabels.findIndex(name => name.toLowerCase() === String(options.name).toLowerCase());
                if (index >= 0) liveLabels.splice(index, 1);
                return { data: {} };
            }
            if (endpoint === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
                for (const name of options.labels as string[]) if (!liveLabels.includes(name)) liveLabels.push(name);
                return { data: {} };
            }
            return { data: {} };
        });
        const event = createPRReviewCommentEvent('/use opus');
        event.pull_request.labels = [{ name: 'AI' }, { name: 'llm-claude-sonnet46' }] as typeof event.pull_request.labels;

        await processCommentEvent(event, 'pull_request_review_comment', 'corr-stale-review-labels', createTestConfig());

        assert.deepStrictEqual(liveLabels, ['AI', 'release-blocker', 'llm-claude-opus5']);
        assert.strictEqual(issueReads, 4, 'verification conflict should force a second live read/mutate/verify attempt');
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
    });

    test('/use does not enqueue or acknowledge when live model-label convergence cannot be verified', async () => {
        mockSafeUpdateLabels.mock.mockImplementationOnce(actualLabelOperations.safeUpdateLabels);
        const liveLabels = ['AI', 'release-blocker', 'llm-claude-opus48'];
        let issueReads = 0;
        let acknowledgements = 0;
        mockOctokit.request.mock.mockImplementation(async (endpoint: string, options: Record<string, unknown>) => {
            if (endpoint === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                return { data: { head: { ref: 'feature-branch' }, labels: liveLabels.map(name => ({ name })) } };
            }
            if (endpoint === 'GET /repos/{owner}/{repo}/issues/{issue_number}') {
                issueReads += 1;
                if (issueReads % 2 === 0 && !liveLabels.includes('llm-claude-haiku')) liveLabels.push('llm-claude-haiku');
                return { data: { labels: liveLabels.map(name => ({ name })) } };
            }
            if (endpoint === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}') {
                const index = liveLabels.findIndex(name => name.toLowerCase() === String(options.name).toLowerCase());
                if (index >= 0) liveLabels.splice(index, 1);
                return { data: {} };
            }
            if (endpoint === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
                for (const name of options.labels as string[]) if (!liveLabels.includes(name)) liveLabels.push(name);
                return { data: {} };
            }
            if (endpoint === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') acknowledgements += 1;
            return { data: {} };
        });

        await processCommentEvent(createPRCommentEvent('/use opus'), 'issue_comment', 'corr-nonconvergent-labels', createTestConfig());

        assert.strictEqual(issueReads, 9);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        assert.strictEqual(acknowledgements, 0);
        assert.ok(liveLabels.includes('release-blocker'));
        assert.ok(liveLabels.includes('llm-claude-opus48'));
        assert.ok(!liveLabels.includes('llm-claude-opus5'));
    });

    for (const leaseFailure of ['acquisition', 'ownership'] as const) {
        test(`/use surfaces retryable failure without enqueue or acknowledgement when label-transition lease ${leaseFailure} fails`, async () => {
            mockSafeUpdateLabels.mock.mockImplementationOnce(actualLabelOperations.safeUpdateLabels);
            const liveLabels = ['AI', 'llm-claude-opus48'];
            let acknowledgements = 0;
            mockOctokit.request.mock.mockImplementation(async (endpoint: string, options: Record<string, unknown>) => {
                if (endpoint === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                    return { data: { head: { ref: 'feature-branch' }, labels: liveLabels.map(name => ({ name })) } };
                }
                if (endpoint === 'GET /repos/{owner}/{repo}/issues/{issue_number}') {
                    return { data: { labels: liveLabels.map(name => ({ name })) } };
                }
                if (endpoint === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}') {
                    const index = liveLabels.findIndex(name => name.toLowerCase() === String(options.name).toLowerCase());
                    if (index >= 0) liveLabels.splice(index, 1);
                    return { data: {} };
                }
                if (endpoint === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
                    for (const name of options.labels as string[]) if (!liveLabels.includes(name)) liveLabels.push(name);
                    return { data: {} };
                }
                if (endpoint === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') acknowledgements += 1;
                return { data: {} };
            });
            const config = createTestConfig();
            if (leaseFailure === 'acquisition') {
                config.redisClient.set.mock.mockImplementation(async (key: string, value: string, ...args: string[]) => {
                    if (key.startsWith('ultrafix:label-transition:')) throw new Error('redis unavailable');
                    if (args.includes('NX') && config.redisClient._store.has(key)) return null;
                    config.redisClient._store.set(key, value);
                    return 'OK';
                });
            } else {
                config.redisClient.eval.mock.mockImplementation(async () => 0);
            }

            const event = createPRCommentEvent('/use opus');
            await assert.rejects(
                processCommentEvent(event, 'issue_comment', `corr-lease-${leaseFailure}`, config),
                { name: 'LabelTransitionLeaseError' },
            );

            assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
            assert.strictEqual(acknowledgements, 0);
            assert.strictEqual(
                config.redisClient._store.has(`pr-comment-processed:testowner:testrepo:42:${event.comment.id}`),
                false,
                'failed delivery must release its exact slash-command claim',
            );
        });
    }

    test('identical /use redelivery retries after transient lease acquisition failure and enqueues exactly once', async () => {
        const event = createPRCommentEvent('/use opus\nRetry this command');
        const config = createTestConfig();
        let leaseAcquisitions = 0;
        let acknowledgements = 0;
        config.redisClient.set.mock.mockImplementation(async (key: string, value: string, ...args: string[]) => {
            if (key.startsWith('ultrafix:label-transition:')) {
                leaseAcquisitions += 1;
                if (leaseAcquisitions === 1) throw new Error('transient redis failure');
            }
            if (args.includes('NX') && config.redisClient._store.has(key)) return null;
            config.redisClient._store.set(key, value);
            return 'OK';
        });
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                return { data: { head: { ref: 'feature-branch' }, labels: [] } };
            }
            if (endpoint === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') acknowledgements += 1;
            return { data: {} };
        });

        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-transient-lease-first', config),
            { name: 'LabelTransitionLeaseError' },
        );
        const redelivery = await processCommentEvent(event, 'issue_comment', 'corr-transient-lease-redelivery', config);

        assert.deepStrictEqual(redelivery, {
            status: 'accepted',
            billing: { seatConsumed: true },
            evidence: { triggerCommentIds: [event.comment.id] },
        });
        assert.strictEqual(mockSafeUpdateLabels.mock.callCount(), 1);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(acknowledgements, 1);
        assert.strictEqual(
            mockQueueAdd.mock.calls[0].arguments[2].jobId,
            `pr-comments-batch-testowner-testrepo-42-${event.comment.id}-${manualRevisionSlug(event.comment.updated_at, event.comment.body)}`,
        );
    });

    test('ownership loss after durable /use publication retries without duplicating its revision, job, or acknowledgement', async () => {
        mockSafeUpdateLabels.mock.mockImplementation(actualLabelOperations.safeUpdateLabels);
        const event = createPRCommentEvent('/use opus\nRetry published work');
        const config = createTestConfig();
        const liveLabels = ['AI', 'llm-claude-opus48'];
        let acknowledgements = 0;
        let jobPublished = false;
        let ownershipFailureInjected = false;

        mockOctokit.request.mock.mockImplementation(async (endpoint: string, options: Record<string, unknown>) => {
            if (endpoint === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                return { data: { head: { ref: 'feature-branch' }, labels: liveLabels.map(name => ({ name })) } };
            }
            if (endpoint === 'GET /repos/{owner}/{repo}/issues/{issue_number}') {
                return { data: { labels: liveLabels.map(name => ({ name })) } };
            }
            if (endpoint === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}') {
                const index = liveLabels.findIndex(name => name.toLowerCase() === String(options.name).toLowerCase());
                if (index >= 0) liveLabels.splice(index, 1);
                return { data: {} };
            }
            if (endpoint === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
                for (const name of options.labels as string[]) if (!liveLabels.includes(name)) liveLabels.push(name);
                return { data: {} };
            }
            if (endpoint === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') acknowledgements += 1;
            return { data: {} };
        });
        mockQueueAdd.mock.mockImplementationOnce(async (name: string, data: Record<string, unknown>, options: { jobId: string }) => {
            jobPublished = true;
            mockWaitingJobs = [{ id: options.jobId, name, data, remove: mock.fn(async () => {}) }];
        });
        config.redisClient.eval.mock.mockImplementation(async (script: string, _keyCount: number, key: string, ...args: string[]) => {
            if (script.includes("redis.call('PEXPIRE'") && jobPublished && !ownershipFailureInjected) {
                ownershipFailureInjected = true;
                config.redisClient._store.delete(key);
                return 0;
            }
            const token = args[0];
            if (config.redisClient._store.get(key) !== token) return 0;
            if (script.includes("redis.call('PEXPIRE'")) return 1;
            config.redisClient._store.delete(key);
            return 1;
        });

        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-published-lease-first', config),
            { name: 'LabelTransitionLeaseError' },
        );
        assert.deepStrictEqual(liveLabels, ['AI', 'llm-claude-opus5']);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(acknowledgements, 0);

        const redelivery = await processCommentEvent(event, 'issue_comment', 'corr-published-lease-redelivery', config);
        const duplicate = await processCommentEvent(event, 'issue_comment', 'corr-published-lease-duplicate', config);

        assert.strictEqual(redelivery.status, 'accepted');
        assert.deepStrictEqual(duplicate, { status: 'ignored', reason: 'duplicate_delivery' });
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1, 'the deterministic published job must be reused');
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 0, 'the published revision must not also be copied to pending storage');
        assert.strictEqual(acknowledgements, 1);
        const publishedData = mockWaitingJobs[0] as { data: { comments: Array<{ id: number; revisionIdentity: string }> } };
        assert.deepStrictEqual(
            publishedData.data.comments.map(comment => ({ id: comment.id, revisionIdentity: comment.revisionIdentity })),
            [{ id: event.comment.id, revisionIdentity: manualRevisionIdentity(event.comment.updated_at, event.comment.body) }],
        );
    });

    test('/use persists canonical label, configured agent, and model on the queued job', async () => {
        const event = createPRCommentEvent('/use llm-claude-opus5\nContinue with the selected model');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-canonical-codex', config);

        assert.deepStrictEqual(mockSafeUpdateLabels.mock.calls[0].arguments[2], ['llm-claude-opus5']);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.agentAlias, 'default');
        assert.strictEqual(jobData.modelName, 'claude-opus-5');
        assert.strictEqual(jobData.modelLabel, 'llm-claude-opus5');
        assert.strictEqual(jobData.llm, 'claude-opus-5');
    });

    test('/use does not queue or acknowledge when the label transition fails', async () => {
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [{ id: 1, name: 'llm-claude-opus48', color: '000', default: false, description: null, node_id: 'L_1', url: '' }],
            },
        }));
        mockSafeUpdateLabels.mock.mockImplementationOnce(async () => ({
            success: false,
            removed: [],
            added: [],
            errors: ['failed'],
        }));

        await processCommentEvent(createPRCommentEvent('/use sonnet'), 'issue_comment', 'corr-label-failure', createTestConfig());

        assert.strictEqual(mockQueueAdd.mock.callCount(), 0);
        assert.strictEqual(mockOctokit.request.mock.callCount(), 1, 'only the PR read should occur; no success acknowledgement');
    });

    test('/use supersedes a delayed provider-limit retry and runs the replacement immediately', async () => {
        const removeRetry = mock.fn(async () => {});
        mockDelayedJobs = [{
            id: 'pr-comments-batch-testowner-testrepo-42-claude-opus48-main-ratelimit-retry',
            name: 'processPullRequestComment',
            data: {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                llm: 'claude-opus-4-8',
                isRetryFromRateLimit: true,
                comments: [{ id: 7, createdAt: '2026-08-14T10:00:00Z', body: 'Original request', author: 'alice', type: 'issue' }],
            },
            remove: removeRetry,
        }];
        const config = createTestConfig();

        const event = createPRCommentEvent('/use opus');
        await processCommentEvent(event, 'issue_comment', 'corr-replace-retry', config);

        assert.strictEqual(removeRetry.mock.callCount(), 1);
        const restored = config.redisClient._lists.get('pending-pr-comments:testowner:testrepo:42')!.map(raw => JSON.parse(raw) as { id: number });
        assert.deepStrictEqual(restored.map(comment => comment.id), [7, event.comment.id], 'old and selected comments should both remain claimable in order');
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.agentAlias, 'default');
        assert.strictEqual(jobData.modelName, 'claude-opus-5');
        assert.strictEqual(mockQueueAdd.mock.calls[0].arguments[2].delay, 3000);
    });

    test('/use queue snapshot cannot race ahead of an old-provider retry publication', async () => {
        const config = createTestConfig();
        let retryReadStarted!: () => void;
        let usePrReadStarted!: () => void;
        let releaseRetryRead!: () => void;
        const retryRead = new Promise<void>(resolve => { retryReadStarted = resolve; });
        const usePrRead = new Promise<void>(resolve => { usePrReadStarted = resolve; });
        const retryReadGate = new Promise<void>(resolve => { releaseRetryRead = resolve; });
        let pullReads = 0;
        mockOctokit.request.mock.mockImplementation(async (endpoint: string) => {
            if (endpoint === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
                pullReads += 1;
                if (pullReads === 1) {
                    retryReadStarted();
                    await retryReadGate;
                } else {
                    usePrReadStarted();
                }
                return {
                    data: {
                        head: { ref: 'feature-branch' },
                        labels: [{ name: 'llm-claude-opus48' }],
                    },
                };
            }
            return { data: {} };
        });

        const removeRetry = mock.fn(async () => { mockDelayedJobs = []; });
        mockQueueAdd.mock.mockImplementationOnce(async (name: string, data: Record<string, unknown>, queueOptions: Record<string, unknown>) => {
            mockDelayedJobs = [{
                id: queueOptions.jobId,
                name,
                data,
                remove: removeRetry,
            }];
        });

        const usageLimitHandling = handleJobError(
            new UsageLimitError('usage limit', Math.floor(Date.now() / 1000) + 3600),
            {
                name: 'processPullRequestComment',
                data: {
                    pullRequestNumber: 42,
                    repoOwner: 'testowner',
                    repoName: 'testrepo',
                    branchName: 'feature-branch',
                    comments: [{ id: 7, body: 'Original request', author: 'alice', type: 'issue' }],
                    llm: 'claude-opus-4-8',
                },
            } as never,
            {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                authorsText: '@alice',
                unprocessedComments: [],
                octokit: mockOctokit as never,
                startingWorkComment: null,
                claudeResult: null,
                correlationId: 'corr-retry-use-race',
                correlatedLogger: mockLoggerInstance as never,
                stateManager: { getTaskState: async () => null } as never,
                taskId: 'retry-use-race',
                redisClient: config.redisClient as never,
                runtimeAgentAlias: 'default',
                runtimeModelName: 'claude-opus-4-8',
            },
        );
        await retryRead;

        const event = createPRCommentEvent('/use opus');
        const useHandling = processCommentEvent(event, 'issue_comment', 'corr-use-retry-race', config);
        await usePrRead;
        releaseRetryRead();

        await Promise.all([usageLimitHandling, useHandling]);

        assert.strictEqual(removeRetry.mock.callCount(), 1, 'the retry published first must be visible to the /use snapshot');
        assert.strictEqual(mockDelayedJobs.length, 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 2);
        assert.ok(String(mockQueueAdd.mock.calls[0].arguments[2].jobId).endsWith('-ratelimit-retry'));
        const replacementData = mockQueueAdd.mock.calls[1].arguments[1] as Record<string, unknown>;
        assert.strictEqual(replacementData.modelName, 'claude-opus-5');
    });

    test('/use removal failure leaves old and selected comments recoverable without enqueueing a second writer', async () => {
        const removalError = new Error('retry became active');
        const removeRetry = mock.fn(async () => { throw removalError; });
        mockDelayedJobs = [{
            id: 'pr-comments-batch-testowner-testrepo-42-old-main-ratelimit-retry',
            name: 'processPullRequestComment',
            data: {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                isRetryFromRateLimit: true,
                comments: [{ id: 7, updatedAt: '2026-08-14T10:01:00Z', body: 'Original request', author: 'alice', type: 'issue' }],
            },
            remove: removeRetry,
        }];
        const config = createTestConfig();

        const event = createPRCommentEvent('/use opus');
        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-remove-race', config),
            removalError,
        );

        const pending = config.redisClient._lists.get('pending-pr-comments:testowner:testrepo:42')!.map(raw => JSON.parse(raw) as { id: number });
        assert.deepStrictEqual(pending.map(comment => comment.id), [7, event.comment.id]);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 0, 'failed removal must not create an overlapping replacement writer');
    });

    test('/use enqueue failure after retry removal leaves all comments recoverable', async () => {
        const enqueueError = new Error('queue unavailable');
        mockQueueAdd.mock.mockImplementationOnce(async () => { throw enqueueError; });
        mockDelayedJobs = [{
            id: 'pr-comments-batch-testowner-testrepo-42-old-main-ratelimit-retry',
            name: 'processPullRequestComment',
            data: {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                isRetryFromRateLimit: true,
                comments: [{ id: 7, body: 'Original request', author: 'alice', type: 'issue' }],
            },
            remove: mock.fn(async () => {}),
        }];
        const config = createTestConfig();

        const event = createPRCommentEvent('/use opus');
        await assert.rejects(
            processCommentEvent(event, 'issue_comment', 'corr-enqueue-race', config),
            enqueueError,
        );

        const pending = config.redisClient._lists.get('pending-pr-comments:testowner:testrepo:42')!.map(raw => JSON.parse(raw) as { id: number });
        assert.deepStrictEqual(pending.map(comment => comment.id), [7, event.comment.id]);
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
        assert.strictEqual(jobData.llm, 'claude-opus-5');
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
        const comments = jobData.comments as Array<{ body: string; revisionIdentity?: string }>;
        // /use body is stripped like /switch — only user instructions remain
        assert.ok(comments.length > 0);
        assert.strictEqual(comments[0].body, 'Refactor the utils');
        const expectedRevision = manualRevisionIdentity(event.comment.updated_at, event.comment.body);
        assert.strictEqual(comments[0].revisionIdentity, expectedRevision);
        assert.strictEqual(jobData.commandCommentRevisionIdentity, expectedRevision);
    });

    test('/use with llm- prefixed argument strips prefix before resolving', async () => {
        const event = createPRCommentEvent('/use llm-opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-llm-prefix', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        // "llm-opus" is normalized before resolving the current alias.
        assert.strictEqual(jobData.llm, 'claude-opus-5');
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
        assert.strictEqual(jobData.llm, 'claude-opus-5');
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
        assert.deepStrictEqual(meta.models, ['claude-sonnet-5']);
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
        assert.deepStrictEqual(meta.models, ['claude-haiku-4-5-20251001']);
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

    test('/use job preserves its explicit model as requestedModels', async () => {
        const event = createPRCommentEvent('/use sonnet\nDo something');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-no-req', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.deepStrictEqual(jobData.requestedModels, ['claude-sonnet-5']);
        assert.strictEqual(jobData.commandCommentCreatedAt, event.comment.created_at);
        assert.strictEqual(jobData.commandCommentType, 'issue');
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

describe('commentEventHandler — routing provenance', () => {
    beforeEach(() => {
        mockQueueAdd.mock.resetCalls();
        mockOctokit.request.mock.resetCalls();
        mockActiveJobs = [];
        mockWaitingJobs = [];
        mockDelayedJobs = [];
    });

    test('ordinary jobs omit explicit provenance and follow the live PR label at execution', async () => {
        mockOctokit.request.mock.mockImplementation(async () => ({
            data: {
                head: { ref: 'feature-branch' },
                labels: [{ name: 'AI' }, { name: 'llm-codex-gpt55' }],
            },
        }));

        await processCommentEvent(
            createPRCommentEvent('Please apply the follow-up'),
            'issue_comment',
            'corr-ordinary-live-routing',
            createTestConfig(),
        );

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        const jobData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(jobData.llm, 'codex-gpt55', 'enqueue may retain label A as its ordinary fallback');
        assert.ok(!Object.hasOwn(jobData, 'agentAlias'));
        assert.ok(!Object.hasOwn(jobData, 'modelName'));
        assert.ok(!Object.hasOwn(jobData, 'modelLabel'));

        const workerLlm = extractModelFromLabels(
            [{ name: 'AI' }, { name: 'llm-codex-gpt56-sol' }],
            jobData.llm as string,
            42,
            mockLoggerInstance as never,
        );
        assert.strictEqual(workerLlm, 'codex-gpt56-sol', 'worker validation must prefer live label B over fallback A');
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

    test('/use stores its revision and queues a deterministic successor when the active writer finishes at the handoff', async () => {
        // Simulate an active job for PR 42
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];

        const event = createPRCommentEvent('/use opus\nFix the bug');
        const config = createTestConfig();
        const handoffSteps: string[] = [];
        mockInvalidateAutomaticWork.mock.mockImplementationOnce(async () => {
            handoffSteps.push('invalidate');
            return { workEpoch: 2, hadAutomaticWork: true };
        });
        config.redisClient.rpush.mock.mockImplementationOnce(async (key: string, ...values: string[]) => {
            handoffSteps.push('store');
            config.redisClient._lists.set(key, [...(config.redisClient._lists.get(key) ?? []), ...values]);
            // The worker crosses its cleanup boundary after the queue snapshot
            // but before the pending write completes.
            mockActiveJobs = [];
        });
        mockQueueAdd.mock.mockImplementationOnce(async () => { handoffSteps.push('enqueue'); });

        await processCommentEvent(event, 'issue_comment', 'corr-batch-1', config);

        assert.deepStrictEqual(handoffSteps, ['invalidate', 'store', 'enqueue']);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 1);
        const pendingComment = JSON.parse(config.redisClient.rpush.mock.calls[0].arguments[1] as string) as Record<string, unknown>;
        assert.strictEqual(pendingComment.body, 'Fix the bug');
        assert.strictEqual(pendingComment.commandMode, 'use');
        assert.strictEqual(pendingComment.commandInstructions, 'Fix the bug');
        assert.strictEqual(pendingComment.llmOverride, 'claude-opus-5');
        assert.strictEqual(pendingComment.agentAlias, 'default');
        assert.strictEqual(pendingComment.modelName, 'claude-opus-5');
        assert.strictEqual(pendingComment.modelLabel, 'llm-claude-opus5');
        const successorData = mockQueueAdd.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.deepStrictEqual(successorData.comments, [], 'successor must claim the durable pending revision');
        assert.strictEqual(
            mockQueueAdd.mock.calls[0].arguments[2].jobId,
            `pr-comments-batch-testowner-testrepo-42-${event.comment.id}-${manualRevisionSlug(event.comment.updated_at, event.comment.body)}`,
        );
        assert.deepStrictEqual(
            mockInvalidateAutomaticWork.mock.calls[0].arguments[1],
            { owner: 'testowner', repo: 'testrepo', pr: 42, sourceCommentId: event.comment.id, sourceCommentRevision: manualRevisionIdentity(event.comment.updated_at, event.comment.body) },
        );
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

    test('/use enqueues normally when no existing job is active', async () => {
        // No active jobs (default)
        const event = createPRCommentEvent('/use opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-batch-3', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 0);
        assert.strictEqual(mockInvalidateAutomaticWork.mock.callCount(), 1);
        assert.deepStrictEqual(
            mockInvalidateAutomaticWork.mock.calls[0].arguments[1],
            { owner: 'testowner', repo: 'testrepo', pr: 42, sourceCommentId: event.comment.id, sourceCommentRevision: manualRevisionIdentity(event.comment.updated_at, event.comment.body) },
        );
    });

    test('/use enqueues an independent revision job after fencing queued automatic work', async () => {
        mockWaitingJobs = [{
            name: 'processPullRequestComment',
            data: {
                pullRequestNumber: 42,
                repoOwner: 'testowner',
                repoName: 'testrepo',
                ultrafixMeta: { mode: 'ultrafix', instructions: '', workEpoch: 0 },
            },
        }];
        mockInvalidateAutomaticWork.mock.mockImplementationOnce(async () => ({ workEpoch: 1, hadAutomaticWork: true }));
        const event = createPRCommentEvent('/use opus');
        const config = createTestConfig();

        await processCommentEvent(event, 'issue_comment', 'corr-use-automatic-takeover', config);

        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 0);
        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.strictEqual(
            mockQueueAdd.mock.calls[0].arguments[2].jobId,
            `pr-comments-batch-testowner-testrepo-42-${event.comment.id}-${manualRevisionSlug(event.comment.updated_at, event.comment.body)}`,
        );
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

    test('batched slash commands on review comments preserve code-review context', async () => {
        mockActiveJobs = [{
            name: 'processPullRequestComment',
            data: { pullRequestNumber: 42, repoOwner: 'testowner', repoName: 'testrepo' },
        }];

        const event = createPRReviewCommentEvent('/use opus\nPlease fix this line');
        const config = createTestConfig();

        await processCommentEvent(event, 'pull_request_review_comment', 'corr-batch-review', config);

        assert.strictEqual(mockQueueAdd.mock.callCount(), 1);
        assert.deepStrictEqual(mockQueueAdd.mock.calls[0].arguments[1].comments, []);
        assert.strictEqual(config.redisClient.rpush.mock.callCount(), 1);
        const pendingComment = JSON.parse(config.redisClient.rpush.mock.calls[0].arguments[1] as string) as Record<string, unknown>;
        assert.strictEqual(pendingComment.type, 'review');
        assert.strictEqual(pendingComment.createdAt, event.comment.created_at);
        assert.strictEqual(pendingComment.hasCodeContext, true);
        assert.match(pendingComment.body as string, /Please fix this line/);
        assert.match(pendingComment.body as string, /--- Review Comment Context ---/);
        assert.match(pendingComment.body as string, /File: src\/auth\.ts/);
        assert.match(pendingComment.body as string, /Line: 27/);
        assert.match(pendingComment.body as string, /@@ -1,5 \+1,10 @@/);
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
                agentAlias: 'claude-prod',
                modelName: 'claude-opus-4-6',
                modelLabel: 'production-opus',
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
            assert.strictEqual(jobData.agentAlias, 'claude-prod', `permutation ${permutation.join(',')}`);
            assert.strictEqual(jobData.modelName, 'claude-opus-4-6', `permutation ${permutation.join(',')}`);
            assert.strictEqual(jobData.modelLabel, 'production-opus', `permutation ${permutation.join(',')}`);
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

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, mock, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWebhookIssueCommentCreatedEvent } from './testHelpers.js';

const root = await mkdtemp(path.join(tmpdir(), 'followup-gate-'));
process.env.DATA_DIR = root;
process.env.DB_FILENAME = path.join(root, 'core.sqlite');
process.env.NODE_ENV = 'test';

// ========== Fake GitHub ==========

type GitHubUser = { id: number; login: string };
const ALICE: GitHubUser = { id: 101, login: 'alice' };
const BOB: GitHubUser = { id: 202, login: 'bob' };
const BOT_LOGIN = 'propr-dev[bot]';

const github = {
    assignees: new Map<number, GitHubUser[]>(),
    failRead: false,
    failPost: false,
    posted: [] as Array<{ issue_number: number; body: string }>,
};

const mockRequest = mock.fn(async (route: string, parameters: Record<string, unknown> = {}) => {
    if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') {
        if (github.failRead) throw Object.assign(new Error('GitHub is down'), { status: 403 });
        const number = Number(parameters.issue_number);
        return { data: { number, assignees: (github.assignees.get(number) ?? []).map(user => ({ ...user, avatar_url: null })) } };
    }
    if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') {
        if (github.failPost) throw Object.assign(new Error('Forbidden'), { status: 403 });
        github.posted.push({ issue_number: Number(parameters.issue_number), body: String(parameters.body) });
        return { data: { id: 1 } };
    }
    if (route.includes('/comments')) return { data: [] };
    return { data: { head: { ref: 'feature-branch' }, labels: [{ name: 'AI' }] } };
});
const mockOctokit = {
    request: mockRequest,
    paginate: mock.fn(async () => []),
};

function assigneeReads(): number {
    return mockRequest.mock.calls.filter(call => call.arguments[0] === 'GET /repos/{owner}/{repo}/issues/{issue_number}').length;
}

// ========== Module mocks ==========

let gateEnabled = false;
const mockLoadFollowupRequiresAssignment = mock.fn(async () => gateEnabled);

await mock.module('simple-git', { namedExports: { simpleGit: mock.fn(() => ({})), SimpleGit: class {} } });
await mock.module('ioredis', {
    namedExports: {
        Redis: function Redis() {
            return { on: mock.fn(), connect: mock.fn(async () => {}), quit: mock.fn(async () => {}) };
        },
    },
});

const mockQueueAdd = mock.fn(async () => {});
await mock.module('bullmq', {
    namedExports: {
        ErrorCode: { JobNotExist: -1, JobNotInState: -3 },
        Queue: function Queue() {
            return {
                add: mockQueueAdd,
                close: mock.fn(),
                on: mock.fn(),
                getActive: mock.fn(async () => []),
                getWaiting: mock.fn(async () => []),
                getDelayed: mock.fn(async () => []),
            };
        },
        QueueEvents: function QueueEvents() {
            return { waitUntilReady: mock.fn(async () => {}), close: mock.fn(async () => {}) };
        },
        Worker: function Worker() {
            return { on: mock.fn(), close: mock.fn() };
        },
    },
});

await mock.module('../packages/core/src/auth/githubAuth.js', {
    namedExports: {
        getAuthenticatedOctokit: mock.fn(async () => mockOctokit),
        getGitHubInstallationToken: mock.fn(async () => 'mock-token'),
        validateGithubIntakePrerequisites: mock.fn(() => {}),
    },
});

const mockLoggerInstance = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };
const mockLogger = { ...mockLoggerInstance, withCorrelation: mock.fn(() => mockLoggerInstance) };
await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: mockLogger,
    namedExports: {
        generateCorrelationId: mock.fn(() => 'test-correlation-id'),
        createCorrelatedLogger: mock.fn(() => mockLoggerInstance),
    },
});

await mock.module('../packages/core/src/config/configManagerAssignment.js', {
    namedExports: {
        FOLLOWUP_REQUIRES_ASSIGNMENT_CONFIG_KEY: 'followup_requires_assignment',
        loadFollowupRequiresAssignment: mockLoadFollowupRequiresAssignment,
        saveFollowupRequiresAssignment: mock.fn(async () => true),
    },
});

const actualConfigManager = await import('../packages/core/src/config/configManager.js');
await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: {
        ...actualConfigManager,
        loadFollowupRequiresAssignment: mockLoadFollowupRequiresAssignment,
        loadFollowupIgnoreKeywords: mock.fn(async () => []),
        hasValidTriggerLabel: mock.fn(async (labels: Array<{ name: string } | string>) => (labels ?? []).some(l => (typeof l === 'string' ? l : l.name) === 'AI')),
    },
});

const actualCommentFilters = await import('../packages/core/src/utils/commentFilters.js');
const BOT_LOGINS = new Set([BOT_LOGIN]);
// Set to exercise the real author filter (whitelist, bot exclusions).
let useRealAuthorFilter = false;
const mockFilterCommentByAuthor = mock.fn((author: string, ...rest: Array<string | null>) => (useRealAuthorFilter
    ? actualCommentFilters.filterCommentByAuthor(author, ...rest)
    : { shouldFilter: BOT_LOGINS.has(author) }));
const mockCheckCommentTrigger = mock.fn(() => ({ isTriggered: true }));
await mock.module('../packages/core/src/utils/commentFilters.js', {
    namedExports: {
        filterCommentByAuthor: mockFilterCommentByAuthor,
        checkCommentTrigger: mockCheckCommentTrigger,
        checkCommentIgnore: mock.fn(() => ({ shouldIgnore: false })),
    },
});

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

const mockAgentRegistry = { ensureInitialized: mock.fn(async () => {}), getAllAgents: mock.fn(() => []) };
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
const mockHandleMergeCommand = mock.fn(async () => {});
await mock.module('../packages/core/src/webhook/mergeConflictDetector.js', {
    namedExports: {
        handleMergeCommand: mockHandleMergeCommand,
        handlePullRequestConflictDetection: mock.fn(async () => {}),
        handlePushConflictDetection: mock.fn(async () => {}),
    },
});

// ========== Modules under test ==========

const { db, runMigrations, closeConnection } = await import('../packages/core/src/db/connection.js');
const { shutdownQueue, getIssueQueue } = await import('../packages/core/src/queue/taskQueue.js');
const gate = await import('../packages/core/src/webhook/followupAssignmentGate.js');
const { loadTaskAssignees } = await import('../packages/core/src/services/taskAssignmentService.js');
const { processCommentEvent, setUltrafixDeps } = await import('../packages/core/src/webhook/commentEventHandler.js');
// Enough of the ultrafix wiring for an accepted manual /fix or /review to dispatch.
setUltrafixDeps({
    loadUltrafixRatingGoal: async () => 7,
    loadUltrafixMaxCycles: async () => 5,
    loadUltrafixPauseSeconds: async () => 60,
    loadPrReviewModel: async () => '',
    startLoop: async () => ({ state: {}, initialAction: 'review' as const }),
    clearStateIfCurrent: async () => true,
    hasAutomaticWork: async () => false,
    reserveAutomaticWork: async () => 1,
    invalidateAutomaticWork: async () => ({ workEpoch: 1, hadAutomaticWork: false }),
    getPendingReviewState: async () => ({ hasPendingReview: false }),
});
const { buildCiFailureFollowupMarker } = await import('../packages/core/src/webhook/ciFailureFollowup.js');

// The polling module sees @propr/core through this mock, wired to the same
// gate source so both intake paths are exercised against one fake GitHub.
await mock.module('../src/jobs/ultrafixResumeClaim.js', { namedExports: { hasUltrafixResumeCandidate: async () => false } });
await mock.module('@propr/core', {
    namedExports: {
        logger: mockLogger,
        generateCorrelationId: () => 'poll-correlation-id',
        handleError: (error: unknown) => { throw error; },
        getIssueQueue,
        COMMENT_BATCH_DELAY_MS: 0,
        filterCommentByAuthor: mockFilterCommentByAuthor,
        checkCommentTrigger: mockCheckCommentTrigger,
        extractLlmFromLabels: () => null,
        resolveModelAlias: (model: string) => model,
        hasValidTriggerLabel: async () => true,
        getCheckRunsStatusForRepo: async () => ({ allPassing: false }),
        getCurrentPRHead: async () => null,
        triggerUltrafixCheckRunHook: async () => undefined,
        createFollowupGateEvaluator: gate.createFollowupGateEvaluator,
        getSystemBotUsernames: gate.getSystemBotUsernames,
        isSystemFollowupComment: gate.isSystemFollowupComment,
        refuseGatedComment: gate.refuseGatedComment,
        rememberRefusedComment: gate.rememberRefusedComment,
        wasRefused: gate.wasRefused,
    },
});
const { pollForPullRequestComments } = await import('../src/polling/prCommentPolling.js');

before(async () => {
    await runMigrations();
});

after(async () => {
    await shutdownQueue();
    await closeConnection();
    await rm(root, { recursive: true, force: true });
});

// ========== Helpers ==========

function createMockRedis() {
    const store = new Map<string, string>();
    return {
        get: mock.fn(async (key: string) => store.get(key) ?? null),
        setex: mock.fn(async (key: string, _ttl: number, value: string) => { store.set(key, value); }),
        set: mock.fn(async (key: string, value: string, ...args: unknown[]) => {
            if (args.includes('NX') && store.has(key)) return null;
            store.set(key, value);
            return 'OK';
        }),
        del: mock.fn(async (key: string) => { store.delete(key); return 1; }),
        rpush: mock.fn(async () => {}),
        expire: mock.fn(async () => {}),
        pipeline: () => {
            const ops: Array<() => void> = [];
            const pipe = {
                setex: (key: string, _ttl: number, value: string) => { ops.push(() => store.set(key, value)); return pipe; },
                exec: async () => { ops.forEach(op => op()); return []; },
            };
            return pipe;
        },
        _store: store,
    };
}

type MockRedis = ReturnType<typeof createMockRedis>;

function createConfig(redisClient: MockRedis = createMockRedis()) {
    return { redisClient, PR_FOLLOWUP_TRIGGER_KEYWORDS: [], MODEL_LABEL_PATTERN: '^llm-(.+)$' } as never;
}

const PR = 42;
const OWNER = 'testowner';
const REPO = 'testrepo';
let nextCommentId = 1000;

function prCommentEvent(body: string, author: GitHubUser | { id: number; login: string; type: 'Bot' }) {
    const event = createWebhookIssueCommentCreatedEvent({
        comment: { id: nextCommentId++, body, user: author },
        issue: { number: PR, labels: [{ name: 'AI' }] },
    });
    (event.issue as Record<string, unknown>).pull_request = { url: `https://api.github.com/repos/${OWNER}/${REPO}/pulls/${PR}` };
    return event;
}

function trackingKey(commentId: number): string {
    return `pr-comment-processed:${OWNER}:${REPO}:${PR}:${commentId}`;
}

function refusedKey(commentId: number): string {
    return `pr-comment-refused:${OWNER}:${REPO}:${PR}:${commentId}`;
}

const pullRequest = { repoOwner: OWNER, repoName: REPO, pullRequestNumber: PR };

beforeEach(() => {
    gateEnabled = false;
    github.assignees.clear();
    github.failRead = false;
    github.failPost = false;
    github.posted = [];
    mockRequest.mock.resetCalls();
    mockQueueAdd.mock.resetCalls();
    mockHandleMergeCommand.mock.resetCalls();
    mockLoggerInstance.info.mock.resetCalls();
    mockLoadFollowupRequiresAssignment.mock.resetCalls();
});

// ========== Gate decision ==========

describe('commentAuthorMayFollowUp', () => {
    test('gate off: allows without any GitHub call', async () => {
        github.assignees.set(PR, [ALICE]);
        const decision = await gate.commentAuthorMayFollowUp({ ...pullRequest, authorId: BOB.id, authorLogin: BOB.login }, { github: mockOctokit });
        assert.deepEqual(decision, { allowed: true, reason: 'gate_disabled' });
        assert.equal(mockRequest.mock.callCount(), 0);
    });

    test('no assignees: allows', async () => {
        gateEnabled = true;
        const decision = await gate.commentAuthorMayFollowUp({ ...pullRequest, authorId: BOB.id, authorLogin: BOB.login }, { github: mockOctokit });
        assert.deepEqual(decision, { allowed: true, reason: 'no_assignees' });
    });

    test('assigned author: allows by id, and by login case-insensitively', async () => {
        gateEnabled = true;
        github.assignees.set(PR, [ALICE]);
        assert.deepEqual(
            await gate.commentAuthorMayFollowUp({ ...pullRequest, authorId: ALICE.id, authorLogin: 'renamed-alice' }, { github: mockOctokit }),
            { allowed: true, reason: 'author_assigned' },
        );
        assert.deepEqual(
            await gate.commentAuthorMayFollowUp({ ...pullRequest, authorLogin: 'ALICE' }, { github: mockOctokit }),
            { allowed: true, reason: 'author_assigned' },
        );
    });

    test('unassigned author: denies', async () => {
        gateEnabled = true;
        github.assignees.set(PR, [ALICE]);
        const decision = await gate.commentAuthorMayFollowUp({ ...pullRequest, authorId: BOB.id, authorLogin: BOB.login }, { github: mockOctokit });
        assert.deepEqual(decision, { allowed: false, reason: 'author_not_assigned' });
    });

    test('system-authored comment: allows without reading assignees', async () => {
        gateEnabled = true;
        github.assignees.set(PR, [ALICE]);
        const decision = await gate.commentAuthorMayFollowUp({ ...pullRequest, authorLogin: BOT_LOGIN, systemAuthored: true }, { github: mockOctokit });
        assert.deepEqual(decision, { allowed: true, reason: 'system_authored' });
        assert.equal(assigneeReads(), 0);
    });

    test('failed live read: fails closed', async () => {
        gateEnabled = true;
        github.failRead = true;
        const decision = await gate.commentAuthorMayFollowUp({ ...pullRequest, authorId: ALICE.id, authorLogin: ALICE.login }, { github: mockOctokit });
        assert.deepEqual(decision, { allowed: false, reason: 'assignment_unavailable' });
    });

    test('evaluator reads live assignees once for several authors', async () => {
        gateEnabled = true;
        github.assignees.set(PR, [ALICE]);
        const evaluator = await gate.createFollowupGateEvaluator(pullRequest, { github: mockOctokit });
        assert.equal((await evaluator.decide({ authorId: ALICE.id, authorLogin: ALICE.login })).allowed, true);
        assert.equal((await evaluator.decide({ authorId: BOB.id, authorLogin: BOB.login })).allowed, false);
        assert.equal((await evaluator.decide({ authorId: BOB.id, authorLogin: BOB.login })).allowed, false);
        assert.equal(assigneeReads(), 1);
    });

    test('refreshes the stored projection of tasks on the pull request', async () => {
        gateEnabled = true;
        await db('tasks').insert({ task_id: 'pr-comment-gate-1', repository: `${OWNER}/${REPO}`, task_type: 'pr-comment', issue_number: PR });
        await db('tasks').insert({ task_id: 'issue-gate-2', repository: `${OWNER}/${REPO}`, task_type: 'issue', issue_number: 7, pr_number: PR });
        await db('tasks').insert({ task_id: 'other-pr-gate-3', repository: `${OWNER}/${REPO}`, task_type: 'pr-comment', issue_number: PR + 1 });
        github.assignees.set(PR, [ALICE]);

        await gate.commentAuthorMayFollowUp({ ...pullRequest, authorId: BOB.id, authorLogin: BOB.login }, { github: mockOctokit });

        const stored = await loadTaskAssignees(['pr-comment-gate-1', 'issue-gate-2', 'other-pr-gate-3']);
        assert.deepEqual(stored.get('pr-comment-gate-1')?.map(user => user.login), ['alice']);
        assert.deepEqual(stored.get('issue-gate-2')?.map(user => user.login), ['alice']);
        assert.equal(stored.has('other-pr-gate-3'), false);
    });
});

// ========== One-time notice ==========

describe('refuseGatedComment', () => {
    const denied = { allowed: false, reason: 'author_not_assigned' } as const;

    test('posts one notice per (pull request, author) and logs every refusal', async () => {
        const redisClient = createMockRedis();
        const options = { redisClient: redisClient as never, github: mockOctokit };
        await gate.refuseGatedComment({ ...pullRequest, authorLogin: 'bob', decision: denied }, options);
        await gate.refuseGatedComment({ ...pullRequest, authorLogin: 'Bob', decision: denied }, options);
        assert.equal(github.posted.length, 1);
        assert.match(github.posted[0].body, /^@bob /);

        await gate.refuseGatedComment({ ...pullRequest, authorLogin: 'carol', decision: denied }, options);
        await gate.refuseGatedComment({ ...pullRequest, pullRequestNumber: PR + 1, authorLogin: 'bob', decision: denied }, options);
        assert.equal(github.posted.length, 3);

        const refusals = mockLogger.info.mock.calls.filter(call => call.arguments[1] === 'Follow-up comment refused by the assignment gate');
        assert.equal(refusals.length, 4);
        assert.deepEqual(
            { ...(refusals[0].arguments[0] as Record<string, unknown>) },
            { repository: `${OWNER}/${REPO}`, pullRequestNumber: PR, commentId: undefined, author: 'bob', reason: 'author_not_assigned' },
        );
        const ttlArgs = redisClient.set.mock.calls[0].arguments.slice(2);
        assert.deepEqual(ttlArgs, ['EX', gate.FOLLOWUP_ASSIGNMENT_NOTICE_TTL_SECONDS, 'NX']);
    });

    test('a failed read posts no notice', async () => {
        const redisClient = createMockRedis();
        await gate.refuseGatedComment({ ...pullRequest, authorLogin: 'bob', decision: { allowed: false, reason: 'assignment_unavailable' } }, { redisClient: redisClient as never, github: mockOctokit });
        assert.equal(github.posted.length, 0);
        assert.equal(redisClient._store.size, 0);
    });

    test('posts no notice to one of ProPR\'s own logins, whatever its case', async () => {
        const redisClient = createMockRedis();
        const options = { redisClient: redisClient as never, github: mockOctokit };
        await gate.refuseGatedComment({ ...pullRequest, authorLogin: BOT_LOGIN, decision: denied }, options);
        await gate.refuseGatedComment({ ...pullRequest, authorLogin: BOT_LOGIN.toUpperCase(), decision: denied }, options);
        assert.equal(github.posted.length, 0);
        assert.equal(redisClient._store.size, 0);
        // Still logged as a refusal.
        const refusals = mockLogger.info.mock.calls.filter(call => call.arguments[1] === 'Follow-up comment refused by the assignment gate');
        assert.ok(refusals.some(call => (call.arguments[0] as { author?: string }).author === BOT_LOGIN));
    });

    test('a failed post releases the claim so the next refusal explains', async () => {
        const redisClient = createMockRedis();
        const options = { redisClient: redisClient as never, github: mockOctokit };
        github.failPost = true;
        await gate.refuseGatedComment({ ...pullRequest, authorLogin: 'bob', decision: denied }, options);
        github.failPost = false;
        await gate.refuseGatedComment({ ...pullRequest, authorLogin: 'bob', decision: denied }, options);
        assert.equal(github.posted.length, 1);
    });
});

// ========== Webhook intake ==========

describe('processCommentEvent with the assignment gate', () => {
    test('gate off: processes the comment and adds no assignee read', async () => {
        github.assignees.set(PR, [ALICE]);
        const disposition = await processCommentEvent(prCommentEvent('please fix', BOB), 'issue_comment', 'c1', createConfig());
        assert.equal(disposition.status, 'accepted');
        assert.equal(mockQueueAdd.mock.callCount(), 1);
        assert.equal(assigneeReads(), 0);
    });

    test('gate on, unassigned pull request: processes every comment', async () => {
        gateEnabled = true;
        const disposition = await processCommentEvent(prCommentEvent('please fix', BOB), 'issue_comment', 'c2', createConfig());
        assert.equal(disposition.status, 'accepted');
        assert.equal(mockQueueAdd.mock.callCount(), 1);
    });

    test('gate on, assigned to A: A starts work, B is ignored and told once', async () => {
        gateEnabled = true;
        github.assignees.set(PR, [ALICE]);
        const redisClient = createMockRedis();

        const fromAlice = await processCommentEvent(prCommentEvent('please fix', ALICE), 'issue_comment', 'c3', createConfig(redisClient));
        assert.equal(fromAlice.status, 'accepted');
        assert.equal(mockQueueAdd.mock.callCount(), 1);

        mockQueueAdd.mock.resetCalls();
        const first = prCommentEvent('please fix', BOB);
        const second = prCommentEvent('and this too', BOB);
        assert.deepEqual(await processCommentEvent(first, 'issue_comment', 'c4', createConfig(redisClient)), { status: 'ignored', reason: 'author_not_assigned' });
        assert.deepEqual(await processCommentEvent(second, 'issue_comment', 'c5', createConfig(redisClient)), { status: 'ignored', reason: 'author_not_assigned' });
        assert.equal(mockQueueAdd.mock.callCount(), 0);
        assert.equal(redisClient._store.has(trackingKey(first.comment.id)), false);
        assert.equal(github.posted.length, 1);
        assert.match(github.posted[0].body, /^@bob /);
    });

    for (const command of ['/review', '/fix', '/ultrafix']) {
        test(`a gated ${command} is refused and not claimed`, async () => {
            gateEnabled = true;
            github.assignees.set(PR, [ALICE]);
            const redisClient = createMockRedis();
            const event = prCommentEvent(command, BOB);
            const disposition = await processCommentEvent(event, 'issue_comment', 'c6', createConfig(redisClient));
            assert.deepEqual(disposition, { status: 'ignored', reason: 'author_not_assigned' });
            assert.equal(redisClient._store.has(trackingKey(event.comment.id)), false);
            assert.equal(mockQueueAdd.mock.callCount(), 0);
        });
    }

    test('a redelivered, already-handled slash command is deduplicated before the gate reads GitHub', async () => {
        gateEnabled = true;
        github.assignees.set(PR, [ALICE]);
        const redisClient = createMockRedis();
        const event = prCommentEvent('/review', ALICE);
        redisClient._store.set(trackingKey(event.comment.id), String(Date.now()));
        assert.deepEqual(await processCommentEvent(event, 'issue_comment', 'c11', createConfig(redisClient)), { status: 'ignored', reason: 'duplicate_delivery' });
        assert.equal(assigneeReads(), 0);
    });

    test('the CI-failure follow-up comment is processed regardless of assignment', async () => {
        gateEnabled = true;
        github.assignees.set(PR, [ALICE]);
        const body = `${buildCiFailureFollowupMarker('a'.repeat(64))}\nCI failed, please fix.`;
        const disposition = await processCommentEvent(prCommentEvent(body, { id: 999, login: BOT_LOGIN, type: 'Bot' }), 'issue_comment', 'c7', createConfig());
        assert.equal(disposition.status, 'accepted');
        assert.equal(mockQueueAdd.mock.callCount(), 1);
        assert.equal(assigneeReads(), 0);
    });

    test('a failed live read fails the delivery so it can be redelivered, and logs it', async () => {
        gateEnabled = true;
        github.failRead = true;
        await assert.rejects(processCommentEvent(prCommentEvent('please fix', ALICE), 'issue_comment', 'c8', createConfig()), /Could not read the assignees/);
        assert.equal(mockQueueAdd.mock.callCount(), 0);
        assert.equal(github.posted.length, 0);
        const refusal = mockLoggerInstance.info.mock.calls.find(call => call.arguments[1] === 'Follow-up comment refused by the assignment gate');
        assert.equal((refusal?.arguments[0] as { reason?: string })?.reason, 'assignment_unavailable');
    });

    test('a slash command whose live read fails is not claimed, so its redelivery reaches the gate again', async () => {
        gateEnabled = true;
        github.assignees.set(PR, [ALICE]);
        github.failRead = true;
        const redisClient = createMockRedis();
        const event = prCommentEvent('/review', BOB);
        await assert.rejects(processCommentEvent(event, 'issue_comment', 'c9', createConfig(redisClient)), /Could not read the assignees/);
        assert.equal(redisClient._store.has(trackingKey(event.comment.id)), false);

        github.failRead = false;
        assert.deepEqual(await processCommentEvent(event, 'issue_comment', 'c10', createConfig(redisClient)), { status: 'ignored', reason: 'author_not_assigned' });
        assert.equal(redisClient._store.has(trackingKey(event.comment.id)), false);
    });

    describe('redelivery of a refused comment', () => {
        const REFUSED = { status: 'ignored', reason: 'author_not_assigned' };

        for (const body of ['please fix', '/fix', '/review', '/merge']) {
            test(`a refused "${body}" stays refused when redelivered after its author is assigned`, async () => {
                gateEnabled = true;
                github.assignees.set(PR, [ALICE]);
                const redisClient = createMockRedis();
                const event = prCommentEvent(body, BOB);
                assert.deepEqual(await processCommentEvent(event, 'issue_comment', 'r1', createConfig(redisClient)), REFUSED);
                assert.ok(redisClient._store.has(refusedKey(event.comment.id)));

                github.assignees.set(PR, [ALICE, BOB]);
                const readsBefore = assigneeReads();
                assert.deepEqual(await processCommentEvent(event, 'issue_comment', 'r2', createConfig(redisClient)), REFUSED);
                // ...and switching the gate off does not release it either.
                gateEnabled = false;
                assert.deepEqual(await processCommentEvent(event, 'issue_comment', 'r3', createConfig(redisClient)), REFUSED);
                assert.equal(assigneeReads(), readsBefore);
                assert.equal(mockQueueAdd.mock.callCount(), 0);
                assert.equal(mockHandleMergeCommand.mock.callCount(), 0);
                assert.equal(redisClient._store.has(trackingKey(event.comment.id)), false);
                assert.equal(github.posted.length, 1);

                // A new comment from the now-assigned author starts work.
                gateEnabled = true;
                const fresh = prCommentEvent(body, BOB);
                const disposition = await processCommentEvent(fresh, 'issue_comment', 'r4', createConfig(redisClient));
                assert.equal(disposition.status, 'accepted');
                assert.equal(disposition.billing?.seatConsumed, true);
                if (body === '/merge') assert.equal(mockHandleMergeCommand.mock.callCount(), 1);
                else assert.equal(mockQueueAdd.mock.callCount(), 1);
            });
        }

        test('a delivery accepted once is still deduplicated as before', async () => {
            gateEnabled = true;
            github.assignees.set(PR, [ALICE]);
            const redisClient = createMockRedis();
            const event = prCommentEvent('please fix', ALICE);
            assert.equal((await processCommentEvent(event, 'issue_comment', 'r5', createConfig(redisClient))).status, 'accepted');
            assert.deepEqual(await processCommentEvent(event, 'issue_comment', 'r6', createConfig(redisClient)), { status: 'ignored', reason: 'duplicate_delivery' });
            assert.equal(redisClient._store.has(refusedKey(event.comment.id)), false);
            assert.equal(mockQueueAdd.mock.callCount(), 1);
        });

        test('a refused comment is not recorded when the author filter drops it first', async () => {
            gateEnabled = true;
            github.assignees.set(PR, [ALICE]);
            const redisClient = createMockRedis();
            const event = prCommentEvent('please fix', BOB);
            mockFilterCommentByAuthor.mock.mockImplementationOnce(() => ({ shouldFilter: true }));
            assert.deepEqual(await processCommentEvent(event, 'issue_comment', 'r7', createConfig(redisClient)), { status: 'ignored', reason: 'filtered_author' });
            assert.equal(redisClient._store.has(refusedKey(event.comment.id)), false);
            assert.equal(assigneeReads(), 0);
        });

        for (const body of ['please fix', '/fix']) {
            test(`a "${body}" whose refusal cannot be recorded fails the delivery, tells nobody, and is decided again on redelivery`, async () => {
                gateEnabled = true;
                github.assignees.set(PR, [ALICE]);
                const redisClient = createMockRedis();
                const event = prCommentEvent(body, BOB);
                redisClient.setex.mock.mockImplementation(async () => { throw new Error('Redis unavailable'); });
                await assert.rejects(processCommentEvent(event, 'issue_comment', 'r8', createConfig(redisClient)), /Redis unavailable/);
                redisClient.setex.mock.restore();
                assert.equal(github.posted.length, 0);
                assert.equal(redisClient._store.has(refusedKey(event.comment.id)), false);
                assert.equal(redisClient._store.has(trackingKey(event.comment.id)), false);
                assert.equal(mockQueueAdd.mock.callCount(), 0);

                // Storage is back and Bob is still unassigned: now the refusal is definitive.
                assert.deepEqual(await processCommentEvent(event, 'issue_comment', 'r9', createConfig(redisClient)), REFUSED);
                assert.ok(redisClient._store.has(refusedKey(event.comment.id)));
                assert.equal(github.posted.length, 1);
                github.assignees.set(PR, [ALICE, BOB]);
                assert.deepEqual(await processCommentEvent(event, 'issue_comment', 'r10', createConfig(redisClient)), REFUSED);
                assert.equal(mockQueueAdd.mock.callCount(), 0);
            });
        }

        test('an unreadable refusal record fails the delivery instead of starting work', async () => {
            gateEnabled = true;
            github.assignees.set(PR, [ALICE, BOB]);
            const redisClient = createMockRedis();
            const event = prCommentEvent('please fix', BOB);
            redisClient._store.set(refusedKey(event.comment.id), String(Date.now()));
            redisClient.get.mock.mockImplementation(async () => { throw new Error('Redis unavailable'); });
            await assert.rejects(processCommentEvent(event, 'issue_comment', 'r11', createConfig(redisClient)), /Redis unavailable/);
            await assert.rejects(processCommentEvent(prCommentEvent('/fix', BOB), 'issue_comment', 'r12', createConfig(redisClient)), /Redis unavailable/);
            redisClient.get.mock.restore();
            assert.equal(mockQueueAdd.mock.callCount(), 0);
        });

        test('an unreadable assignment is not recorded, so the redelivery after the outage proceeds', async () => {
            gateEnabled = true;
            github.assignees.set(PR, [ALICE, BOB]);
            github.failRead = true;
            const redisClient = createMockRedis();
            const event = prCommentEvent('/review', BOB);
            await assert.rejects(processCommentEvent(event, 'issue_comment', 'r13', createConfig(redisClient)), /Could not read the assignees/);
            assert.equal(redisClient._store.has(refusedKey(event.comment.id)), false);

            github.failRead = false;
            const disposition = await processCommentEvent(event, 'issue_comment', 'r14', createConfig(redisClient));
            assert.equal(disposition.status, 'accepted');
            assert.equal(mockQueueAdd.mock.callCount(), 1);
        });
    });
});

// ========== Polling intake ==========

describe('pollForPullRequestComments with the assignment gate', () => {
    const openPr = { number: PR, title: 'PR', labels: [{ name: 'AI' }], head: { ref: 'feature-branch' } };
    const comments = [
        { id: 1, body: 'from alice', user: ALICE, created_at: '2026-10-09T10:00:00Z' },
        { id: 2, body: 'from bob', user: BOB, created_at: '2026-10-09T10:01:00Z' },
        { id: 3, body: 'bob again', user: BOB, created_at: '2026-10-09T10:02:00Z' },
    ];
    const pollingOctokit = (prComments: Array<{ id: number; body: string; user: GitHubUser; created_at: string }>) => ({
        paginate: async <T>(endpoint: string): Promise<T[]> => {
            if (endpoint === 'GET /repos/{owner}/{repo}/pulls') return [openPr] as T[];
            if (endpoint === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') return prComments as T[];
            return [];
        },
    });

    async function poll(redisClient: MockRedis, prComments = comments): Promise<number[]> {
        await pollForPullRequestComments(pollingOctokit(prComments), `${OWNER}/${REPO}`, 'poll', {
            redisClient: redisClient as never,
            GITHUB_BOT_USERNAME: BOT_LOGIN,
            PR_FOLLOWUP_TRIGGER_KEYWORDS: [],
            MODEL_LABEL_PATTERN: '^llm-(.+)$',
        });
        const jobs = mockQueueAdd.mock.calls.map(call => (call.arguments as unknown[])[1] as { comments: Array<{ id: number }> });
        return jobs.flatMap(job => job.comments.map(comment => comment.id));
    }

    test('gate off: queues every comment and adds no assignee read', async () => {
        github.assignees.set(PR, [ALICE]);
        assert.deepEqual(await poll(createMockRedis()), [1, 2, 3]);
        assert.equal(assigneeReads(), 0);
    });

    test('gate on, unassigned pull request: queues every comment', async () => {
        gateEnabled = true;
        assert.deepEqual(await poll(createMockRedis()), [1, 2, 3]);
        assert.equal(assigneeReads(), 1);
    });

    test('gate on, assigned to A: queues only A, reads once per pull request, tells B once', async () => {
        gateEnabled = true;
        github.assignees.set(PR, [ALICE]);
        const redisClient = createMockRedis();
        assert.deepEqual(await poll(redisClient), [1]);
        assert.equal(assigneeReads(), 1);
        assert.equal(mockLoadFollowupRequiresAssignment.mock.callCount(), 1);
        assert.equal(github.posted.length, 1);
        assert.equal(redisClient._store.has(trackingKey(2)), false);

        // A later poll still refuses B's comments without a second notice.
        mockQueueAdd.mock.resetCalls();
        assert.deepEqual(await poll(redisClient), []);
        assert.equal(github.posted.length, 1);
    });

    test('a refused comment is dropped for good, as on the webhook path', async () => {
        gateEnabled = true;
        github.assignees.set(PR, [ALICE]);
        const redisClient = createMockRedis();
        const fromBob = comments.filter(comment => comment.user === BOB);
        assert.deepEqual(await poll(redisClient, fromBob), []);
        assert.equal(assigneeReads(), 1);
        assert.ok(redisClient._store.has(`pr-comment-refused:${OWNER}:${REPO}:${PR}:2`));
        assert.ok(redisClient._store.has(`pr-comment-refused:${OWNER}:${REPO}:${PR}:3`));
        assert.equal(redisClient._store.has(trackingKey(2)), false);

        // Later polls skip the refused comments without asking GitHub again.
        assert.deepEqual(await poll(redisClient, fromBob), []);
        assert.equal(assigneeReads(), 1);

        // Assigning B afterwards does not queue the comments refused earlier...
        github.assignees.set(PR, [ALICE, BOB]);
        assert.deepEqual(await poll(redisClient, fromBob), []);
        // ...and neither does switching the gate off.
        gateEnabled = false;
        assert.deepEqual(await poll(redisClient, fromBob), []);

        // B's next comment is a new one, and goes through.
        gateEnabled = true;
        assert.deepEqual(await poll(redisClient, [...fromBob, { id: 4, body: 'now assigned', user: BOB, created_at: '2026-10-09T10:03:00Z' }]), [4]);
    });

    test('a refusal that cannot be recorded is asked about again on the next poll', async () => {
        gateEnabled = true;
        github.assignees.set(PR, [ALICE]);
        const redisClient = createMockRedis();
        const fromBob = comments.filter(comment => comment.user === BOB);
        redisClient.setex.mock.mockImplementation(async () => { throw new Error('Redis unavailable'); });
        assert.deepEqual(await poll(redisClient, fromBob), []);
        redisClient.setex.mock.restore();
        // Not recorded, so not definitive: nobody was told it was refused.
        assert.equal(github.posted.length, 0);
        github.assignees.set(PR, [ALICE, BOB]);
        assert.deepEqual(await poll(redisClient, fromBob), [2, 3]);
    });

    test('a comment refused on the webhook is not queued by a later poll once its author is assigned', async () => {
        gateEnabled = true;
        github.assignees.set(PR, [ALICE]);
        const redisClient = createMockRedis();
        const event = prCommentEvent('please fix', BOB);
        assert.deepEqual(await processCommentEvent(event, 'issue_comment', 'x1', createConfig(redisClient)), { status: 'ignored', reason: 'author_not_assigned' });

        github.assignees.set(PR, [ALICE, BOB]);
        const readsBefore = assigneeReads();
        const sameComment = { id: event.comment.id, body: 'please fix', user: BOB, created_at: '2026-10-09T10:01:00Z' };
        assert.deepEqual(await poll(redisClient, [sameComment]), []);
        assert.equal(assigneeReads(), readsBefore);
        assert.deepEqual(await poll(redisClient, [sameComment, { id: 5, body: 'now assigned', user: BOB, created_at: '2026-10-09T10:02:00Z' }]), [5]);
    });

    for (const body of ['please fix', '/fix']) {
        test(`a "${body}" refused by a poll is not started by a webhook delivery of the same comment`, async () => {
            gateEnabled = true;
            github.assignees.set(PR, [ALICE]);
            const redisClient = createMockRedis();
            const event = prCommentEvent(body, BOB);
            assert.deepEqual(await poll(redisClient, [{ id: event.comment.id, body, user: BOB, created_at: '2026-10-09T10:01:00Z' }]), []);
            assert.ok(redisClient._store.has(refusedKey(event.comment.id)));

            github.assignees.set(PR, [ALICE, BOB]);
            assert.deepEqual(await processCommentEvent(event, 'issue_comment', 'x2', createConfig(redisClient)), { status: 'ignored', reason: 'author_not_assigned' });
            assert.equal(mockQueueAdd.mock.callCount(), 0);
            assert.equal(redisClient._store.has(trackingKey(event.comment.id)), false);
        });
    }

    test('a failed live read queues nothing and is asked about again on the next poll', async () => {
        gateEnabled = true;
        github.assignees.set(PR, [ALICE]);
        github.failRead = true;
        const redisClient = createMockRedis();
        assert.deepEqual(await poll(redisClient), []);
        assert.equal(github.posted.length, 0);
        assert.deepEqual([...redisClient._store.keys()].filter(key => key.startsWith('pr-comment-refused:')), []);

        github.failRead = false;
        assert.deepEqual(await poll(redisClient), [1]);
    });
    describe('with ProPR\'s bot whitelisted and the real author filter', () => {
        const BOT: GitHubUser = { id: 999, login: BOT_LOGIN };
        const ciFollowup = `${buildCiFailureFollowupMarker('b'.repeat(64))}\nCI failed, please fix.`;
        let savedWhitelist: string | undefined;

        beforeEach(() => {
            savedWhitelist = process.env.GITHUB_USER_WHITELIST;
            process.env.GITHUB_USER_WHITELIST = `alice,bob,${BOT_LOGIN}`;
            useRealAuthorFilter = true;
            gateEnabled = true;
            github.assignees.set(PR, [ALICE]);
        });

        after(() => {
            useRealAuthorFilter = false;
            if (savedWhitelist === undefined) delete process.env.GITHUB_USER_WHITELIST;
            else process.env.GITHUB_USER_WHITELIST = savedWhitelist;
        });

        for (const [name, body] of [['CI-failure follow-up', ciFollowup], ['/ultrafix', '/ultrafix']]) {
            test(`a system ${name} on a pull request assigned to A is queued, not refused`, async () => {
                const redisClient = createMockRedis();
                const queued = await poll(redisClient, [{ id: 10, body, user: BOT, created_at: '2026-10-09T10:00:00Z' }]);
                assert.deepEqual(queued, [10]);
                assert.equal(github.posted.length, 0);
                assert.equal(mockLoggerInstance.info.mock.calls.some(call => call.arguments[1] === 'Follow-up comment refused by the assignment gate'), false);
            });
        }

        test('a plain comment from ProPR\'s whitelisted bot is refused without a notice addressed to itself', async () => {
            const queued = await poll(createMockRedis(), [{ id: 12, body: 'ProPR status update', user: BOT, created_at: '2026-10-09T10:00:00Z' }]);
            assert.deepEqual(queued, []);
            assert.equal(github.posted.length, 0);
        });

        test('the system marker from a person is not an exemption', async () => {
            const queued = await poll(createMockRedis(), [{ id: 11, body: ciFollowup, user: BOB, created_at: '2026-10-09T10:00:00Z' }]);
            assert.deepEqual(queued, []);
            assert.equal(github.posted.length, 1);
            assert.match(github.posted[0].body, /^@bob /);
        });
    });
});

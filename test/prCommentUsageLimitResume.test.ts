import assert from 'node:assert/strict';
import { after, beforeEach, describe, mock, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Issue #3247: a follow-up whose agent hit a provider usage limit leaves its
 * starting comment (`<id>✓` plus `phase=started`) on the pull request and hands
 * the claim to a delayed retry. That retry must run the request once rather
 * than read the starting comment as completion.
 *
 * These tests run the real processor (processPullRequestCommentJob) with its
 * real validation, starting comment, usage-limit error handling, durable retry
 * scheduling and cleanup, against the real WorkerStateManager and a migrated
 * SQLite database. GitHub, Redis, the BullMQ queue, the worktree and the agent
 * run itself are in memory; the agent's commit and push are replaced by the
 * real completion comment edited into the starting comment.
 */

const root = await mkdtemp(path.join(tmpdir(), 'pr-comment-usage-limit-resume-'));
process.env.DATA_DIR = root;
process.env.DB_FILENAME = path.join(root, 'core.sqlite');
process.env.NODE_ENV = 'test';
process.env.PRIMARY_PROCESSING_LABELS = 'AI';
// With no configured keywords every comment is an explicit trigger. This
// fixture needs plain comments to remain subject to the processing-label gate.
process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS = '@propr';
process.env.GITHUB_BOT_USERNAME = 'propr-dev[bot]';
delete process.env.CONFIG_REPO;

const BOT = 'propr-dev[bot]';
const REQUEST_ID = 6256068930;

const redisValues = new Map<string, string>();
function FakeRedis() {
    return {
        on: () => {},
        get: async (key: string) => redisValues.get(key) ?? null,
        setex: async (key: string, _ttl: number, value: string) => { redisValues.set(key, value); return 'OK'; },
        set: async (key: string, value: string, ...args: unknown[]) => {
            if (args.includes('NX') && redisValues.has(key)) return null;
            redisValues.set(key, value);
            return 'OK';
        },
        eval: async (_script: string, _keys: number, key: string, expected: string, _ttl: string, next: string) => {
            if (redisValues.get(key) !== expected) return 0;
            redisValues.set(key, next);
            return 1;
        },
        llen: async () => 0,
        lrange: async () => [],
        rpush: async () => 1,
        keys: async () => [],
        del: async (key: string) => { redisValues.delete(key); return 1; },
        quit: async () => 'OK',
        disconnect: () => {},
    };
}
await mock.module('ioredis', { namedExports: { Redis: FakeRedis } });

/** A BullMQ job as the processor and the retry scheduler see it. */
class QueueJob {
    attemptsMade = 0;
    token: string | undefined = 'worker-lock';
    opts = { attempts: 1 };
    constructor(public id: string, public name: string, public data: Record<string, unknown>, public state = 'waiting', public delay = 0) {}
    async getState() { return this.state; }
    async updateData(data: Record<string, unknown>) { this.data = data; }
    async moveToDelayed() { this.state = 'delayed'; }
    async remove() { queued.delete(this.id); }
}
const queued = new Map<string, QueueJob>();
const fakeQueue = {
    add: async (name: string, data: Record<string, unknown>, opts: { jobId: string; delay?: number }) => {
        // BullMQ returns the existing job for a duplicate ID.
        const existing = queued.get(opts.jobId);
        if (existing) return existing;
        const job = new QueueJob(opts.jobId, name, structuredClone(data), 'delayed', opts.delay ?? 0);
        queued.set(job.id, job);
        return job;
    },
    getJob: async (id: string) => queued.get(id),
    getJobs: async () => [],
};
await mock.module('../packages/core/src/queue/taskQueue.js', { namedExports: {
    GITHUB_ISSUE_QUEUE_NAME: 'test-issues', COMMENT_BATCH_DELAY_MS: 3000, INDEXING_QUEUE_NAME: 'test-indexing',
    getIssueQueue: async () => fakeQueue, getIndexingQueue: async () => fakeQueue,
    issueQueue: fakeQueue, indexingQueue: fakeQueue,
    createWorker: async () => { throw new Error('not used'); }, shutdownQueue: async () => {},
} });
const publisher = { publishActivity: async () => true, publishTaskUpdate: async () => true, publishDraftUpdate: async () => true };
await mock.module('../packages/core/src/utils/eventPublisher.js', {
    namedExports: { getEventPublisher: () => publisher, closeEventPublisher: async () => {}, publishNotificationUpdateThroughRedis: () => {}, EventPublisher: class {} },
});

const { db, runMigrations, closeConnection } = await import('../packages/core/src/db/connection.js');
const { WorkerStateManager, TaskStates } = await import('../packages/core/src/utils/workerStateManager.js');
await runMigrations();
const stateManager = new WorkerStateManager({ keyPrefix: 'test:pr-comment-usage-limit-resume:' });

interface GitHubComment { id: number; body: string; user: { login: string; type?: string }; created_at: string; updated_at: string }

/** The pull request and its issue comments as GitHub reports them. */
const github = {
    comments: [] as GitHubComment[],
    nextId: 7_000_000_000,
    pr: { state: 'open', merged: false, labels: [{ name: 'AI' }] as Array<{ name: string }> },
    writes: [] as Array<{ method: 'POST' | 'PATCH'; id: number; body: string }>,
};
function addComment(id: number, login: string, body: string): GitHubComment {
    const at = new Date(Date.UTC(2026, 9, 18, 22, 0, 0) + github.comments.length * 1000).toISOString();
    const comment = { id, body, user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' }, created_at: at, updated_at: at };
    github.comments.push(comment);
    return comment;
}
const octokit = {
    auth: async () => ({ token: 'fixture-token' }),
    request: async (endpoint: string, params: Record<string, unknown>) => {
        if (endpoint === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
            return { data: {
                number: 42, title: 'Keep create dialog', body: 'Original objective', user: { login: 'integry' },
                state: github.pr.state, merged: github.pr.merged, labels: github.pr.labels,
                base: { ref: 'main' }, head: { ref: 'feature', sha: '4b79523', repo: { full_name: 'acme/web' } },
            } };
        }
        if (endpoint === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') {
            return { data: params.page === 1 ? structuredClone(github.comments) : [], headers: {} };
        }
        if (endpoint === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments') return { data: [], headers: {} };
        if (endpoint === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') {
            const comment = addComment(github.nextId++, BOT, String(params.body));
            github.writes.push({ method: 'POST', id: comment.id, body: comment.body });
            return { data: { id: comment.id, html_url: `https://github.com/acme/web/pull/42#issuecomment-${comment.id}`, user: { login: BOT } } };
        }
        if (endpoint === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}') {
            const comment = github.comments.find(entry => entry.id === params.comment_id);
            if (!comment) throw Object.assign(new Error('Not Found'), { status: 404 });
            comment.body = String(params.body);
            github.writes.push({ method: 'PATCH', id: comment.id, body: comment.body });
            return { data: { id: comment.id, html_url: `https://github.com/acme/web/pull/42#issuecomment-${comment.id}` } };
        }
        throw new Error(`Unexpected GitHub request ${endpoint}`);
    },
};

/** Set when the retry's PR intent was withdrawn (production: taskIntent.preventWithdrawnJob). */
let withdrawn = false;
const core = await import('../packages/core/src/index.ts');
await mock.module('@propr/core', { namedExports: {
    ...core,
    getStateManager: () => stateManager,
    getAuthenticatedOctokit: async () => octokit,
    preventWithdrawnJob: async () => withdrawn ? 'cancelled_pr_closed' : null,
    inspectTaskContainerLivenessForTask: async () => ({ liveness: 'not_found', container: null }),
    inspectLegacyDockerContainerLivenessForTask: async () => 'not_found',
    ensureGitRepository: async () => {},
    createLogFiles: async () => {},
    recordLLMMetrics: async () => {},
    loadRepositoryVisualPreviewSettings: async () => ({ enabled: false, types: [] }),
} });

const noOp = async () => {};
/** Each agent launch, and what it does: hit the provider usage limit or succeed. */
let agentOutcomes: Array<'usage_limit' | 'succeed'> = [];
let agentRuns: Array<{ taskId: string; prompt: string }> = [];
const resetTimestamp = Math.floor(Date.UTC(2026, 9, 18, 23, 5, 0) / 1000);
const worktree = { worktreePath: root, branchName: 'feature' };
const modules: Record<string, Record<string, unknown>> = {
    runCostCap: {
        withRunCostCap: async (_target: unknown, operation: (guard: unknown) => Promise<unknown>) => operation({ setWorkflowCap: async () => undefined }),
        applyWorkflowCostCap: async (workflow: unknown) => workflow,
        pullRequestRunCostCapTarget: () => ({}),
    },
    repositoryWorkflow: {
        prepareRepositoryWorkflow: async () => undefined,
        resolveAttemptRepositoryWorkflow: async () => ({ workflow: undefined, admitted: async () => undefined }),
        withRepositoryWorkflowAdmission: async (_options: unknown, execute: () => Promise<unknown>) => execute(),
        reconcileRepositoryWorkflowAdmission: async (workflow: unknown) => workflow,
        deferRepositoryWorkflowJob: async (_job: unknown, execute: () => Promise<unknown>) => execute(),
    },
    prPendingComments: {
        pickUpPendingCommentsWithClaim: async (comments: unknown[]) => ({ commentsToProcess: comments, pickedUpComments: [] }),
        applyPendingCommentCommandContext: () => {}, restorePendingComments: noOp,
    },
    prProcessingLock: {
        acquirePRProcessingLock: async () => true, ensurePRProcessingLockToken: async () => 'lease-token',
        acquireCurrentPRProcessingLock: async (_redis: unknown, { lockKey }: { lockKey: string }) => lockKey,
        releasePRProcessingLock: async () => true, startPRProcessingLockHeartbeat: () => noOp,
    },
    prContinuation: { findPRContinuation: async () => null, continuationStatus: () => '' },
    prContinuationReview: { stopOriginalPRReviewCycle: async () => null },
    prPublicationRecovery: { recoverPendingPublication: async () => undefined },
    prPublication: {
        PullRequestPublication: class {
            continuation = undefined;
            pendingCompletion = undefined;
            status = '';
            target = { owner: 'acme', repo: 'web', branch: 'feature' };
            async prepare() { return { localRepoPath: root, worktreeInfo: worktree }; }
            async finishCompletion() {}
        },
    },
    prCommentHandoffIntegration: {
        recordExecutionHandoff: noOp, gatePredecessorHandoff: async () => undefined,
        checkpointExecutionHandoffUsageLimitRetry: noOp, settleExecutionHandoffAfterError: noOp,
        retireExecutionHandoffAfterCleanup: noOp, markExecutionHandoffCleanupPending: noOp,
        markExecutionHandoffContainer: noOp, markExecutionHandoffAgentExited: noOp,
        // No real worktree to remove.
        writerOwnedWorktree: () => undefined,
    },
    followupCiSuspension: { suspendObsoleteValidationForImplementation: noOp, releaseFollowupCiSuspensionsForTask: noOp },
    ultrafixJobHelpers: { handleUltrafixContinuation: noOp, markSelectedUltrafixFindings: noOp, restorePendingCommentsIfUltrafixJobSuperseded: async () => false },
    prContributionDiscussion: { loadOriginalContributionDiscussion: async () => '' },
    prCommentJobHelpers: {
        fetchLinkedIssueContext: async () => ({ context: '', linkedIssueNumber: null, linkedIssueLabels: [] }),
        updateTaskTitleForPR: noOp,
    },
    issueJobHelpers: { localizeContentImages: async (body: string) => body },
    prCommentAgentUtils: {
        generateSummaryTitle: async () => 'Keep create dialog',
        resolvePRCommentModelName: async () => 'Claude Opus 5.5',
        resolveAndExecuteAgent: async ({ taskId, prompt }: { taskId: string; prompt: string }) => {
            agentRuns.push({ taskId, prompt });
            const outcome = agentOutcomes.shift();
            if (outcome === 'usage_limit') throw new core.UsageLimitError('Claude usage limit reached', resetTimestamp);
            if (outcome !== 'succeed') throw new Error('an unexpected agent launch');
            return {
                agentType: 'claude',
                claudeResult: {
                    success: true, sessionId: 'session-1', conversationId: 'conversation-1', executionTime: 1,
                    model: 'claude-opus-5-5', summary: 'Kept the create dialog open.', modifiedFiles: ['src/dialog.ts'],
                },
            };
        },
    },
};
// The publication of a successful run: the real completion comment, edited into the starting comment.
const { buildCompletionComment } = await import('../src/jobs/prCompletionComment.js');
modules.prCommentPostExecution = {
    handlePostExecution: async ({ state }: { state: { unprocessedComments: never[]; authorsText: string; claudeResult: never; startingWorkComment: { data: { id: number } } } }) => {
        const body = await buildCompletionComment({ commitHash: 'c0ffee1234567' }, state.unprocessedComments, {
            changesSummary: 'Kept the create dialog open.', commitMessage: 'feat(ai): keep create dialog', llm: 'claude-opus-5-5', authorsText: state.authorsText,
        }, state.claudeResult);
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', { owner: 'acme', repo: 'web', comment_id: state.startingWorkComment.data.id, body });
        return { commitHash: 'c0ffee1234567', partial: false };
    },
};
for (const [name, namedExports] of Object.entries(modules)) {
    const real = await import(`../src/jobs/${name}.js`);
    await mock.module(`../src/jobs/${name}.js`, { namedExports: { ...real, ...namedExports } });
}

const { processPullRequestCommentJob } = await import('../src/jobs/processPullRequestCommentJob.js');
const { filterUnprocessedComments } = await import('../src/jobs/prCommentJobHelpers.js');
const { buildStartingWorkCommentBody } = await import('../src/jobs/prCommentJobUtils.js');

after(async () => {
    await stateManager.close();
    await closeConnection();
    await rm(root, { recursive: true, force: true });
});

const ORIGINAL_JOB_ID = `pr-comments-batch-acme-web-42-${REQUEST_ID}-2026-10-18T22-41-43Z-4a44e32517ed`;
const request = { id: REQUEST_ID, body: 'Please keep the create dialog open after saving.', author: 'integry', type: 'issue' as const };

function originalJob(): QueueJob {
    return new QueueJob(ORIGINAL_JOB_ID, 'processPullRequestComment', {
        repoOwner: 'acme', repoName: 'web', pullRequestNumber: 42, commandMode: 'default',
        correlationId: 'correlation-original', llm: 'claude-opus-5-5', branchName: 'feature',
        comments: [{ ...request }],
    }, 'active');
}

async function run(job: QueueJob) {
    job.state = 'active';
    const result = await processPullRequestCommentJob(job as never);
    job.state = 'completed';
    return result;
}

const startedMarker = `<!-- propr:work-evidence phase=started trigger-comment-ids=${REQUEST_ID} -->`;
const completedMarker = `<!-- propr:work-evidence phase=completed trigger-comment-ids=${REQUEST_ID} -->`;
const botComments = () => github.comments.filter(comment => comment.user.login === BOT);
const completions = () => botComments().filter(comment => comment.body.includes(completedMarker));

/** The original attempt: starting receipt, provider usage limit, durable retry. */
async function hitUsageLimit(): Promise<QueueJob> {
    agentOutcomes = ['usage_limit'];
    const result = await run(originalJob());
    assert.deepEqual(result, { status: 'requeued', reason: 'usage_limit' });
    assert.equal(queued.size, 1, 'one delayed retry owns the request');
    return [...queued.values()][0];
}

beforeEach(async () => {
    await db('task_history').delete();
    await db('tasks').delete();
    redisValues.clear();
    queued.clear();
    agentOutcomes = [];
    agentRuns = [];
    withdrawn = false;
    github.comments = [];
    github.writes = [];
    github.pr = { state: 'open', merged: false, labels: [{ name: 'AI' }] };
    addComment(REQUEST_ID, 'integry', request.body);
});

describe('a follow-up interrupted by a provider usage limit (#3247)', () => {
    test('the scheduled retry runs the request exactly once, and repeated delivery after completion is skipped', async () => {
        const retry = await hitUsageLimit();

        // The original attempt left the starting receipt as it was posted.
        const [starting, delay] = botComments();
        assert.ok(starting.body.includes(`${REQUEST_ID}✓`));
        assert.ok(starting.body.trimEnd().endsWith(startedMarker), 'the starting receipt is still only started');
        assert.match(delay.body, /Processing Delayed/);
        assert.ok(delay.body.includes(`Job ID: ${retry.id} `), 'the delay comment names the retry that owns the request');
        assert.equal(completions().length, 0);

        // The retry keeps the original request, its identity and its spend budget.
        assert.deepEqual(retry.data.comments, [request]);
        assert.equal(retry.data.correlationId, 'correlation-original');
        assert.deepEqual(retry.data.costBudgetTaskIds, [ORIGINAL_JOB_ID]);
        assert.equal(retry.data.prProcessingLockToken, undefined, 'it does not inherit the original lease');
        const original = (await stateManager.getTaskState(ORIGINAL_JOB_ID))!;
        assert.notEqual(original.state, TaskStates.COMPLETED, 'the interrupted attempt is not recorded as completed');

        // The retry is not suppressed by the starting receipt and completes the request once.
        agentOutcomes = ['succeed'];
        const resumed = await run(retry);
        assert.equal(resumed.status, 'complete');
        assert.deepEqual(agentRuns.map(entry => entry.taskId), [ORIGINAL_JOB_ID, retry.id], 'one launch per attempt');
        assert.ok(agentRuns[1].prompt.includes(request.body), 'the retry executes the original request');
        assert.equal(completions().length, 1, 'exactly one completion receipt');
        assert.equal((await stateManager.getTaskState(retry.id))?.state, TaskStates.CLAUDE_EXECUTION,
            'the retry ran under its own task; the worker finalizer records its completion');

        // Delivering the same retry, or the original request, again is skipped:
        // the completion receipt ends the request.
        const writes = github.writes.length;
        agentOutcomes = ['succeed'];
        assert.deepEqual(await run(retry), { status: 'skipped', reason: 'already_processed', pullRequestNumber: 42 });
        const redelivery = originalJob();
        redelivery.id = `${ORIGINAL_JOB_ID}-redelivery`;
        assert.deepEqual(await run(redelivery), { status: 'skipped', reason: 'already_processed', pullRequestNumber: 42 });
        assert.equal(agentRuns.length, 2, 'no further launch');
        assert.equal(github.writes.length, writes, 'no further comment');
        assert.equal(completions().length, 1);
        assert.equal(queued.size, 1, 'no further dispatch');
    });

    test('a retry whose request has meanwhile completed or failed is skipped without a launch', async () => {
        for (const phase of ['completed', 'failed'] as const) {
            const retry = await hitUsageLimit();
            addComment(github.nextId++, BOT, `Comment ID: ${REQUEST_ID}✓\n<!-- propr:work-evidence phase=${phase} trigger-comment-ids=${REQUEST_ID} -->`);
            const launches = agentRuns.length;
            assert.deepEqual(await run(retry), { status: 'skipped', reason: 'already_processed', pullRequestNumber: 42 }, phase);
            assert.equal(agentRuns.length, launches, `${phase}: no launch`);
            queued.clear();
            await db('task_history').delete();
            await db('tasks').delete();
            redisValues.clear();
            github.comments = github.comments.filter(comment => comment.id === REQUEST_ID);
        }
    });

    test('a retry keeps the closed-PR, missing-label, deleted-comment and withdrawn-intent guards', async () => {
        const cases: Array<[string, () => void, Record<string, unknown>]> = [
            ['merged', () => { github.pr.state = 'closed'; github.pr.merged = true; }, { status: 'skipped', reason: 'pull_request_merged', pullRequestNumber: 42 }],
            ['closed', () => { github.pr.state = 'closed'; }, { status: 'cancelled', reason: 'cancelled_pr_closed', pullRequestNumber: 42 }],
            ['label', () => { github.pr.labels = []; }, { status: 'skipped', reason: 'missing_required_label', pullRequestNumber: 42 }],
            ['deleted', () => { github.comments = github.comments.filter(comment => comment.id !== REQUEST_ID); }, { status: 'skipped', reason: 'all_comments_deleted', pullRequestNumber: 42 }],
            ['withdrawn', () => { withdrawn = true; }, { status: 'cancelled', reason: 'cancelled_pr_closed' }],
        ];
        for (const [name, change, expected] of cases) {
            github.comments = github.comments.filter(comment => comment.id === REQUEST_ID);
            if (!github.comments.length) addComment(REQUEST_ID, 'integry', request.body);
            github.pr = { state: 'open', merged: false, labels: [{ name: 'AI' }] };
            withdrawn = false;
            queued.clear();
            // Each case retries the same source attempt, so its retry task ID recurs.
            await db('task_history').delete();
            await db('tasks').delete();
            redisValues.clear();
            const retry = await hitUsageLimit();
            const launches = agentRuns.length;
            change();
            agentOutcomes = ['succeed'];
            assert.deepEqual(await run(retry), expected, name);
            assert.equal(agentRuns.length, launches, `${name}: no launch`);
            assert.equal(completions().length, 0, `${name}: no completion`);
        }
    });
});

describe('request receipts in filterUnprocessedComments', () => {
    const log = { debug() {}, info() {}, warn() {}, error() {} } as never;
    const pending = (id = REQUEST_ID) => [{ id, body: 'Fix it', author: 'integry', type: 'issue' as const }];
    const bot = (body: string, login = BOT) => ({ id: 1, user: { login }, body, created_at: '2026-10-18T22:41:50Z' });
    const remaining = (bodies: Array<ReturnType<typeof bot>>, id = REQUEST_ID) =>
        filterUnprocessedComments(pending(id), bodies, BOT, { pullRequestNumber: 42, correlatedLogger: log }).map(comment => comment.id);
    const startingBody = buildStartingWorkCommentBody('@integry', pending(), 'https://propr.example/tasks/t1');

    test('the production starting receipt alone leaves the request unprocessed', () => {
        assert.ok(startingBody.includes(`${REQUEST_ID}✓`) && startingBody.includes(startedMarker));
        assert.deepEqual(remaining([bot(startingBody)]), [REQUEST_ID]);
        // The publication destination line the processor appends keeps it a starting receipt.
        assert.deepEqual(remaining([bot(`${startingBody}\n\nPublishing to continuation PR #43.`)]), [REQUEST_ID]);
        assert.deepEqual(remaining([bot(startingBody.replace(/\n/g, '\r\n'))]), [REQUEST_ID]);
    });

    test('a batch starting receipt leaves each of its requests unprocessed', () => {
        const batch = [...pending(111), ...pending(222)];
        const body = buildStartingWorkCommentBody('@integry', batch, 'https://propr.example/tasks/t1');
        assert.deepEqual(filterUnprocessedComments(batch, [bot(body)], BOT, { pullRequestNumber: 42, correlatedLogger: log }).map(c => c.id), [111, 222]);
    });

    test('completed, partial and failed receipts end the request', () => {
        assert.deepEqual(remaining([bot(startingBody), bot(`✅ Applied\n\n_Processing comment ID: ${REQUEST_ID}✓_\n${completedMarker}\n<!-- propr:accepted-request comment-id=${REQUEST_ID} body-sha256=${'a'.repeat(64)} -->`)]), []);
        assert.deepEqual(remaining([bot(`⚠️ **Applied partial follow-up changes**\n\n_Processing comment ID: ${REQUEST_ID}✓_\n${completedMarker}`)]), []);
        assert.deepEqual(remaining([bot(`❌ Failed\n\n---\nComment ID: ${REQUEST_ID}✓\nPlease check the logs for more details.\n<!-- propr:work-evidence phase=failed trigger-comment-ids=${REQUEST_ID} -->`)]), []);
        // A batch completion that names the request among others.
        assert.deepEqual(remaining([bot(`_Processing comment IDs: 5✓, ${REQUEST_ID}✓_\n<!-- propr:work-evidence phase=completed trigger-comment-ids=5,${REQUEST_ID} -->`)]), []);
    });

    test('legacy receipts without work-evidence markers keep consuming through their checkmark', () => {
        assert.deepEqual(remaining([bot(`✅ **Applied the requested follow-up changes**\n\n---\n_Processing comment ID: ${REQUEST_ID}✓_`)]), []);
        assert.deepEqual(remaining([bot(`- Comment 1 by @integry (ID: ${REQUEST_ID}✓)`)]), []);
        // A starting comment from before the markers existed cannot be told apart and still counts.
        assert.deepEqual(remaining([bot(`🔄 **Starting work on follow-up changes**\n\n---\n_Processing comment ID: ${REQUEST_ID}✓_`)]), []);
    });

    test('a started marker that is not the receipt footer does not reopen a completion', () => {
        // An agent summary quoting a started marker inside a legacy completion.
        const quoted = `✅ Applied\n\n## Summary\n\nThe footer is now:\n\n${startedMarker}\n\n---\n_Processing comment ID: ${REQUEST_ID}✓_`;
        assert.deepEqual(remaining([bot(quoted)]), []);
        // A started marker inline rather than on its own line.
        assert.deepEqual(remaining([bot(`_Processing comment ID: ${REQUEST_ID}✓_ ${startedMarker}`)]), []);
        // A started marker for another request.
        assert.deepEqual(remaining([bot(`_Processing comment ID: ${REQUEST_ID}✓_\n<!-- propr:work-evidence phase=started trigger-comment-ids=99 -->`)]), []);
    });

    test('untrusted and lookalike receipts are not evidence', () => {
        const completed = `_Processing comment ID: ${REQUEST_ID}✓_\n${completedMarker}`;
        assert.deepEqual(remaining([bot(completed, 'integry')]), [REQUEST_ID], 'a person cannot complete a request');
        assert.deepEqual(remaining([bot(completed, 'propr-dev')]), [REQUEST_ID], 'nor an account resembling the bot');
        // A receipt for a longer ID that ends in this one.
        assert.deepEqual(remaining([bot('_Processing comment ID: 112345✓_\n<!-- propr:work-evidence phase=completed trigger-comment-ids=112345 -->')], 12345), [12345]);
        // A marker without the receipt's checkmark (the interrupted-without-changes notice returns the request).
        assert.deepEqual(remaining([bot(`Returned comment ID: ${REQUEST_ID}\n\n<!-- propr:work-evidence phase=failed trigger-comment-ids=${REQUEST_ID} -->`)]), [REQUEST_ID]);
    });
});

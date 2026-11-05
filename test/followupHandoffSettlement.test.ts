import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { up } from '../packages/core/src/db/migrations/20261017000000_add_pr_followup_handoffs.js';

/**
 * Durable settlement regressions, run over the production git operations,
 * the real normal error handler and the real handoff checkpoints:
 *
 * - Usage-limit crash window: the worker dies after the usage-limit retry is
 *   scheduled (and its delay comment posted) but before the handoff settles.
 *   The retry job owns the claimed comments, so neither a standalone pass nor
 *   the retry's own admission gate returns them to the pending list, and
 *   repeated passes stay idempotent. A death around the queue add itself
 *   fails closed for an operator instead of guessing.
 * - Durable classification: a liveness warning recorded while the handoff
 *   waits at cleanup_pending overwrites the diagnostic status reason, but the
 *   request it returned to the queue still retires as `noChanges`.
 */

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
const root = await mkdtemp(path.join(tmpdir(), 'followup-handoff-settlement-'));

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return silentLog; } };
const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
    '-c', 'protocol.file.allow=always', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const BRANCH = 'propr/pr-head';
const KEY = { repository: 'acme/widgets', pull_request: 7 };
const LOCK = 'lock:pr:acme:widgets:7';

// Real core git operations (commit staging, settled-worktree release, the
// generated-path predicate); only the database, logger and push are local.
const core = await import('@propr/core');
const pushes: string[] = [];
await mock.module('@propr/core', {
    namedExports: {
        ...core,
        db: database,
        logger: silentLog,
        pushBranch: async (worktreePath: string, branchName: string) => {
            git(worktreePath, 'push', 'origin', `HEAD:refs/heads/${branchName}`);
            pushes.push(git(worktreePath, 'rev-parse', 'HEAD'));
            return { rebased: false, commitHash: git(worktreePath, 'rev-parse', 'HEAD') };
        },
    },
});
// The queue add is the only stub on the usage-limit path; `onRetryScheduled`
// lets a test kill the worker right after the add lands.
const retries: Array<{ comments: Array<{ id: number }> }> = [];
let onRetryScheduled: () => void = () => undefined;
await mock.module('../src/jobs/prCommentUsageLimitRecovery.js', {
    namedExports: {
        schedulePRCommentUsageLimitRetry: async (_job: unknown, comments: Array<{ id: number }>) => {
            retries.push({ comments });
            onRetryScheduled();
            return 'retry-job-1';
        },
    },
});
await mock.module('../src/jobs/prContributionDiscussion.js', { namedExports: { loadOriginalContributionDiscussion: async () => undefined } });
after(async () => {
    await database.destroy();
    await core.closeConnection?.();
    await rm(root, { recursive: true, force: true });
});

const {
    recordFollowupHandoff, advanceFollowupHandoff, loadFollowupHandoff, PR_FOLLOWUP_HANDOFFS_TABLE, HANDOFF_AWAITING_OPERATOR,
    SETTLEMENT_RETURNED_TO_QUEUE, SETTLEMENT_RETRY_SCHEDULED, SETTLEMENT_RETRY_SCHEDULING,
} = await import('../src/jobs/followupHandoffStore.js');
const {
    recoverInterruptedFollowupHandoffs, adoptPredecessorFollowupHandoff, inspectFollowupHandoffs, resumeOperatorHeldFollowupHandoff,
} = await import('../src/jobs/followupHandoffRecovery.js');
const { createFollowupHandoffGitOps } = await import('../src/jobs/followupHandoffGitOps.js');
const { handleJobError, UsageLimitError } = await import('../src/jobs/prCommentJobUtils.js');
const { checkpointExecutionHandoffUsageLimitRetry } = await import('../src/jobs/prCommentHandoffIntegration.js');

type HandoffRecord = NonNullable<Awaited<ReturnType<typeof loadFollowupHandoff>>>;
interface Fixture { origin: string; local: string; wt: string }
let fixtureIndex = 0;

async function createFixture(): Promise<Fixture> {
    const dir = path.join(root, `fx-${fixtureIndex++}`);
    await mkdir(dir, { recursive: true });
    git(dir, 'init', '--bare', 'origin.git');
    git(dir, 'clone', 'origin.git', 'local');
    const local = path.join(dir, 'local');
    await writeFile(path.join(local, 'base.txt'), 'base\n');
    git(local, 'add', '.');
    git(local, 'commit', '-m', 'Base');
    git(local, 'branch', '-M', BRANCH);
    git(local, 'push', '-u', 'origin', BRANCH);
    git(local, 'checkout', '--detach');
    const wt = path.join(dir, 'wt');
    git(local, 'worktree', 'add', wt, BRANCH);
    return { origin: path.join(dir, 'origin.git'), local, wt };
}

function createLockRedis() {
    const store = new Map<string, { value: string; ttl: number }>();
    return {
        async set(key: string, value: string, _ex: string, ttl: number, nx?: string) {
            if (nx === 'NX' && store.has(key)) return null;
            store.set(key, { value, ttl: Number(ttl) });
            return 'OK';
        },
        async eval(script: string, _numKeys: number, key: string, ...args: Array<string | number>) {
            const current = store.get(key);
            if (script.includes('ttl')) { // adopt
                const [predecessor, successor, ttlSeconds, floor] = args;
                if (!current) { store.set(key, { value: String(successor), ttl: Number(ttlSeconds) }); return 1; }
                if (current.value !== String(predecessor)) return 0;
                if (current.ttl > Number(floor)) return -1;
                store.set(key, { value: String(successor), ttl: Number(ttlSeconds) });
                return 1;
            }
            if (script.includes('del')) { // release
                if (current?.value === String(args[0])) { store.delete(key); return 1; }
                return 0;
            }
            if (script.includes('expire')) { // renew
                if (current?.value === String(args[0])) { current.ttl = Number(args[1]); return 1; }
                return 0;
            }
            throw new Error('Unknown lock script');
        },
        async quit() { return 'OK'; },
    };
}

interface FakeComment { id: number; body: string; html_url: string }

function createOctokit() {
    const comments: FakeComment[] = [];
    let nextId = 1000;
    return {
        comments,
        async request(route: string, params?: Record<string, unknown>) {
            if (route.startsWith('GET ') && route.includes('/pulls/')) return { data: { head: { ref: BRANCH }, base: { ref: 'main' } } };
            if (route.startsWith('PATCH ')) {
                const found = comments.find(comment => comment.id === params?.comment_id);
                if (!found) throw Object.assign(new Error('Not Found'), { status: 404 });
                found.body = String(params?.body ?? '');
                return { data: found };
            }
            if (route.startsWith('POST ')) {
                const created = { id: nextId++, body: String(params?.body ?? ''), html_url: `https://example.test/comment/${nextId}` };
                comments.push(created);
                return { data: created };
            }
            throw new Error(`Unexpected request: ${route}`);
        },
        async paginate() { return [...comments]; },
        async auth() { return { token: 'installation-token' }; },
    };
}

function createHarness() {
    return createFixture().then(fx => {
        const states = new Map<string, string>([['task-1', 'processing']]);
        const stateManager = {
            states,
            async getTaskState(taskId: string) { return states.has(taskId) ? { state: states.get(taskId)! } : null; },
            async updateTaskState(taskId: string, state: string) { states.set(taskId, state); },
            async updateHistoryMetadata() { return undefined; },
        };
        const octokit = createOctokit();
        const restored: number[] = [];
        const withdrawn: number[] = [];
        const scheduled: string[] = [];
        const h = {
            fx, stateManager, octokit, restored, withdrawn, scheduled,
            onSchedule: (() => undefined) as () => void,
            deps: {} as Record<string, unknown>,
        };
        h.deps = {
            store: { database }, redis: createLockRedis(), log: silentLog, stateManager,
            getOctokit: async () => octokit,
            inspectLiveness: async () => ({ liveness: 'not_found' }),
            // Production git operations over the real core implementations.
            git: createFollowupHandoffGitOps(async () => 'installation-token'),
            restoreComments: async (_record: unknown, claimed: Array<{ id: number }>) => { restored.push(...claimed.map(comment => comment.id)); },
            withdrawRestoredComments: async (_record: unknown, claimed: Array<{ id: number }>) => { withdrawn.push(...claimed.map(comment => comment.id)); },
            scheduleRestoredComments: async (record: HandoffRecord) => { scheduled.push(record.incarnation); h.onSchedule(); },
            taskStates: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
        };
        return h;
    });
}

async function seedHandoff(h: Awaited<ReturnType<typeof createHarness>>): Promise<HandoffRecord> {
    const record = await recordFollowupHandoff({
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 },
        taskId: 'task-1', sourceTaskIds: [], correlationId: 'corr-1',
        target: { repoOwner: 'acme', repoName: 'widgets', branchName: BRANCH, isFork: false },
        worktreePath: h.fx.wt, localRepoPath: h.fx.local,
        claimedComments: [{ id: 11, body: 'please fix the widget', author: 'alice', type: 'issue' }],
        jobData: { pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets', correlationId: 'corr-1' } as never,
        llm: 'claude', lockKey: LOCK, lockToken: 'dead-worker-token',
        binding: { headSha: git(h.fx.wt, 'rev-parse', 'HEAD') },
    }, { database });
    assert.ok(record);
    h.octokit.comments.push({ id: 500, body: '🤖 Starting work on the follow-up', html_url: 'https://example.test/comment/500' });
    const linked = await advanceFollowupHandoff({ database }, record, { phase: 'agent_exited', starting_comment_id: 500 });
    assert.ok(linked);
    return linked;
}

const branchOf = (wt: string) => git(wt, 'branch', '--show-current');

beforeEach(async () => {
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).delete();
    pushes.length = 0;
    retries.length = 0;
    onRetryScheduled = () => undefined;
});

const CLAIMED = [{ id: 11, body: 'please fix the widget', author: 'alice', type: 'issue' }];

/** The real normal usage-limit handler with the production checkpoint hook; the worker then dies before settling. */
async function hitUsageLimit(h: Awaited<ReturnType<typeof createHarness>>, record: HandoffRecord): Promise<void> {
    const state = { followupHandoff: record };
    await handleJobError(new UsageLimitError('Claude usage limit reached', Math.floor(Date.now() / 1000) + 3600),
        { id: 'job-1', name: 'processPullRequestComment', data: { pullRequestNumber: 7, comments: CLAIMED }, attemptsMade: 0, opts: {} } as never, {
            pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets', authorsText: '@alice',
            unprocessedComments: CLAIMED as never, octokit: h.octokit as never, startingWorkComment: { data: { id: 500 } },
            claudeResult: null, correlationId: 'corr-1', correlatedLogger: silentLog as never,
            stateManager: h.stateManager as never, taskId: 'task-1', retryComments: CLAIMED as never, followupHandoff: record,
            checkpointUsageLimitRetry: stage => checkpointExecutionHandoffUsageLimitRetry(state, stage, silentLog as never),
        });
}

test('usage-limit crash window: a scheduled retry keeps its claimed comments through a standalone recovery pass', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await hitUsageLimit(h, record);
    assert.equal(retries.length, 1, 'the retry job carrying the claim was scheduled');
    assert.equal(h.octokit.comments.length, 2, 'the delay comment was posted');
    const delay = h.octokit.comments[1].body;
    assert.match(delay, /Processing Delayed/);
    const pending = await loadFollowupHandoff({ database }, KEY);
    assert.equal(pending?.settlement, SETTLEMENT_RETRY_SCHEDULED, 'the retry ownership is durable before the handoff settles');

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.errors, 0);
    assert.equal(summary.settled, 1, 'reconciled to the settlement outcome');
    assert.equal(summary.noChanges, 0);
    assert.deepEqual(h.restored, [], 'the retry-owned comments are never returned to the pending list');
    assert.equal(h.scheduled.length, 0, 'no second follow-up is queued for them');
    assert.equal(h.octokit.comments.length, 2, 'no interrupted notice is posted');
    assert.equal(h.octokit.comments[0].body, '🤖 Starting work on the follow-up', 'the starting comment is left alone');
    assert.equal(h.octokit.comments[1].body, delay, 'the delay comment is left alone');
    assert.equal(h.stateManager.states.get('task-1'), 'cancelled', 'the attempt ends requeued, as its job result would record');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined, 'the handoff retires');
    assert.equal(branchOf(h.fx.wt), '', 'the branch is free for the retry');

    const again = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(again.inspected, 0, 'a repeated pass finds nothing to do');
    assert.deepEqual(h.restored, []);
});

test('usage-limit crash window: the retry job adopting its predecessor in-line does not requeue its own comments', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await hitUsageLimit(h, record);

    const adoption = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: 'retry-job-1', log: silentLog, lockToken: 'retry-job-1-token' },
        h.deps,
    );
    assert.deepEqual(adoption, { resumed: { outcome: 'settled' } });
    assert.deepEqual(h.restored, [], 'the adopting retry is the only owner of the claim');
    assert.equal(h.octokit.comments.length, 2);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    assert.equal(branchOf(h.fx.wt), '');
});

test('usage-limit crash window: a death around the queue add fails closed, and an operator resume returns the request once', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    // The queue add lands, then the worker dies before confirming it.
    onRetryScheduled = () => { throw new Error('worker killed'); };
    await assert.rejects(hitUsageLimit(h, record), /worker killed/);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.settlement, SETTLEMENT_RETRY_SCHEDULING);

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.awaitingOperator, 1);
    assert.deepEqual(h.restored, [], 'a possibly retry-owned claim is not returned to the queue');
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(held?.status_reason, 'usage_limit_retry_unconfirmed');
    const [status] = await inspectFollowupHandoffs({ store: { database }, inspectLiveness: async () => ({ liveness: 'not_found' }) } as never);
    assert.match(status.nextAction, /usage-limit retry job/);

    // The operator found no retry job and resumes: the request returns exactly once.
    assert.deepEqual(await resumeOperatorHeldFollowupHandoff(KEY, h.deps as never), { resumed: true });
    const resumed = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(resumed.noChanges, 1);
    assert.deepEqual(h.restored, [11]);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

test('a liveness warning recorded during cleanup keeps the returned request classified as noChanges', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    // The first pass returns the request but cannot release the branch yet.
    await writeFile(path.join(h.fx.wt, 'scratch.txt'), 'transient\n');
    const realGit = h.deps.git as ReturnType<typeof createFollowupHandoffGitOps>;
    h.deps.git = { ...realGit, hasUncommittedChanges: async () => false };
    const first = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(first.cleanupPending, 1);
    assert.deepEqual(h.restored, [11]);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.settlement, SETTLEMENT_RETURNED_TO_QUEUE);
    await rm(path.join(h.fx.wt, 'scratch.txt'));
    h.deps.git = realGit;

    // A later pass cannot read container liveness and records the diagnostic.
    h.deps.inspectLiveness = async () => ({ liveness: 'unavailable' });
    const blind = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(blind.failedClosed, 1);
    const warned = await loadFollowupHandoff({ database }, KEY);
    assert.equal(warned?.status_reason, 'liveness_unavailable', 'the diagnostic reason is overwritten');
    assert.equal(warned?.settlement, SETTLEMENT_RETURNED_TO_QUEUE, 'the durable classification is not');
    const [status] = await inspectFollowupHandoffs({ store: { database }, inspectLiveness: async () => ({ liveness: 'unavailable' }) } as never);
    assert.equal(status.record.settlement, SETTLEMENT_RETURNED_TO_QUEUE, 'operator status reports the durable classification');

    h.deps.inspectLiveness = async () => ({ liveness: 'not_found' });
    const retired = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(retired.noChanges, 1, 'the returned request is still counted as noChanges');
    assert.equal(retired.settled, 0);
    assert.deepEqual(h.restored, [11], 'cleanup retries never return it twice');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    assert.equal(branchOf(h.fx.wt), '');
});

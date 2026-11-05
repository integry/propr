import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { up } from '../packages/core/src/db/migrations/20261017000000_add_pr_followup_handoffs.js';

/**
 * Usage-limit retry ownership on the follow-up handoff, run over the real
 * normal error handler, the real handoff checkpoints, the real retry
 * persistence (`schedulePRCommentUsageLimitRetry`, including its
 * duplicate-job reconciliation) and the production git operations. Only the
 * queue backend is in memory, with BullMQ's duplicate-ID semantics: adding an
 * existing job ID returns the stored job and never overwrites its payload.
 *
 * - A handoff database outage while the retry would be scheduled fails
 *   closed: no retry is added and no delay comment is posted, so after the
 *   database returns, recovery is the request's only owner and returns it once.
 * - A swallowed ownership loss (the container-identity checkpoint's) equally
 *   refuses the retry instead of treating the lost handoff as absent.
 * - A durable `scheduling` checkpoint whose confirmation fails stays held as
 *   unconfirmed rather than requeued.
 * - Retry persistence that lands on a reconciled fallback job transfers the
 *   claim to exactly that queued job.
 * - Unpublished edits retained beside a scheduled retry are never published:
 *   the requeue's CANCELLED state is no user cancellation, and neither an
 *   operator's authorization nor resumption of such a hold publishes them.
 * - Unpublished edits beside an unconfirmed retry are held for an operator
 *   before collection, by standalone recovery and inline adoption alike.
 * - An operator release of that hold records that the retry owns the
 *   request, so neither the release nor the retry's admission suppresses it.
 */

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
const root = await mkdtemp(path.join(tmpdir(), 'followup-handoff-usage-limit-'));

// The worker's handoff database; an outage makes every query it starts fail,
// while the test's own reads and recovery passes use the database directly.
let databaseOutage = false;
const workerDb = new Proxy(database, {
    apply(target, thisArg, args) {
        if (databaseOutage) throw new Error('handoff database unavailable');
        return Reflect.apply(target, thisArg, args);
    },
});

interface QueuedJob { id: string; name: string; data: { comments?: Array<{ id: number }>; prProcessingLockToken?: string }; state: string; getState(): Promise<string>; remove(): Promise<void> }
const queued = new Map<string, QueuedJob>();
let onQueueAdd: (jobId: string) => void = () => undefined;
function storeJob(id: string, name: string, data: QueuedJob['data'], state: string): QueuedJob {
    const job: QueuedJob = {
        id, name, data: structuredClone(data), state,
        async getState() { return job.state; },
        async remove() { queued.delete(id); },
    };
    queued.set(id, job);
    return job;
}
const issueQueue = {
    async add(name: string, data: QueuedJob['data'], options: { jobId: string }) {
        const existing = queued.get(options.jobId);
        if (existing) return existing;
        const job = storeJob(options.jobId, name, data, 'delayed');
        onQueueAdd(options.jobId);
        return job;
    },
    async getJob(jobId: string) { return queued.get(jobId); },
};

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return silentLog; } };
const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
    '-c', 'protocol.file.allow=always', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const BRANCH = 'propr/pr-head';
const KEY = { repository: 'acme/widgets', pull_request: 7 };
const LOCK = 'lock:pr:acme:widgets:7';

const core = await import('@propr/core');
await mock.module('@propr/core', {
    namedExports: { ...core, db: workerDb, logger: silentLog, issueQueue },
});
await mock.module('../src/jobs/prContributionDiscussion.js', { namedExports: { loadOriginalContributionDiscussion: async () => undefined } });
after(async () => {
    await database.destroy();
    await core.closeConnection?.();
    await rm(root, { recursive: true, force: true });
});

const {
    recordFollowupHandoff, advanceFollowupHandoff, loadFollowupHandoff, loadCancelledClaimIds, PR_FOLLOWUP_HANDOFFS_TABLE,
    PR_FOLLOWUP_CANCELLED_CLAIMS_TABLE, HANDOFF_AWAITING_OPERATOR, HANDOFF_RELEASED, SETTLEMENT_RETRY_SCHEDULED, SETTLEMENT_RETRY_SCHEDULING,
} = await import('../src/jobs/followupHandoffStore.js');
const {
    recoverInterruptedFollowupHandoffs, adoptPredecessorFollowupHandoff, settleFollowupHandoffAfterFailure,
} = await import('../src/jobs/followupHandoffRecovery.js');
const { authorizeCancelledFollowupHandoff, releaseFollowupHandoffRecord, resumeOperatorHeldFollowupHandoff } = await import('../src/jobs/followupHandoffOperator.js');
const { createFollowupHandoffGitOps } = await import('../src/jobs/followupHandoffGitOps.js');
const { handleJobError, UsageLimitError } = await import('../src/jobs/prCommentJobUtils.js');
const {
    checkpointExecutionHandoffUsageLimitRetry, gatePredecessorHandoff, markExecutionHandoffContainer, FollowupHandoffOwnershipLostError,
} = await import('../src/jobs/prCommentHandoffIntegration.js');

type HandoffRecord = NonNullable<Awaited<ReturnType<typeof loadFollowupHandoff>>>;
interface HandoffState { followupHandoff?: HandoffRecord | null; followupHandoffOwnershipLost?: boolean }
let fixtureIndex = 0;

async function createFixture() {
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
    return { local, wt };
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

async function createHarness() {
    const fx = await createFixture();
    const states = new Map<string, string>([['task-1', 'processing']]);
    const stateManager = {
        states,
        async getTaskState(taskId: string) { return states.has(taskId) ? { state: states.get(taskId)! } : null; },
        async updateTaskState(taskId: string, state: string) { states.set(taskId, state); },
        async updateHistoryMetadata() { return undefined; },
    };
    const octokit = createOctokit();
    const restored: number[] = [];
    const scheduled: string[] = [];
    const deps = {
        store: { database }, redis: createLockRedis(), log: silentLog, stateManager,
        getOctokit: async () => octokit,
        inspectLiveness: async () => ({ liveness: 'not_found' }),
        git: createFollowupHandoffGitOps(async () => 'installation-token'),
        restoreComments: async (_record: unknown, claimed: Array<{ id: number }>) => { restored.push(...claimed.map(comment => comment.id)); },
        withdrawRestoredComments: async () => undefined,
        scheduleRestoredComments: async (record: HandoffRecord) => { scheduled.push(record.incarnation); },
        taskStates: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
    };
    return { fx, stateManager, octokit, restored, scheduled, deps };
}
type Harness = Awaited<ReturnType<typeof createHarness>>;

const CLAIMED = [{ id: 11, body: 'please fix the widget', author: 'alice', type: 'issue' }];
const SOURCE_JOB = { id: 'job-1', name: 'processPullRequestComment', data: { pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets', correlationId: 'corr-1', comments: CLAIMED, prProcessingLockToken: 'dead-worker-token' }, attemptsMade: 0, opts: {} };

async function seedHandoff(h: Harness): Promise<HandoffRecord> {
    const record = await recordFollowupHandoff({
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 },
        taskId: 'task-1', sourceTaskIds: [], correlationId: 'corr-1',
        target: { repoOwner: 'acme', repoName: 'widgets', branchName: BRANCH, isFork: false },
        worktreePath: h.fx.wt, localRepoPath: h.fx.local, claimedComments: CLAIMED as never,
        jobData: SOURCE_JOB.data as never, llm: 'claude', lockKey: LOCK, lockToken: 'dead-worker-token',
        binding: { headSha: git(h.fx.wt, 'rev-parse', 'HEAD') },
    }, { database });
    assert.ok(record);
    h.octokit.comments.push({ id: 500, body: '🤖 Starting work on the follow-up', html_url: 'https://example.test/comment/500' });
    const linked = await advanceFollowupHandoff({ database }, record, { phase: 'agent_exited', starting_comment_id: 500 });
    assert.ok(linked);
    return linked;
}

/** The real normal usage-limit handler with the production checkpoint hook; the worker then dies before settling. */
async function hitUsageLimit(h: Harness, state: HandoffState): Promise<void> {
    await handleJobError(new UsageLimitError('Claude usage limit reached', Math.floor(Date.now() / 1000) + 3600), SOURCE_JOB as never, {
        pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets', authorsText: '@alice',
        unprocessedComments: CLAIMED as never, octokit: h.octokit as never, startingWorkComment: { data: { id: 500 } },
        claudeResult: null, correlationId: 'corr-1', correlatedLogger: silentLog as never,
        stateManager: h.stateManager as never, taskId: 'task-1', retryComments: CLAIMED as never, followupHandoff: state.followupHandoff,
        checkpointUsageLimitRetry: stage => checkpointExecutionHandoffUsageLimitRetry(state as never, stage, silentLog as never),
    });
}

const delayComments = (h: Harness) => h.octokit.comments.filter(comment => /Processing Delayed/.test(comment.body));
const branchOf = (wt: string) => git(wt, 'branch', '--show-current');

beforeEach(async () => {
    databaseOutage = false;
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).delete();
    await database(PR_FOLLOWUP_CANCELLED_CLAIMS_TABLE).delete();
    queued.clear();
    onQueueAdd = () => undefined;
});

test('a handoff database outage at the retry checkpoints schedules no retry, and recovery returns the request once', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    // Both settlement writes fail; queue persistence and GitHub stay available.
    databaseOutage = true;
    await assert.rejects(hitUsageLimit(h, { followupHandoff: record }), /handoff database unavailable/);
    assert.equal(queued.size, 0, 'no retry job takes the claim without durable ownership');
    assert.deepEqual(delayComments(h), [], 'no delay comment promises a retry that does not exist');
    // The worker dies here, before the handoff's error settlement.
    databaseOutage = false;
    const pending = await loadFollowupHandoff({ database }, KEY);
    assert.equal(pending?.settlement ?? null, null);

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.errors, 0);
    assert.equal(summary.noChanges, 1);
    assert.deepEqual(h.restored, [11], 'recovery, the only owner, returns the request');
    assert.equal(h.scheduled.length, 1, 'exactly one follow-up is scheduled for it');
    assert.equal(queued.size, 0, 'no usage-limit retry owns it alongside');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    assert.equal(branchOf(h.fx.wt), '');

    const again = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(again.inspected, 0);
    assert.deepEqual(h.restored, [11], 'a repeated pass never returns it twice');
});

test('a swallowed ownership loss refuses the usage-limit retry instead of treating the handoff as absent', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const state: HandoffState = { followupHandoff: record };
    // Recovery took the row over; the container-identity callback's loss is swallowed by the agent.
    assert.ok(await advanceFollowupHandoff({ database }, record, { lock_token: 'handoff-recovery:successor' }));
    await assert.rejects(markExecutionHandoffContainer(state as never, 'container-1'), FollowupHandoffOwnershipLostError);
    assert.equal(state.followupHandoff, null);

    await assert.rejects(hitUsageLimit(h, state), FollowupHandoffOwnershipLostError);
    assert.equal(queued.size, 0, 'the successor owning the handoff stays the claim\'s only owner');
    assert.deepEqual(delayComments(h), []);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.settlement ?? null, null);
});

test('a failed retry confirmation after a durable scheduling checkpoint is held as unconfirmed, never requeued', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    // The outage begins once the retry job is persisted.
    onQueueAdd = () => { databaseOutage = true; };
    await hitUsageLimit(h, { followupHandoff: record });
    assert.equal(queued.size, 1, 'the retry exists');
    assert.equal(delayComments(h).length, 1, 'the delay comment was posted');
    databaseOutage = false;
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.settlement, SETTLEMENT_RETRY_SCHEDULING, 'the uncertain state is durable');

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.awaitingOperator, 1);
    assert.deepEqual(h.restored, [], 'the possibly retry-owned claim is not returned');
    assert.equal(h.scheduled.length, 0);
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(held?.status_reason, 'usage_limit_retry_unconfirmed');
});

// Review 6230432423 F35: a recovery that adopts the handoff while the retry is
// being scheduled owns everything after; the obsolete writer's confirmation
// propagates the loss instead of announcing a delay it no longer owns.
test('a takeover during retry scheduling propagates ownership loss past the delay comment', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const state: HandoffState = { followupHandoff: record };
    let successor: HandoffRecord | null = null;
    // The source worker stalls while the retry job is persisted; its lease
    // expires and a recovery pass installs its own durable owner token.
    const realAdd = issueQueue.add;
    issueQueue.add = async (...args: Parameters<typeof realAdd>) => {
        const job = await realAdd(...args);
        const scheduling = await loadFollowupHandoff({ database }, KEY);
        successor = await advanceFollowupHandoff({ database }, scheduling!, { lock_token: 'handoff-recovery:successor' });
        return job;
    };
    try {
        await assert.rejects(hitUsageLimit(h, state), FollowupHandoffOwnershipLostError);
    } finally {
        issueQueue.add = realAdd;
    }
    assert.ok(successor, 'the successor took the row over');
    assert.equal(state.followupHandoffOwnershipLost, true);
    assert.equal(state.followupHandoff, null);
    assert.equal(queued.size, 1, 'the retry was already persisted before the takeover was observed');
    assert.deepEqual(delayComments(h), [], 'the obsolete writer posts no delay comment');
    const row = await loadFollowupHandoff({ database }, KEY);
    assert.equal(row?.lock_token, 'handoff-recovery:successor');
    assert.equal(row?.settlement, SETTLEMENT_RETRY_SCHEDULING, "the successor's view of the uncertain retry is not overwritten");
});

test('real retry persistence reconciles a terminal duplicate and hands the claim to the queued fallback job', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    // An earlier retry of the same claim under the same deterministic attempt ID
    // already ran to completion: it carries the comments but can no longer own them.
    const attempt = createHash('sha256').update(JSON.stringify({ correlationId: 'corr-1', sourceJobId: 'job-1' })).digest('hex').slice(0, 16);
    const attemptJobId = `pr-comments-batch-acme-widgets-7-default-main-ratelimit-retry-${attempt}`;
    storeJob(attemptJobId, 'processPullRequestComment', { comments: [{ id: 11 }], prProcessingLockToken: 'stale' }, 'completed');

    await hitUsageLimit(h, { followupHandoff: record });
    const owners = [...queued.values()].filter(job => job.id !== attemptJobId);
    assert.equal(owners.length, 1, 'one new queued job owns the claim');
    const [owner] = owners;
    assert.equal(owner.state, 'delayed');
    assert.deepEqual(owner.data.comments?.map(comment => comment.id), [11], 'the queued job carries the claimed comments');
    assert.equal(owner.data.prProcessingLockToken, undefined, 'it does not inherit the dead attempt\'s lease');
    assert.equal(queued.get(attemptJobId)?.data.prProcessingLockToken, 'stale', 'the terminal duplicate is left untouched');
    const [delay] = delayComments(h);
    assert.ok(delay?.body.includes(`Job ID: ${owner.id} `), 'the delay comment names the job that owns the claim');
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.settlement, SETTLEMENT_RETRY_SCHEDULED);

    // That job adopts its predecessor in-line before preparing a worktree.
    const adoption = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: owner.id, log: silentLog, lockToken: `${owner.id}-token` },
        h.deps as never,
    );
    assert.deepEqual(adoption, { resumed: { outcome: 'settled' } });
    assert.deepEqual(h.restored, [], 'the queued retry stays the claim\'s only owner');
    assert.equal(h.scheduled.length, 0);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    assert.equal(branchOf(h.fx.wt), '', 'the branch is free for the retry');
});

// Retained unpublished edits plus a scheduled retry: the retry is the one
// owner of execution, so recovery never commits, pushes or comments the
// replaced attempt's edits — they stay in the worktree, unpublished.
async function retainEditsBesideScheduledRetry(h: Harness): Promise<string> {
    const record = await seedHandoff(h);
    const baseHead = git(h.fx.wt, 'rev-parse', 'HEAD');
    await writeFile(path.join(h.fx.wt, 'widget.txt'), 'half-finished edit\n');
    await hitUsageLimit(h, { followupHandoff: record });
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.settlement, SETTLEMENT_RETRY_SCHEDULED);
    assert.equal(queued.size, 1, 'the retry owns the request');
    return baseHead;
}

async function assertRetryRemainsSoleOwner(h: Harness, baseHead: string): Promise<void> {
    assert.equal(git(h.fx.local, 'ls-remote', 'origin', `refs/heads/${BRANCH}`).split('\t')[0], baseHead, 'nothing was pushed');
    assert.equal(git(h.fx.local, 'rev-parse', BRANCH), baseHead, 'nothing was committed onto the branch');
    assert.equal(h.octokit.comments.filter(comment => comment.id !== 500 && !/Processing Delayed/.test(comment.body)).length, 0, 'no completion comment');
    assert.equal(h.octokit.comments.find(comment => comment.id === 500)?.body, '🤖 Starting work on the follow-up', 'the starting comment is left alone');
    assert.deepEqual(h.restored, []);
    assert.equal(h.scheduled.length, 0);
    assert.equal(queued.size, 1, 'the scheduled retry still owns the request');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    assert.equal(branchOf(h.fx.wt), '', 'the branch is free for the retry');
    assert.match(git(h.fx.wt, 'status', '--porcelain'), /widget\.txt/, 'the retained edits stay in the worktree');
}

test('retained edits beside a scheduled retry settle without a cancellation hold and are never published', async () => {
    const h = await createHarness();
    const baseHead = await retainEditsBesideScheduledRetry(h);
    // The normal path settles the handoff, then its finalizer records the requeue as CANCELLED.
    await settleFollowupHandoffAfterFailure({ repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, taskId: 'task-1', cancelled: false }, { store: { database } });
    const settled = await loadFollowupHandoff({ database }, KEY);
    assert.equal(settled?.status, 'active');
    assert.equal(settled?.phase, 'cleanup_pending', 'only branch release is owed');
    h.stateManager.states.set('task-1', 'cancelled');

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.errors, 0);
    assert.equal(summary.awaitingOperator, 0, 'the requeue is not held as a user cancellation');
    await assertRetryRemainsSoleOwner(h, baseHead);
});

test('an operator authorizing a retry-owned cancellation hold re-arms no publication of the retained edits', async () => {
    const h = await createHarness();
    const baseHead = await retainEditsBesideScheduledRetry(h);
    // A hold recorded before the fix: the requeued attempt classified as a user cancellation.
    const record = await loadFollowupHandoff({ database }, KEY);
    assert.ok(await advanceFollowupHandoff({ database }, record!, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'cancelled_by_user' }));
    h.stateManager.states.set('task-1', 'cancelled');

    const authorized = await authorizeCancelledFollowupHandoff(KEY, h.deps as never);
    assert.ok(authorized);
    assert.equal(authorized.operator_authorized ? 1 : 0, 0, 'no publication authority is granted');
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.errors, 0);
    assert.equal(summary.awaitingOperator, 0);
    await assertRetryRemainsSoleOwner(h, baseHead);
});

test('an operator resuming a retry-owned cancellation hold hands the request to the retry, which adopts it without publishing', async () => {
    const h = await createHarness();
    const baseHead = await retainEditsBesideScheduledRetry(h);
    const record = await loadFollowupHandoff({ database }, KEY);
    assert.ok(await advanceFollowupHandoff({ database }, record!, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'cancelled_by_user' }));
    h.stateManager.states.set('task-1', 'cancelled');

    assert.deepEqual(await resumeOperatorHeldFollowupHandoff(KEY, h.deps as never), { resumed: true }, 'the requeue needs no cancellation authorization');
    // Even a stale authorization flag on the row grants no publication.
    const resumed = await loadFollowupHandoff({ database }, KEY);
    assert.ok(await advanceFollowupHandoff({ database }, resumed!, { operator_authorized: 1 }));
    const [retry] = [...queued.values()];
    const adoption = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: retry.id, log: silentLog, lockToken: `${retry.id}-token` },
        h.deps as never,
    );
    assert.deepEqual(adoption, { resumed: { outcome: 'settled' } });
    await assertRetryRemainsSoleOwner(h, baseHead);
});

// Review 6231027074 F42: the retry is persisted but the worker dies before
// confirming it, with unpublished edits retained. The retry may already own
// the request, so recovery holds before collecting the edits — through either
// entry point, and ahead of a cancellation hold an operator could authorize.
async function retainEditsBesideUnconfirmedRetry(h: Harness): Promise<string> {
    const record = await seedHandoff(h);
    const baseHead = git(h.fx.wt, 'rev-parse', 'HEAD');
    await writeFile(path.join(h.fx.wt, 'widget.txt'), 'half-finished edit\n');
    onQueueAdd = () => { databaseOutage = true; };
    await hitUsageLimit(h, { followupHandoff: record });
    databaseOutage = false;
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.settlement, SETTLEMENT_RETRY_SCHEDULING);
    assert.equal(queued.size, 1, 'the retry was persisted');
    return baseHead;
}

async function assertHeldWithEditsUnpublished(h: Harness, baseHead: string): Promise<void> {
    assert.equal(git(h.fx.local, 'ls-remote', 'origin', `refs/heads/${BRANCH}`).split('\t')[0], baseHead, 'nothing was pushed');
    assert.equal(git(h.fx.wt, 'rev-parse', 'HEAD'), baseHead, 'nothing was committed');
    assert.match(git(h.fx.wt, 'status', '--porcelain'), /widget\.txt/, 'the retained edits stay in the worktree');
    assert.equal(h.octokit.comments.filter(comment => comment.id !== 500 && !/Processing Delayed/.test(comment.body)).length, 0, 'no completion comment');
    assert.equal(h.octokit.comments.find(comment => comment.id === 500)?.body, '🤖 Starting work on the follow-up', 'the starting comment is left alone');
    assert.deepEqual(h.restored, [], 'the possibly retry-owned claim is not returned');
    assert.equal(h.scheduled.length, 0);
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(held?.status_reason, 'usage_limit_retry_unconfirmed');
    assert.equal(held?.phase, 'agent_exited');
    assert.equal(held?.commit_hash ?? null, null);
    assert.equal(held?.settlement, SETTLEMENT_RETRY_SCHEDULING, 'the unresolved owner stays durable');
    const again = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(again.published, 0, 'a later pass publishes nothing either');
    assert.deepEqual(h.restored, []);
}

test('retained edits beside an unconfirmed retry are held by standalone recovery, never collected or published', async () => {
    const h = await createHarness();
    const baseHead = await retainEditsBesideUnconfirmedRetry(h);
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.errors, 0);
    assert.equal(summary.awaitingOperator, 1);
    assert.equal(summary.published, 0);
    await assertHeldWithEditsUnpublished(h, baseHead);
});

test('retained edits beside an unconfirmed retry are held by inline adoption, never collected or published', async () => {
    const h = await createHarness();
    const baseHead = await retainEditsBesideUnconfirmedRetry(h);
    const [retry] = [...queued.values()];
    const adoption = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: retry.id, log: silentLog, lockToken: `${retry.id}-token` },
        h.deps as never,
    );
    assert.deepEqual(adoption, { resumed: { outcome: 'awaiting_operator', reason: 'usage_limit_retry_unconfirmed' } });
    await assertHeldWithEditsUnpublished(h, baseHead);
});

test('a cancelled task beside an unconfirmed retry is held as unconfirmed, not as an authorizable user cancellation', async () => {
    const h = await createHarness();
    const baseHead = await retainEditsBesideUnconfirmedRetry(h);
    h.stateManager.states.set('task-1', 'cancelled');
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.awaitingOperator, 1);
    await assertHeldWithEditsUnpublished(h, baseHead);
});

// Review 6231097252 F43: the operator verified the persisted retry exists and
// force-releases the unconfirmed hold over the retained edits. The requeue
// left the attempt CANCELLED, which must not read as a user cancellation: the
// retry keeps its comments through the release and its own admission.
test('force-releasing an unconfirmed retry hold keeps the existing retry as the request\'s one owner', async () => {
    const h = await createHarness();
    const baseHead = await retainEditsBesideUnconfirmedRetry(h);
    h.stateManager.states.set('task-1', 'cancelled');
    const withdrawn: number[] = [];
    h.deps.withdrawRestoredComments = async (_record: unknown, claimed: Array<{ id: number }>) => { withdrawn.push(...claimed.map(entry => entry.id)); };
    assert.equal((await recoverInterruptedFollowupHandoffs(h.deps)).awaitingOperator, 1);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status_reason, 'usage_limit_retry_unconfirmed');

    assert.equal((await releaseFollowupHandoffRecord(KEY, { force: true }, h.deps as never)).released, true);
    const released = await loadFollowupHandoff({ database }, KEY);
    assert.equal(released?.status, HANDOFF_RELEASED);
    assert.equal(released?.settlement, SETTLEMENT_RETRY_SCHEDULED, 'the release persisted the retry as the owner');
    assert.deepEqual(await loadCancelledClaimIds({ database }, KEY), [], 'no suppression was recorded');
    assert.deepEqual(withdrawn, [], 'nothing was withdrawn as a cancellation');
    assert.equal(git(h.fx.local, 'ls-remote', 'origin', `refs/heads/${BRANCH}`).split('\t')[0], baseHead, 'nothing was pushed');
    assert.match(git(h.fx.wt, 'status', '--porcelain'), /widget\.txt/, 'the retained edits stay in the worktree');
    assert.equal(branchOf(h.fx.wt), '', 'the branch is free for the retry');

    // The existing retry reaches admission carrying the request.
    const [retry] = [...queued.values()];
    const commentsToProcess = (retry.data.comments ?? []).map(entry => ({ ...entry }));
    assert.deepEqual(commentsToProcess.map(entry => entry.id), [11]);
    const lockToken = `${retry.id}-token`;
    assert.equal(await h.deps.redis.set(LOCK, lockToken, 'EX', 3600, 'NX'), 'OK');
    const result = await gatePredecessorHandoff({
        job: { name: 'processPullRequestComment', data: retry.data } as never,
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 },
        taskId: retry.id, stateManager: h.stateManager as never, redisClient: h.deps.redis as never,
        commentsToProcess: commentsToProcess as never, pickedUpComments: [], lockKey: LOCK, lockToken, correlatedLogger: silentLog as never,
    });
    assert.equal(result, undefined, 'the retry is admitted');
    assert.deepEqual(commentsToProcess.map(entry => entry.id), [11], 'and keeps its request');
});

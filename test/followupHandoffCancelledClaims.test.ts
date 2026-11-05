import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { up } from '../packages/core/src/db/migrations/20261017000000_add_pr_followup_handoffs.js';

/**
 * Regressions for review 6230272784, run over the production git operations,
 * the real handoff store and the real recovery/release paths:
 *
 * - F32: a cancelled request's claimed comments never become executable
 *   again without explicit authorization. A worker death between restoring
 *   them and withdrawing them is reconciled by the next pass's cancellation
 *   hold, and an operator release withdraws them (refusing until that
 *   succeeds) before the row stops blocking admission.
 * - F33: a writer that detected loss of handoff ownership stops every later
 *   checkpoint, including after a loss the container callback swallowed.
 * - A follow-up that claimed the cancelled comments from the pending list
 *   before taking the PR lease, and is admitted only after an operator
 *   released the cancelled predecessor, drops them before execution.
 * - F37: that holds even when an unrelated follow-up ran in between and
 *   replaced, then retired, the released handoff row.
 * - F40: an explicit authorization after a refused release revokes the
 *   suppression that release recorded, so the authorized request returned to
 *   the queue still executes.
 * - F41: a scheduled usage-limit retry keeps its claims through an operator
 *   release of the requeued (CANCELLED) attempt it replaced.
 */

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
const root = await mkdtemp(path.join(tmpdir(), 'followup-handoff-cancelled-claims-'));

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return silentLog; } };
const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
    '-c', 'protocol.file.allow=always', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const BRANCH = 'propr/pr-head';
const KEY = { repository: 'acme/widgets', pull_request: 7 };
const LOCK = 'lock:pr:acme:widgets:7';

// Real core git operations; only the database and logger are local.
const core = await import('@propr/core');
await mock.module('@propr/core', { namedExports: { ...core, db: database, logger: silentLog } });
after(async () => {
    await database.destroy();
    await core.closeConnection?.();
    await rm(root, { recursive: true, force: true });
});

const {
    recordFollowupHandoff, advanceFollowupHandoff, finalizeFollowupHandoff, loadFollowupHandoff, recordFollowupHandoffDiagnostic,
    PR_FOLLOWUP_HANDOFFS_TABLE, PR_FOLLOWUP_CANCELLED_CLAIMS_TABLE, HANDOFF_ACTIVE, HANDOFF_AWAITING_OPERATOR, HANDOFF_RELEASED, SETTLEMENT_RETRY_SCHEDULING,
    SETTLEMENT_RETRY_SCHEDULED, loadCancelledClaimIds,
} = await import('../src/jobs/followupHandoffStore.js');
const { authorizeCancelledFollowupHandoff, recoverInterruptedFollowupHandoffs, releaseFollowupHandoffRecord } = await import('../src/jobs/followupHandoffRecovery.js');
const { createFollowupHandoffGitOps } = await import('../src/jobs/followupHandoffGitOps.js');
const {
    FollowupHandoffOwnershipLostError, gatePredecessorHandoff, markExecutionHandoffAgentExited, markExecutionHandoffContainer,
    stopAfterHandoffOwnershipLoss, writerOwnedWorktree,
} = await import('../src/jobs/prCommentHandoffIntegration.js');

type HandoffRecord = NonNullable<Awaited<ReturnType<typeof loadFollowupHandoff>>>;

async function createFixture(name: string): Promise<{ local: string; wt: string }> {
    const dir = path.join(root, name);
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

let fixtureIndex = 0;

/**
 * The PR's pending-comment list is the set a later follow-up job would pick
 * up; restoration and withdrawal are idempotent by comment ID, as in Redis.
 */
async function createHarness() {
    const fx = await createFixture(`fx-${fixtureIndex++}`);
    const states = new Map<string, string>([['task-1', 'processing']]);
    const pending = new Set<number>();
    const comments: Array<{ id: number; body: string; html_url: string }> = [
        { id: 500, body: '🤖 Starting work on the follow-up', html_url: 'https://example.test/comment/500' },
    ];
    const h = {
        fx, states, pending, comments,
        onRestore: (() => undefined) as () => void,
        withdrawalFails: false,
        deps: {} as Record<string, unknown>,
    };
    h.deps = {
        store: { database }, redis: createLockRedis(), log: silentLog,
        stateManager: {
            async getTaskState(taskId: string) { return states.has(taskId) ? { state: states.get(taskId)! } : null; },
            async updateTaskState(taskId: string, state: string) {
                if (states.get(taskId) === 'cancelled') return { state: 'cancelled' };
                states.set(taskId, state);
                return { state };
            },
            async updateHistoryMetadata() { return undefined; },
        },
        getOctokit: async () => ({
            async request(route: string, params?: Record<string, unknown>) {
                if (route.startsWith('PATCH ')) {
                    const found = comments.find(comment => comment.id === params?.comment_id);
                    if (!found) throw Object.assign(new Error('Not Found'), { status: 404 });
                    found.body = String(params?.body ?? '');
                    return { data: found };
                }
                throw new Error(`Unexpected request: ${route}`);
            },
            async paginate() { return [...comments]; },
            async auth() { return { token: 'installation-token' }; },
        }),
        inspectLiveness: async () => ({ liveness: 'not_found' }),
        git: createFollowupHandoffGitOps(async () => 'installation-token'),
        restoreComments: async (_record: unknown, claimed: Array<{ id: number }>) => {
            for (const comment of claimed) pending.add(comment.id);
            h.onRestore();
        },
        withdrawRestoredComments: async (_record: unknown, claimed: Array<{ id: number }>) => {
            if (h.withdrawalFails) throw new Error('redis unavailable');
            for (const comment of claimed) pending.delete(comment.id);
        },
        scheduleRestoredComments: async () => undefined,
        taskStates: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
    };
    return h;
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function seedHandoff(h: Harness): Promise<HandoffRecord> {
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
    const linked = await advanceFollowupHandoff({ database }, record, { phase: 'agent_exited', starting_comment_id: 500 });
    assert.ok(linked);
    return linked;
}

/** A later follow-up job's pickup: whatever is pending runs once admission allows it. */
function laterFollowupPickup(h: Harness): number[] {
    return [...h.pending];
}

beforeEach(async () => {
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).delete();
    await database(PR_FOLLOWUP_CANCELLED_CLAIMS_TABLE).delete();
});

// --- F32: cancelled claims stay suppressed across interruptions and release.

test('F32: a worker death after restoration is reconciled on restart, and release keeps the cancelled claims out of the queue', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    // The user cancels while the restoration is awaited; the worker dies
    // after it succeeded but before its own late withdrawal could run.
    h.onRestore = () => {
        h.states.set('task-1', 'cancelled');
        throw new Error('worker killed');
    };
    const crashed = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(crashed.errors, 1);
    assert.deepEqual([...h.pending], [11], 'the restored claim is pending when the worker dies');
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_ACTIVE);

    h.onRestore = () => undefined;
    const restarted = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(restarted.awaitingOperator, 1);
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(held?.status_reason, 'cancelled_by_user');
    assert.deepEqual([...h.pending], [], 'the initial cancellation hold withdraws the claims an earlier pass restored');

    // The operator stops tracking the cancelled handoff, without authorizing it.
    const released = await releaseFollowupHandoffRecord(KEY, {}, h.deps as never);
    assert.equal(released.released, true);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_RELEASED);
    assert.deepEqual(laterFollowupPickup(h), [], 'a later follow-up cannot acquire the cancelled claims');
    assert.equal(h.states.get('task-1'), 'cancelled');
});

for (const reason of ['cancelled_by_user', 'liveness_unavailable']) {
    test(`F32: release withdraws a cancelled hold's pending claims with reason ${reason}`, async () => {
        const h = await createHarness();
        const record = await seedHandoff(h);
        // Earlier builds could overwrite a hold's reason with a liveness warning.
        // Seed that historical state directly; current diagnostics preserve holds.
        h.states.set('task-1', 'cancelled');
        h.pending.add(11);
        const held = await advanceFollowupHandoff({ database }, record, { status: HANDOFF_AWAITING_OPERATOR, status_reason: reason });
        assert.ok(held);
        assert.equal(await recordFollowupHandoffDiagnostic({ database }, held, 'liveness_unavailable'), false);
        assert.equal((await loadFollowupHandoff({ database }, KEY))?.status_reason, reason);

        assert.equal((await releaseFollowupHandoffRecord(KEY, {}, h.deps as never)).released, true);
        assert.deepEqual(laterFollowupPickup(h), [], 'the cancelled request cannot run after its release');
    });
}

test('F32: a failed withdrawal keeps the hold, and release refuses until the withdrawal succeeds', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    h.onRestore = () => { h.states.set('task-1', 'cancelled'); };
    h.withdrawalFails = true;
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.awaitingOperator, 1);
    assert.deepEqual([...h.pending], [11], 'Redis was unavailable for the withdrawal');

    const refused = await releaseFollowupHandoffRecord(KEY, {}, h.deps as never);
    assert.deepEqual(refused, { released: false, reason: 'cancelled_claims_withdrawal_failed' });
    const still = await loadFollowupHandoff({ database }, KEY);
    assert.equal(still?.status, HANDOFF_AWAITING_OPERATOR, 'the hold keeps blocking admission');
    assert.equal(git(h.fx.wt, 'branch', '--show-current'), BRANCH, 'nothing was released before the refusal');
    assert.deepEqual(laterFollowupPickup(h), [11], 'pending, but no follow-up is admitted while the hold stands');

    h.withdrawalFails = false;
    assert.equal((await releaseFollowupHandoffRecord(KEY, {}, h.deps as never)).released, true);
    assert.deepEqual(laterFollowupPickup(h), [], 'the retried withdrawal removed the cancelled claims');
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_RELEASED);
});

test('F32: releasing a hold whose task was not cancelled leaves the pending list alone', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    h.pending.add(11);
    const held = await advanceFollowupHandoff({ database }, record, {
        status: HANDOFF_AWAITING_OPERATOR, status_reason: 'usage_limit_retry_unconfirmed', settlement: SETTLEMENT_RETRY_SCHEDULING,
    });
    assert.ok(held);
    assert.equal((await releaseFollowupHandoffRecord(KEY, {}, h.deps as never)).released, true);
    assert.deepEqual(laterFollowupPickup(h), [11], 'only a cancelled request is withdrawn');
});

// --- A pending-list claim taken before the lease, admitted after the release.

type Comment = { id: number; body: string; author: string; type: 'issue' };
const comment = (id: number): Comment => ({ id, body: `request ${id}`, author: 'alice', type: 'issue' });

/** A later follow-up's destructive pending-list claim, taken before it holds the PR lease. */
function claimPendingBeforeLease(h: Harness): Comment[] {
    const claimed = [...h.pending].map(comment);
    h.pending.clear();
    return claimed;
}

/** Holds the cancelled predecessor with its claims still pending (the withdrawal failed). */
async function holdWithClaimsPending(h: Harness): Promise<void> {
    await seedHandoff(h);
    h.onRestore = () => { h.states.set('task-1', 'cancelled'); };
    h.withdrawalFails = true;
    assert.equal((await recoverInterruptedFollowupHandoffs(h.deps)).awaitingOperator, 1);
    assert.deepEqual([...h.pending], [11]);
    h.withdrawalFails = false;
}

async function admitAfterLease(
    h: Harness,
    captured: { commentsToProcess: Comment[]; pickedUpComments: Comment[] },
    taskId = 'task-2',
) {
    const redis = h.deps.redis as ReturnType<typeof createLockRedis>;
    const lockToken = `${taskId}-token`;
    assert.equal(await redis.set(LOCK, lockToken, 'EX', 3600, 'NX'), 'OK', 'the follow-up acquires the free lease');
    const result = await gatePredecessorHandoff({
        job: { name: 'processPullRequestComment', data: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 } } as never,
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 },
        taskId, stateManager: h.deps.stateManager as never, redisClient: redis as never,
        ...captured, lockKey: LOCK, lockToken, correlatedLogger: silentLog as never,
    });
    return { result, redis, lockToken };
}

test('a claim captured before the lease drops the released cancelled predecessor\'s comments before execution', async () => {
    const h = await createHarness();
    await holdWithClaimsPending(h);
    // The follow-up for a new comment claims the pending list, then waits for the lease.
    const pickedUpComments = claimPendingBeforeLease(h);
    const commentsToProcess = [comment(12), ...pickedUpComments];
    // Meanwhile the operator releases the cancelled predecessor; its
    // withdrawal finds nothing pending, because the follow-up holds the claim.
    assert.equal((await releaseFollowupHandoffRecord(KEY, {}, h.deps as never)).released, true);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_RELEASED);

    const { result } = await admitAfterLease(h, { commentsToProcess, pickedUpComments });
    assert.equal(result, undefined, 'the follow-up still runs its own request');
    assert.deepEqual(commentsToProcess.map(entry => entry.id), [12], 'the cancelled request is not executed');
    assert.deepEqual(pickedUpComments, [], 'nor restored to the pending list by a later reschedule');
    assert.equal(h.states.get('task-1'), 'cancelled');
});

test('a follow-up whose captured comments were all cancelled claims is skipped and frees the lease', async () => {
    const h = await createHarness();
    await holdWithClaimsPending(h);
    const pickedUpComments = claimPendingBeforeLease(h);
    // An empty pending-comment batch job: everything it captured is the cancelled claim.
    const commentsToProcess = [...pickedUpComments];
    assert.equal((await releaseFollowupHandoffRecord(KEY, {}, h.deps as never)).released, true);

    const { result, redis } = await admitAfterLease(h, { commentsToProcess, pickedUpComments });
    assert.deepEqual(result, { status: 'skipped', reason: 'cancelled_predecessor_claims', pullRequestNumber: 7 });
    assert.deepEqual(commentsToProcess, []);
    assert.equal(await redis.set(LOCK, 'next', 'EX', 3600, 'NX'), 'OK', 'the skipped follow-up released its lease');
    assert.deepEqual(laterFollowupPickup(h), [], 'the cancelled request never returns to the queue');
});

test('F37: an intervening follow-up that replaces and retires the released row does not let the captured cancelled claim execute', async () => {
    const h = await createHarness();
    await holdWithClaimsPending(h);
    // B claims the pending list (the cancelled request 11) for its new comment
    // 12, then pauses before taking the PR lease.
    const pickedUpComments = claimPendingBeforeLease(h);
    const commentsToProcess = [comment(12), ...pickedUpComments];
    assert.equal((await releaseFollowupHandoffRecord(KEY, {}, h.deps as never)).released, true);
    const released = await loadFollowupHandoff({ database }, KEY);
    assert.equal(released?.status, HANDOFF_RELEASED);

    // An unrelated follow-up C runs first: it passes the gate, records its own
    // handoff over the released row, finishes, and retires it.
    const cComments = [comment(13)];
    const c = await admitAfterLease(h, { commentsToProcess: cComments, pickedUpComments: [...cComments] }, 'task-3');
    assert.equal(c.result, undefined);
    assert.deepEqual(cComments.map(entry => entry.id), [13], "C's own request is untouched");
    h.states.set('task-3', 'processing');
    const cHandoff = await recordFollowupHandoff({
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 },
        taskId: 'task-3', sourceTaskIds: [], correlationId: 'corr-3',
        target: { repoOwner: 'acme', repoName: 'widgets', branchName: BRANCH, isFork: false },
        worktreePath: h.fx.wt, localRepoPath: h.fx.local, claimedComments: cComments,
        jobData: { pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets', correlationId: 'corr-3' } as never,
        llm: 'claude', lockKey: LOCK, lockToken: c.lockToken,
    }, { database });
    assert.ok(cHandoff, 'the released row is replaceable');
    assert.equal(cHandoff.incarnation === released?.incarnation, false, "C's handoff replaced the cancelled predecessor's identity");
    assert.equal(await finalizeFollowupHandoff({ database }, cHandoff), true);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined, 'no handoff row remains');
    await c.redis.eval('del', 1, LOCK, c.lockToken);

    // B resumes and is admitted under the lease.
    const { result } = await admitAfterLease(h, { commentsToProcess, pickedUpComments });
    assert.equal(result, undefined, 'B still runs its own request');
    assert.deepEqual(commentsToProcess.map(entry => entry.id), [12], 'the cancelled request is still dropped');
    assert.deepEqual(pickedUpComments, [], 'nor returned to the queue by a later reschedule');
    assert.deepEqual(laterFollowupPickup(h), []);
    assert.equal(h.states.get('task-1'), 'cancelled');
});

test('F37: release refuses when the cancelled-claim evidence cannot be recorded', async () => {
    const h = await createHarness();
    await holdWithClaimsPending(h);
    await database.schema.renameTable(PR_FOLLOWUP_CANCELLED_CLAIMS_TABLE, 'cancelled_claims_unavailable');
    try {
        const refused = await releaseFollowupHandoffRecord(KEY, {}, h.deps as never);
        assert.deepEqual(refused, { released: false, reason: 'cancelled_claims_withdrawal_failed' });
    } finally {
        await database.schema.renameTable('cancelled_claims_unavailable', PR_FOLLOWUP_CANCELLED_CLAIMS_TABLE);
    }
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR, 'the hold keeps blocking admission');
    assert.deepEqual(laterFollowupPickup(h), [11], 'nothing was withdrawn before the evidence was durable');
});

test('a released hold whose task was not cancelled leaves the captured comments alone', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const held = await advanceFollowupHandoff({ database }, record, {
        status: HANDOFF_AWAITING_OPERATOR, status_reason: 'usage_limit_retry_unconfirmed', settlement: SETTLEMENT_RETRY_SCHEDULING,
    });
    assert.ok(held);
    h.pending.add(11);
    const pickedUpComments = claimPendingBeforeLease(h);
    const commentsToProcess = [...pickedUpComments];
    assert.equal((await releaseFollowupHandoffRecord(KEY, {}, h.deps as never)).released, true);

    const { result } = await admitAfterLease(h, { commentsToProcess, pickedUpComments });
    assert.equal(result, undefined);
    assert.deepEqual(commentsToProcess.map(entry => entry.id), [11], 'only a cancelled request is dropped');
});

// --- F40: authorization supersedes the suppression a refused release recorded.

test('F40: authorizing a hold whose release was refused after recording suppression keeps the returned request executable', async () => {
    const h = await createHarness();
    await holdWithClaimsPending(h);
    // The release records the suppression evidence, then its withdrawal fails.
    h.withdrawalFails = true;
    assert.deepEqual(await releaseFollowupHandoffRecord(KEY, {}, h.deps as never), { released: false, reason: 'cancelled_claims_withdrawal_failed' });
    assert.deepEqual(await loadCancelledClaimIds({ database }, KEY), [11], 'the refused release left suppression evidence');
    h.withdrawalFails = false;

    assert.ok(await authorizeCancelledFollowupHandoff(KEY, h.deps as never));
    assert.deepEqual(await loadCancelledClaimIds({ database }, KEY), [], 'authorization revoked its own suppression');
    // Recovery returns the authorized no-change request to the queue and retires the handoff.
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.noChanges, 1);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);

    const pickedUpComments = claimPendingBeforeLease(h);
    const commentsToProcess = [...pickedUpComments];
    const { result } = await admitAfterLease(h, { commentsToProcess, pickedUpComments });
    assert.equal(result, undefined, 'the restored request is admitted');
    assert.deepEqual(commentsToProcess.map(entry => entry.id), [11], 'and executes');
});

test('F40: authorization keeps suppression another released cancellation recorded', async () => {
    const h = await createHarness();
    await holdWithClaimsPending(h);
    // An earlier, successfully released cancelled task's claim on this pull request.
    await database(PR_FOLLOWUP_CANCELLED_CLAIMS_TABLE).insert({ ...KEY, comment_id: 99, task_id: 'task-0', created_at: 1 });
    h.withdrawalFails = true;
    await releaseFollowupHandoffRecord(KEY, {}, h.deps as never);
    h.withdrawalFails = false;
    assert.ok(await authorizeCancelledFollowupHandoff(KEY, h.deps as never));
    assert.deepEqual(await loadCancelledClaimIds({ database }, KEY), [99]);
});

// --- F41: a scheduled usage-limit retry owns its claims through operator release.

test('F41: releasing a retry-owned handoff after failed cleanup keeps the scheduled retry\'s claims', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    assert.ok(await advanceFollowupHandoff({ database }, record, { settlement: SETTLEMENT_RETRY_SCHEDULED }));
    const realGit = h.deps.git as ReturnType<typeof createFollowupHandoffGitOps>;
    h.deps.git = { ...realGit, async releaseSettledWorktree() { throw new Error('index.lock exists'); } };

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.errors, 0);
    const pendingCleanup = await loadFollowupHandoff({ database }, KEY);
    assert.equal(pendingCleanup?.phase, 'cleanup_pending');
    assert.equal(pendingCleanup?.status, HANDOFF_ACTIVE);
    assert.equal(h.states.get('task-1'), 'cancelled', 'recovery recorded the requeued attempt');

    // The release condition is repaired and the operator releases the handoff.
    h.deps.git = realGit;
    assert.equal((await releaseFollowupHandoffRecord(KEY, {}, h.deps as never)).released, true);
    assert.deepEqual(await loadCancelledClaimIds({ database }, KEY), [], 'no suppression for the retry\'s claims');

    // The scheduled retry carries the claimed comment in its payload.
    const commentsToProcess = [comment(11)];
    const { result } = await admitAfterLease(h, { commentsToProcess, pickedUpComments: [] }, 'task-retry');
    assert.equal(result, undefined, 'the retry is admitted');
    assert.deepEqual(commentsToProcess.map(entry => entry.id), [11], 'and keeps its request');
});

test('F41: a user-cancelled hold without a scheduled retry is still suppressed on release', async () => {
    const h = await createHarness();
    await holdWithClaimsPending(h);
    assert.equal((await releaseFollowupHandoffRecord(KEY, {}, h.deps as never)).released, true);
    assert.deepEqual(await loadCancelledClaimIds({ database }, KEY), [11]);
    const commentsToProcess = [comment(11), comment(12)];
    const { result } = await admitAfterLease(h, { commentsToProcess, pickedUpComments: [] });
    assert.equal(result, undefined);
    assert.deepEqual(commentsToProcess.map(entry => entry.id), [12]);
});

// --- F33: detected ownership loss is a stop condition for every later checkpoint.

test('F33: a loss the container callback swallowed stops the next checkpoint instead of reading as no handoff', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const state: { followupHandoff?: HandoffRecord | null; followupHandoffOwnershipLost?: boolean; worktreeInfo?: { worktreePath: string } } = {
        followupHandoff: record, worktreeInfo: { worktreePath: h.fx.wt },
    };
    // Recovery adopts the handoff: a new owner token on the durable row.
    const adopted = await advanceFollowupHandoff({ database }, record, { lock_token: 'handoff-recovery:successor' });
    assert.ok(adopted);

    // The executor swallows the container-identity callback's failure.
    await markExecutionHandoffContainer(state, 'container-1').catch(() => undefined);
    assert.equal(state.followupHandoff, null);
    assert.equal(state.followupHandoffOwnershipLost, true);

    await assert.rejects(markExecutionHandoffAgentExited(state, true), FollowupHandoffOwnershipLostError,
        'publication may not continue as if no handoff had been recorded');
    const successor = await loadFollowupHandoff({ database }, KEY);
    assert.equal(successor?.lock_token, 'handoff-recovery:successor');
    assert.equal(successor?.generation, adopted.generation, "the successor's row is untouched");
    assert.equal(writerOwnedWorktree(state), undefined, "the successor's retained worktree is not this writer's to clean up");
    assert.deepEqual(stopAfterHandoffOwnershipLoss(new FollowupHandoffOwnershipLostError('handoff_record_changed'), silentLog as never),
        { status: 'skipped', reason: 'followup_handoff_ownership_lost' });
    assert.equal(h.comments[0].body, '🤖 Starting work on the follow-up');
});

test('F33: an owning writer keeps its worktree for cleanup', async () => {
    const worktreeInfo = { worktreePath: '/worktree' };
    assert.equal(writerOwnedWorktree({ followupHandoff: null, worktreeInfo }), worktreeInfo);
});

import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { up } from '../packages/core/src/db/migrations/20261017000000_add_pr_followup_handoffs.js';

/**
 * Regressions for review 6229724202, run over the production git operations
 * with the real core commit and branch-release implementations:
 *
 * - F28: a cancellation that lands while the standalone recovery queues the
 *   restored-comment follow-up withdraws the restored claims and keeps the
 *   handoff operator-held, so the already-queued job cannot execute them.
 * - F31: the same holds for a cancellation the state manager reports from
 *   inside the finalizer's own (unapplied) task transition.
 * - F29: a retained worktree holding only generated runtime output (which
 *   commits unstage) takes the no-change path and frees the branch instead of
 *   checkpointing an impossible `committed` phase without a commit.
 * - Normal-error crash window: the normal path's failure notice carries the
 *   handoff marker, and a worker death before the handoff settles reconciles
 *   to the settlement's own outcome — no requeue, no overwritten notice — or,
 *   with retained work, publishes once over the notice in place.
 * - S11: reconciled deliveries count as `settled`, distinct from interrupted
 *   requests returned to the queue (`noChanges`).
 */

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
const root = await mkdtemp(path.join(tmpdir(), 'followup-handoff-outcomes-'));

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
await mock.module('../src/jobs/prCommentUsageLimitRecovery.js', { namedExports: { schedulePRCommentUsageLimitRetry: async () => 'unused' } });
await mock.module('../src/jobs/prContributionDiscussion.js', { namedExports: { loadOriginalContributionDiscussion: async () => undefined } });
after(async () => {
    await database.destroy();
    await core.closeConnection?.();
    await rm(root, { recursive: true, force: true });
});

const { recordFollowupHandoff, advanceFollowupHandoff, loadFollowupHandoff, PR_FOLLOWUP_HANDOFFS_TABLE, HANDOFF_AWAITING_OPERATOR } =
    await import('../src/jobs/followupHandoffStore.js');
const { recoverInterruptedFollowupHandoffs, adoptPredecessorFollowupHandoff } = await import('../src/jobs/followupHandoffRecovery.js');
const { createFollowupHandoffGitOps } = await import('../src/jobs/followupHandoffGitOps.js');
const { handleJobError } = await import('../src/jobs/prCommentJobUtils.js');
const { handoffCommentMarker, HANDOFF_NORMAL_FAILURE_MARKER } = await import('../src/jobs/followupHandoffMarker.js');

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
});

test('F28: a cancellation while the restored-comment follow-up is queued withdraws the claims and keeps the handoff held', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    // The user cancels while the queue add is outstanding; the add itself succeeds.
    h.onSchedule = () => { h.stateManager.states.set('task-1', 'cancelled'); };

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.deepEqual(h.scheduled.length, 1, 'the follow-up job was already queued');
    assert.equal(summary.awaitingOperator, 1);
    assert.equal(summary.noChanges + summary.settled, 0);
    assert.deepEqual(h.withdrawn, [11], 'the restored claims are withdrawn from the pending list again');
    assert.equal(h.stateManager.states.get('task-1'), 'cancelled', 'the cancelled task is not overwritten as failed');
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(held?.status_reason, 'cancelled_by_user');
    assert.equal(branchOf(h.fx.wt), BRANCH, 'the branch is not released behind an operator hold');

    // The queued job's admission gate releases the ended, cancelled attempt
    // (so the pull request is not blocked) and drops the cancelled claims
    // from its batch instead of executing them.
    const adoption = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: 'task-2', log: silentLog, lockToken: 'task-2-token' },
        h.deps,
    );
    assert.deepEqual(adoption, { releasedCancelledClaimIds: [11] });
});

test('F31: a cancellation inside the final task transition withdraws the claims and keeps the handoff held', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    // The finalizer reads the task as nonterminal; the user cancels while its
    // transition is awaited, and the state manager's CAS re-read returns the
    // cancelled state without applying the requested transition.
    const transitions: string[] = [];
    h.stateManager.updateTaskState = async (_taskId: string, state: string) => {
        transitions.push(state);
        h.stateManager.states.set('task-1', 'cancelled');
        return { state: 'cancelled' };
    };

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.deepEqual(transitions, ['failed'], 'the cancellation landed inside the final transition');
    assert.equal(h.scheduled.length, 1, 'the follow-up job was already queued');
    assert.equal(summary.awaitingOperator, 1);
    assert.equal(summary.noChanges + summary.settled, 0);
    assert.deepEqual(h.withdrawn, [11], 'the restored claims are withdrawn from the pending list again');
    assert.equal(h.stateManager.states.get('task-1'), 'cancelled');
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(held?.status_reason, 'cancelled_by_user');
    assert.equal(held?.phase, 'agent_exited', 'no cleanup_pending checkpoint is recorded');
    assert.equal(branchOf(h.fx.wt), BRANCH, 'the branch is not released behind an operator hold');

    // A later job releases the ended, cancelled attempt and drops its claims.
    const adoption = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: 'task-2', log: silentLog, lockToken: 'task-2-token' },
        h.deps,
    );
    assert.deepEqual(adoption, { releasedCancelledClaimIds: [11] });
});

test('F28: an operator-authorized cancelled no-change recovery still returns the request to the queue', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const authorized = await advanceFollowupHandoff({ database }, record, { operator_authorized: 1 });
    assert.ok(authorized);
    h.stateManager.states.set('task-1', 'cancelled');

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.noChanges, 1);
    assert.deepEqual(h.restored, [11]);
    assert.deepEqual(h.withdrawn, []);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

test('F29: a worktree holding only generated runtime output takes the no-change path and frees the branch', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    const baseHead = git(h.fx.wt, 'rev-parse', 'HEAD');
    await mkdir(path.join(h.fx.wt, '.propr/cache'), { recursive: true });
    await writeFile(path.join(h.fx.wt, '.propr/cache/output'), 'generated\n');

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.errors, 0);
    assert.equal(summary.awaitingOperator, 0, 'no impossible committed checkpoint is held as recorded_commit_mismatch');
    assert.equal(summary.noChanges, 1);
    assert.deepEqual(h.restored, [11], 'the request returns to the queue');
    assert.equal(h.scheduled.length, 1);
    assert.equal(git(h.fx.wt, 'rev-parse', 'HEAD'), baseHead, 'no commit was created');
    assert.equal(git(h.fx.origin, 'rev-parse', `refs/heads/${BRANCH}`), baseHead, 'nothing was pushed');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined, 'the handoff retires');
    assert.equal(branchOf(h.fx.wt), '', 'the branch is free for the next follow-up');
    assert.ok(existsSync(path.join(h.fx.wt, '.propr/cache/output')), 'the retained worktree keeps its files');
});

test('F29: generated output beside an unpushed commit publishes that commit instead of stranding it', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await writeFile(path.join(h.fx.wt, 'feature.txt'), 'agent work\n');
    git(h.fx.wt, 'add', 'feature.txt');
    git(h.fx.wt, 'commit', '-m', 'agent commit');
    const agentHead = git(h.fx.wt, 'rev-parse', 'HEAD');
    await mkdir(path.join(h.fx.wt, '.propr/cache'), { recursive: true });
    await writeFile(path.join(h.fx.wt, '.propr/cache/output'), 'generated\n');

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.deepEqual(pushes, [agentHead], 'exactly the agent commit is pushed');
    assert.equal(git(h.fx.origin, 'rev-parse', `refs/heads/${BRANCH}`), agentHead);
    assert.deepEqual(h.restored, []);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    assert.equal(branchOf(h.fx.wt), '', 'generated output does not keep the published branch attached');
});

async function failNormally(h: Awaited<ReturnType<typeof createHarness>>, record: HandoffRecord): Promise<void> {
    // The real normal error handler; the worker then dies before settling the handoff.
    await handleJobError(new Error('agent tooling crashed'), { id: 'job-1', data: { pullRequestNumber: 7 }, attemptsMade: 0, opts: {} } as never, {
        pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets', authorsText: '@alice',
        unprocessedComments: [{ id: 11, body: 'please fix the widget', author: 'alice', type: 'issue' }] as never,
        octokit: h.octokit as never, startingWorkComment: { data: { id: 500 } }, claudeResult: null, correlationId: 'corr-1',
        correlatedLogger: silentLog as never, stateManager: h.stateManager as never, taskId: 'task-1',
        followupHandoff: record,
    });
}

test('normal-error crash window: a delivered failure notice is reconciled without requeueing or overwriting it', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await failNormally(h, record);
    const notice = h.octokit.comments[0].body;
    assert.ok(notice.includes(handoffCommentMarker(record)) && notice.includes(HANDOFF_NORMAL_FAILURE_MARKER),
        'the normal failure notice carries the handoff marker');
    assert.equal(h.stateManager.states.get('task-1'), 'failed');

    // The first pass cannot release the branch yet (a retained dirty file), so it
    // stops at cleanup_pending; a later pass retires it. Neither requeues.
    await writeFile(path.join(h.fx.wt, 'scratch.txt'), 'transient\n');
    const realGit = h.deps.git as ReturnType<typeof createFollowupHandoffGitOps>;
    h.deps.git = { ...realGit, hasUncommittedChanges: async () => false };
    const first = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(first.cleanupPending, 1);
    const pending = await loadFollowupHandoff({ database }, KEY);
    assert.equal(pending?.phase, 'cleanup_pending');
    assert.equal(pending?.completion_comment_url, 'https://example.test/comment/500', 'the delivered notice is checkpointed');
    await rm(path.join(h.fx.wt, 'scratch.txt'));
    h.deps.git = realGit;

    const second = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(second.settled, 1, 'S11: a reconciled failure is counted as settled');
    assert.equal(second.noChanges, 0);
    assert.deepEqual(h.restored, [], 'the answered request is never returned to the queue');
    assert.equal(h.scheduled.length, 0);
    assert.equal(h.octokit.comments.length, 1);
    assert.equal(h.octokit.comments[0].body, notice, 'the failure notice is left unchanged');
    assert.equal(h.stateManager.states.get('task-1'), 'failed');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    assert.equal(branchOf(h.fx.wt), '');
});

test('normal-error crash window: retained work after a delivered failure is published once over the notice', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await writeFile(path.join(h.fx.wt, 'feature.txt'), 'agent work\n');
    await failNormally(h, record);

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.equal(pushes.length, 1);
    assert.equal(h.octokit.comments.length, 1, 'no second comment is posted');
    assert.match(h.octokit.comments[0].body, /Recovered and published follow-up changes/);
    assert.ok(!h.octokit.comments[0].body.includes(HANDOFF_NORMAL_FAILURE_MARKER));

    // A repeated pass finds nothing left to do.
    const again = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(again.inspected, 0);
    assert.equal(pushes.length, 1);
});

test('S11: an interrupted request returned to the queue is still counted as noChanges', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.noChanges, 1);
    assert.equal(summary.settled, 0);
    assert.deepEqual(h.restored, [11]);
});

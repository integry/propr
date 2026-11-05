import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { up } from '../packages/core/src/db/migrations/20261017000000_add_pr_followup_handoffs.js';

/**
 * Operator authorization and resume serialize with release under the pull
 * request's processing lease, and release acts only on the row re-read under
 * that lease: a re-armed publication obligation is never detached by a
 * release that read the handoff before it was re-armed.
 */

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
after(async () => { await database.destroy(); });

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

await mock.module('@propr/core', {
    namedExports: {
        db: database,
        logger: silentLog,
        TaskStates: {
            PENDING: 'pending', PROCESSING: 'processing', CLAUDE_EXECUTION: 'claude_execution',
            POST_PROCESSING: 'post_processing', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled',
        },
        AI_COMMIT_AUTHOR: { name: 'ProPR Test', email: 'propr@example.test' },
        getAuthenticatedOctokit: async () => { throw new Error('tests must inject their own Octokit'); },
        getStateManager: () => { throw new Error('tests must inject their own state manager'); },
        getIssueQueue: async () => ({ add: async () => undefined, getJob: async () => null }),
        issueQueue: { add: async () => undefined, getJob: async () => null },
        inspectTaskContainerLivenessForTask: async () => { throw new Error('tests must inject liveness'); },
        inspectLegacyDockerContainerLivenessForTask: async () => 'not_found',
        commitChanges: async () => { throw new Error('tests must inject git operations'); },
        createHooklessGit: () => { throw new Error('tests must inject git operations'); },
        releaseBranchFromSettledWorktree: async () => { throw new Error('tests must inject git operations'); },
        cleanupWorktree: async () => undefined,
        createWorktreeFromExistingBranch: async () => { throw new Error('unexpected worktree creation'); },
        ensureRepoCloned: async () => { throw new Error('unexpected clone'); },
        getRepoUrl: () => 'https://example.test/repo.git',
        pushBranch: async () => { throw new Error('tests must inject git operations'); },
        getPendingPrCommentsKey: (owner: string, repo: string, pr: number) => `pending:${owner}:${repo}:${pr}`,
    },
});

const {
    recordFollowupHandoff, advanceFollowupHandoff, loadFollowupHandoff,
    HANDOFF_ACTIVE, HANDOFF_AWAITING_OPERATOR, HANDOFF_RELEASED, PR_FOLLOWUP_HANDOFFS_TABLE,
} = await import('../src/jobs/followupHandoffStore.js');
const {
    authorizeCancelledFollowupHandoff, releaseFollowupHandoffRecord, resumeOperatorHeldFollowupHandoff,
} = await import('../src/jobs/followupHandoffRecovery.js');

const BRANCH = 'propr/pr-head';
const KEY = { repository: 'acme/widgets', pull_request: 7 };
const LOCK = 'lock:pr:acme:widgets:7';

function createFakeLockRedis() {
    const store = new Map<string, { value: string; ttl: number }>();
    return {
        store,
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

/** A worktree holding unpublished work: settled release refuses, a forced one detaches it. */
function createGitOps() {
    const state = { attached: true, settledCalls: 0, detached: 0, onSettledRelease: async () => {} };
    const gitOps = {
        state,
        async releaseSettledWorktree() {
            state.settledCalls += 1;
            await state.onSettledRelease();
            return false;
        },
        async worktreeAttachment() { return state.attached ? 'attached' as const : 'not_on_branch' as const; },
        async detachWorktreeHead() { state.attached = false; state.detached += 1; },
        async branchWorktreeRegistrations() { return state.attached ? ['/tmp/wt'] : []; },
    };
    return gitOps;
}

function createHarness() {
    const redis = createFakeLockRedis();
    const gitOps = createGitOps();
    let onLiveness = async () => {};
    const deps = {
        store: { database }, redis, log: silentLog,
        stateManager: { async getTaskState() { return { state: 'cancelled' }; } },
        inspectLiveness: async () => { await onLiveness(); return { liveness: 'not_found' }; },
        git: gitOps,
        withdrawRestoredComments: async () => undefined,
        taskStates: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
    };
    return { redis, gitOps, deps, setOnLiveness(hook: () => Promise<void>) { onLiveness = hook; } };
}

async function seedHeldHandoff(statusReason: string) {
    const record = await recordFollowupHandoff({
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 },
        taskId: 'task-1', sourceTaskIds: [], correlationId: 'corr-1',
        target: { repoOwner: 'acme', repoName: 'widgets', branchName: BRANCH, isFork: false },
        worktreePath: '/tmp/wt', localRepoPath: '/tmp/local',
        claimedComments: [{ id: 11, body: 'please fix the widget', author: 'alice', type: 'issue' }],
        jobData: { pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets', correlationId: 'corr-1' } as never,
        llm: 'claude', lockKey: LOCK, lockToken: 'dead-worker-token',
    }, { database });
    assert.ok(record);
    const held = await advanceFollowupHandoff({ database }, record!, { status: HANDOFF_AWAITING_OPERATOR, status_reason: statusReason });
    assert.ok(held);
    return held!;
}

beforeEach(async () => {
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).delete();
});

const variants = [
    {
        name: 'authorization',
        statusReason: 'cancelled_by_user',
        rearm: (deps: object) => authorizeCancelledFollowupHandoff(KEY, deps),
        refusedDuringRelease: (result: unknown) => assert.equal(result, null),
        rearmed: (result: unknown) => assert.equal((result as { status?: string } | null)?.status, HANDOFF_ACTIVE),
    },
    {
        name: 'plain resume',
        statusReason: 'worktree_missing',
        rearm: (deps: object) => resumeOperatorHeldFollowupHandoff(KEY, deps),
        refusedDuringRelease: (result: unknown) => assert.deepEqual(result, { resumed: false, reason: 'lease_held_by_live_writer' }),
        rearmed: (result: unknown) => assert.deepEqual(result, { resumed: true }),
    },
];

for (const variant of variants) {
    test(`F39 ${variant.name}: re-arming while a forced release is mid-flight is refused under the release's lease`, async () => {
        const h = createHarness();
        await seedHeldHandoff(variant.statusReason);
        let concurrent: unknown;
        h.gitOps.state.onSettledRelease = async () => {
            concurrent = await variant.rearm(h.deps);
            assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR,
                'the row was not re-armed while release held the lease');
        };

        const released = await releaseFollowupHandoffRecord(KEY, { force: true }, h.deps);
        variant.refusedDuringRelease(concurrent);
        assert.equal(released.released, true);
        assert.equal(h.gitOps.state.detached, 1);
        const row = await loadFollowupHandoff({ database }, KEY);
        assert.equal(row?.status, HANDOFF_RELEASED, 'the detached worktree carries no surviving publication obligation');
        assert.equal(row?.operator_authorized, 0);
        assert.equal(h.redis.store.has(LOCK), false, 'every operator lease is given back');
    });

    test(`F39 ${variant.name}: a release that read the row before it was re-armed never detaches the obligation`, async () => {
        const h = createHarness();
        await seedHeldHandoff(variant.statusReason);
        let concurrent: unknown;
        // Liveness is checked from the unlocked snapshot, before the release lease.
        h.setOnLiveness(async () => { concurrent = await variant.rearm(h.deps); });

        const released = await releaseFollowupHandoffRecord(KEY, { force: true }, h.deps);
        variant.rearmed(concurrent);
        assert.deepEqual(released, { released: false, reason: 'superseded' });
        assert.equal(h.gitOps.state.settledCalls, 0, 'no worktree mutation from the stale snapshot');
        assert.equal(h.gitOps.state.detached, 0);
        assert.equal(h.gitOps.state.attached, true, 'the surviving obligation keeps its attached branch');
        const row = await loadFollowupHandoff({ database }, KEY);
        assert.equal(row?.status, HANDOFF_ACTIVE);
        assert.equal(h.redis.store.has(LOCK), false);
    });
}

test('F39: authorization and resume refuse while a live writer holds the PR lease', async () => {
    const h = createHarness();
    await seedHeldHandoff('cancelled_by_user');
    h.redis.store.set(LOCK, { value: 'live-writer-token', ttl: 3600 });
    assert.equal(await authorizeCancelledFollowupHandoff(KEY, h.deps), null);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR);

    await database(PR_FOLLOWUP_HANDOFFS_TABLE).delete();
    await seedHeldHandoff('worktree_missing');
    assert.deepEqual(await resumeOperatorHeldFollowupHandoff(KEY, h.deps), { resumed: false, reason: 'lease_held_by_live_writer' });
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(h.redis.store.get(LOCK)?.value, 'live-writer-token', 'the foreign lease is never touched');
});

import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { up } from '../packages/core/src/db/migrations/20261017000000_add_pr_followup_handoffs.js';

/**
 * Regressions for the durable follow-up handoff review findings: normal-path
 * phase persistence, recovery lease heartbeats, operator-held durability,
 * failure settlement evidence, guarded release, cancellation re-checks,
 * keyed operator recovery, operator re-arm, durable cleanup, and
 * publication-binding/container-identity fail-closed behavior.
 */

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
const root = await mkdtemp(path.join(tmpdir(), 'followup-handoff-findings-'));
after(async () => { await database.destroy(); await rm(root, { recursive: true, force: true }); });

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
    adoptPredecessorFollowupHandoff, authorizeCancelledFollowupHandoff,
    recoverInterruptedFollowupHandoffs, releaseFollowupHandoffRecord,
    resumeOperatorHeldFollowupHandoff, settleFollowupHandoffAfterFailure,
} = await import('../src/jobs/followupHandoffRecovery.js');
const { resumeFollowupHandoff } = await import('../src/jobs/followupHandoffResume.js');
const { adoptPRProcessingLock } = await import('../src/jobs/prProcessingLock.js');
const {
    markExecutionHandoffAgentExited, markExecutionHandoffCommitted,
    markExecutionHandoffCommentPublished, markExecutionHandoffPushed,
} = await import('../src/jobs/prCommentHandoffIntegration.js');

const BRANCH = 'propr/pr-head';
const KEY = { repository: 'acme/widgets', pull_request: 7 };
const LOCK = 'lock:pr:acme:widgets:7';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
    '-c', 'protocol.file.allow=always', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let fixtureIndex = 0;
interface Fixture { dir: string; origin: string; local: string; wt: string }

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
    return { dir, origin: path.join(dir, 'origin.git'), local, wt };
}

const originHead = (fx: Fixture) => git(fx.origin, 'rev-parse', `refs/heads/${BRANCH}`);

interface GitCounters { commits: number; pushes: number; released: number; detached: number }

function createGitOps(counters: GitCounters) {
    const clean = (wt: string) => git(wt, 'status', '--porcelain', '--untracked-files=all') === '';
    const unpushed = (wt: string) => {
        git(wt, 'fetch', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`);
        return git(wt, 'rev-list', '--count', 'HEAD', '--not', `refs/remotes/origin/${BRANCH}`) !== '0';
    };
    return {
        async worktreeAttachment(worktreePath: string, branchName: string) {
            if (!existsSync(worktreePath)) return 'missing' as const;
            return git(worktreePath, 'branch', '--show-current') === branchName ? 'attached' as const : 'not_on_branch' as const;
        },
        async branchWorktreeRegistrations(localRepoPath: string, branchName: string) {
            return git(localRepoPath, 'worktree', 'list', '--porcelain').split('\n\n')
                .filter(entry => entry.split('\n').includes(`branch refs/heads/${branchName}`))
                .map(entry => entry.split('\n')[0].slice('worktree '.length))
                .filter(holder => holder !== localRepoPath);
        },
        async hasUncommittedChanges(worktreePath: string) { return !clean(worktreePath); },
        async commitWork(worktreePath: string, message: string) {
            git(worktreePath, 'add', '-A');
            git(worktreePath, 'commit', '-m', message);
            counters.commits += 1;
            return { commitHash: git(worktreePath, 'rev-parse', 'HEAD') };
        },
        async hasUnpushedCommits(worktreePath: string) { return unpushed(worktreePath); },
        async head(worktreePath: string) { return git(worktreePath, 'rev-parse', 'HEAD'); },
        async remoteBranchHead(worktreePath: string, branchName: string) {
            try {
                git(worktreePath, 'fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`);
                return git(worktreePath, 'rev-parse', `refs/remotes/origin/${branchName}`);
            } catch {
                return null;
            }
        },
        async isAncestorOfHead(worktreePath: string, sha: string) {
            try {
                git(worktreePath, 'merge-base', '--is-ancestor', sha, 'HEAD');
                return true;
            } catch {
                return false;
            }
        },
        async push(worktreePath: string) {
            git(worktreePath, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
            counters.pushes += 1;
            return { commitHash: git(worktreePath, 'rev-parse', 'HEAD') };
        },
        async releaseSettledWorktree(_localRepoPath: string, _branchName: string, worktreePath: string) {
            if (!existsSync(worktreePath) || !clean(worktreePath) || unpushed(worktreePath)) return false;
            git(worktreePath, 'checkout', '--detach');
            counters.released += 1;
            return true;
        },
        async detachWorktreeHead(worktreePath: string) {
            git(worktreePath, 'checkout', '--detach');
            counters.detached += 1;
        },
    };
}

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

function createStateManager(initial: Record<string, string> = {}) {
    const states = new Map(Object.entries(initial));
    return {
        states,
        async getTaskState(taskId: string) { return states.has(taskId) ? { state: states.get(taskId)! } : null; },
        async updateTaskState(taskId: string, state: string) { states.set(taskId, state); },
        async updateHistoryMetadata() { return undefined; },
    };
}

interface FakeComment { id: number; body: string; html_url: string }

function createOctokit(pull: { head: { ref: string }; base: { ref: string } }) {
    const comments: FakeComment[] = [];
    let nextId = 1000;
    return {
        comments, pull,
        async request(route: string, params?: Record<string, unknown>) {
            if (route.startsWith('GET ') && route.includes('/pulls/')) return { data: this.pull };
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

interface Harness {
    fx: Fixture;
    counters: GitCounters;
    gitOps: ReturnType<typeof createGitOps>;
    redis: ReturnType<typeof createFakeLockRedis>;
    stateManager: ReturnType<typeof createStateManager>;
    octokit: ReturnType<typeof createOctokit>;
    restored: Array<{ id: number }>;
    deps: Record<string, unknown>;
}

async function createHarness(options: { taskStates?: Record<string, string>; liveness?: string } = {}): Promise<Harness> {
    const fx = await createFixture();
    const counters: GitCounters = { commits: 0, pushes: 0, released: 0, detached: 0 };
    const gitOps = createGitOps(counters);
    const redis = createFakeLockRedis();
    const stateManager = createStateManager(options.taskStates ?? { 'task-1': 'processing' });
    const octokit = createOctokit({ head: { ref: BRANCH }, base: { ref: 'main' } });
    const restored: Array<{ id: number }> = [];
    const deps = {
        store: { database }, redis, log: silentLog, stateManager,
        getOctokit: async () => octokit,
        inspectLiveness: async () => ({ liveness: options.liveness ?? 'not_found' }),
        git: gitOps,
        restoreComments: async (_record: unknown, claimed: Array<{ id: number }>) => { restored.push(...claimed); },
        taskStates: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
    };
    return { fx, counters, gitOps, redis, stateManager, octokit, restored, deps };
}

interface SeedOverrides {
    taskId?: string;
    lockToken?: string;
    pullRequestNumber?: number;
    fixture?: Fixture;
    binding?: { headRef?: string | null; baseRef?: string | null; headSha?: string | null };
}

async function seedHandoff(h: Harness, overrides: SeedOverrides = {}) {
    const pr = overrides.pullRequestNumber ?? 7;
    const fx = overrides.fixture ?? h.fx;
    const record = await recordFollowupHandoff({
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: pr },
        taskId: overrides.taskId ?? 'task-1',
        sourceTaskIds: [],
        correlationId: 'corr-1',
        target: { repoOwner: 'acme', repoName: 'widgets', branchName: BRANCH, isFork: false },
        worktreePath: fx.wt, localRepoPath: fx.local,
        claimedComments: [{ id: 11, body: 'please fix the widget', author: 'alice', type: 'issue' }],
        jobData: { pullRequestNumber: pr, repoOwner: 'acme', repoName: 'widgets', correlationId: 'corr-1' } as never,
        llm: 'claude',
        lockKey: `lock:pr:acme:widgets:${pr}`,
        lockToken: overrides.lockToken ?? 'dead-worker-token',
        binding: overrides.binding,
    }, { database });
    assert.ok(record, 'handoff must be recorded');
    return record!;
}

const agentEdit = async (fx: Fixture) => {
    await writeFile(path.join(fx.wt, 'feature.txt'), 'agent work\n');
};

const commitInWorktree = (fx: Fixture, message = 'agent commit') => {
    git(fx.wt, 'add', '-A');
    git(fx.wt, 'commit', '-m', message);
    return git(fx.wt, 'rev-parse', 'HEAD');
};

const recoveredComments = (h: Harness) => h.octokit.comments.filter(comment => comment.body.includes('Recovered and published follow-up changes'));
const interruptionComments = (h: Harness) => h.octokit.comments.filter(comment => comment.body.includes('interrupted before any changes'));

beforeEach(async () => {
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).delete();
});

// --- F1: the normal publication path persists commit/push/comment phases.

test('F1: a restart after the normal push recovers publication instead of reporting missing work', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const state = { followupHandoff: record };
    await markExecutionHandoffAgentExited(state);
    await agentEdit(h.fx);
    const head = commitInWorktree(h.fx);
    await markExecutionHandoffCommitted(state, head);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.phase, 'committed');
    git(h.fx.wt, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
    await markExecutionHandoffPushed(state, head);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.phase, 'pushed');

    // Worker dies before the completion comment. The worktree is clean and the
    // push is done — recovery must finish publication, not report missing work.
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.equal(summary.noChanges, 0);
    assert.equal(interruptionComments(h).length, 0, 'no false interruption notice');
    assert.equal(recoveredComments(h).length, 1);
    assert.deepEqual(h.restored, [], 'addressed comments are not restored to the queue');
    assert.equal(h.stateManager.states.get('task-1'), 'completed');
    assert.equal(h.counters.commits + h.counters.pushes, 0, 'recovery re-ran nothing');
    assert.equal(originHead(h.fx), head);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

test('F1: a restart after the normal completion comment never overwrites it with a failure notice', async () => {
    const h = await createHarness({ taskStates: { 'task-1': 'completed' } });
    const record = await seedHandoff(h);
    const state = { followupHandoff: record };
    await markExecutionHandoffAgentExited(state);
    await agentEdit(h.fx);
    const head = commitInWorktree(h.fx);
    await markExecutionHandoffCommitted(state, head);
    git(h.fx.wt, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
    await markExecutionHandoffPushed(state, head);
    await markExecutionHandoffCommentPublished(state, 'https://example.test/comment/normal');
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.phase, 'comment_published');

    // Worker dies before finalizing the handoff row.
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.equal(h.octokit.comments.length, 0, 'the delivered completion comment is never replaced');
    assert.deepEqual(h.restored, []);
    assert.equal(h.stateManager.states.get('task-1'), 'completed', 'the completed task is never marked failed');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    assert.equal(h.counters.released, 1, 'the branch is freed from the retained worktree');
});

// --- F2: recovery renews its lease and stops mutating when ownership is lost.

test('F2: the recovery heartbeat keeps a concurrent operator pass from adopting the lease mid-publication', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await agentEdit(h.fx);
    const realPush = h.gitOps.push.bind(h.gitOps);
    let adoptionDuringPush: string | undefined;
    h.gitOps.push = async (worktreePath: string) => {
        // Simulate lease TTL decay mid-publication; the heartbeat must renew it.
        h.redis.store.get(LOCK)!.ttl = 100;
        const deadline = Date.now() + 5000;
        while (h.redis.store.get(LOCK)!.ttl !== 3600 && Date.now() < deadline) await sleep(5);
        assert.equal(h.redis.store.get(LOCK)!.ttl, 3600, 'the heartbeat renewed the decayed lease');
        adoptionDuringPush = await adoptPRProcessingLock(h.redis, LOCK, {
            predecessorToken: h.redis.store.get(LOCK)!.value, successorToken: 'second-operator-pass',
        });
        return realPush(worktreePath);
    };
    const summary = await recoverInterruptedFollowupHandoffs({ ...h.deps, heartbeatIntervalMs: 5 });
    assert.equal(adoptionDuringPush, 'live_owner', 'a concurrent pass cannot adopt the renewed lease');
    assert.equal(summary.published, 1);
    assert.equal(h.counters.pushes, 1);
    assert.equal(recoveredComments(h).length, 1);
});

test('F2: a lease lost during recovery stops all further mutations', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await agentEdit(h.fx);
    const realPush = h.gitOps.push.bind(h.gitOps);
    h.gitOps.push = async (worktreePath: string) => {
        const result = await realPush(worktreePath);
        // Another writer takes the lease; the heartbeat must notice and abort.
        h.redis.store.set(LOCK, { value: 'foreign-owner', ttl: 3600 });
        await sleep(100);
        return result;
    };
    const summary = await recoverInterruptedFollowupHandoffs({ ...h.deps, heartbeatIntervalMs: 5 });
    assert.equal(summary.lockedByOtherWriter, 1);
    assert.equal(summary.published, 0);
    assert.equal(h.octokit.comments.length, 0, 'no comment publishes after the lease was lost');
    assert.equal(h.redis.store.get(LOCK)?.value, 'foreign-owner', 'the foreign lease is never deleted');
    const record = await loadFollowupHandoff({ database }, KEY);
    assert.equal(record?.status, HANDOFF_ACTIVE, 'the obligation stays recorded for the next pass');
});

test('F2: resume stops before the push once ownership is reported lost', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h.fx);
    const head = commitInWorktree(h.fx);
    const committed = await advanceFollowupHandoff({ database }, record, { phase: 'committed', commit_hash: head });
    const outcome = await resumeFollowupHandoff({
        record: committed!, octokit: h.octokit as never, git: h.gitOps as never,
        stateManager: h.stateManager as never, restoreComments: async () => undefined,
        store: { database }, log: silentLog, taskStates: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
        isOwnershipLost: () => true,
    });
    assert.equal(outcome.outcome, 'ownership_lost');
    assert.equal(h.counters.pushes, 0);
    assert.equal(h.octokit.comments.length, 0);
});

// --- F3: operator-held handoffs block successors and cannot be overwritten.

test('F3: an operator-held predecessor blocks a new follow-up and its row survives replacement attempts', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h.fx);
    const held = await advanceFollowupHandoff({ database }, record, {
        status: HANDOFF_AWAITING_OPERATOR, status_reason: 'worktree_missing',
    });
    assert.ok(held);

    const adoption = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: 'task-2', log: silentLog, lockToken: 'task-2-token' },
        h.deps,
    );
    assert.ok('blocked' in adoption && adoption.blocked === 'predecessor_awaiting_operator');

    // Even if a later attempt reaches the store, the unresolved row is not replaceable.
    const replaced = await seedHandoffAttempt(h, 'task-2');
    assert.equal(replaced, null, 'the store refuses to overwrite an operator-held handoff');
    const survivor = await loadFollowupHandoff({ database }, KEY);
    assert.equal(survivor?.task_id, 'task-1');
    assert.equal(survivor?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(survivor?.incarnation, held!.incarnation);

    // After an explicit operator release, a new attempt may take the slot over.
    await advanceFollowupHandoff({ database }, survivor!, { status: HANDOFF_RELEASED, status_reason: 'released_by_operator' });
    const afterRelease = await seedHandoffAttempt(h, 'task-2');
    assert.equal(afterRelease?.task_id, 'task-2');
});

async function seedHandoffAttempt(h: Harness, taskId: string) {
    return recordFollowupHandoff({
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 },
        taskId, sourceTaskIds: [], correlationId: 'corr-2',
        target: { repoOwner: 'acme', repoName: 'widgets', branchName: BRANCH, isFork: false },
        worktreePath: h.fx.wt, localRepoPath: h.fx.local,
        claimedComments: [], jobData: {} as never, llm: null,
        lockKey: LOCK, lockToken: 'new-attempt-token',
    }, { database });
}

// --- F4: handled failures keep unpublished obligations recoverable.

test('F4: a handled failure with retained unpublished work keeps the handoff adoptable', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await agentEdit(h.fx);
    await settleFollowupHandoffAfterFailure(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, taskId: 'task-1', cancelled: false },
        { store: { database }, git: h.gitOps as never, log: silentLog },
    );
    const kept = await loadFollowupHandoff({ database }, KEY);
    assert.equal(kept?.status, HANDOFF_ACTIVE, 'the retained work stays discoverable');
    assert.equal(kept?.status_reason, 'publication_failed');

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1, 'a later recovery pass publishes the retained work');
    assert.equal(recoveredComments(h).length, 1);
});

test('F4/F15: a handled failure with no unpublished work keeps the row until branch release is proven', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await settleFollowupHandoffAfterFailure(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, taskId: 'task-1', cancelled: false },
        { store: { database }, git: h.gitOps as never, log: silentLog },
    );
    // The branch is still attached to the retained worktree, so the settled row
    // survives at cleanup_pending instead of being deleted with the branch held.
    const pending = await loadFollowupHandoff({ database }, KEY);
    assert.equal(pending?.status, HANDOFF_ACTIVE);
    assert.equal(pending?.phase, 'cleanup_pending');
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    // S11: a settled failure is not an interrupted request returned to the queue.
    assert.equal(summary.settled, 1, 'recovery releases the branch without republishing');
    assert.equal(summary.noChanges, 0);
    assert.equal(h.counters.released, 1);
    assert.equal(h.counters.pushes + h.octokit.comments.length, 0, 'nothing publishes during cleanup');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined, 'the row retires once the branch is free');
});

test('F23: a handled failure whose worktree directory is gone but still registered keeps the handoff', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await rm(h.fx.wt, { recursive: true, force: true });
    assert.ok(git(h.fx.local, 'worktree', 'list', '--porcelain').includes(`branch refs/heads/${BRANCH}`),
        'Git still records the removed worktree as holding the branch');
    await settleFollowupHandoffAfterFailure(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, taskId: 'task-1', cancelled: false },
        { store: { database }, git: h.gitOps as never, log: silentLog },
    );
    const kept = await loadFollowupHandoff({ database }, KEY);
    assert.equal(kept?.status, HANDOFF_ACTIVE, 'the branch obligation stays discoverable');
    assert.equal(kept?.phase, 'cleanup_pending');
});

test('F4/F15/F23: a handled failure whose worktree registration is gone retires the handoff', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await rm(h.fx.wt, { recursive: true, force: true });
    git(h.fx.local, 'worktree', 'prune');
    await settleFollowupHandoffAfterFailure(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, taskId: 'task-1', cancelled: false },
        { store: { database }, git: h.gitOps as never, log: silentLog },
    );
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

test('F23: unreadable worktree registrations after a failure keep the handoff', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await rm(h.fx.wt, { recursive: true, force: true });
    const blindGit = { ...h.gitOps, branchWorktreeRegistrations: async () => { throw new Error('git unavailable'); } };
    await settleFollowupHandoffAfterFailure(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, taskId: 'task-1', cancelled: false },
        { store: { database }, git: blindGit as never, log: silentLog },
    );
    const kept = await loadFollowupHandoff({ database }, KEY);
    assert.equal(kept?.status, HANDOFF_ACTIVE);
    assert.equal(kept?.status_reason, 'publication_failed');
});

test('F4: unreadable publication evidence after a failure fails closed and keeps the handoff', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    const failingGit = { ...h.gitOps, worktreeAttachment: async () => { throw new Error('git unavailable'); } };
    await settleFollowupHandoffAfterFailure(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, taskId: 'task-1', cancelled: false },
        { store: { database }, git: failingGit as never, log: silentLog },
    );
    const kept = await loadFollowupHandoff({ database }, KEY);
    assert.equal(kept?.status, HANDOFF_ACTIVE);
    assert.equal(kept?.status_reason, 'publication_failed');
});

test('F4: a cancellation failure holds the handoff for an operator decision', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await agentEdit(h.fx);
    await settleFollowupHandoffAfterFailure(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, taskId: 'task-1', cancelled: true },
        { store: { database }, git: h.gitOps as never, log: silentLog },
    );
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(held?.status_reason, 'cancelled_by_user');
});

// --- F5: release is guarded by agent liveness and the PR lease.

test('F5: release refuses a live or unverifiable agent, even when forced', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    const live = await releaseFollowupHandoffRecord(KEY, { force: true }, { ...h.deps, inspectLiveness: async () => ({ liveness: 'running' }) });
    assert.deepEqual(live, { released: false, reason: 'agent_still_running' });
    const unknown = await releaseFollowupHandoffRecord(KEY, { force: true }, { ...h.deps, inspectLiveness: async () => ({ liveness: 'unavailable' }) });
    assert.deepEqual(unknown, { released: false, reason: 'liveness_unavailable' });
    assert.equal(h.counters.detached + h.counters.released, 0, 'no worktree mutation happened');
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_ACTIVE);
});

test('F5: release refuses while another writer holds the PR lease, then succeeds under its own lease', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    h.redis.store.set(LOCK, { value: 'live-writer-token', ttl: 3600 });
    const refused = await releaseFollowupHandoffRecord(KEY, {}, h.deps);
    assert.deepEqual(refused, { released: false, reason: 'lease_held_by_live_writer' });
    assert.equal(h.redis.store.get(LOCK)?.value, 'live-writer-token');

    h.redis.store.delete(LOCK);
    const released = await releaseFollowupHandoffRecord(KEY, {}, h.deps);
    assert.equal(released.released, true);
    assert.equal(h.counters.released, 1);
    assert.equal(h.redis.store.has(LOCK), false, 'the release lease is given back');
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_RELEASED);
});

// --- F6: cancellation is observed throughout recovery.

test('F6: cancellation during recovery halts before the push and preserves the handoff', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await agentEdit(h.fx);
    const before = originHead(h.fx);
    const realCommit = h.gitOps.commitWork.bind(h.gitOps);
    h.gitOps.commitWork = async (worktreePath: string, message: string) => {
        const result = await realCommit(worktreePath, message);
        // The user cancels while recovery is still collecting output.
        h.stateManager.states.set('task-1', 'cancelled');
        return result;
    };
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.awaitingOperator, 1);
    assert.equal(summary.published, 0);
    assert.equal(h.counters.pushes, 0, 'nothing was pushed after cancellation');
    assert.equal(h.octokit.comments.length, 0);
    assert.equal(originHead(h.fx), before);
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(held?.status_reason, 'cancelled_by_user');

    // Explicit operator authorization publishes the preserved work exactly once.
    assert.ok(await authorizeCancelledFollowupHandoff(KEY, { store: { database }, redis: h.redis }));
    const second = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(second.published, 1);
    assert.equal(h.counters.pushes, 1);
    assert.equal(recoveredComments(h).length, 1);
});

// --- F7: operator recovery is strictly scoped to its target.

test('F7: keyed recovery publishes only the targeted pull request', async () => {
    const h = await createHarness({ taskStates: { 'task-1': 'processing', 'task-9': 'processing' } });
    await seedHandoff(h);
    await agentEdit(h.fx);
    const otherFx = await createFixture();
    await seedHandoff(h, { pullRequestNumber: 9, taskId: 'task-9', fixture: otherFx });
    await agentEdit(otherFx);
    const otherBefore = originHead(otherFx);

    const summary = await recoverInterruptedFollowupHandoffs(h.deps, KEY);
    assert.equal(summary.inspected, 1, 'only the targeted handoff is considered');
    assert.equal(summary.published, 1);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    const untouched = await loadFollowupHandoff({ database }, { repository: 'acme/widgets', pull_request: 9 });
    assert.equal(untouched?.status, HANDOFF_ACTIVE);
    assert.equal(untouched?.phase, 'agent_running');
    assert.equal(originHead(otherFx), otherBefore, 'the other PR was not pushed');
    assert.equal(recoveredComments(h).length, 1);
});

// --- F8: a repaired operator-held handoff can be re-armed without cancellation authority.

test('F8: resume re-arms a repaired operator-held handoff; cancellation still needs explicit authorization', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h.fx);
    await advanceFollowupHandoff({ database }, record, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'worktree_missing' });

    const reactivated = await resumeOperatorHeldFollowupHandoff(KEY, { store: { database }, redis: h.redis });
    assert.deepEqual(reactivated, { resumed: true });
    const rearmed = await loadFollowupHandoff({ database }, KEY);
    assert.equal(rearmed?.status, HANDOFF_ACTIVE);
    assert.equal(rearmed?.operator_authorized, 0, 're-arming grants no cancelled-work publication authority');

    const summary = await recoverInterruptedFollowupHandoffs(h.deps, KEY);
    assert.equal(summary.published, 1);

    // A cancellation hold refuses the plain resume and demands explicit authorization.
    const cancelled = await seedHandoff(h, { taskId: 'task-2' });
    await advanceFollowupHandoff({ database }, cancelled, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'cancelled_by_user' });
    const refused = await resumeOperatorHeldFollowupHandoff(KEY, { store: { database }, redis: h.redis });
    assert.deepEqual(refused, { resumed: false, reason: 'requires_cancellation_authorization' });
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR);
});

// --- F9: cleanup is a durable phase; the row survives until branch release is proven.

test('F9 published path: a failed branch release retains the row and retries cleanup without republishing', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await agentEdit(h.fx);
    const realRelease = h.gitOps.releaseSettledWorktree.bind(h.gitOps);
    let failures = 1;
    h.gitOps.releaseSettledWorktree = async (localRepoPath: string, branchName: string, worktreePath: string) => {
        if (failures-- > 0) throw new Error('worktree lock contention');
        return realRelease(localRepoPath, branchName, worktreePath);
    };
    const first = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(first.cleanupPending, 1);
    assert.equal(first.published, 0, 'the outcome is not reported published until cleanup settles');
    assert.equal(h.counters.pushes, 1);
    assert.equal(recoveredComments(h).length, 1);
    const retained = await loadFollowupHandoff({ database }, KEY);
    assert.equal(retained?.phase, 'cleanup_pending');
    assert.equal(retained?.status, HANDOFF_ACTIVE);
    assert.equal(git(h.fx.wt, 'branch', '--show-current'), BRANCH, 'the branch is still attached');

    const second = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(second.published, 1);
    assert.equal(h.counters.pushes, 1, 'exactly one push in total');
    assert.equal(h.counters.commits, 1, 'exactly one commit in total');
    assert.equal(recoveredComments(h).length, 1, 'exactly one completion comment in total');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    assert.equal(git(h.fx.wt, 'branch', '--show-current'), '', 'the branch is free again');
});

test('F9 no-change path: a refused branch release retains the row and retries cleanup without reposting', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    const realRelease = h.gitOps.releaseSettledWorktree.bind(h.gitOps);
    let failures = 1;
    h.gitOps.releaseSettledWorktree = async (localRepoPath: string, branchName: string, worktreePath: string) => {
        if (failures-- > 0) return false;
        return realRelease(localRepoPath, branchName, worktreePath);
    };
    const first = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(first.cleanupPending, 1);
    assert.equal(interruptionComments(h).length, 1);
    assert.deepEqual(h.restored.map(comment => comment.id), [11]);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.phase, 'cleanup_pending');

    const second = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(second.noChanges, 1);
    assert.equal(interruptionComments(h).length, 1, 'the owed notice is not duplicated');
    assert.deepEqual(h.restored.map(comment => comment.id), [11], 'comments are not restored twice');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    assert.equal(git(h.fx.wt, 'branch', '--show-current'), '');
});

test('F9: a crash right before branch release resumes cleanup only, with no new publication', async () => {
    const h = await createHarness({ taskStates: { 'task-1': 'completed' } });
    const record = await seedHandoff(h);
    await agentEdit(h.fx);
    const head = commitInWorktree(h.fx);
    git(h.fx.wt, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
    await advanceFollowupHandoff({ database }, record, { phase: 'cleanup_pending', commit_hash: head });

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.equal(h.octokit.comments.length, 0, 'publication already happened; nothing is posted');
    assert.equal(h.counters.pushes, 0);
    assert.equal(h.counters.released, 1);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

// --- F11: publication binding and container identity fail closed.

test('F11: an externally advanced head fails closed before the push and preserves the handoff', async () => {
    const h = await createHarness();
    await seedHandoff(h, { binding: { headRef: BRANCH, baseRef: 'main', headSha: originHead(h.fx) } });
    await agentEdit(h.fx);
    // Someone else pushes to the PR head branch while the handoff is interrupted.
    git(h.fx.dir, 'clone', 'origin.git', 'external');
    const external = path.join(h.fx.dir, 'external');
    git(external, 'checkout', BRANCH);
    await writeFile(path.join(external, 'external.txt'), 'external change\n');
    git(external, 'add', '-A');
    git(external, 'commit', '-m', 'external advance');
    git(external, 'push', 'origin', BRANCH);
    const externalHead = originHead(h.fx);

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.awaitingOperator, 1);
    assert.equal(h.counters.pushes, 0, 'the externally advanced head is never overwritten');
    assert.equal(originHead(h.fx), externalHead);
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(held?.status_reason, 'head_advanced_externally');
    assert.ok(existsSync(path.join(h.fx.wt, 'feature.txt')), 'the retained work is preserved');
});

test('F11: a retargeted or re-headed pull request fails closed before the push', async () => {
    const h = await createHarness();
    await seedHandoff(h, { binding: { headRef: BRANCH, baseRef: 'main', headSha: originHead(h.fx) } });
    await agentEdit(h.fx);
    h.octokit.pull = { head: { ref: BRANCH }, base: { ref: 'develop' } };
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.awaitingOperator, 1);
    assert.equal(h.counters.pushes, 0);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status_reason, 'pr_binding_mismatch');

    // A changed head ref fails closed the same way (fresh row: the held one is
    // not replaceable, which F3 covers separately).
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).delete();
    await seedHandoff(h, { taskId: 'task-2', binding: { headRef: BRANCH, baseRef: 'main' } });
    h.octokit.pull = { head: { ref: 'some-other-branch' }, base: { ref: 'main' } };
    const second = await recoverInterruptedFollowupHandoffs(h.deps, KEY);
    assert.equal(second.awaitingOperator, 1);
    assert.equal(h.counters.pushes, 0);
});

test('F11: a mismatched agent container identity fails closed everywhere', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h.fx);
    await advanceFollowupHandoff({ database }, record, { container_id: 'container-bound' });
    const mismatched = {
        ...h.deps,
        inspectLiveness: async () => ({ liveness: 'stopped', container: { id: 'container-impostor', name: 'propr-agent' } }),
    };
    const summary = await recoverInterruptedFollowupHandoffs(mismatched);
    assert.equal(summary.failedClosed, 1);
    assert.equal(h.counters.commits + h.counters.pushes, 0);
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_ACTIVE, 'the handoff is preserved untouched');
    assert.equal(held?.status_reason, 'container_identity_mismatch');

    const adoption = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: 'task-2', log: silentLog, lockToken: 'task-2-token' },
        mismatched,
    );
    assert.ok('blocked' in adoption && adoption.blocked === 'predecessor_container_identity_mismatch');

    const release = await releaseFollowupHandoffRecord(KEY, { force: true }, mismatched);
    assert.deepEqual(release, { released: false, reason: 'container_identity_mismatch' });

    // The matching container's exit is trusted and recovery proceeds.
    const matching = {
        ...h.deps,
        inspectLiveness: async () => ({ liveness: 'stopped', container: { id: 'container-bound', name: 'propr-agent' } }),
    };
    const recovered = await recoverInterruptedFollowupHandoffs(matching);
    assert.equal(recovered.published, 1);
});

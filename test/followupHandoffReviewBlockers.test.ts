import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { DelayedError } from 'bullmq';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fsPromises, { chmod, mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { up } from '../packages/core/src/db/migrations/20261017000000_add_pr_followup_handoffs.js';

/**
 * Regressions for review 6228423740 (F9–F14): liveness diagnostics must not
 * invalidate the live writer and failed normal checkpoints fail closed (F9),
 * cleanup_pending and unrecordable handoffs block successor admission (F10),
 * committed recovery verifies worktree attachment and the exact recorded HEAD
 * (F11), recovery never rebases over an externally advanced head (F12),
 * no-change recovery re-checks cancellation (F13), and self-provisioned Redis
 * uses the shared runtime configuration (F14).
 *
 * Also regressions for review 6228446060 (F15–F20): normal success and settled
 * failures retain the row at cleanup_pending until branch release is proven
 * (F15), cancellation is re-checked after binding validation (F17), owed-comment
 * publication re-checks the lease before every PATCH/POST including the
 * pagination fallback (F18), and unavailable remote evidence fails closed in
 * the default git ops, the recovery pass and the admission gate (F20).
 *
 * Also regressions for review 6229380750: a missing worktree directory never
 * proves branch release — every retirement path checks the repository's Git
 * worktree registrations and access errors are not "missing" (F23); a
 * cancellation during comment restoration withdraws the restored claims and
 * holds the handoff instead of scheduling replacement work (F24); recovered
 * completion comments bind accepted request bodies only when the agent's full
 * success was recorded (S8).
 *
 * Also regressions for review 6230552827 F36: the job a standalone recovery
 * queues for restored comments keeps the request's spend cap override and
 * budget lineage, including the interrupted task.
 */

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
const root = await mkdtemp(path.join(tmpdir(), 'followup-handoff-blockers-'));
after(async () => { await database.destroy(); await rm(root, { recursive: true, force: true }); });

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
    '-c', 'protocol.file.allow=always', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The admission-gate tests run the production default dependencies end to end,
// so the core git/GitHub/queue surface is functional here instead of throwing.
let currentLiveness = 'not_found';
let refuseBranchRelease = false;
const pushBranchCalls: Array<Record<string, unknown>> = [];
const queuedRecoveryJobs: Array<Record<string, unknown>> = [];
const redisRuntimeConfig: { url?: string; options: Record<string, unknown> } = {
    url: 'rediss://user:secret@redis.example.test:6380/2',
    options: { host: 'redis.example.test', port: 6380, db: 2, maxRetriesPerRequest: null, enableReadyCheck: false },
};
let octokitForDefaults: unknown;

const BRANCH = 'propr/pr-head';
const KEY = { repository: 'acme/widgets', pull_request: 7 };
const LOCK = 'lock:pr:acme:widgets:7';

await mock.module('@propr/core', {
    namedExports: {
        db: database,
        logger: silentLog,
        TaskStates: {
            PENDING: 'pending', PROCESSING: 'processing', CLAUDE_EXECUTION: 'claude_execution',
            POST_PROCESSING: 'post_processing', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled',
        },
        AI_COMMIT_AUTHOR: { name: 'ProPR Test', email: 'propr@example.test' },
        getAuthenticatedOctokit: async () => octokitForDefaults,
        getStateManager: () => { throw new Error('tests must inject their own state manager'); },
        getIssueQueue: async () => ({ add: async () => undefined, getJob: async () => null }),
        issueQueue: {
            add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
                queuedRecoveryJobs.push({ name, data, opts });
                return { id: `recovery-${queuedRecoveryJobs.length}` };
            },
            getJob: async () => null,
        },
        inspectTaskContainerLivenessForTask: async () => ({ liveness: currentLiveness }),
        inspectLegacyDockerContainerLivenessForTask: async () => 'not_found',
        buildRedisRuntimeConfig: () => redisRuntimeConfig,
        commitChanges: async (worktreePath: string, message: string) => {
            git(worktreePath, 'add', '-A');
            git(worktreePath, 'commit', '-m', message);
            return { commitHash: git(worktreePath, 'rev-parse', 'HEAD') };
        },
        createHooklessGit: (cwd: string) => ({
            raw: async (args: string[]) => git(cwd, ...args),
        }),
        releaseBranchFromSettledWorktree: async (_git: unknown, branchName: string, worktreePath: string) => {
            if (refuseBranchRelease) return false;
            if (git(worktreePath, 'status', '--porcelain', '--untracked-files=all') !== '') return false;
            git(worktreePath, 'fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`);
            if (git(worktreePath, 'rev-list', '--count', 'HEAD', '--not', `refs/remotes/origin/${branchName}`) !== '0') return false;
            git(worktreePath, 'checkout', '--detach');
            return true;
        },
        cleanupWorktree: async () => undefined,
        createWorktreeFromExistingBranch: async () => { throw new Error('unexpected worktree creation'); },
        ensureRepoCloned: async () => { throw new Error('unexpected clone'); },
        getRepoUrl: () => 'https://example.test/repo.git',
        pushBranch: async (worktreePath: string, branchName: string, options: Record<string, unknown>) => {
            pushBranchCalls.push({ branchName, ...options });
            git(worktreePath, 'push', 'origin', `HEAD:refs/heads/${branchName}`);
            return { rebased: false, commitHash: git(worktreePath, 'rev-parse', 'HEAD') };
        },
        getPendingPrCommentsKey: (owner: string, repo: string, pr: number) => `pending:${owner}:${repo}:${pr}`,
    },
});

class FakeRuntimeRedis {
    static constructed: unknown[][] = [];
    constructor(...args: unknown[]) { FakeRuntimeRedis.constructed.push(args); }
    async quit() { return 'OK'; }
    async set() { return 'OK'; }
    async eval() { return 1; }
}
// Shaped so both this module's `import('ioredis')` destructuring and bullmq's
// CJS require keep working under the mock.
await mock.module('ioredis', {
    defaultExport: { Redis: FakeRuntimeRedis, default: FakeRuntimeRedis },
    namedExports: { Redis: FakeRuntimeRedis },
});

const {
    recordFollowupHandoff, advanceFollowupHandoff, loadFollowupHandoff, PR_FOLLOWUP_HANDOFFS_TABLE,
    HANDOFF_ACTIVE, HANDOFF_AWAITING_OPERATOR,
} = await import('../src/jobs/followupHandoffStore.js');
const { recordFailedClosed, resolveRecoveryDeps } = await import('../src/jobs/followupHandoffDeps.js');
const { recoverInterruptedFollowupHandoffs } = await import('../src/jobs/followupHandoffRecovery.js');
const {
    FollowupHandoffOwnershipLostError, gatePredecessorHandoff,
    markExecutionHandoffAgentExited, markExecutionHandoffCleanupPending, markExecutionHandoffCommitted, markExecutionHandoffPushed,
    recordExecutionHandoff, retireExecutionHandoffAfterCleanup,
} = await import('../src/jobs/prCommentHandoffIntegration.js');
const { createFollowupHandoffGitOps } = await import('../src/jobs/followupHandoffGitOps.js');
const { resumeFollowupHandoff } = await import('../src/jobs/followupHandoffResume.js');

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

interface GitCounters { commits: number; pushes: number; released: number }

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
        async detachWorktreeHead(worktreePath: string) { git(worktreePath, 'checkout', '--detach'); },
    };
}

function createFakeLockRedis() {
    const store = new Map<string, { value: string; ttl: number }>();
    const restoredJson: string[] = [];
    return {
        store, restoredJson,
        async set(key: string, value: string, _ex: string, ttl: number, nx?: string) {
            if (nx === 'NX' && store.has(key)) return null;
            store.set(key, { value, ttl: Number(ttl) });
            return 'OK';
        },
        async eval(script: string, _numKeys: number, key: string, ...args: Array<string | number>) {
            if (script.includes('cjson')) { // restore pending comments
                restoredJson.push(...args.slice(1).map(String));
                return 1;
            }
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

async function createHarness(options: { taskStates?: Record<string, string> } = {}): Promise<Harness> {
    const fx = await createFixture();
    const counters: GitCounters = { commits: 0, pushes: 0, released: 0 };
    const gitOps = createGitOps(counters);
    const redis = createFakeLockRedis();
    const stateManager = createStateManager(options.taskStates ?? { 'task-1': 'processing' });
    const octokit = createOctokit({ head: { ref: BRANCH }, base: { ref: 'main' } });
    const restored: Array<{ id: number }> = [];
    const deps = {
        store: { database }, redis, log: silentLog, stateManager,
        getOctokit: async () => octokit,
        inspectLiveness: async () => ({ liveness: 'not_found' }),
        git: gitOps,
        restoreComments: async (_record: unknown, claimed: Array<{ id: number }>) => { restored.push(...claimed); },
        taskStates: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
    };
    return { fx, counters, gitOps, redis, stateManager, octokit, restored, deps };
}

async function seedHandoff(h: Harness, overrides: { taskId?: string; binding?: { headRef?: string; baseRef?: string; headSha?: string }; jobData?: Record<string, unknown> } = {}) {
    const record = await recordFollowupHandoff({
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 },
        taskId: overrides.taskId ?? 'task-1',
        sourceTaskIds: [],
        correlationId: 'corr-1',
        target: { repoOwner: 'acme', repoName: 'widgets', branchName: BRANCH, isFork: false },
        worktreePath: h.fx.wt, localRepoPath: h.fx.local,
        claimedComments: [{ id: 11, body: 'please fix the widget', author: 'alice', type: 'issue' }],
        jobData: { pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets', correlationId: 'corr-1', ...overrides.jobData } as never,
        llm: 'claude',
        lockKey: LOCK, lockToken: 'dead-worker-token',
        binding: overrides.binding,
    }, { database });
    assert.ok(record, 'handoff must be recorded');
    return record!;
}

const agentEdit = async (fx: Fixture) => { await writeFile(path.join(fx.wt, 'feature.txt'), 'agent work\n'); };

const commitInWorktree = (fx: Fixture, message = 'agent commit') => {
    git(fx.wt, 'add', '-A');
    git(fx.wt, 'commit', '-m', message);
    return git(fx.wt, 'rev-parse', 'HEAD');
};

beforeEach(async () => {
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).delete();
    currentLiveness = 'not_found';
    refuseBranchRelease = false;
    pushBranchCalls.length = 0;
    queuedRecoveryJobs.length = 0;
    FakeRuntimeRedis.constructed.length = 0;
});

// --- F9: diagnostics never invalidate the live writer; failed checkpoints fail closed.

test('F9: a lease-less liveness diagnostic leaves the live writer\'s checkpoints valid', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const state = { followupHandoff: record };

    // Startup reconciliation gets unavailable container evidence and records
    // the diagnostic while the normal worker still owns the lease and the row.
    await recordFailedClosed(record, { store: { database }, log: silentLog });
    const diagnosed = await loadFollowupHandoff({ database }, KEY);
    assert.equal(diagnosed?.status_reason, 'liveness_unavailable');
    assert.equal(diagnosed?.generation, record.generation, 'the diagnostic does not advance the generation');

    // The live writer's next checkpoints must still land durably.
    await agentEdit(h.fx);
    const head = commitInWorktree(h.fx);
    await markExecutionHandoffCommitted(state, head);
    assert.ok(state.followupHandoff, 'the writer keeps tracking its handoff');
    git(h.fx.wt, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
    await markExecutionHandoffPushed(state, head);
    const persisted = await loadFollowupHandoff({ database }, KEY);
    assert.equal(persisted?.phase, 'pushed');
    assert.equal(persisted?.commit_hash, head);
});

test('F9: a checkpoint that cannot be recorded fails closed instead of continuing untracked', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const state = { followupHandoff: record };
    // A successor adopted the row (new lock token): the original writer lost ownership.
    const adopted = await advanceFollowupHandoff({ database }, record, { lock_token: 'successor-token' });
    assert.ok(adopted);
    await assert.rejects(
        markExecutionHandoffCommitted(state, 'deadbeef'),
        FollowupHandoffOwnershipLostError,
    );
    assert.equal(state.followupHandoff, null);
    const survivor = await loadFollowupHandoff({ database }, KEY);
    assert.equal(survivor?.lock_token, 'successor-token', 'the successor\'s row is untouched');
    assert.equal(survivor?.phase, 'agent_running');
});

test('F9: a benign concurrent generation bump is retried, not treated as lost ownership', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const state = { followupHandoff: record };
    // Same owner, same incarnation and lock token — only the generation moved.
    await advanceFollowupHandoff({ database }, record, { status_reason: 'publication_failed' });
    await markExecutionHandoffCommitted(state, 'abc123');
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.phase, 'committed');
    assert.ok(state.followupHandoff);
});

// --- F10: unresolved predecessors block successor admission.

function gateParams(h: Harness, taskId: string) {
    h.redis.store.set(LOCK, { value: `${taskId}-token`, ttl: 3600 });
    return {
        job: { name: 'processPullRequestComment', data: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 } } as never,
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 },
        taskId,
        stateManager: h.stateManager as never,
        redisClient: h.redis as never,
        pickedUpComments: [],
        lockKey: LOCK, lockToken: `${taskId}-token`,
        correlatedLogger: silentLog as never,
    };
}

test('F10: a cleanup_pending predecessor defers the successor instead of racing the attached branch', async () => {
    const h = await createHarness();
    octokitForDefaults = h.octokit;
    await seedHandoff(h);
    refuseBranchRelease = true;

    // Admission gate: the inline resume settles publication (no changes) but
    // branch release fails, so the successor must be rescheduled, not admitted.
    const result = await gatePredecessorHandoff(gateParams(h, 'task-2'));
    assert.ok(result, 'the successor is not admitted');
    assert.equal(result!.status, 'rescheduled');
    assert.equal((result as { reason?: string }).reason, 'predecessor_cleanup_pending');
    assert.equal(queuedRecoveryJobs.length, 1, 'a delayed replacement job was queued');
    assert.equal(h.redis.store.has(LOCK), false, 'the blocked successor released its lease');
    const retained = await loadFollowupHandoff({ database }, KEY);
    assert.equal(retained?.phase, 'cleanup_pending');
    assert.equal(retained?.status, HANDOFF_ACTIVE);
    assert.equal(retained?.lock_token, 'task-2-token', "the admission gate installed the adopting writer's lease token as the durable owner");
    assert.equal(git(h.fx.wt, 'branch', '--show-current'), BRANCH, 'the branch is still attached');

    // Branch release recovers; the next gate pass finishes cleanup and admits.
    refuseBranchRelease = false;
    const second = await gatePredecessorHandoff(gateParams(h, 'task-2'));
    assert.equal(second, undefined, 'the successor proceeds once the branch is free');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    assert.equal(git(h.fx.wt, 'branch', '--show-current'), '');
});

test('F10: an unrecordable handoff refuses the agent launch', async () => {
    const h = await createHarness();
    // A different task's unresolved row still owns the obligation.
    const predecessor = await seedHandoff(h, { taskId: 'task-1' });
    await advanceFollowupHandoff({ database }, predecessor, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'worktree_missing' });
    const state = {
        worktreeInfo: { worktreePath: h.fx.wt, branchName: BRANCH },
        localRepoPath: h.fx.local,
        unprocessedComments: [],
        startingWorkComment: null,
        followupHandoff: null,
    };
    await assert.rejects(
        recordExecutionHandoff({
            state: state as never,
            job: { data: {} } as never,
            ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 },
            taskId: 'task-2', correlationId: 'corr-2',
            publication: { target: { repoOwner: 'acme', repoName: 'widgets', branchName: BRANCH, isFork: false } } as never,
            llm: 'claude', lockKey: LOCK, lockToken: 'task-2-token',
            binding: { headRef: BRANCH, baseRef: 'main' },
            correlatedLogger: silentLog as never,
        }),
        /agent launch is refused/,
    );
    const survivor = await loadFollowupHandoff({ database }, KEY);
    assert.equal(survivor?.task_id, 'task-1', 'the unresolved row is preserved');
});

test('an operator-held predecessor delays the follow-up in place with backoff instead of queueing a replacement per minute', async () => {
    const h = await createHarness();
    const predecessor = await seedHandoff(h, { taskId: 'task-1' });
    await advanceFollowupHandoff({ database }, predecessor, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'cancelled_by_user' });
    const job = {
        id: 'task-2', name: 'processPullRequestComment', token: 'worker-token',
        data: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, prProcessingLockToken: 'task-2-token' } as Record<string, unknown>,
        updateData: mock.fn(async (next: Record<string, unknown>) => { job.data = next; }),
        moveToDelayed: mock.fn(async (_timestamp: number, _token: string) => {}),
    };
    const delays: number[] = [];
    for (let pass = 0; pass < 2; pass += 1) {
        const before = Date.now();
        await assert.rejects(gatePredecessorHandoff({ ...gateParams(h, 'task-2'), job: job as never }),
            (error: unknown) => error instanceof DelayedError);
        assert.equal(h.redis.store.has(LOCK), false, 'the waiting follow-up released its lease');
        delays.push(job.moveToDelayed.mock.calls[pass].arguments[0] - before);
    }
    assert.equal(queuedRecoveryJobs.length, 0, 'no replacement job, so no new task per retry');
    assert.equal(job.data.predecessorWaitAttempts, 2);
    assert.ok(delays[0] >= 60_000 && delays[0] < 61_000, `first wait is about a minute (${delays[0]})`);
    assert.ok(delays[1] >= 120_000 && delays[1] < 121_000, `second wait backs off (${delays[1]})`);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR, 'the hold is untouched');
});

// --- F11: committed recovery verifies attachment and the exact recorded HEAD.

test('F11: a replaced worktree HEAD holds the committed handoff instead of pushing it', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h, { binding: { headSha: originHead(h.fx) } });
    await agentEdit(h.fx);
    const recorded = commitInWorktree(h.fx);
    const committed = await advanceFollowupHandoff({ database }, record, { phase: 'committed', commit_hash: recorded });
    assert.ok(committed);
    // Manual recovery replaces the worktree HEAD with an unrelated commit.
    await writeFile(path.join(h.fx.wt, 'other.txt'), 'unrelated\n');
    commitInWorktree(h.fx, 'unrelated commit');
    const before = originHead(h.fx);

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.awaitingOperator, 1);
    assert.equal(h.counters.pushes, 0, 'the unverified HEAD is never published');
    assert.equal(originHead(h.fx), before);
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(held?.status_reason, 'recorded_commit_mismatch');
});

test('F11: a committed handoff whose worktree left the branch holds for an operator', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h, { binding: { headSha: originHead(h.fx) } });
    await agentEdit(h.fx);
    const recorded = commitInWorktree(h.fx);
    await advanceFollowupHandoff({ database }, record, { phase: 'committed', commit_hash: recorded });
    git(h.fx.wt, 'checkout', '--detach');

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.awaitingOperator, 1);
    assert.equal(h.counters.pushes, 0);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status_reason, 'worktree_not_on_branch');
});

// --- F12: recovery never rebases over an externally advanced head.

test('F12: a non-fast-forward rejection between validation and push holds for an operator', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h, { binding: { headSha: originHead(h.fx) } });
    await agentEdit(h.fx);
    const recorded = commitInWorktree(h.fx);
    await advanceFollowupHandoff({ database }, record, { phase: 'committed', commit_hash: recorded });
    const before = originHead(h.fx);
    // The other contributor's push lands after validatePublicationBinding fetched.
    h.gitOps.push = async () => {
        throw new Error('To https://example.test/repo.git\n ! [rejected] (fetch first)\nUpdates were rejected because the remote contains work that you do not have locally');
    };

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.awaitingOperator, 1);
    assert.equal(originHead(h.fx), before, 'nothing was force-published or rebased');
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(held?.status_reason, 'head_advanced_externally');
});

test('F12: the default handoff git push disables non-fast-forward rebasing', async () => {
    const fx = await createFixture();
    await writeFile(path.join(fx.wt, 'feature.txt'), 'work\n');
    git(fx.wt, 'add', '-A');
    git(fx.wt, 'commit', '-m', 'work');
    const ops = createFollowupHandoffGitOps(async () => 'token');
    await ops.push(fx.wt, { repoOwner: 'acme', repoName: 'widgets', branchName: BRANCH });
    assert.equal(pushBranchCalls.length, 1);
    assert.equal(pushBranchCalls[0].rebaseOnNonFastForward, false);
});

// --- F13: no-change recovery re-checks cancellation before publishing or restoring.

test('F13: cancellation during git inspection stops the no-change publication and restoration', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    const realUnpushed = h.gitOps.hasUnpushedCommits.bind(h.gitOps);
    h.gitOps.hasUnpushedCommits = async (worktreePath: string) => {
        const result = await realUnpushed(worktreePath);
        // The user cancels while recovery awaits the Git evidence.
        h.stateManager.states.set('task-1', 'cancelled');
        return result;
    };

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.awaitingOperator, 1);
    assert.equal(summary.noChanges, 0);
    assert.equal(h.octokit.comments.length, 0, 'no interruption notice for cancelled work');
    assert.deepEqual(h.restored, [], 'cancelled claimed comments are not requeued');
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(held?.status_reason, 'cancelled_by_user');
    assert.equal(h.stateManager.states.get('task-1'), 'cancelled', 'the task is never marked failed');
});

// --- F14: self-provisioned Redis uses the shared runtime configuration.

test('F14: recovery builds its Redis client from the shared runtime configuration', async () => {
    const h = await createHarness();
    const resolved = await resolveRecoveryDeps({
        log: silentLog, store: { database }, stateManager: h.stateManager as never,
        git: h.gitOps as never, restoreComments: async () => undefined,
        inspectLiveness: async () => ({ liveness: 'not_found' }),
        taskStates: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
    });
    assert.equal(resolved.ownRedis, true);
    assert.equal(FakeRuntimeRedis.constructed.length, 1);
    assert.deepEqual(FakeRuntimeRedis.constructed[0], [redisRuntimeConfig.url, redisRuntimeConfig.options],
        'the URL form carries credentials, TLS and database selection');

    // Without a URL, the full options object (auth, TLS, db) is used directly.
    delete redisRuntimeConfig.url;
    const optionsOnly = await resolveRecoveryDeps({
        log: silentLog, store: { database }, stateManager: h.stateManager as never,
        git: h.gitOps as never, restoreComments: async () => undefined,
        inspectLiveness: async () => ({ liveness: 'not_found' }),
        taskStates: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
    });
    assert.equal(optionsOnly.ownRedis, true);
    assert.deepEqual(FakeRuntimeRedis.constructed[1], [redisRuntimeConfig.options]);

    // An injected client is reused untouched.
    const injected = await resolveRecoveryDeps({
        redis: h.redis as never, log: silentLog, stateManager: h.stateManager as never,
    });
    assert.equal(injected.ownRedis, false);
    assert.equal(FakeRuntimeRedis.constructed.length, 2);
});

// --- F15: durable cleanup for normal success; the row survives until branch release.

test('F15: a published follow-up retains the handoff at cleanup_pending until the branch is free', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    // The normal path delivered commit, push and completion comment.
    await agentEdit(h.fx);
    const head = commitInWorktree(h.fx);
    git(h.fx.wt, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
    const published = await advanceFollowupHandoff({ database }, record, {
        phase: 'comment_published', commit_hash: head, completion_comment_url: 'https://example.test/comment/1',
    });
    assert.ok(published);
    const state = { followupHandoff: published };
    await markExecutionHandoffCleanupPending(state, silentLog as never);
    const pending = await loadFollowupHandoff({ database }, KEY);
    assert.equal(pending?.phase, 'cleanup_pending');
    assert.equal(pending?.status, HANDOFF_ACTIVE);
    assert.equal(git(h.fx.wt, 'branch', '--show-current'), BRANCH, 'the branch is still attached before cleanup');

    // A worker death in this window leaves a discoverable row: recovery frees
    // the branch without republishing anything.
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.equal(h.counters.pushes, 0, 'cleanup never pushes again');
    assert.equal(h.octokit.comments.length, 0, 'cleanup never comments again');
    assert.equal(git(h.fx.wt, 'branch', '--show-current'), '', 'the branch is released');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined, 'the row retires once release is proven');
});

test('F15: the handoff retires only once worktree cleanup proves branch release', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const pending = await advanceFollowupHandoff({ database }, record, { phase: 'cleanup_pending' });
    assert.ok(pending);

    // Worktree cleanup has not freed the branch yet: the row must survive.
    await retireExecutionHandoffAfterCleanup({ followupHandoff: pending }, silentLog as never);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.phase, 'cleanup_pending');

    // Cleanup detached the worktree; retirement is now provable.
    git(h.fx.wt, 'checkout', '--detach');
    const freed = await loadFollowupHandoff({ database }, KEY);
    await retireExecutionHandoffAfterCleanup({ followupHandoff: freed! }, silentLog as never);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

// --- F17: cancellation observed during binding validation stops the push.

test('F17: cancellation during binding validation stops the recovery push', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h, { binding: { headRef: BRANCH, baseRef: 'main', headSha: originHead(h.fx) } });
    await agentEdit(h.fx);
    const recorded = commitInWorktree(h.fx);
    await advanceFollowupHandoff({ database }, record, { phase: 'committed', commit_hash: recorded });
    const realRequest = h.octokit.request.bind(h.octokit);
    h.octokit.request = async (route: string, params?: Record<string, unknown>) => {
        // The user cancels while recovery awaits the PR binding lookup.
        if (route.startsWith('GET ')) h.stateManager.states.set('task-1', 'cancelled');
        return realRequest(route, params);
    };
    const before = originHead(h.fx);

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.awaitingOperator, 1);
    assert.equal(h.counters.pushes, 0, 'the cancelled work is never pushed');
    assert.equal(originHead(h.fx), before);
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(held?.status_reason, 'cancelled_by_user');
});

// --- F18: owed-comment publication re-checks the lease before each mutation.

function resumeParams(h: Harness, record: NonNullable<Awaited<ReturnType<typeof loadFollowupHandoff>>>, isOwnershipLost: () => boolean) {
    return {
        record, octokit: h.octokit as never, git: h.gitOps as never,
        stateManager: h.stateManager as never, restoreComments: async () => undefined,
        store: { database }, log: silentLog,
        taskStates: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
        isOwnershipLost,
    };
}

test('F18: lease loss during comment pagination stops the fallback POST and retains the obligation', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h.fx);
    const head = commitInWorktree(h.fx);
    git(h.fx.wt, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
    const pushed = await advanceFollowupHandoff({ database }, record, { phase: 'pushed', commit_hash: head });
    assert.ok(pushed);
    let lost = false;
    h.octokit.paginate = async () => { lost = true; return []; };

    const outcome = await resumeFollowupHandoff(resumeParams(h, pushed, () => lost));
    assert.equal(outcome.outcome, 'ownership_lost');
    assert.equal(h.octokit.comments.length, 0, 'no comment is created after the observed loss');
    const retained = await loadFollowupHandoff({ database }, KEY);
    assert.equal(retained?.phase, 'pushed');
    assert.equal(retained?.status, HANDOFF_ACTIVE, 'the obligation stays recorded for the next owner');
});

test('F18: lease loss after a 404 starting-comment PATCH stops the fallback creation', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h.fx);
    const head = commitInWorktree(h.fx);
    git(h.fx.wt, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
    // The recorded starting comment was deleted meanwhile: the PATCH 404s and
    // execution falls through to the pagination + creation fallback.
    const pushed = await advanceFollowupHandoff({ database }, record, {
        phase: 'pushed', commit_hash: head, starting_comment_id: 555,
    });
    assert.ok(pushed);
    let lost = false;
    h.octokit.paginate = async () => { lost = true; return []; };

    const outcome = await resumeFollowupHandoff(resumeParams(h, pushed, () => lost));
    assert.equal(outcome.outcome, 'ownership_lost');
    assert.equal(h.octokit.comments.length, 0);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_ACTIVE);
});

// --- F20: unavailable remote evidence fails closed instead of trusting the cache.

test('F20: the default git ops refuse cached remote evidence when the remote is unreachable', async () => {
    const fx = await createFixture();
    const ops = createFollowupHandoffGitOps(async () => 'token');
    assert.ok(await ops.remoteBranchHead(fx.wt, BRANCH), 'a reachable remote answers (and caches the ref)');
    await rename(fx.origin, `${fx.origin}.gone`);
    await assert.rejects(ops.remoteBranchHead(fx.wt, BRANCH), /remote publication evidence is unavailable/);
    // The unpushed-work overestimate stays tolerant offline; it gates nothing by itself.
    assert.equal(await ops.hasUnpushedCommits(fx.wt, BRANCH), false);
});

test('F20: unavailable remote evidence retains the committed handoff and pushes nothing', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h, { binding: { headSha: originHead(h.fx) } });
    await agentEdit(h.fx);
    const recorded = commitInWorktree(h.fx);
    await advanceFollowupHandoff({ database }, record, { phase: 'committed', commit_hash: recorded });
    h.gitOps.remoteBranchHead = async () => { throw new Error('current remote publication evidence is unavailable'); };

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.errors, 1, 'the pass fails closed and retries later');
    assert.equal(h.counters.pushes, 0, 'nothing publishes against stale evidence');
    const retained = await loadFollowupHandoff({ database }, KEY);
    assert.equal(retained?.status, HANDOFF_ACTIVE);
    assert.equal(retained?.phase, 'committed');
});

test('F20: a gate that cannot verify the predecessor reschedules the successor instead of racing it', async () => {
    const h = await createHarness();
    octokitForDefaults = h.octokit;
    const record = await seedHandoff(h, { binding: { headSha: originHead(h.fx) } });
    await agentEdit(h.fx);
    const recorded = commitInWorktree(h.fx);
    await advanceFollowupHandoff({ database }, record, { phase: 'committed', commit_hash: recorded });
    // The gate's inline resume needs current remote evidence; take the remote away.
    await rename(h.fx.origin, `${h.fx.origin}.gone`);

    const result = await gatePredecessorHandoff(gateParams(h, 'task-2'));
    assert.ok(result, 'the successor is not admitted');
    assert.equal(result!.status, 'rescheduled');
    assert.equal((result as { reason?: string }).reason, 'predecessor_recovery_failed');
    assert.equal(queuedRecoveryJobs.length, 1, 'a delayed replacement job was queued');
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_ACTIVE, 'the predecessor obligation is untouched');
});

// --- Review 6229229315 F21: cancellation is re-checked inside comment
// publication, before restoring claimed comments, and before committing.
// F22: an observed lease loss stops restoration, task-state mutation and
// branch release that follow an in-flight await.

function trackedResumeParams(h: Harness, record: NonNullable<Awaited<ReturnType<typeof loadFollowupHandoff>>>, isOwnershipLost: () => boolean = () => false) {
    return {
        ...resumeParams(h, record, isOwnershipLost),
        restoreComments: async (_record: unknown, claimed: Array<{ id: number }>) => { h.restored.push(...claimed); },
    };
}

async function seedPushed(h: Harness) {
    const record = await seedHandoff(h);
    await agentEdit(h.fx);
    const head = commitInWorktree(h.fx);
    git(h.fx.wt, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
    const pushed = await advanceFollowupHandoff({ database }, record, { phase: 'pushed', commit_hash: head });
    assert.ok(pushed);
    return pushed;
}

test('F21: cancellation during comment pagination stops the fallback completion POST', async () => {
    const h = await createHarness();
    const pushed = await seedPushed(h);
    h.octokit.paginate = async () => { h.stateManager.states.set('task-1', 'cancelled'); return []; };

    const outcome = await resumeFollowupHandoff(trackedResumeParams(h, pushed));
    assert.equal(outcome.outcome, 'awaiting_operator');
    assert.equal(h.octokit.comments.length, 0, 'no success comment is published for the cancelled task');
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(held?.status_reason, 'cancelled_by_user');
    assert.equal(held?.phase, 'pushed', 'the owed publication is preserved, not advanced');
});

test('F21: cancellation during a 404 starting-comment PATCH stops the fallback POST', async () => {
    const h = await createHarness();
    const pushed = await advanceFollowupHandoff({ database }, await seedPushed(h), { starting_comment_id: 555 });
    assert.ok(pushed);
    const realRequest = h.octokit.request.bind(h.octokit);
    h.octokit.request = async (route: string, params?: Record<string, unknown>) => {
        if (route.startsWith('PATCH ')) h.stateManager.states.set('task-1', 'cancelled');
        return realRequest(route, params);
    };

    const outcome = await resumeFollowupHandoff(trackedResumeParams(h, pushed));
    assert.equal(outcome.outcome, 'awaiting_operator');
    assert.equal(h.octokit.comments.length, 0);
});

test('F21: cancellation during the no-change notice request stops restoration and task failure', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const realRequest = h.octokit.request.bind(h.octokit);
    h.octokit.request = async (route: string, params?: Record<string, unknown>) => {
        const result = await realRequest(route, params);
        if (route.startsWith('POST ')) h.stateManager.states.set('task-1', 'cancelled');
        return result;
    };

    const outcome = await resumeFollowupHandoff(trackedResumeParams(h, record));
    assert.equal(outcome.outcome, 'awaiting_operator');
    assert.deepEqual(h.restored, [], 'cancelled claimed comments are not returned to pending work');
    assert.equal(h.stateManager.states.get('task-1'), 'cancelled', 'the task is never marked failed');
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(git(h.fx.wt, 'branch', '--show-current'), BRANCH, 'the branch is not released');
});

test('F21: cancellation during dirty-worktree inspection stops the recovery commit', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h.fx);
    const realDirty = h.gitOps.hasUncommittedChanges.bind(h.gitOps);
    h.gitOps.hasUncommittedChanges = async (worktreePath: string) => {
        const dirty = await realDirty(worktreePath);
        h.stateManager.states.set('task-1', 'cancelled');
        return dirty;
    };
    const before = git(h.fx.wt, 'rev-parse', 'HEAD');

    const outcome = await resumeFollowupHandoff(trackedResumeParams(h, record));
    assert.equal(outcome.outcome, 'awaiting_operator');
    assert.equal(h.counters.commits, 0, 'the cancelled work is never committed');
    assert.equal(git(h.fx.wt, 'rev-parse', 'HEAD'), before);
    assert.notEqual(git(h.fx.wt, 'status', '--porcelain'), '', 'the retained edit is preserved');
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.phase, 'agent_running');
});

test('F22: lease loss during dirty-worktree inspection stops the recovery commit', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h.fx);
    let lost = false;
    const realDirty = h.gitOps.hasUncommittedChanges.bind(h.gitOps);
    h.gitOps.hasUncommittedChanges = async (worktreePath: string) => { lost = true; return realDirty(worktreePath); };

    const outcome = await resumeFollowupHandoff(trackedResumeParams(h, record, () => lost));
    assert.equal(outcome.outcome, 'ownership_lost');
    assert.equal(h.counters.commits, 0);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_ACTIVE);
});

test('F22: lease loss during the no-change notice request stops restoration and finalization', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    let lost = false;
    const realRequest = h.octokit.request.bind(h.octokit);
    h.octokit.request = async (route: string, params?: Record<string, unknown>) => {
        const result = await realRequest(route, params);
        if (route.startsWith('POST ')) lost = true;
        return result;
    };

    const outcome = await resumeFollowupHandoff(trackedResumeParams(h, record, () => lost));
    assert.equal(outcome.outcome, 'ownership_lost');
    assert.equal(h.octokit.comments.length, 1, 'the already-started notice request completed');
    assert.deepEqual(h.restored, [], 'claimed comments are not restored after the observed loss');
    assert.equal(h.stateManager.states.get('task-1'), 'processing', 'the task state is not mutated');
    const retained = await loadFollowupHandoff({ database }, KEY);
    assert.equal(retained?.status, HANDOFF_ACTIVE);
    assert.equal(retained?.phase, 'agent_running', 'the obligation is neither advanced nor retired');
    assert.equal(git(h.fx.wt, 'branch', '--show-current'), BRANCH);
});

test('F22: lease loss while finalization reads the task state stops the state update', async () => {
    const h = await createHarness();
    const pushed = await seedPushed(h);
    const published = await advanceFollowupHandoff({ database }, pushed, {
        phase: 'comment_published', completion_comment_url: 'https://example.test/comment/1',
    });
    assert.ok(published);
    let lost = false;
    const realGet = h.stateManager.getTaskState.bind(h.stateManager);
    h.stateManager.getTaskState = async (taskId: string) => { lost = true; return realGet(taskId); };

    const outcome = await resumeFollowupHandoff(trackedResumeParams(h, published, () => lost));
    assert.equal(outcome.outcome, 'ownership_lost');
    assert.equal(h.stateManager.states.get('task-1'), 'processing', 'the task is not finalized after the loss');
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.phase, 'comment_published');
});

test('F22: lease loss during the worktree attachment check stops the branch release', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const pending = await advanceFollowupHandoff({ database }, record, { phase: 'cleanup_pending' });
    assert.ok(pending);
    let lost = false;
    const realAttachment = h.gitOps.worktreeAttachment.bind(h.gitOps);
    h.gitOps.worktreeAttachment = async (worktreePath: string, branchName: string) => {
        lost = true;
        return realAttachment(worktreePath, branchName);
    };

    const outcome = await resumeFollowupHandoff(trackedResumeParams(h, pending, () => lost));
    assert.equal(outcome.outcome, 'ownership_lost');
    assert.equal(h.counters.released, 0, 'the branch is not released after the observed loss');
    assert.equal(git(h.fx.wt, 'branch', '--show-current'), BRANCH);
    const retained = await loadFollowupHandoff({ database }, KEY);
    assert.equal(retained?.phase, 'cleanup_pending', 'the cleanup obligation stays for the successor');
    assert.equal(retained?.status, HANDOFF_ACTIVE);
});

test('F22: lease loss during the branch release leaves the row for the successor to retire', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const pending = await advanceFollowupHandoff({ database }, record, { phase: 'cleanup_pending' });
    assert.ok(pending);
    let lost = false;
    const realRelease = h.gitOps.releaseSettledWorktree.bind(h.gitOps);
    h.gitOps.releaseSettledWorktree = async (localRepoPath: string, branchName: string, worktreePath: string) => {
        const released = await realRelease(localRepoPath, branchName, worktreePath);
        lost = true;
        return released;
    };

    const outcome = await resumeFollowupHandoff(trackedResumeParams(h, pending, () => lost));
    assert.equal(outcome.outcome, 'ownership_lost');
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.phase, 'cleanup_pending');
});

// --- Review 6229380750 F23: release proof comes from Git's worktree
// registrations, never from a missing directory.

test('F23: the default git ops report missing only for absent paths and reject access errors', async () => {
    const h = await createHarness();
    const ops = createFollowupHandoffGitOps(async () => 'token');
    assert.equal(await ops.worktreeAttachment(path.join(h.fx.dir, 'absent'), BRANCH), 'missing');
    await writeFile(path.join(h.fx.dir, 'plain-file'), '');
    assert.equal(await ops.worktreeAttachment(path.join(h.fx.dir, 'plain-file', 'wt'), BRANCH), 'missing');
    // Injected so the rule holds for every uid: root bypasses directory modes.
    for (const code of ['EACCES', 'EPERM', 'EIO']) {
        const denied = mock.method(fsPromises, 'access', async () => { throw Object.assign(new Error(`${code}: injected`), { code }); });
        syncBuiltinESMExports();
        try {
            await assert.rejects(ops.worktreeAttachment(h.fx.wt, BRANCH), { code });
        } finally {
            denied.mock.restore();
            syncBuiltinESMExports();
        }
    }
});

test('F23: a real permission-denied worktree path rejects instead of reporting missing', {
    skip: process.getuid?.() === 0 && 'uid 0 bypasses directory permissions, so chmod cannot produce EACCES; the injected-error test above covers root',
}, async () => {
    const h = await createHarness();
    const ops = createFollowupHandoffGitOps(async () => 'token');
    const guarded = path.join(h.fx.dir, 'guarded');
    await mkdir(path.join(guarded, 'wt'), { recursive: true });
    await chmod(guarded, 0o000);
    try {
        await assert.rejects(ops.worktreeAttachment(path.join(guarded, 'wt'), BRANCH), /EACCES/);
    } finally {
        await chmod(guarded, 0o755);
    }
});

test('F23: the default git ops read branch holders from the registrations, including removed directories', async () => {
    const h = await createHarness();
    const ops = createFollowupHandoffGitOps(async () => 'token');
    assert.deepEqual(await ops.branchWorktreeRegistrations(h.fx.local, BRANCH), [h.fx.wt]);
    await rm(h.fx.wt, { recursive: true, force: true });
    assert.deepEqual(await ops.branchWorktreeRegistrations(h.fx.local, BRANCH), [h.fx.wt],
        'a removed directory still holds the branch until its registration is gone');
    git(h.fx.local, 'worktree', 'prune');
    assert.deepEqual(await ops.branchWorktreeRegistrations(h.fx.local, BRANCH), []);
    await assert.rejects(ops.branchWorktreeRegistrations(path.join(h.fx.dir, 'absent'), BRANCH));
});

test('F23: recovery cleanup keeps the handoff while a removed worktree is still registered on the branch', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const pending = await advanceFollowupHandoff({ database }, record, { phase: 'cleanup_pending' });
    assert.ok(pending);
    await rm(h.fx.wt, { recursive: true, force: true });

    const outcome = await resumeFollowupHandoff(trackedResumeParams(h, pending));
    assert.equal(outcome.outcome, 'cleanup_pending');
    const retained = await loadFollowupHandoff({ database }, KEY);
    assert.equal(retained?.phase, 'cleanup_pending', 'the stranded branch stays discoverable');
    assert.equal(retained?.status, HANDOFF_ACTIVE);

    // Once the registration itself is gone the branch is provably free.
    git(h.fx.local, 'worktree', 'prune');
    const retry = await resumeFollowupHandoff(trackedResumeParams(h, retained!));
    // S11: no request was returned to the queue by recovery, so it is not counted as no_changes.
    assert.equal(retry.outcome, 'settled');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

test('F23: recovery cleanup keeps the handoff when worktree registrations are unreadable', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const pending = await advanceFollowupHandoff({ database }, record, { phase: 'cleanup_pending' });
    assert.ok(pending);
    git(h.fx.wt, 'checkout', '--detach');
    h.gitOps.branchWorktreeRegistrations = async () => { throw new Error('git unavailable'); };

    const outcome = await resumeFollowupHandoff(trackedResumeParams(h, pending));
    assert.equal(outcome.outcome, 'cleanup_pending');
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.phase, 'cleanup_pending');
});

test('F23: recovery cleanup keeps the handoff when the worktree path is inaccessible', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const pending = await advanceFollowupHandoff({ database }, record, { phase: 'cleanup_pending' });
    assert.ok(pending);
    const ops = createFollowupHandoffGitOps(async () => 'token');
    await chmod(h.fx.dir, 0o000);
    try {
        const outcome = await resumeFollowupHandoff({ ...trackedResumeParams(h, pending), git: ops as never });
        assert.equal(outcome.outcome, 'cleanup_pending', 'an access error is not release evidence');
    } finally {
        await chmod(h.fx.dir, 0o755);
    }
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.phase, 'cleanup_pending');
});

test('F23: normal retirement keeps the handoff while a removed worktree is still registered on the branch', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const pending = await advanceFollowupHandoff({ database }, record, { phase: 'cleanup_pending' });
    assert.ok(pending);
    await rm(h.fx.wt, { recursive: true, force: true });

    await retireExecutionHandoffAfterCleanup({ followupHandoff: pending }, silentLog as never);
    const retained = await loadFollowupHandoff({ database }, KEY);
    assert.equal(retained?.phase, 'cleanup_pending', 'a missing directory is not release proof');

    git(h.fx.local, 'worktree', 'prune');
    await retireExecutionHandoffAfterCleanup({ followupHandoff: retained! }, silentLog as never);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

// --- Review 6229380750 F24: a cancellation during comment restoration never
// schedules replacement work.

test('F24: cancellation during restoration withdraws the restored claims and holds instead of scheduling', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const pending: number[] = [];
    const scheduled: unknown[] = [];
    const outcome = await resumeFollowupHandoff({
        ...trackedResumeParams(h, record),
        restoreComments: async (_record: unknown, claimed: Array<{ id: number }>) => {
            pending.push(...claimed.map(comment => comment.id));
            // The user cancels while the restoration is awaited.
            h.stateManager.states.set('task-1', 'cancelled');
        },
        withdrawRestoredComments: async (_record: unknown, claimed: Array<{ id: number }>) => {
            for (const comment of claimed) pending.splice(pending.indexOf(comment.id), 1);
        },
        scheduleRestoredComments: async (scheduledRecord: unknown) => { scheduled.push(scheduledRecord); },
    });

    assert.equal(outcome.outcome, 'awaiting_operator');
    assert.deepEqual(scheduled, [], 'no replacement follow-up job is queued');
    assert.deepEqual(pending, [], 'the restored claims cannot trigger automatic execution');
    assert.equal(h.stateManager.states.get('task-1'), 'cancelled', 'the task is never marked failed');
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR, 'the handoff stays for an operator decision');
    assert.equal(held?.status_reason, 'cancelled_by_user');
    assert.notEqual(held?.phase, 'cleanup_pending');
    assert.equal(git(h.fx.wt, 'branch', '--show-current'), BRANCH, 'the branch is not released');
});

test('F24: a failed withdrawal still holds the cancelled handoff and schedules nothing', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const scheduled: unknown[] = [];
    const outcome = await resumeFollowupHandoff({
        ...trackedResumeParams(h, record),
        restoreComments: async () => { h.stateManager.states.set('task-1', 'cancelled'); },
        withdrawRestoredComments: async () => { throw new Error('redis unavailable'); },
        scheduleRestoredComments: async (scheduledRecord: unknown) => { scheduled.push(scheduledRecord); },
    });
    assert.equal(outcome.outcome, 'awaiting_operator');
    assert.deepEqual(scheduled, []);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR);
});

test('F24: a standalone recovery pass cancelled during restoration queues no follow-up job', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    const withdrawn: number[] = [];
    queuedRecoveryJobs.length = 0;
    const summary = await recoverInterruptedFollowupHandoffs({
        ...h.deps,
        restoreComments: async () => { h.stateManager.states.set('task-1', 'cancelled'); },
        withdrawRestoredComments: async (_record: unknown, claimed: Array<{ id: number }>) => { withdrawn.push(...claimed.map(comment => comment.id)); },
    } as never);
    assert.equal(summary.awaitingOperator, 1);
    assert.deepEqual(withdrawn, [11], 'the recovery pass wires the withdrawal through');
    assert.deepEqual(queuedRecoveryJobs, [], 'the default scheduler never queued replacement work');
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR);
});

// --- Review 6230552827 F36: the restored request keeps its spending constraints.

test('F36: standalone no-change recovery queues the restored request with its spend cap and budget lineage', async () => {
    const h = await createHarness();
    await seedHandoff(h, { jobData: { maxCostUsd: 4.5, costBudgetTaskIds: ['task-0'] } });
    const summary = await recoverInterruptedFollowupHandoffs(h.deps as never);
    assert.equal(summary.noChanges, 1);
    assert.deepEqual(h.restored.map(comment => comment.id), [11], 'the claimed comment was restored');
    assert.equal(queuedRecoveryJobs.length, 1, 'the default scheduler queued the replacement');
    const queued = queuedRecoveryJobs[0] as { name: string; data: Record<string, unknown> };
    assert.equal(queued.name, 'processPullRequestComment');
    assert.equal(queued.data.maxCostUsd, 4.5, 'the explicit spend cap override is kept');
    assert.deepEqual(queued.data.costBudgetTaskIds, ['task-0', 'task-1'], 'earlier attempts and the interrupted task count toward the budget');
    assert.notEqual(queued.data.correlationId, 'corr-1');
});

test('F36: a restored request without an override still counts the interrupted attempt\'s spend', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await recoverInterruptedFollowupHandoffs(h.deps as never);
    assert.equal(queuedRecoveryJobs.length, 1);
    const queued = queuedRecoveryJobs[0] as { data: Record<string, unknown> };
    assert.equal('maxCostUsd' in queued.data, false, 'no override is invented');
    assert.deepEqual(queued.data.costBudgetTaskIds, ['task-1']);
});

// --- Review 6229380750 S8: accepted-request evidence on recovered completions.

const ACCEPTED_SHA = 'a'.repeat(64);

async function seedCompletedPushed(h: Harness, agentCompleted: number | null) {
    const record = await recordFollowupHandoff({
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 },
        taskId: 'task-1', sourceTaskIds: [], correlationId: 'corr-1',
        target: { repoOwner: 'acme', repoName: 'widgets', branchName: BRANCH, isFork: false },
        worktreePath: h.fx.wt, localRepoPath: h.fx.local,
        claimedComments: [{ id: 11, body: 'please fix the widget', author: 'alice', type: 'issue', acceptedBodySha256: ACCEPTED_SHA }],
        jobData: { pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets', correlationId: 'corr-1' } as never,
        llm: 'claude', lockKey: LOCK, lockToken: 'dead-worker-token',
    }, { database });
    assert.ok(record);
    await agentEdit(h.fx);
    const head = commitInWorktree(h.fx);
    git(h.fx.wt, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
    const pushed = await advanceFollowupHandoff({ database }, record!, { phase: 'pushed', commit_hash: head, agent_completed: agentCompleted });
    assert.ok(pushed);
    return pushed!;
}

test('S8: a recovered completion of a fully successful agent binds the accepted request bodies', async () => {
    const h = await createHarness();
    const pushed = await seedCompletedPushed(h, 1);
    const outcome = await resumeFollowupHandoff(trackedResumeParams(h, pushed));
    assert.equal(outcome.outcome, 'published');
    assert.equal(h.octokit.comments.length, 1);
    assert.match(h.octokit.comments[0].body, new RegExp(`<!-- propr:accepted-request comment-id=11 body-sha256=${ACCEPTED_SHA} -->`));
});

for (const agentCompleted of [0, null]) {
    test(`S8: a recovered completion without recorded full success (${agentCompleted}) binds no accepted bodies`, async () => {
        const h = await createHarness();
        const pushed = await seedCompletedPushed(h, agentCompleted);
        const outcome = await resumeFollowupHandoff(trackedResumeParams(h, pushed));
        assert.equal(outcome.outcome, 'published');
        assert.equal(h.octokit.comments.length, 1);
        assert.doesNotMatch(h.octokit.comments[0].body, /propr:accepted-request/);
        assert.match(h.octokit.comments[0].body, /11✓/, 'the completed comment IDs are still reported');
    });
}

test('S8: the normal path records whether the agent exited with full success', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    const carrier = { followupHandoff: record };
    await markExecutionHandoffAgentExited(carrier, true);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.agent_completed, 1);
    assert.equal(carrier.followupHandoff?.phase, 'agent_exited');
    await markExecutionHandoffAgentExited(carrier, false);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.agent_completed, 0);
});

// --- Review 6229573230 F25: an operator release is recorded only once the
// repository's worktree registrations prove the branch free.

const { releaseFollowupHandoffRecord } = await import('../src/jobs/followupHandoffRecovery.js');
const { HANDOFF_RELEASED } = await import('../src/jobs/followupHandoffStore.js');

test('F25: a forced release of a removed but still-registered worktree is refused and the obligation kept', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await agentEdit(h.fx);
    await rm(h.fx.wt, { recursive: true, force: true });

    const refused = await releaseFollowupHandoffRecord(KEY, { force: true }, h.deps);
    assert.deepEqual(refused, { released: false, reason: 'branch_still_registered' });
    const retained = await loadFollowupHandoff({ database }, KEY);
    assert.equal(retained?.status, HANDOFF_ACTIVE, 'admission keeps treating the branch as held');
    assert.equal(h.redis.store.size, 0, 'the operator lease is released after the refusal');

    // Once the stale registration itself is repaired, the release is proven.
    git(h.fx.local, 'worktree', 'prune');
    assert.equal((await releaseFollowupHandoffRecord(KEY, { force: true }, h.deps)).released, true);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_RELEASED);
});

test('F25: a release whose settled-release claim left the branch registered is refused', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    // The release reports success without actually freeing the branch.
    h.gitOps.releaseSettledWorktree = async () => true;

    for (const force of [false, true]) {
        const refused = await releaseFollowupHandoffRecord(KEY, { force }, h.deps);
        assert.deepEqual(refused, { released: false, reason: 'branch_still_registered' });
    }
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_ACTIVE);
});

test('F25: unreadable worktree registrations refuse the release, forced or not', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    h.gitOps.branchWorktreeRegistrations = async () => { throw new Error('git unavailable'); };

    assert.deepEqual(await releaseFollowupHandoffRecord(KEY, {}, h.deps),
        { released: false, reason: 'worktree_registrations_unavailable' });
    await agentEdit(h.fx);
    assert.deepEqual(await releaseFollowupHandoffRecord(KEY, { force: true }, h.deps),
        { released: false, reason: 'worktree_registrations_unavailable' });
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_ACTIVE);
});

test('F25: a forced detach that frees the branch is recorded as released', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await agentEdit(h.fx);
    assert.equal((await releaseFollowupHandoffRecord(KEY, { force: true }, h.deps)).released, true);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_RELEASED);
    assert.deepEqual(await h.gitOps.branchWorktreeRegistrations(h.fx.local, BRANCH), []);
    assert.ok(existsSync(path.join(h.fx.wt, 'feature.txt')), 'the retained files survive');
});

// --- Review 6229573230 F26: a replacement incarnation never inherits its
// predecessor's recorded agent success.

test('F26: a successor replacing a released successful handoff binds no accepted bodies after its own interruption', async () => {
    const h = await createHarness({ taskStates: { 'task-1': 'completed', 'task-2': 'processing' } });
    const predecessor = await seedCompletedPushed(h, 1);
    const released = await advanceFollowupHandoff({ database }, predecessor, { status: HANDOFF_RELEASED, status_reason: 'released_by_operator' });
    assert.ok(released);

    const successor = await recordFollowupHandoff({
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 },
        taskId: 'task-2', sourceTaskIds: [], correlationId: 'corr-2',
        target: { repoOwner: 'acme', repoName: 'widgets', branchName: BRANCH, isFork: false },
        worktreePath: h.fx.wt, localRepoPath: h.fx.local,
        claimedComments: [{ id: 12, body: 'and the gadget', author: 'alice', type: 'issue', acceptedBodySha256: ACCEPTED_SHA }],
        jobData: { pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets', correlationId: 'corr-2' } as never,
        llm: 'claude', lockKey: LOCK, lockToken: 'dead-successor-token',
    }, { database });
    assert.ok(successor);
    const stored = await loadFollowupHandoff({ database }, KEY);
    assert.equal(stored?.task_id, 'task-2');
    assert.equal(stored?.agent_completed, null, 'the replacement row resets the predecessor\'s agent success');

    // The successor's agent leaves partial work and is lost before its exit checkpoint.
    await writeFile(path.join(h.fx.wt, 'partial.txt'), 'partial successor work\n');
    const outcome = await resumeFollowupHandoff(trackedResumeParams(h, stored!));
    assert.equal(outcome.outcome, 'published');
    const completion = h.octokit.comments.at(-1)!;
    assert.match(completion.body, /12✓/);
    assert.doesNotMatch(completion.body, /propr:accepted-request/, 'no accepted-request evidence without the successor\'s own success');
});

// --- Review 6229573230 F27: recovery reconciles a completion the normal path
// delivered before its durable checkpoint, without overwriting or duplicating it.

const { normalCompletionHandoffMarkers } = await import('../src/jobs/followupHandoffMarker.js');

function trackMutations(h: Harness): string[] {
    const mutations: string[] = [];
    const request = h.octokit.request.bind(h.octokit);
    h.octokit.request = async (route: string, params?: Record<string, unknown>) => {
        if (!route.startsWith('GET ')) mutations.push(route.split(' ')[0]);
        return request(route, params);
    };
    return mutations;
}

async function withStartingComment(h: Harness, record: NonNullable<Awaited<ReturnType<typeof loadFollowupHandoff>>>) {
    h.octokit.comments.push({ id: 500, body: '🤖 Starting work on the follow-up', html_url: 'https://example.test/comment/500' });
    const linked = await advanceFollowupHandoff({ database }, record, { starting_comment_id: 500 });
    assert.ok(linked);
    return linked!;
}

test('F27: a completion delivered on the starting comment before its checkpoint is recorded unchanged', async () => {
    const h = await createHarness();
    const pushed = await withStartingComment(h, await seedPushed(h));
    // Normal publication PATCHed the starting comment, then the worker died
    // before markExecutionHandoffCommentPublished.
    const normalBody = `${normalCompletionHandoffMarkers(pushed)}\n\n✅ Applied the follow-up changes (normal completion)`;
    h.octokit.comments[0].body = normalBody;
    const mutations = trackMutations(h);

    const outcome = await resumeFollowupHandoff(trackedResumeParams(h, pushed));
    assert.equal(outcome.outcome, 'published');
    assert.deepEqual(mutations, [], 'no PATCH or POST touches the delivered completion');
    assert.equal(h.octokit.comments.length, 1);
    assert.equal(h.octokit.comments[0].body, normalBody);
    assert.equal(h.stateManager.states.get('task-1'), 'completed');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined, 'the handoff retires once the branch is free');
});

test('F27: a completion delivered as a separate comment is recorded without announcing again on the starting comment', async () => {
    const h = await createHarness();
    const pushed = await withStartingComment(h, await seedPushed(h));
    const normalBody = `${normalCompletionHandoffMarkers(pushed)}\n\n✅ Applied the follow-up changes (replacement comment)`;
    h.octokit.comments.push({ id: 501, body: normalBody, html_url: 'https://example.test/comment/501' });
    const mutations = trackMutations(h);
    let checkpointedUrl: string | null | undefined;

    const outcome = await resumeFollowupHandoff({
        ...trackedResumeParams(h, pushed),
        stateManager: {
            ...h.stateManager,
            async updateTaskState(taskId: string, state: string) {
                checkpointedUrl = (await loadFollowupHandoff({ database }, KEY))?.completion_comment_url;
                h.stateManager.states.set(taskId, state);
            },
        },
    });
    assert.equal(outcome.outcome, 'published');
    assert.deepEqual(mutations, []);
    assert.equal(h.octokit.comments[0].body, '🤖 Starting work on the follow-up', 'the starting comment is left alone');
    assert.equal(h.octokit.comments.length, 2);
    assert.equal(checkpointedUrl, 'https://example.test/comment/501', 'the delivered URL is checkpointed before finalization');
});

test('F27: a delivered no-change completion is recorded as completed, never requeued as interrupted', async () => {
    const h = await createHarness();
    const record = await withStartingComment(h, await seedHandoff(h));
    const carrier = { followupHandoff: record };
    await markExecutionHandoffAgentExited(carrier, true);
    // Normal no-change completion was delivered; the worker died before its checkpoint.
    const normalBody = `${normalCompletionHandoffMarkers(record)}\n\n✅ No changes were needed`;
    h.octokit.comments[0].body = normalBody;
    const mutations = trackMutations(h);

    const outcome = await resumeFollowupHandoff(trackedResumeParams(h, carrier.followupHandoff!));
    assert.equal(outcome.outcome, 'settled', 'S11: a reconciled completion is not an interrupted request returned to the queue');
    assert.deepEqual(mutations, []);
    assert.equal(h.octokit.comments[0].body, normalBody);
    assert.deepEqual(h.restored, [], 'the answered request is not returned to the queue');
    assert.equal(h.stateManager.states.get('task-1'), 'completed');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

test('F27: without delivered completion evidence recovery still publishes once on the starting comment', async () => {
    const h = await createHarness();
    const pushed = await withStartingComment(h, await seedPushed(h));
    const mutations = trackMutations(h);

    const outcome = await resumeFollowupHandoff(trackedResumeParams(h, pushed));
    assert.equal(outcome.outcome, 'published');
    assert.deepEqual(mutations, ['PATCH']);
    assert.match(h.octokit.comments[0].body, /Recovered and published follow-up changes/);
});

// --- A follow-up held for an operator on a merged or closed pull request must
// not block every later follow-up forever (integry/mcptest#447: a /fix queued
// a replacement every minute for two hours, and kept going after the merge).

const { releaseClosedPullRequestHandoffs, readPullRequestClosure } = await import('../src/jobs/closedPullRequestHandoffs.js');

function waitingJob(taskId: string) {
    const job = {
        id: taskId, name: 'processPullRequestComment', token: 'worker-token',
        data: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, prProcessingLockToken: `${taskId}-token` } as Record<string, unknown>,
        updateData: mock.fn(async (next: Record<string, unknown>) => { job.data = next; }),
        moveToDelayed: mock.fn(async (_timestamp: number, _token: string) => {}),
    };
    return job;
}

test('a follow-up blocked by an operator hold on a merged pull request ends instead of waiting', async () => {
    const h = await createHarness();
    const predecessor = await seedHandoff(h, { taskId: 'task-1' });
    await advanceFollowupHandoff({ database }, predecessor, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'worktree_not_on_branch' });
    const job = waitingJob('task-2');
    const releases: Array<{ ref: unknown; closure: string }> = [];
    const queuedBefore = queuedRecoveryJobs.length;

    const result = await gatePredecessorHandoff({
        ...gateParams(h, 'task-2'), job: job as never,
        pullRequestClosure: async () => 'merged',
        releaseClosedHold: async (ref, closure) => { releases.push({ ref, closure }); return { released: true }; },
    });

    assert.deepEqual(result, { status: 'cancelled', reason: 'cancelled_pr_closed', pullRequestNumber: 7 });
    assert.equal(job.moveToDelayed.mock.calls.length, 0, 'the job does not wait');
    assert.equal(queuedRecoveryJobs.length, queuedBefore, 'no replacement job is queued');
    assert.equal(h.redis.store.has(LOCK), false, 'the PR lease is released before the hold is');
    assert.deepEqual(releases, [{ ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 }, closure: 'merged' }]);
});

for (const [label, closure] of [
    ['an open pull request', async () => null],
    ['an unreadable pull request state', async () => { throw new Error('GitHub unavailable'); }],
] as const) {
    test(`a follow-up blocked by an operator hold keeps waiting for ${label}`, async () => {
        const h = await createHarness();
        const predecessor = await seedHandoff(h, { taskId: 'task-1' });
        await advanceFollowupHandoff({ database }, predecessor, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'cancelled_by_user' });
        const job = waitingJob('task-2');

        await assert.rejects(gatePredecessorHandoff({
            ...gateParams(h, 'task-2'), job: job as never, pullRequestClosure: closure,
            releaseClosedHold: async () => assert.fail('an open pull request keeps its hold'),
        }), (error: unknown) => error instanceof DelayedError);
        assert.equal(job.moveToDelayed.mock.calls.length, 1);
        assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR);
    });
}

test('readPullRequestClosure tells merged, closed and open pull requests apart', async () => {
    const reply = (data: Record<string, unknown>) => ({ request: async () => ({ data }) });
    assert.equal(await readPullRequestClosure(reply({ state: 'closed', merged: true }), 'acme', 'widgets', 7), 'merged');
    assert.equal(await readPullRequestClosure(reply({ state: 'closed', merged: false, merged_at: null }), 'acme', 'widgets', 7), 'closed');
    assert.equal(await readPullRequestClosure(reply({ state: 'open' }), 'acme', 'widgets', 7), null);
});

test('the periodic pass releases a hold on a merged pull request, keeps retained work, and drops its queued comments', async () => {
    const h = await createHarness();
    const predecessor = await seedHandoff(h, { taskId: 'task-1' });
    await agentEdit(h.fx);
    await advanceFollowupHandoff({ database }, predecessor, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'worktree_not_on_branch' });
    const deleted: string[] = [];
    const redis = Object.assign(h.redis, { del: async (key: string) => { deleted.push(key); return 1; } });
    let now = 1_000_000;

    // Open: nothing changes, and the pull request is not read again within the interval.
    const open = await releaseClosedPullRequestHandoffs({ ...h.deps, redis, now: () => now });
    assert.deepEqual(open, { inspected: 1, released: 0, refused: 0, errors: 0 });
    h.octokit.pull = { ...h.octokit.pull, state: 'closed', merged: true } as never;
    const throttled = await releaseClosedPullRequestHandoffs({ ...h.deps, redis, now: () => now });
    assert.equal(throttled.inspected, 0);

    now += 10 * 60_000;
    const merged = await releaseClosedPullRequestHandoffs({ ...h.deps, redis, now: () => now });
    assert.deepEqual(merged, { inspected: 1, released: 1, refused: 0, errors: 0 });
    const released = await loadFollowupHandoff({ database }, KEY);
    assert.equal(released?.status, HANDOFF_RELEASED);
    assert.equal(released?.status_reason, 'released_pr_merged');
    assert.ok(existsSync(path.join(h.fx.wt, 'feature.txt')), 'retained edits are never deleted');
    assert.deepEqual(deleted, ['pending:acme:widgets:7']);
    assert.equal(h.redis.store.has(LOCK), false, 'the operator lease is released');
});

test('the periodic pass leaves a hold whose agent is still running for a later pass', async () => {
    const h = await createHarness();
    const predecessor = await seedHandoff(h, { taskId: 'task-1' });
    await advanceFollowupHandoff({ database }, predecessor, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'cancelled_by_user' });
    h.octokit.pull = { ...h.octokit.pull, state: 'closed', merged: false } as never;

    const summary = await releaseClosedPullRequestHandoffs({
        ...h.deps, inspectLiveness: async () => ({ liveness: 'running' }), now: () => 5_000_000,
    });
    assert.deepEqual(summary, { inspected: 1, released: 0, refused: 1, errors: 0 });
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR);
});

for (const deletedDuringResume of [false, true]) {
    test(`F6: pending retry defers successor admission (deleted during resume=${deletedDuringResume})`, async () => {
        const h = await createHarness({ taskStates: { 'task-1': 'pending' } });
        octokitForDefaults = h.octokit;
        const record = await seedHandoff(h);
        await agentEdit(h.fx);
        const commit = commitInWorktree(h.fx);
        await advanceFollowupHandoff({ database }, record, { phase: deletedDuringResume ? 'agent_exited' : 'committed', commit_hash: commit, status_reason: 'publication_failed' });
        if (deletedDuringResume) {
            const readState = h.stateManager.getTaskState.bind(h.stateManager);
            h.stateManager.getTaskState = async taskId => {
                // After the early attachment check and adoption, resume awaits
                // cancellation state before collecting the attempt's output.
                if (taskId === 'task-1') await rm(h.fx.wt, { recursive: true, force: true });
                return readState(taskId);
            };
        } else {
            await rm(h.fx.wt, { recursive: true, force: true });
        }
        const result = await gatePredecessorHandoff(gateParams(h, 'task-2'));
        assert.equal(result?.status, 'rescheduled');
        assert.equal((result as { reason?: string }).reason, 'predecessor_retry_pending');
        assert.equal(queuedRecoveryJobs.length, 1);
        assert.equal(h.redis.store.has(LOCK), false);
        assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_ACTIVE);
        assert.equal(pushBranchCalls.length, 0);
    });
}

for (const patch of [{ status_reason: 'publication_failed' }, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'worktree_missing' }]) {
    test(`F7: stale diagnostic cannot overwrite a newly checkpointed ${patch.status_reason}`, async () => {
        const h = await createHarness();
        const stale = await seedHandoff(h);
        await advanceFollowupHandoff({ database }, stale, patch);
        await recordFailedClosed(stale, { store: { database }, log: silentLog });
        assert.equal((await loadFollowupHandoff({ database }, KEY))?.status_reason, patch.status_reason);
    });
}

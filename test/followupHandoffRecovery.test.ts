import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import knex from 'knex';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { up } from '../packages/core/src/db/migrations/20261017000000_add_pr_followup_handoffs.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await up(database);
const root = await mkdtemp(path.join(tmpdir(), 'followup-handoff-'));
after(async () => { await database.destroy(); await rm(root, { recursive: true, force: true }); });

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
// Jobs the default standalone-recovery scheduler queues for restored comments.
const queuedFollowupJobs: Array<{ name: string; data: Record<string, unknown>; opts: Record<string, unknown> }> = [];

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
        inspectTaskContainerLivenessForTask: async () => { throw new Error('tests must inject liveness'); },
        commitChanges: async () => { throw new Error('tests must inject git operations'); },
        createHooklessGit: () => { throw new Error('tests must inject git operations'); },
        releaseBranchFromSettledWorktree: async () => { throw new Error('tests must inject git operations'); },
        cleanupWorktree: async () => undefined,
        createWorktreeFromExistingBranch: async () => { throw new Error('unexpected worktree creation'); },
        ensureRepoCloned: async () => { throw new Error('unexpected clone'); },
        getRepoUrl: () => 'https://example.test/repo.git',
        pushBranch: async () => { throw new Error('tests must inject git operations'); },
        getPendingPrCommentsKey: (owner: string, repo: string, pr: number) => `pending:${owner}:${repo}:${pr}`,
        issueQueue: {
            add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
                queuedFollowupJobs.push({ name, data, opts });
                return { id: String(opts.jobId) };
            },
        },
    },
});

const {
    recordFollowupHandoff, advanceFollowupHandoff, loadFollowupHandoff, loadFollowupHandoffs,
    HANDOFF_ACTIVE, HANDOFF_AWAITING_OPERATOR, HANDOFF_RELEASED, PR_FOLLOWUP_HANDOFFS_TABLE,
} = await import('../src/jobs/followupHandoffStore.js');
const {
    adoptPredecessorFollowupHandoff, authorizeCancelledFollowupHandoff, inspectFollowupHandoffs,
    recoverInterruptedFollowupHandoffs, releaseFollowupHandoffRecord, settleFollowupHandoffAfterFailure,
} = await import('../src/jobs/followupHandoffRecovery.js');
const { adoptPRProcessingLock } = await import('../src/jobs/prProcessingLock.js');

const BRANCH = 'propr/pr-7';
const KEY = { repository: 'acme/widgets', pull_request: 7 };

const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
    '-c', 'protocol.file.allow=always', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let fixtureIndex = 0;
interface Fixture { dir: string; origin: string; local: string; wt: string }

/** A bare origin, a clone acting as the shared local repo, and a retained worktree holding the branch. */
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

interface GitCounters { commits: number; pushes: number; released: number; detached: number; restarted: number }

function createGitOps(counters: GitCounters) {
    const clean = (wt: string) => git(wt, 'status', '--porcelain', '--untracked-files=all') === '';
    const unpushed = (wt: string) => {
        git(wt, 'fetch', 'origin', BRANCH);
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
        /** Models core's restartBranchFromRemoteHead after the authenticated fetch. */
        async restartBranchFromRemoteHead(localRepoPath: string, branchName: string) {
            git(localRepoPath, 'fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`);
            const remote = git(localRepoPath, 'rev-parse', `refs/remotes/origin/${branchName}`);
            const local = git(localRepoPath, 'rev-parse', `refs/heads/${branchName}`);
            if (git(localRepoPath, 'rev-list', '--count', local, '--not', remote) === '0') return true;
            if (git(localRepoPath, 'worktree', 'list', '--porcelain').split('\n').includes(`branch refs/heads/${branchName}`)) return false;
            git(localRepoPath, 'update-ref', `refs/propr/superseded/${branchName}/${local.slice(0, 12)}`, local);
            git(localRepoPath, 'update-ref', `refs/heads/${branchName}`, remote, local);
            counters.restarted += 1;
            return true;
        },
    };
}

const localBranchHead = (fx: Fixture) => git(fx.local, 'rev-parse', `refs/heads/${BRANCH}`);
const supersededBackups = (fx: Fixture) => git(fx.local, 'for-each-ref', '--format=%(objectname)', `refs/propr/superseded/${BRANCH}/`).split('\n').filter(Boolean);
/** What the next job's createWorktreeFromExistingBranch checks out: the reused local branch as it is. */
function nextJobHead(fx: Fixture, name: string): string {
    const wt = path.join(fx.dir, name);
    git(fx.local, 'worktree', 'add', wt, BRANCH);
    return git(wt, 'rev-parse', 'HEAD');
}

/** In-memory PR processing lease with the adopt/renew/release script semantics. */
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
    const updates: Array<{ taskId: string; state?: string; metadata?: Record<string, unknown> }> = [];
    return {
        states, updates,
        async getTaskState(taskId: string) { return states.has(taskId) ? { state: states.get(taskId)! } : null; },
        async updateTaskState(taskId: string, state: string, metadata?: Record<string, unknown>) {
            states.set(taskId, state);
            updates.push({ taskId, state, metadata });
        },
        async updateHistoryMetadata(taskId: string, _historyState: string, metadata?: Record<string, unknown>) {
            updates.push({ taskId, metadata });
        },
    };
}

interface FakeComment { id: number; body: string; html_url: string }

function createOctokit(seedComments: FakeComment[] = []) {
    const comments = [...seedComments];
    let nextId = 1000;
    return {
        comments,
        pull: { state: 'open', merged: false },
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

async function createHarness(options: { taskStates?: Record<string, string>; liveness?: string; comments?: FakeComment[] } = {}): Promise<Harness> {
    const fx = await createFixture();
    const counters: GitCounters = { commits: 0, pushes: 0, released: 0, detached: 0, restarted: 0 };
    const gitOps = createGitOps(counters);
    const redis = createFakeLockRedis();
    const stateManager = createStateManager(options.taskStates ?? { 'task-1': 'processing' });
    const octokit = createOctokit(options.comments);
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

async function seedHandoff(h: Harness, overrides: { taskId?: string; startingCommentId?: number; lockToken?: string } = {}) {
    const record = await recordFollowupHandoff({
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7 },
        taskId: overrides.taskId ?? 'task-1',
        sourceTaskIds: [],
        correlationId: 'corr-1',
        target: { repoOwner: 'acme', repoName: 'widgets', branchName: BRANCH, isFork: false },
        worktreePath: h.fx.wt, localRepoPath: h.fx.local,
        claimedComments: [{ id: 11, body: 'please fix the widget', author: 'alice', type: 'issue' }],
        jobData: { pullRequestNumber: 7, repoOwner: 'acme', repoName: 'widgets', correlationId: 'corr-1' } as never,
        llm: 'claude',
        lockKey: 'lock:pr:acme:widgets:7',
        lockToken: overrides.lockToken ?? 'dead-worker-token',
        startingCommentId: overrides.startingCommentId,
    }, { database });
    assert.ok(record, 'handoff must be recorded');
    return record!;
}

const agentEdit = async (h: Harness) => {
    await writeFile(path.join(h.fx.wt, 'feature.txt'), 'agent work\n');
};

const publishedComments = (h: Harness) => h.octokit.comments.filter(comment => comment.body.includes('Recovered and published follow-up changes'));

beforeEach(async () => {
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).delete();
    queuedFollowupJobs.length = 0;
});

test('restart while the agent container is live leaves the handoff and worktree untouched', async () => {
    const h = await createHarness({ liveness: 'running' });
    await seedHandoff(h);
    await agentEdit(h);
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.skippedLiveAgent, 1);
    assert.equal(summary.published, 0);
    assert.equal(h.counters.commits + h.counters.pushes, 0);
    assert.equal(h.octokit.comments.length, 0);
    const record = await loadFollowupHandoff({ database }, KEY);
    assert.equal(record?.phase, 'agent_running');
    assert.equal(record?.status, HANDOFF_ACTIVE);
});

test('agent exited before commit: edits are committed, pushed and announced exactly once', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h, { startingCommentId: 500 });
    h.octokit.comments.push({ id: 500, body: 'Starting work', html_url: 'https://example.test/comment/500' });
    await advanceFollowupHandoff({ database }, record, { phase: 'agent_exited' });
    await agentEdit(h);
    const before = originHead(h.fx);
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.equal(h.counters.commits, 1);
    assert.equal(h.counters.pushes, 1);
    assert.notEqual(originHead(h.fx), before);
    // The owed comment lands on the retained starting-work comment, not a duplicate.
    assert.equal(h.octokit.comments.length, 1);
    assert.match(h.octokit.comments[0].body, /Recovered and published follow-up changes/);
    assert.match(h.octokit.comments[0].body, /11✓/);
    assert.equal(h.stateManager.states.get('task-1'), 'completed');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    // The worktree is preserved with a detached HEAD so the branch is free again.
    assert.equal(h.counters.released, 1);
    assert.ok(existsSync(path.join(h.fx.wt, 'feature.txt')));
    assert.equal(git(h.fx.wt, 'branch', '--show-current'), '');
});

test('committed before push: the existing commit is pushed without re-committing', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h);
    git(h.fx.wt, 'add', '-A');
    git(h.fx.wt, 'commit', '-m', 'agent commit');
    const head = git(h.fx.wt, 'rev-parse', 'HEAD');
    await advanceFollowupHandoff({ database }, record, { phase: 'committed', commit_hash: head });
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.equal(h.counters.commits, 0);
    assert.equal(h.counters.pushes, 1);
    assert.equal(originHead(h.fx), head);
    assert.equal(publishedComments(h).length, 1);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

test('evidence alone recovers committed-but-unpushed work when the phase write was lost', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await agentEdit(h);
    git(h.fx.wt, 'add', '-A');
    git(h.fx.wt, 'commit', '-m', 'agent commit');
    const head = git(h.fx.wt, 'rev-parse', 'HEAD');
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.equal(h.counters.commits, 0, 'no duplicate commit on top of the agent commit');
    assert.equal(originHead(h.fx), head);
});

test('pushed before comment publication: only the owed comment is published', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h);
    git(h.fx.wt, 'add', '-A');
    git(h.fx.wt, 'commit', '-m', 'agent commit');
    git(h.fx.wt, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
    const head = originHead(h.fx);
    await advanceFollowupHandoff({ database }, record, { phase: 'pushed', commit_hash: head });
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.equal(h.counters.commits + h.counters.pushes, 0);
    assert.equal(originHead(h.fx), head);
    assert.equal(publishedComments(h).length, 1);
    assert.equal(h.stateManager.states.get('task-1'), 'completed');
});

test('comment published before task finalization: finalizes without another comment', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h);
    git(h.fx.wt, 'add', '-A');
    git(h.fx.wt, 'commit', '-m', 'agent commit');
    git(h.fx.wt, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
    await advanceFollowupHandoff({ database }, record, {
        phase: 'comment_published', commit_hash: originHead(h.fx), completion_comment_url: 'https://example.test/comment/1',
    });
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.equal(h.octokit.comments.length, 0, 'the owed comment was already delivered');
    assert.equal(h.stateManager.states.get('task-1'), 'completed');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

test('no changes: owed notice is posted, claimed comments are returned, and the task fails', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    const before = originHead(h.fx);
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.noChanges, 1);
    assert.equal(summary.published, 0);
    assert.equal(originHead(h.fx), before);
    assert.equal(h.octokit.comments.length, 1);
    assert.match(h.octokit.comments[0].body, /interrupted before any changes/);
    assert.ok(!h.octokit.comments[0].body.includes('11✓'), 'returned comments are not acknowledged as processed');
    assert.deepEqual(h.restored.map(comment => comment.id), [11]);
    assert.equal(h.stateManager.states.get('task-1'), 'failed');
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    assert.equal(h.counters.released, 1);
    // S7: a standalone pass runs outside any comment job, so it queues the
    // pending-comment follow-up itself instead of waiting for a new comment.
    assert.equal(queuedFollowupJobs.length, 1);
    assert.equal(queuedFollowupJobs[0].name, 'processPullRequestComment');
    assert.deepEqual(queuedFollowupJobs[0].data.comments, []);
    assert.equal(queuedFollowupJobs[0].data.pullRequestNumber, 7);
    assert.equal(queuedFollowupJobs[0].data.branchName, BRANCH);
    assert.match(String(queuedFollowupJobs[0].opts.jobId), /^pr-comments-batch-acme-widgets-7-handoff-/);
});

test('S7: a no-change pass retried after a crash re-queues under the same per-incarnation job ID', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    // The worker dies after restoring and queuing, before the task is finalized.
    const realUpdate = h.stateManager.updateTaskState.bind(h.stateManager);
    h.stateManager.updateTaskState = async () => { throw new Error('worker died'); };
    const first = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(first.errors, 1);
    assert.equal(queuedFollowupJobs.length, 1);
    h.stateManager.updateTaskState = realUpdate;
    const second = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(second.noChanges, 1);
    assert.equal(h.octokit.comments.length, 1, 'the notice is deduplicated by its marker');
    assert.equal(queuedFollowupJobs.length, 2);
    assert.equal(queuedFollowupJobs[1].opts.jobId, queuedFollowupJobs[0].opts.jobId,
        'BullMQ keeps one job per ID, so the retry cannot queue a duplicate attempt');
});

test('S7: in-line predecessor adoption leaves the pending follow-up to the adopting job', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    queuedFollowupJobs.length = 0;
    const adoption = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: 'task-2', log: silentLog, lockToken: 'task-2-token' },
        h.deps,
    );
    assert.equal('resumed' in adoption && adoption.resumed?.outcome, 'no_changes');
    assert.deepEqual(h.restored.map(comment => comment.id), [11]);
    assert.equal(queuedFollowupJobs.length, 0, 'the adopting job\'s cleanup drains the restored comments');
});

test('missing worktree holds the handoff for an operator instead of failing or fabricating work', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await rm(h.fx.wt, { recursive: true, force: true });
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.awaitingOperator, 1);
    const record = await loadFollowupHandoff({ database }, KEY);
    assert.equal(record?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(record?.status_reason, 'worktree_missing');
    assert.equal(h.octokit.comments.length, 0);
});

test('unavailable container liveness fails closed and a later healthy pass recovers', async () => {
    const h = await createHarness({ liveness: 'unavailable' });
    await seedHandoff(h);
    await agentEdit(h);
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.failedClosed, 1);
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_ACTIVE);
    assert.equal(held?.status_reason, 'liveness_unavailable');
    assert.equal(h.counters.commits + h.counters.pushes, 0);
    // Liveness comes back and reports the container gone: the same record publishes.
    const healthy = { ...h.deps, inspectLiveness: async () => ({ liveness: 'not_found' }) };
    const second = await recoverInterruptedFollowupHandoffs(healthy);
    assert.equal(second.published, 1);
    assert.equal(publishedComments(h).length, 1);
});

test('user cancellation is authoritative: nothing publishes without explicit operator authorization', async () => {
    const h = await createHarness({ taskStates: { 'task-1': 'cancelled' } });
    await seedHandoff(h);
    await agentEdit(h);
    const before = originHead(h.fx);
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.awaitingOperator, 1);
    assert.equal(originHead(h.fx), before);
    assert.equal(h.octokit.comments.length, 0);
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(held?.status_reason, 'cancelled_by_user');
    assert.ok(existsSync(path.join(h.fx.wt, 'feature.txt')), 'cancelled work is preserved');

    // Explicit operator authorization publishes the preserved work exactly once.
    const authorized = await authorizeCancelledFollowupHandoff(KEY, { store: { database }, redis: h.redis });
    assert.equal(authorized?.status, HANDOFF_ACTIVE);
    const second = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(second.published, 1);
    assert.notEqual(originHead(h.fx), before);
    assert.equal(publishedComments(h).length, 1);
    assert.equal(h.stateManager.states.get('task-1'), 'cancelled', 'the cancelled terminal state is never overwritten');
});

test('a redelivered follow-up adopts the recoverable predecessor under the shared lease', async () => {
    const h = await createHarness();
    await seedHandoff(h, { taskId: 'task-1' });
    await agentEdit(h);
    const adoption = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: 'task-2', log: silentLog, lockToken: 'task-2-token' },
        h.deps,
    );
    assert.ok('resumed' in adoption && adoption.resumed?.outcome === 'published');
    assert.equal(publishedComments(h).length, 1);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
    // Nothing left to adopt: the new follow-up proceeds to prepare its own worktree.
    const again = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: 'task-2', log: silentLog, lockToken: 'task-2-token' },
        h.deps,
    );
    assert.ok(!('blocked' in again) || !again.blocked);
});

test('a live predecessor blocks a new follow-up instead of racing its retained worktree', async () => {
    const h = await createHarness({ liveness: 'running' });
    await seedHandoff(h);
    const adoption = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: 'task-2', log: silentLog, lockToken: 'task-2-token' },
        h.deps,
    );
    assert.ok('blocked' in adoption && adoption.blocked === 'predecessor_agent_still_running');
    const unavailable = await adoptPredecessorFollowupHandoff(
        { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId: 'task-2', log: silentLog, lockToken: 'task-2-token' },
        { ...h.deps, inspectLiveness: async () => ({ liveness: 'unavailable' }) },
    );
    assert.ok('blocked' in unavailable && unavailable.blocked === 'predecessor_liveness_unavailable');
});

test('a second recovery pass after success publishes nothing more', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await agentEdit(h);
    const first = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(first.published, 1);
    const second = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(second.inspected, 0);
    assert.equal(h.counters.commits, 1);
    assert.equal(h.counters.pushes, 1);
    assert.equal(publishedComments(h).length, 1);
});

test('a lease still renewed by its recorded owner refuses takeover; a stale one converges', async () => {
    const h = await createHarness();
    await seedHandoff(h, { lockToken: 'owner-token' });
    await agentEdit(h);
    // Freshly renewed lease: the recorded owner is alive somewhere.
    h.redis.store.set('lock:pr:acme:widgets:7', { value: 'owner-token', ttl: 3600 });
    const blocked = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(blocked.lockedByOtherWriter, 1);
    assert.equal(h.counters.pushes, 0);
    // The same lease without renewals is a dead owner's: successor ownership is taken.
    h.redis.store.set('lock:pr:acme:widgets:7', { value: 'owner-token', ttl: 100 });
    const recovered = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(recovered.published, 1);
    assert.equal(h.redis.store.has('lock:pr:acme:widgets:7'), false, 'the successor lease is released after recovery');
});

test('a different live owner\'s lease is never taken over', async () => {
    const h = await createHarness();
    await seedHandoff(h, { lockToken: 'owner-token' });
    h.redis.store.set('lock:pr:acme:widgets:7', { value: 'someone-else', ttl: 10 });
    const result = await adoptPRProcessingLock(h.redis, 'lock:pr:acme:widgets:7', { predecessorToken: 'owner-token', successorToken: 'succ' });
    assert.equal(result, 'other_owner');
    assert.equal(h.redis.store.get('lock:pr:acme:widgets:7')?.value, 'someone-else');
});

test('release refuses to free a branch holding unpublished work unless forced, and never deletes files', async () => {
    const h = await createHarness();
    await seedHandoff(h);
    await agentEdit(h);
    const refused = await releaseFollowupHandoffRecord(KEY, {}, h.deps);
    assert.equal(refused.released, false);
    assert.equal(refused.reason, 'worktree_holds_unpublished_work');
    const forced = await releaseFollowupHandoffRecord(KEY, { force: true }, h.deps);
    assert.equal(forced.released, true);
    assert.equal(h.counters.detached, 1);
    assert.ok(existsSync(path.join(h.fx.wt, 'feature.txt')), 'files survive a forced release');
    const record = await loadFollowupHandoff({ database }, KEY);
    assert.equal(record?.status, HANDOFF_RELEASED);
    // Released handoffs are skipped by recovery and reported as needing nothing.
    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.inspected, 0);
    const [status] = await inspectFollowupHandoffs({ store: { database }, inspectLiveness: async () => ({ liveness: 'not_found' }) }, KEY);
    assert.equal(status.nextAction, 'none');
});

test('status inspection names the retained worktree and the next action', async () => {
    const h = await createHarness({ liveness: 'running' });
    await seedHandoff(h);
    const statuses = await inspectFollowupHandoffs({ store: { database }, inspectLiveness: async () => ({ liveness: 'running' }) });
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].record.worktree_path, h.fx.wt);
    assert.equal(statuses[0].liveness, 'running');
    assert.match(statuses[0].nextAction, /wait for the live agent/);
    assert.equal((await loadFollowupHandoffs({ database }, { status: HANDOFF_ACTIVE })).length, 1);
});

for (const phase of ['comment_published', 'cleanup_pending'] as const) {
    test(`recovery retires ${phase} after normal cleanup removed the checkout`, async () => {
        const h = await createHarness();
        const record = await seedHandoff(h);
        await advanceFollowupHandoff({ database }, record, {
            phase, commit_hash: originHead(h.fx), completion_comment_url: 'https://example.test/comment/1',
        });
        git(h.fx.local, 'worktree', 'remove', h.fx.wt);
        const summary = await recoverInterruptedFollowupHandoffs(h.deps);
        assert.equal(summary.published, 1);
        assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
        assert.equal(h.counters.commits + h.counters.pushes + h.counters.released, 0);
        assert.equal(h.octokit.comments.length, 0);
    });
}

for (const phase of ['committed', 'pushed'] as const) {
    test(`${phase} obligation survives missing checkout and failure settlement`, async () => {
        const h = await createHarness();
        const record = await seedHandoff(h);
        await agentEdit(h);
        git(h.fx.wt, 'add', '-A');
        git(h.fx.wt, 'commit', '-m', 'agent commit');
        const head = git(h.fx.wt, 'rev-parse', 'HEAD');
        if (phase === 'pushed') git(h.fx.wt, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
        await advanceFollowupHandoff({ database }, record, { phase, commit_hash: head });
        git(h.fx.local, 'worktree', 'remove', h.fx.wt);
        await settleFollowupHandoffAfterFailure(
            { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, taskId: 'task-1', cancelled: false },
            { store: { database }, git: h.deps.git, log: silentLog },
        );
        assert.equal((await loadFollowupHandoff({ database }, KEY))?.phase, phase);
        const summary = await recoverInterruptedFollowupHandoffs(h.deps);
        assert.equal(summary.errors, 0);
        if (phase === 'pushed') {
            assert.equal(summary.published, 1);
            assert.equal(publishedComments(h).length, 1);
            assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
        } else {
            assert.equal(summary.awaitingOperator, 1);
            assert.equal((await loadFollowupHandoff({ database }, KEY))?.status_reason, 'worktree_missing');
            assert.equal(h.octokit.comments.length, 0);
        }
    });
}

/**
 * Production git ops rebuild a deleted worktree from the clone's local branch
 * and release a missing worktree by dropping its registration; this models both.
 */
function withWorktreeRestore(h: Harness, options: { failRestore?: boolean } = {}) {
    const restores: string[] = [];
    const gitOps = {
        ...h.gitOps,
        async restoreMissingWorktree(localRepoPath: string, worktreePath: string, branchName: string) {
            if (options.failRestore) return false;
            git(localRepoPath, 'worktree', 'prune', '--expire=now');
            git(localRepoPath, 'worktree', 'add', worktreePath, branchName);
            restores.push(worktreePath);
            return true;
        },
        async releaseSettledWorktree(localRepoPath: string, branchName: string, worktreePath: string) {
            if (existsSync(worktreePath)) return h.gitOps.releaseSettledWorktree(localRepoPath, branchName, worktreePath);
            git(localRepoPath, 'worktree', 'prune', '--expire=now');
            return true;
        },
    };
    h.deps.git = gitOps;
    return restores;
}

test('a deleted worktree is rebuilt from the branch and the agent\'s unpushed commit is published', async () => {
    const h = await createHarness();
    const restores = withWorktreeRestore(h);
    const record = await seedHandoff(h);
    await advanceFollowupHandoff({ database }, record, { phase: 'agent_exited', agent_completed: 1 });
    await agentEdit(h);
    git(h.fx.wt, 'add', '-A');
    git(h.fx.wt, 'commit', '-m', 'agent commit');
    const agentCommit = git(h.fx.wt, 'rev-parse', 'HEAD');
    await rm(h.fx.wt, { recursive: true, force: true });

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.equal(summary.awaitingOperator, 0);
    assert.deepEqual(restores, [h.fx.wt]);
    assert.equal(originHead(h.fx), agentCommit, 'the commit made before the deletion reaches the pull request');
    assert.equal(publishedComments(h).length, 1);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

test('a deleted worktree without commits returns the request to the queue, even after a reported success', async () => {
    const h = await createHarness();
    withWorktreeRestore(h);
    const record = await seedHandoff(h);
    // The agent reported success, but its uncommitted edits went with the folder.
    await advanceFollowupHandoff({ database }, record, { phase: 'agent_exited', agent_completed: 1 });
    await agentEdit(h);
    await rm(h.fx.wt, { recursive: true, force: true });

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.noChanges, 1);
    assert.deepEqual(h.restored.map(comment => comment.id), [11]);
    assert.equal(h.octokit.comments.length, 1);
    assert.match(h.octokit.comments[0].body, /worktree was deleted/);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

test('a worktree_missing hold from before the fix is re-armed and recovered by the next pass', async () => {
    const h = await createHarness({ taskStates: { 'task-1': 'failed' } });
    withWorktreeRestore(h);
    const record = await seedHandoff(h);
    await rm(h.fx.wt, { recursive: true, force: true });
    await advanceFollowupHandoff({ database }, record, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'worktree_missing' });

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.noChanges, 1);
    assert.deepEqual(h.restored.map(comment => comment.id), [11]);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

test('a cancelled hold is released by the background pass once stale, and its comments are not requeued', async () => {
    const h = await createHarness({ taskStates: { 'task-1': 'cancelled' } });
    withWorktreeRestore(h);
    const withdrawn: number[] = [];
    h.deps.withdrawRestoredComments = async (_record: unknown, claimed: Array<{ id: number }>) => { withdrawn.push(...claimed.map(comment => comment.id)); };
    const record = await seedHandoff(h);
    await rm(h.fx.wt, { recursive: true, force: true });
    await advanceFollowupHandoff({ database }, record, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'worktree_missing' });

    await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR, 'a fresh hold is left for a day');
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).update({ updated_at: Date.now() - 25 * 3_600_000 });
    await recoverInterruptedFollowupHandoffs(h.deps);
    const released = await loadFollowupHandoff({ database }, KEY);
    assert.equal(released?.status, HANDOFF_RELEASED);
    assert.equal(released?.status_reason, 'auto_released_stale_hold');
    assert.deepEqual(withdrawn, [11], 'the cancelled request is withdrawn from the pending list');
    assert.equal(h.restored.length, 0);
    assert.equal(queuedFollowupJobs.length, 0);
    assert.match(h.octokit.comments.at(-1)?.body ?? '', /Cleared a stuck follow-up/);
});

test('a worktree that cannot be rebuilt is held once as worktree_restore_failed and not retried in a loop', async () => {
    const h = await createHarness();
    withWorktreeRestore(h, { failRestore: true });
    await seedHandoff(h);
    await rm(h.fx.wt, { recursive: true, force: true });

    const first = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(first.awaitingOperator, 1);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status_reason, 'worktree_restore_failed');
    const second = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(second.inspected, 0);
    assert.equal(h.octokit.comments.length, 0);
});

const adoptAs = (h: Harness, currentTaskId: string) => adoptPredecessorFollowupHandoff(
    { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: 7, currentTaskId, log: silentLog, lockToken: `${currentTaskId}-token` },
    h.deps,
);

test('the automatic retry of a failed attempt takes over its own not_on_branch hold instead of waiting forever', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h);
    git(h.fx.wt, 'add', '-A');
    git(h.fx.wt, 'commit', '-m', 'agent commit');
    // Push salvage after a rejected push: commits kept elsewhere, worktree moved off the branch.
    git(h.fx.wt, 'checkout', '--detach');
    await advanceFollowupHandoff({ database }, record, { phase: 'committed', commit_hash: git(h.fx.wt, 'rev-parse', 'HEAD') });
    const committed = await loadFollowupHandoff({ database }, KEY);
    await advanceFollowupHandoff({ database }, committed!, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'worktree_not_on_branch' });

    assert.deepEqual(await adoptAs(h, 'task-2'), { blocked: 'predecessor_awaiting_operator' }, 'another task still waits for the operator');
    assert.deepEqual(await adoptAs(h, 'task-1'), {});
    const released = await loadFollowupHandoff({ database }, KEY);
    assert.equal(released?.status, HANDOFF_RELEASED);
    assert.equal(released?.status_reason, 'superseded_by_retry');
    assert.equal(h.counters.pushes, 0, 'the failed attempt\'s commit is not published');
    assert.ok(existsSync(path.join(h.fx.wt, 'feature.txt')), 'the failed attempt\'s files stay on disk');
    // F3: the branch no longer carries the failed attempt's commit, so the retry does not inherit it.
    assert.equal(localBranchHead(h.fx), originHead(h.fx), 'the branch restarts from the pull request head');
    assert.deepEqual(supersededBackups(h.fx), [git(h.fx.wt, 'rev-parse', 'HEAD')], 'the failed commit is kept under a backup ref');
    assert.equal(nextJobHead(h.fx, 'retry-wt'), originHead(h.fx));
    assert.deepEqual(await adoptAs(h, 'task-3'), {}, 'later comments are no longer blocked');
});

test('the retry takes over right after a handled failure that moved the worktree off the branch', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h);
    git(h.fx.wt, 'checkout', '--detach');
    await advanceFollowupHandoff({ database }, record, { phase: 'agent_exited', status_reason: 'publication_failed' });

    assert.deepEqual(await adoptAs(h, 'task-1'), {});
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_RELEASED);
    assert.equal(h.octokit.comments.length, 0);
});

test('a same-task redelivery whose worktree is still on the branch keeps normal recovery', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h);
    await advanceFollowupHandoff({ database }, record, { phase: 'agent_exited', status_reason: 'publication_failed' });

    const adoption = await adoptAs(h, 'task-1');
    assert.equal('resumed' in adoption && adoption.resumed?.outcome, 'published');
    assert.equal(h.counters.pushes, 1);
});

test('a user-cancelled hold is never taken over by a job of the same task', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await advanceFollowupHandoff({ database }, record, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'cancelled_by_user' });
    assert.deepEqual(await adoptAs(h, 'task-1'), { blocked: 'predecessor_awaiting_operator' });
});

async function heldBy(h: Harness, reason: string, taskState: string) {
    h.stateManager.states.set('task-1', taskState);
    const record = await seedHandoff(h);
    git(h.fx.wt, 'checkout', '--detach');
    await advanceFollowupHandoff({ database }, record, { status: HANDOFF_AWAITING_OPERATOR, status_reason: reason });
}

test('a new comment releases a hold whose attempt failed and gave up its branch, and tells the PR', async () => {
    const h = await createHarness();
    await heldBy(h, 'worktree_not_on_branch', 'failed');
    assert.deepEqual(await adoptAs(h, 'task-2'), {});
    const released = await loadFollowupHandoff({ database }, KEY);
    assert.equal(released?.status, HANDOFF_RELEASED);
    assert.equal(released?.status_reason, 'auto_released_for_new_request');
    assert.equal(h.counters.pushes, 0);
    assert.ok(existsSync(path.join(h.fx.wt, 'base.txt')), 'the old worktree stays on disk');
    assert.equal(h.octokit.comments.length, 1);
    assert.match(h.octokit.comments[0].body, /Cleared a stuck follow-up[\s\S]*comment again/);
    assert.doesNotMatch(h.octokit.comments[0].body, /\/tmp|fx-/, 'no host paths on the pull request');
});

test('a new comment drops a cancelled request\'s comments when it releases the hold', async () => {
    const h = await createHarness();
    const withdrawn: number[] = [];
    h.deps.withdrawRestoredComments = async (_record: unknown, claimed: Array<{ id: number }>) => { withdrawn.push(...claimed.map(comment => comment.id)); };
    await heldBy(h, 'cancelled_by_user', 'cancelled');
    assert.deepEqual(await adoptAs(h, 'task-2'), { releasedCancelledClaimIds: [11] });
    assert.deepEqual(withdrawn, [11]);
});

test('a hold whose own retry is still pending keeps a new comment waiting for that retry', async () => {
    const h = await createHarness();
    await heldBy(h, 'worktree_not_on_branch', 'pending');
    assert.deepEqual(await adoptAs(h, 'task-2'), { blocked: 'predecessor_awaiting_operator' });
});

test('holds that need a real decision are never released automatically', async () => {
    const h = await createHarness();
    await heldBy(h, 'pr_binding_mismatch', 'failed');
    assert.deepEqual(await adoptAs(h, 'task-2'), { blocked: 'predecessor_awaiting_operator' });
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).update({ updated_at: Date.now() - 30 * 24 * 3_600_000 });
    await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(h.octokit.comments.length, 0);
});

test('a stale failed hold is released by the background pass without any new comment', async () => {
    const h = await createHarness();
    await heldBy(h, 'head_advanced_externally', 'failed');
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).update({ updated_at: Date.now() - 25 * 3_600_000 });
    await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status_reason, 'auto_released_stale_hold');
    assert.equal(h.octokit.comments.length, 1);
});

// --- F2: the loss of a worktree is durable evidence, not a local observation.

test('F2: a worker that stops after the rebuild but before the claims are restored still requeues the request', async () => {
    const h = await createHarness();
    withWorktreeRestore(h);
    const record = await seedHandoff(h);
    await advanceFollowupHandoff({ database }, record, { phase: 'agent_exited', agent_completed: 1, agent_summary: 'all done' });
    await agentEdit(h);
    await rm(h.fx.wt, { recursive: true, force: true });
    // The worker stops right after the rebuild: the restoration of the claimed comments never runs.
    const restoreComments = h.deps.restoreComments;
    h.deps.restoreComments = async () => { throw new Error('worker stopped'); };
    const interrupted = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(interrupted.errors, 1);
    assert.ok(existsSync(h.fx.wt), 'the worktree was rebuilt before the stop');
    const marked = await loadFollowupHandoff({ database }, KEY);
    assert.equal(marked?.status, HANDOFF_ACTIVE);
    assert.equal(marked?.agent_completed, null, 'the recorded success is invalidated durably, before the rebuild');
    assert.equal(marked?.agent_summary, null);
    assert.equal(marked?.status_reason, 'worktree_lost');

    // The next pass (after a restart) finds the folder intact; the loss is on record.
    h.deps.restoreComments = restoreComments;
    const second = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(second.noChanges, 1);
    assert.equal(second.settled, 0, 'the lost run is not reported as an answered request');
    assert.deepEqual(h.restored.map(comment => comment.id), [11]);
    assert.equal(h.octokit.comments.length, 1);
    assert.match(h.octokit.comments[0].body, /worktree was deleted/);
    assert.doesNotMatch(h.octokit.comments[0].body, /Analyzed the follow-up request/);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

test('F2: the loss marker is written before the rebuild, so a rebuild that fails leaves no trusted success behind', async () => {
    const h = await createHarness();
    withWorktreeRestore(h, { failRestore: true });
    const record = await seedHandoff(h);
    await advanceFollowupHandoff({ database }, record, { phase: 'agent_exited', agent_completed: 1 });
    await rm(h.fx.wt, { recursive: true, force: true });
    assert.equal((await recoverInterruptedFollowupHandoffs(h.deps)).awaitingOperator, 1);
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status_reason, 'worktree_restore_failed');
    assert.equal(held?.agent_completed, null);
});

test('F2: a committed handoff whose worktree was deleted is rebuilt and pushes exactly the recorded commit', async () => {
    const h = await createHarness();
    const restores = withWorktreeRestore(h);
    const record = await seedHandoff(h);
    await agentEdit(h);
    git(h.fx.wt, 'add', '-A');
    git(h.fx.wt, 'commit', '-m', 'agent commit');
    const agentCommit = git(h.fx.wt, 'rev-parse', 'HEAD');
    await advanceFollowupHandoff({ database }, record, { phase: 'committed', commit_hash: agentCommit, agent_completed: 1 });
    await rm(h.fx.wt, { recursive: true, force: true });

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published, 1);
    assert.deepEqual(restores, [h.fx.wt]);
    assert.equal(originHead(h.fx), agentCommit);
    assert.equal(h.counters.pushes, 1);
    assert.equal(await loadFollowupHandoff({ database }, KEY), undefined);
});

// --- S10: re-arming a worktree_missing hold grants no authority and keeps it releasable.

test('S10: a re-armed worktree_missing hold whose rebuild then fails is still released by a new comment', async () => {
    const h = await createHarness({ taskStates: { 'task-1': 'failed' } });
    withWorktreeRestore(h, { failRestore: true });
    const record = await seedHandoff(h);
    await rm(h.fx.wt, { recursive: true, force: true });
    await advanceFollowupHandoff({ database }, record, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'worktree_missing' });

    assert.equal((await recoverInterruptedFollowupHandoffs(h.deps)).awaitingOperator, 1);
    const held = await loadFollowupHandoff({ database }, KEY);
    assert.equal(held?.status_reason, 'worktree_restore_failed');
    assert.equal(held?.operator_authorized, 0, 're-arming grants no publication authority');
    assert.deepEqual(await adoptAs(h, 'task-2'), {});
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_RELEASED);
    // The stale background pass releases such a hold too.
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).delete();
    const again = await seedHandoff(h);
    await advanceFollowupHandoff({ database }, again, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'worktree_restore_failed' });
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).update({ updated_at: Date.now() - 25 * 3_600_000 });
    await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status_reason, 'auto_released_stale_hold');
});

// --- S11: releasable holds on the liveness path.

test('S11: an inconclusive liveness probe blocks a new comment without making the hold unreleasable', async () => {
    const h = await createHarness({ liveness: 'unavailable' });
    await heldBy(h, 'worktree_not_on_branch', 'failed');
    assert.deepEqual(await adoptAs(h, 'task-2'), { blocked: 'predecessor_liveness_unavailable' });
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status_reason, 'worktree_not_on_branch', 'the hold reason is not overwritten');
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR);
    h.deps.inspectLiveness = async () => ({ liveness: 'not_found' });
    assert.deepEqual(await adoptAs(h, 'task-2'), {}, 'a later conclusive probe releases it');
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_RELEASED);
});

test('S11: a cancelled hold keeps its reason through an inconclusive probe, so resume still demands authorization', async () => {
    const h = await createHarness({ liveness: 'unavailable' });
    await heldBy(h, 'cancelled_by_user', 'cancelled');
    assert.deepEqual(await adoptAs(h, 'task-2'), { blocked: 'predecessor_liveness_unavailable' });
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status_reason, 'cancelled_by_user');
});

test('S11: a same-task takeover that cannot free the branch names the registration, not an operator hold', async () => {
    const h = await createHarness();
    const record = await seedHandoff(h);
    await agentEdit(h);
    git(h.fx.wt, 'checkout', '--detach');
    await advanceFollowupHandoff({ database }, record, { phase: 'agent_exited', status_reason: 'publication_failed' });
    h.deps.git = { ...h.gitOps, branchWorktreeRegistrations: async () => ['/elsewhere/holder'] };
    assert.deepEqual(await adoptAs(h, 'task-1'), { blocked: 'predecessor_branch_still_held' });
    const kept = await loadFollowupHandoff({ database }, KEY);
    assert.equal(kept?.status, HANDOFF_ACTIVE);
    assert.equal(kept?.status_reason, 'publication_failed');
});

// --- S15: automatic release when the settled-worktree release refuses.

test('S15: a new comment releases a cancelled attempt with unpublished work by detaching it; the commit stays', async () => {
    const h = await createHarness();
    const withdrawn: number[] = [];
    h.deps.withdrawRestoredComments = async (_record: unknown, claimed: Array<{ id: number }>) => { withdrawn.push(...claimed.map(comment => comment.id)); };
    h.stateManager.states.set('task-1', 'cancelled');
    const record = await seedHandoff(h);
    await agentEdit(h);
    git(h.fx.wt, 'add', '-A');
    git(h.fx.wt, 'commit', '-m', 'never published');
    const unpublished = git(h.fx.wt, 'rev-parse', 'HEAD');
    await advanceFollowupHandoff({ database }, record, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'cancelled_by_user' });

    assert.deepEqual(await adoptAs(h, 'task-2'), { releasedCancelledClaimIds: [11] });
    assert.equal(h.counters.released, 0, 'the settled-worktree release refused the unpublished commit');
    assert.equal(h.counters.detached, 1, 'the worktree was detached in place instead');
    assert.equal(git(h.fx.wt, 'branch', '--show-current'), '', 'the branch is free');
    assert.equal(git(h.fx.wt, 'rev-parse', 'HEAD'), unpublished, 'the unpublished commit stays checked out');
    assert.notEqual(originHead(h.fx), unpublished);
    assert.equal(h.counters.pushes, 0);
    assert.deepEqual(withdrawn, [11]);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_RELEASED);
    // F3/F4: detaching the worktree does not move the branch ref, so the branch is restarted too.
    assert.equal(h.counters.restarted, 1);
    assert.equal(localBranchHead(h.fx), originHead(h.fx), 'the local branch no longer points at the cancelled commit');
    assert.deepEqual(supersededBackups(h.fx), [unpublished], 'the cancelled commit is kept under a backup ref');
    assert.equal(nextJobHead(h.fx, 'next-wt'), originHead(h.fx), 'the next job starts from the pull request head, not the cancelled commit');
});

test('F3: a cancelled hold stays when the branch cannot be restarted from the pull request head', async () => {
    const h = await createHarness();
    h.deps.withdrawRestoredComments = async () => undefined;
    h.stateManager.states.set('task-1', 'cancelled');
    const record = await seedHandoff(h);
    await agentEdit(h);
    git(h.fx.wt, 'add', '-A');
    git(h.fx.wt, 'commit', '-m', 'never published');
    const unpublished = git(h.fx.wt, 'rev-parse', 'HEAD');
    await advanceFollowupHandoff({ database }, record, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'cancelled_by_user' });
    h.deps.git = { ...h.gitOps, restartBranchFromRemoteHead: async () => false };

    assert.deepEqual(await adoptAs(h, 'task-2'), { blocked: 'predecessor_awaiting_operator' });
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR, 'the hold stands');
    assert.equal(localBranchHead(h.fx), unpublished, 'nothing else moved the branch');
    assert.equal(h.octokit.comments.length, 0, 'no release is announced');
    // The stale background pass refuses the same way.
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).update({ updated_at: Date.now() - 25 * 3_600_000 });
    await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR);
    assert.equal(h.counters.pushes, 0);
});

test('S20: a cancelled hold whose task state was lost is released with its claims withdrawn', async () => {
    const h = await createHarness({ taskStates: {} });
    const withdrawn: number[] = [];
    h.deps.withdrawRestoredComments = async (_record: unknown, claimed: Array<{ id: number }>) => { withdrawn.push(...claimed.map(comment => comment.id)); };
    const record = await seedHandoff(h);
    git(h.fx.wt, 'checkout', '--detach');
    await advanceFollowupHandoff({ database }, record, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'cancelled_by_user' });
    assert.equal(await h.stateManager.getTaskState('task-1'), null, 'no task state at all');

    assert.deepEqual(await adoptAs(h, 'task-2'), { releasedCancelledClaimIds: [11] }, 'the hold reason alone proves the cancellation');
    assert.deepEqual(withdrawn, [11]);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_RELEASED);
});

test('S18: a failed attempt whose retry is pending is not rebuilt and published behind the retry\'s back', async () => {
    const h = await createHarness({ taskStates: { 'task-1': 'pending' } }); // FAILED, then the queue scheduled its retry
    const restores = withWorktreeRestore(h);
    const record = await seedHandoff(h);
    await agentEdit(h);
    git(h.fx.wt, 'add', '-A');
    git(h.fx.wt, 'commit', '-m', 'failed attempt');
    const failedCommit = git(h.fx.wt, 'rev-parse', 'HEAD');
    await advanceFollowupHandoff({ database }, record, { phase: 'committed', commit_hash: failedCommit, status_reason: 'publication_failed' });
    await rm(h.fx.wt, { recursive: true, force: true }); // host cleanup before the retry runs

    const summary = await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal(summary.published + summary.awaitingOperator, 0);
    assert.deepEqual(restores, [], 'no rebuild');
    assert.equal(h.counters.pushes, 0, 'the failed attempt is not published');
    const kept = await loadFollowupHandoff({ database }, KEY);
    assert.equal(kept?.status, HANDOFF_ACTIVE);
    assert.equal(kept?.status_reason, 'publication_failed', 'the reason the retry\'s takeover relies on is kept');
    // The retry takes the attempt over and starts from the pull request head.
    assert.deepEqual(await adoptAs(h, 'task-1'), {});
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_RELEASED);
    assert.equal(localBranchHead(h.fx), originHead(h.fx));
    assert.deepEqual(supersededBackups(h.fx), [failedCommit]);
    // Once the retry is over (no retry left), a lost worktree is rebuilt and published as before.
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).delete();
    h.stateManager.states.set('task-1', 'failed');
    const again = await seedHandoff(h);
    git(h.fx.local, 'worktree', 'prune', '--expire=now');
    git(h.fx.local, 'worktree', 'add', h.fx.wt, BRANCH);
    await agentEdit(h);
    git(h.fx.wt, 'add', '-A');
    git(h.fx.wt, 'commit', '-m', 'final attempt');
    const finalCommit = git(h.fx.wt, 'rev-parse', 'HEAD');
    await advanceFollowupHandoff({ database }, again, { phase: 'committed', commit_hash: finalCommit, status_reason: 'publication_failed' });
    await rm(h.fx.wt, { recursive: true, force: true });
    assert.equal((await recoverInterruptedFollowupHandoffs(h.deps)).published, 1);
    assert.equal(originHead(h.fx), finalCommit);
});

test('S15: the background pass releases a stale cancelled attempt with unpublished work the same way', async () => {
    const h = await createHarness({ taskStates: { 'task-1': 'cancelled' } });
    h.deps.withdrawRestoredComments = async () => undefined;
    const record = await seedHandoff(h);
    await agentEdit(h);
    git(h.fx.wt, 'add', '-A');
    git(h.fx.wt, 'commit', '-m', 'never published');
    await advanceFollowupHandoff({ database }, record, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'cancelled_by_user' });
    await database(PR_FOLLOWUP_HANDOFFS_TABLE).update({ updated_at: Date.now() - 25 * 3_600_000 });
    await recoverInterruptedFollowupHandoffs(h.deps);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status_reason, 'auto_released_stale_hold');
    assert.equal(h.counters.detached, 1);
    assert.equal(git(h.fx.wt, 'branch', '--show-current'), '');
    assert.ok(existsSync(path.join(h.fx.wt, 'feature.txt')), 'files stay on disk');
    assert.equal(h.counters.restarted, 1, 'the background release restarts the branch too');
    assert.equal(localBranchHead(h.fx), originHead(h.fx));
    assert.equal(nextJobHead(h.fx, 'next-wt'), originHead(h.fx), 'the next job does not inherit the cancelled commit');
});

test('S15: a hold whose worktree and Git registration are both gone is released without touching Git', async () => {
    const h = await createHarness();
    await heldBy(h, 'worktree_missing', 'failed');
    await rm(h.fx.wt, { recursive: true, force: true });
    git(h.fx.local, 'worktree', 'prune', '--expire=now');
    assert.deepEqual(await adoptAs(h, 'task-2'), {});
    assert.equal(h.counters.released + h.counters.detached, 0);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status_reason, 'auto_released_for_new_request');
});

test('S15: a refused release that leaves a registration on the branch keeps the new comment waiting', async () => {
    const h = await createHarness({ taskStates: { 'task-1': 'failed' } });
    const record = await seedHandoff(h);
    await rm(h.fx.wt, { recursive: true, force: true });
    await advanceFollowupHandoff({ database }, record, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'worktree_missing' });
    // The harness release refuses a missing folder, and its registration still names the branch.
    assert.deepEqual(await h.gitOps.branchWorktreeRegistrations(h.fx.local, BRANCH), [h.fx.wt]);
    assert.deepEqual(await adoptAs(h, 'task-2'), { blocked: 'predecessor_awaiting_operator' });
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR);
});

for (const probe of ['not_found', 'unavailable']) {
    test(`F5/F7: a missing failed attempt blocks another task after ${probe} liveness`, async () => {
        const h = await createHarness({ taskStates: { 'task-1': 'pending' }, liveness: probe });
        const restores = withWorktreeRestore(h);
        const record = await seedHandoff(h);
        await agentEdit(h);
        git(h.fx.wt, 'add', '-A');
        git(h.fx.wt, 'commit', '-m', 'failed attempt');
        await advanceFollowupHandoff({ database }, record, {
            phase: 'committed', commit_hash: git(h.fx.wt, 'rev-parse', 'HEAD'), status_reason: 'publication_failed',
        });
        await rm(h.fx.wt, { recursive: true, force: true });
        if (probe === 'unavailable') {
            assert.deepEqual(await adoptAs(h, 'task-2'), { blocked: 'predecessor_liveness_unavailable' });
            await recoverInterruptedFollowupHandoffs(h.deps);
            assert.equal((await loadFollowupHandoff({ database }, KEY))?.status_reason, 'publication_failed');
            h.deps.inspectLiveness = async () => ({ liveness: 'not_found' });
        }
        assert.deepEqual(await adoptAs(h, 'task-2'), { blocked: 'predecessor_retry_pending' });
        await recoverInterruptedFollowupHandoffs(h.deps);
        assert.deepEqual(restores, []);
        assert.equal(h.counters.pushes, 0);
        assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_ACTIVE);
        assert.equal((await loadFollowupHandoff({ database }, KEY))?.status_reason, 'publication_failed');
    });
}

test('S22: legacy missing-worktree holds wait for the pending retry', async () => {
    const h = await createHarness({ taskStates: { 'task-1': 'pending' } });
    const restores = withWorktreeRestore(h);
    const record = await seedHandoff(h);
    await rm(h.fx.wt, { recursive: true, force: true });
    await advanceFollowupHandoff({ database }, record, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'worktree_missing' });
    await recoverInterruptedFollowupHandoffs(h.deps);
    assert.deepEqual(restores, []);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR);
    assert.deepEqual(await adoptAs(h, 'task-2'), { blocked: 'predecessor_awaiting_operator' });
});

for (const merged of [false, true]) {
    test(`S25: automatic release skips the PR notice on a closed PR (merged=${merged})`, async () => {
        const h = await createHarness();
        h.octokit.pull = { state: 'closed', merged };
        await heldBy(h, 'worktree_not_on_branch', 'failed');
        assert.deepEqual(await adoptAs(h, 'task-2'), {});
        assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_RELEASED);
        assert.equal(h.octokit.comments.length, 0);
        assert.ok(h.stateManager.updates.length > 0, 'task timeline still records the release');
    });
}

test('S22: automatic re-arm rechecks retry state after acquiring the lease', async () => {
    const h = await createHarness({ taskStates: { 'task-1': 'failed' } });
    const restores = withWorktreeRestore(h);
    const record = await seedHandoff(h);
    await rm(h.fx.wt, { recursive: true, force: true });
    await advanceFollowupHandoff({ database }, record, { status: HANDOFF_AWAITING_OPERATOR, status_reason: 'worktree_missing' });
    const evaluate = h.redis.eval.bind(h.redis);
    h.redis.eval = async (...args) => {
        if (args[0].includes('ttl')) h.stateManager.states.set('task-1', 'pending');
        return evaluate(...args);
    };
    await recoverInterruptedFollowupHandoffs(h.deps);
    assert.deepEqual(restores, []);
    assert.equal((await loadFollowupHandoff({ database }, KEY))?.status, HANDOFF_AWAITING_OPERATOR);
});

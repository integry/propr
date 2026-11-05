import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import knex from 'knex';

// Isolate Git's global config and the fixed storage paths before importing production code.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-handoff-restore-'));
process.env.GIT_CLONES_BASE_PATH = path.join(root, 'clones');
process.env.GIT_WORKTREES_BASE_PATH = path.join(root, 'worktrees');
// simple-git's environment guard strips GIT_CONFIG_GLOBAL. HOME is shared by
// both Git clients, so neither reads or writes the runner's global config.
process.env.HOME = root;
process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
delete process.env.GIT_CONFIG_GLOBAL;
const bin = path.join(root, 'bin');
await fs.ensureDir(bin);
await fs.writeFile(path.join(bin, 'sudo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await mock.module('../packages/core/src/db/connection.js', {
    namedExports: {
        db, closeConnection: async () => undefined, runMigrations: async () => undefined,
        configureSqliteConnection: () => undefined, configurePooledSqliteConnection: () => undefined, createKnexConfigForMigrations: () => ({}),
    },
});
after(async () => { await db.destroy(); await fs.remove(root); });

const { createFollowupHandoffGitOps } = await import('../src/jobs/followupHandoffGitOps.js');
const { releasePredecessorInline } = await import('../src/jobs/followupHandoffAutoRelease.js');
const { recordFollowupHandoff, advanceFollowupHandoff, loadFollowupHandoff, HANDOFF_AWAITING_OPERATOR, HANDOFF_RELEASED } = await import('../src/jobs/followupHandoffStore.js');
const { up } = await import('../packages/core/src/db/migrations/20261017000000_add_pr_followup_handoffs.js');
const { trustManagedGitDirectories, createHooklessGit, createWorktreeFromExistingBranch } = await import('@propr/core');
await up(db);

const BRANCH = 'propr/pr-9';
const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'protocol.file.allow=always', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let serial = 0;
async function fixture() {
    const dir = path.join(root, `fx-${serial++}`);
    await fs.ensureDir(dir);
    git(dir, 'init', '--bare', 'origin.git');
    git(dir, 'clone', 'origin.git', 'clone');
    const clone = path.join(dir, 'clone');
    await fs.writeFile(path.join(clone, 'a.txt'), 'a\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'base');
    git(clone, 'branch', '-M', BRANCH);
    git(clone, 'push', '-u', 'origin', BRANCH);
    git(clone, 'checkout', '--detach');
    const wt = path.join(dir, 'worktrees', 'pr-9-followup');
    git(clone, 'worktree', 'add', wt, BRANCH);
    return { clone, wt };
}

const ops = createFollowupHandoffGitOps(async () => 'unused-token');

test('a deleted follow-up worktree is rebuilt on its branch and keeps the unpushed commit', async () => {
    const { clone, wt } = await fixture();
    await fs.writeFile(path.join(wt, 'b.txt'), 'agent\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-m', 'agent work');
    const agentCommit = git(wt, 'rev-parse', 'HEAD');
    await fs.remove(wt); // what a host cleanup's rm -rf does; the registration survives

    assert.equal(await ops.worktreeAttachment(wt, BRANCH), 'missing');
    assert.equal(await ops.restoreMissingWorktree!(clone, wt, BRANCH), true);
    assert.equal(await ops.worktreeAttachment(wt, BRANCH), 'attached');
    assert.equal(git(wt, 'rev-parse', 'HEAD'), agentCommit);
    assert.equal(await ops.hasUnpushedCommits(wt, BRANCH), true);
});

test('a deleted worktree whose registration still holds staged work is not rebuilt', async () => {
    const { clone, wt } = await fixture();
    await fs.writeFile(path.join(wt, 'b.txt'), 'staged\n');
    git(wt, 'add', '.');
    await fs.remove(wt);

    assert.equal(await ops.restoreMissingWorktree!(clone, wt, BRANCH), false);
    assert.equal(await fs.pathExists(wt), false);
    assert.match(git(clone, 'worktree', 'list', '--porcelain'), new RegExp(`worktree ${wt}`), 'the registration with staged work is kept');
});

test('startup trust writes managed directory entries once to the isolated global config', async () => {
    await trustManagedGitDirectories(createHooklessGit());
    await trustManagedGitDirectories(createHooklessGit()); // idempotent
    const entries = git(root, 'config', '--global', '--get-all', 'safe.directory').split('\n');
    assert.deepEqual(entries.sort(), [`${path.join(root, 'clones')}/*`, `${path.join(root, 'worktrees')}/*`].sort());
});

test('releasing a deleted worktree reports nothing to release instead of throwing', async () => {
    const { clone, wt } = await fixture();
    git(wt, 'checkout', '--detach'); // failure cleanup or push salvage gave up the branch
    await fs.remove(wt);

    assert.equal(await ops.releaseSettledWorktree(clone, BRANCH, wt), false);
    assert.deepEqual(await ops.branchWorktreeRegistrations(clone, BRANCH), [], 'the branch is already free');
    git(clone, 'worktree', 'prune', '--expire=now');
    assert.equal(await ops.releaseSettledWorktree(clone, BRANCH, wt), false, 'also with no registration left at all');
});

// --- S13: the fallback fetch for a branch the clone no longer has is authenticated.

test('a branch the clone no longer has is rebuilt from the remote head through the authenticated fetch', async () => {
    const { clone, wt } = await fixture();
    await fs.remove(wt);
    git(clone, 'worktree', 'prune', '--expire=now');
    git(clone, 'branch', '-D', BRANCH);
    git(clone, 'update-ref', '-d', `refs/remotes/origin/${BRANCH}`);
    let tokensRequested = 0;
    const authenticated = createFollowupHandoffGitOps(async () => { tokensRequested += 1; return 'installation-token'; });

    assert.equal(await authenticated.restoreMissingWorktree!(clone, wt, BRANCH), true);
    assert.equal(tokensRequested, 1, 'the remote fetch ran with the installation token, like every other remote operation');
    assert.equal(await authenticated.worktreeAttachment(wt, BRANCH), 'attached');
    assert.equal(git(wt, 'rev-parse', 'HEAD'), git(clone, 'rev-parse', `refs/remotes/origin/${BRANCH}`));
});

// --- S9: in-line release of a missing-worktree hold with the production release helper.

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
let holdSerial = 0;

/** An operator-held handoff of an ended task, with the recovery deps releasePredecessorInline reads. */
async function heldHandoff(clone: string, wt: string, hold: { reason: string; taskState: string }) {
    const pullRequest = 100 + holdSerial++;
    const record = await recordFollowupHandoff({
        ref: { repoOwner: 'acme', repoName: 'widgets', pullRequestNumber: pullRequest },
        taskId: `task-${pullRequest}`, sourceTaskIds: [], correlationId: 'corr',
        target: { repoOwner: 'acme', repoName: 'widgets', branchName: BRANCH, isFork: false },
        worktreePath: wt, localRepoPath: clone,
        claimedComments: [{ id: 11, body: 'please', author: 'alice', type: 'issue' }],
        jobData: { pullRequestNumber: pullRequest, repoOwner: 'acme', repoName: 'widgets' } as never,
        llm: 'claude', lockKey: `lock:${pullRequest}`, lockToken: 'dead-token',
    }, { database: db });
    assert.ok(record);
    const held = await advanceFollowupHandoff({ database: db }, record!, { status: HANDOFF_AWAITING_OPERATOR, status_reason: hold.reason });
    assert.ok(held);
    const posted: string[] = [];
    const withdrawn: number[] = [];
    const resolved = {
        store: { database: db }, git: ops, log: silentLog,
        stateManager: {
            async getTaskState() { return { state: hold.taskState }; },
            async updateTaskState() { return undefined; },
            async updateHistoryMetadata() { return undefined; },
        },
        taskStates: { COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' },
        withdrawRestoredComments: async (_record: unknown, claimed: Array<{ id: number }>) => { withdrawn.push(...claimed.map(comment => comment.id)); },
        getOctokit: async () => ({ request: async (route: string, params: { body?: string }) => {
            if (route.startsWith('GET ')) return { data: { state: 'open', merged: false } };
            posted.push(params.body ?? ''); return { data: {} };
        } }),
    };
    return { held: held!, resolved: resolved as never, posted, withdrawn, key: { repository: 'acme/widgets', pull_request: pullRequest } };
}
const heldMissingWorktree = (clone: string, wt: string) => heldHandoff(clone, wt, { reason: 'worktree_missing', taskState: 'failed' });

test('a new comment releases a worktree_missing hold whose Git registration survived, with the real release helper', async () => {
    const { clone, wt } = await fixture();
    await fs.remove(wt); // host cleanup; the registration still holds the branch
    assert.deepEqual(await ops.branchWorktreeRegistrations(clone, BRANCH), [wt]);
    const { held, resolved, posted, key } = await heldMissingWorktree(clone, wt);

    assert.deepEqual(await releasePredecessorInline(held, resolved, 'task-new', silentLog), []);
    const released = await loadFollowupHandoff({ database: db }, key);
    assert.equal(released?.status, HANDOFF_RELEASED);
    assert.equal(released?.status_reason, 'auto_released_for_new_request');
    assert.deepEqual(await ops.branchWorktreeRegistrations(clone, BRANCH), [], 'the surviving registration no longer holds the branch');
    assert.match(git(clone, 'worktree', 'list', '--porcelain'), new RegExp(`worktree ${wt}\n`), 'the registration itself is kept');
    assert.equal(posted.length, 1);
    assert.match(posted[0], /Cleared a stuck follow-up/);
});

test('the real release also frees the branch when the missing worktree\'s registration holds staged work', async () => {
    const { clone, wt } = await fixture();
    await fs.writeFile(path.join(wt, 'b.txt'), 'staged\n');
    git(wt, 'add', '.');
    await fs.remove(wt);
    // The rebuild refuses this registration (staged work is recoverable only from its index) ...
    assert.equal(await ops.restoreMissingWorktree!(clone, wt, BRANCH), false);
    const { held, resolved, key } = await heldMissingWorktree(clone, wt);

    // ... but a release only detaches it, so the branch is freed and the index stays.
    assert.deepEqual(await releasePredecessorInline(held, resolved, 'task-new', silentLog), []);
    assert.equal((await loadFollowupHandoff({ database: db }, key))?.status, HANDOFF_RELEASED);
    assert.deepEqual(await ops.branchWorktreeRegistrations(clone, BRANCH), []);
    const admin = path.join(clone, '.git', 'worktrees', path.basename(wt));
    assert.ok(await fs.pathExists(path.join(admin, 'index')), 'the staged index is retained');
    assert.doesNotMatch(await fs.readFile(path.join(admin, 'HEAD'), 'utf8'), /^ref:/, 'the registration HEAD is detached');
});

// --- F3/F4: a released attempt's unpublished commit is never inherited by the next job.

/**
 * The shared clone at its production path, so createWorktreeFromExistingBranch
 * (real core) creates the jobs' worktrees from it exactly as the worker does.
 */
async function productionClone() {
    const owner = 'acme';
    const repoName = `widgets-${serial++}`;
    const dir = path.join(root, `e2e-${repoName}`);
    await fs.ensureDir(dir);
    git(dir, 'init', '--bare', 'origin.git');
    const clone = path.join(root, 'clones', owner, repoName);
    await fs.ensureDir(path.dirname(clone));
    git(dir, 'clone', 'origin.git', clone);
    await fs.writeFile(path.join(clone, 'a.txt'), 'a\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'base');
    git(clone, 'branch', '-M', BRANCH);
    git(clone, 'push', '-u', 'origin', BRANCH);
    git(clone, 'checkout', '--detach');
    const origin = path.join(dir, 'origin.git');
    const jobWorktree = async (name: string) => (await createWorktreeFromExistingBranch(clone, BRANCH, { worktreeDirName: name, owner, repoName })).worktreePath;
    return { clone, origin, jobWorktree, remoteHead: () => git(origin, 'rev-parse', `refs/heads/${BRANCH}`) };
}

test('F3: a cancelled follow-up\'s unpublished commit is not inherited by the next job and never reaches the pull request', async () => {
    const fx = await productionClone();
    const before = fx.remoteHead();
    // The cancelled attempt committed on the branch in its worktree but never pushed.
    const cancelledWt = await fx.jobWorktree('attempt-1');
    await fs.writeFile(path.join(cancelledWt, 'cancelled.txt'), 'cancelled work\n');
    git(cancelledWt, 'add', '.');
    git(cancelledWt, 'commit', '-m', 'cancelled work');
    const cancelledCommit = git(cancelledWt, 'rev-parse', 'HEAD');
    const { held, resolved, withdrawn, key } = await heldHandoff(fx.clone, cancelledWt, { reason: 'cancelled_by_user', taskState: 'cancelled' });

    // A new comment releases the hold with the real Git operations.
    assert.deepEqual(await releasePredecessorInline(held, resolved, 'task-new', silentLog), [11]);
    assert.deepEqual(withdrawn, [11]);
    assert.equal((await loadFollowupHandoff({ database: db }, key))?.status, HANDOFF_RELEASED);
    assert.equal(git(cancelledWt, 'branch', '--show-current'), '', 'the cancelled worktree is detached in place');
    assert.equal(git(cancelledWt, 'rev-parse', 'HEAD'), cancelledCommit, 'with its commit still checked out');
    assert.equal(git(fx.clone, 'rev-parse', `refs/heads/${BRANCH}`), before, 'the local branch restarted from the pull request head');
    const backups = git(fx.clone, 'for-each-ref', '--format=%(refname) %(objectname)', `refs/propr/superseded/${BRANCH}/`).split('\n');
    assert.equal(backups.length, 1);
    assert.match(backups[0], new RegExp(`-${cancelledCommit.slice(0, 12)} ${cancelledCommit}$`), 'the cancelled commit is kept under a backup ref named after it');

    // The next job's worktree is created from the reused branch, implements and pushes.
    const nextWt = await fx.jobWorktree('attempt-2');
    assert.equal(git(nextWt, 'rev-parse', 'HEAD'), before, 'the next job starts from the pull request head, not the cancelled commit');
    await fs.writeFile(path.join(nextWt, 'next.txt'), 'new request\n');
    git(nextWt, 'add', '.');
    git(nextWt, 'commit', '-m', 'new request');
    git(nextWt, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`);
    const published = fx.remoteHead();
    assert.equal(published, git(nextWt, 'rev-parse', 'HEAD'));
    assert.throws(() => git(fx.origin, 'merge-base', '--is-ancestor', cancelledCommit, published), 'the cancelled commit never reached the pull request');
    assert.equal(git(fx.clone, 'cat-file', '-t', cancelledCommit), 'commit', 'while the clone still keeps it');
});

test('S24: startup warns when Git cannot match managed directory wildcards', async () => {
    const { logger } = await import('@propr/core');
    const warnings: string[] = [];
    const warning = mock.method(logger, 'warn', (_fields: unknown, message: string) => { warnings.push(message); });
    try {
        for (const version of ['2.45.4', '2.46.0', '3.0.0']) {
            warnings.length = 0;
            await trustManagedGitDirectories({ raw: async (args: string[]) => args[0] === '--version' ? `git version ${version}` : '' } as never);
            assert.equal(warnings.length, version === '2.45.4' ? 1 : 0);
            if (warnings.length) assert.match(warnings[0], /Git 2.46 or newer/);
        }
    } finally {
        warning.mock.restore();
    }
});

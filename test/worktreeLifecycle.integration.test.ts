import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { simpleGit, type SimpleGit } from 'simple-git';

// Import production entry points only after isolating their fixed storage paths.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-worktree-lifecycle-'));
process.env.GIT_CLONES_BASE_PATH = path.join(root, 'clones');
process.env.GIT_WORKTREES_BASE_PATH = path.join(root, 'worktrees');
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig');
const bin = path.join(root, 'bin');
await fs.ensureDir(bin);
await fs.writeFile(path.join(bin, 'sudo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const { cleanupExistingBranch, addWorktreeWithoutTracking, removeStaleWorktreeRegistration } =
    await import('../packages/core/src/git/worktreeCreation.js');
const { cleanupWorktree, cleanupExpiredWorktrees, safePruneWorktrees,
    createWorktreeForIssue, createWorktreeFromExistingBranch } =
    await import('../packages/core/src/git/repoManager.js');

let repo: string;
let git: SimpleGit;
let worktree: string;
let repoName: string;
let initial: string;
let serial = 0;
before(async () => fs.ensureDir(process.env.GIT_CLONES_BASE_PATH!));
beforeEach(async () => {
    repoName = `repo-${++serial}`;
    repo = path.join(root, 'clones', 'owner', repoName);
    worktree = path.join(root, 'worktrees', 'owner', repoName, 'checkout');
    await fs.ensureDir(repo);
    git = simpleGit(repo);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');
    await fs.writeFile(path.join(repo, '.gitignore'), 'private.env\n');
    await fs.writeFile(path.join(repo, 'tracked'), 'initial');
    await git.add('.').commit('initial');
    initial = (await git.revparse(['HEAD'])).trim();
});
after(async () => fs.remove(root));

async function create(branch = 'task') {
    await fs.ensureDir(path.dirname(worktree));
    await addWorktreeWithoutTracking(git, worktree, branch, { startPoint: 'main' });
    return simpleGit(worktree);
}
async function privateWork(wt: SimpleGit) {
    await fs.writeFile(path.join(worktree, 'tracked'), 'unpublished');
    await wt.add('.').commit('unpublished');
    await fs.writeFile(path.join(worktree, 'tracked'), 'staged');
    await wt.add('tracked');
    await fs.writeFile(path.join(worktree, 'tracked'), 'unstaged');
    await fs.writeFile(path.join(worktree, 'untracked'), 'untracked data');
    await fs.writeFile(path.join(worktree, 'private.env'), 'private data');
    return { head: await wt.revparse(['HEAD']), index: await wt.raw(['show', ':tracked']) };
}
async function assertPrivateWork(wt: SimpleGit, expected: Awaited<ReturnType<typeof privateWork>>) {
    assert.equal(await wt.revparse(['HEAD']), expected.head);
    assert.equal(await wt.raw(['show', ':tracked']), expected.index);
    assert.equal(await fs.readFile(path.join(worktree, 'tracked'), 'utf8'), 'unstaged');
    assert.equal(await fs.readFile(path.join(worktree, 'untracked'), 'utf8'), 'untracked data');
    assert.equal(await fs.readFile(path.join(worktree, 'private.env'), 'utf8'), 'private data');
    assert.equal(await git.revparse(['refs/heads/task']), expected.head);
    assert.match(await git.raw(['worktree', 'list', '--porcelain']), new RegExp(worktree));
}

test('missing refs succeed in an unborn repository and a populated repository', async () => {
    const empty = path.join(root, 'empty');
    await fs.ensureDir(empty);
    const emptyGit = simpleGit(empty);
    await emptyGit.init();
    await cleanupExistingBranch(emptyGit, 'never-existed');
    await cleanupExistingBranch(git, 'never-existed');
    await git.branch(['prefix/child']);
    await cleanupExistingBranch(git, 'prefix'); // prefix matches are not exact refs
});

test('existing loose and packed branches are retained at their original commits', async () => {
    await git.branch(['task']);
    await assert.rejects(cleanupExistingBranch(git, 'task'), /Existing branch retained/);
    await git.raw(['pack-refs', '--all']);
    await assert.rejects(cleanupExistingBranch(git, 'task'), /Existing branch retained/);
    assert.equal((await git.revparse(['task'])).trim(), initial);
});

test('reuse creates a missing local branch from the requested start point without tracking', async () => {
    await addWorktreeWithoutTracking(git, worktree, 'task', { startPoint: 'main', resetBranch: true });
    assert.equal((await simpleGit(worktree).revparse(['HEAD'])).trim(), initial);
    assert.equal((await git.raw(['config', '--get', 'branch.task.remote'])).trim(), '');
});

test('reuse preserves a packed local branch ahead of its requested start point', async () => {
    const wt = await create();
    const saved = await privateWork(wt);
    await cleanupWorktree(repo, worktree, 'task', { deleteBranch: true });
    await git.raw(['pack-refs', '--all']);
    const retry = `${worktree}-retry`;
    await addWorktreeWithoutTracking(git, retry, 'task', { startPoint: 'main', resetBranch: true });
    assert.equal(await simpleGit(retry).revparse(['HEAD']), saved.head);
    await assertPrivateWork(wt, saved);
});

test('an occupied branch and an existing nonempty destination fail without losing private work', async () => {
    const wt = await create();
    const saved = await privateWork(wt);
    await assert.rejects(addWorktreeWithoutTracking(git, `${worktree}-retry`, 'task', {
        startPoint: 'main', resetBranch: true,
    }), /already (?:checked out|used by worktree)/);
    await assert.rejects(addWorktreeWithoutTracking(git, worktree, 'other', { startPoint: 'main' }));
    await assertPrivateWork(wt, saved);
});

for (const strategy of ['always_delete', 'keep_on_failure', 'keep_for_hours']) {
    for (const success of [true, false]) {
        test(`production cleanup preserves all work with ${strategy}, success=${success}`, async () => {
            const wt = await create();
            const saved = await privateWork(wt);
            await cleanupWorktree(repo, worktree, 'task', {
                deleteBranch: true, success, retentionStrategy: strategy, retentionHours: 0,
            });
            await assertPrivateWork(wt, saved);
        });
    }
}

test('expired retention markers cannot authorize deletion', async () => {
    const wt = await create();
    const saved = await privateWork(wt);
    await fs.writeJson(path.join(worktree, '.retention-info.json'), { scheduledCleanup: '2000-01-01T00:00:00Z' });
    assert.equal((await cleanupExpiredWorktrees(path.join(root, 'worktrees'))).cleaned, 0);
    await assertPrivateWork(wt, saved);
});

test('missing checkouts keep their administrative HEAD and registration even when old', async () => {
    const wt = await create();
    await wt.checkout(['--detach']);
    await fs.writeFile(path.join(worktree, 'tracked'), 'detached history');
    await wt.add('.').commit('detached commit');
    const head = await wt.revparse(['HEAD']);
    const admin = (await fs.readFile(path.join(worktree, '.git'), 'utf8')).trim().slice('gitdir: '.length);
    await fs.move(worktree, `${worktree}-offline`);
    await fs.utimes(admin, new Date(0), new Date(0));
    assert.equal(await removeStaleWorktreeRegistration(git, worktree), false);
    assert.equal((await safePruneWorktrees(repo, 0)).pruned, 0);
    assert.equal((await fs.readFile(path.join(admin, 'HEAD'), 'utf8')).trim(), head.trim());
    assert.match(await git.raw(['worktree', 'list', '--porcelain']), new RegExp(worktree));
});

test('real Git errors abort branch checks and reuse without creating a checkout', async () => {
    const invalid = path.join(root, 'not-a-repo');
    await fs.ensureDir(invalid);
    const invalidGit = simpleGit(invalid);
    await assert.rejects(cleanupExistingBranch(invalidGit, 'missing'), /not a git repository/);
    await assert.rejects(addWorktreeWithoutTracking(invalidGit, worktree, 'missing', {
        startPoint: 'main', resetBranch: true,
    }), /not a git repository/);
    // An unreadable ref database must not be interpreted as an absent branch.
    await fs.writeFile(path.join(repo, '.git', 'packed-refs'), 'invalid packed refs\n');
    await assert.rejects(cleanupExistingBranch(git, 'missing'), /packed-refs/);
    await assert.rejects(addWorktreeWithoutTracking(git, worktree, 'missing', {
        startPoint: 'main', resetBranch: true,
    }), /packed-refs/);
    assert.equal(await fs.pathExists(worktree), false);
});

test('a broken loose branch ref fails closed instead of appearing absent', async () => {
    await fs.writeFile(path.join(repo, '.git', 'refs', 'heads', 'broken'), 'f'.repeat(40) + '\n');
    await assert.rejects(cleanupExistingBranch(git, 'broken'), /bad ref/);
    await assert.rejects(addWorktreeWithoutTracking(git, worktree, 'broken', {
        startPoint: 'main', resetBranch: true,
    }), /bad ref/);
    assert.equal(await fs.pathExists(worktree), false);
    assert.equal(await fs.readFile(path.join(repo, '.git', 'refs', 'heads', 'broken'), 'utf8'), 'f'.repeat(40) + '\n');
});

async function remoteBranch(branch: string) {
    const remote = path.join(root, `remote-${serial}.git`);
    await simpleGit().raw(['init', '--bare', '--initial-branch=main', remote]);
    await git.addRemote('origin', remote);
    await git.push('origin', `main:refs/heads/${branch}`);
    await git.push('origin', 'main');
    await git.fetch('origin');
}
const issue = () => ({ issueId: 42, issueTitle: 'Fix', owner: 'owner', repoName });

test('repoManager creates a fresh issue branch and falls back when a reuse ref is absent', async () => {
    await remoteBranch('published');
    for (const reuseBranch of [undefined, 'never-published']) {
        const result = await createWorktreeForIssue(repo, issue(), { baseBranch: 'main', reuseBranch });
        assert.equal((await simpleGit(result.worktreePath).revparse(['HEAD'])).trim(), initial);
        assert.notEqual(result.branchName, reuseBranch);
        assert.ok((await fs.stat(path.join(result.worktreePath, '.git'))).isFile());
    }
});

for (const entry of ['issue', 'existing'] as const) {
    test(`repoManager ${entry} path reuses remote-only then locally advanced branches safely`, async () => {
        await remoteBranch('task');
        const run = (dir: string) => entry === 'issue'
            ? createWorktreeForIssue(repo, issue(), { baseBranch: 'main', reuseBranch: 'task' })
            : createWorktreeFromExistingBranch(repo, 'task', { owner: 'owner', repoName, worktreeDirName: dir });
        const first = await run('first');
        worktree = first.worktreePath;
        const wt = simpleGit(worktree);
        const saved = await privateWork(wt);
        await assert.rejects(run('occupied'));
        await assertPrivateWork(wt, saved);
        await cleanupWorktree(repo, worktree, 'task', { deleteBranch: true });
        const retry = await run('retry');
        assert.equal(await simpleGit(retry.worktreePath).revparse(['HEAD']), saved.head);
        await assertPrivateWork(wt, saved);
        if (entry === 'existing') await assert.rejects(run('first'), /Existing worktree retained/);
        await assertPrivateWork(wt, saved);
    });
}

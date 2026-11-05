import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import {
    addWorktreeWithoutTracking,
    releaseBranchFromLostAttemptWorktree,
    releaseLostAttemptBranch,
    releaseBranchFromSettledWorktree,
    worktreeHoldingBranch,
} from '../packages/core/src/git/worktreeCreation.js';

const BRANCH = '254/feature';

/** A clone whose `feature` branch is pushed and checked out in a leftover worktree. */
async function leftoverWorktree() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'settled-worktree-'));
    const remote = path.join(root, 'remote.git');
    const repo = path.join(root, 'repo');
    const holder = path.join(root, 'pr-255-merge-old');
    await simpleGit().raw(['init', '--bare', '--initial-branch=main', remote]);
    await fs.mkdir(repo);
    const git = simpleGit(repo);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.name', 'Test');
    await git.addConfig('user.email', 'test@example.test');
    await fs.writeFile(path.join(repo, 'file.txt'), 'base');
    await git.add('.').commit('base');
    await git.addRemote('origin', remote);
    await git.raw(['worktree', 'add', '-b', BRANCH, holder]);
    const holderGit = simpleGit(holder);
    await fs.writeFile(path.join(holder, 'file.txt'), 'merged');
    await holderGit.add('.').commit('merge: resolve conflicts');
    await holderGit.push('origin', BRANCH);
    await git.raw(['fetch', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`]);
    return { root, repo, git, holder, holderGit };
}

async function branchInUseError(git: ReturnType<typeof simpleGit>, worktreePath: string): Promise<Error> {
    try {
        await addWorktreeWithoutTracking(git, worktreePath, BRANCH, { startPoint: `origin/${BRANCH}`, resetBranch: true });
    } catch (error) {
        return error as Error;
    }
    throw new Error('expected the branch to be in use');
}

test('releases a branch held by a clean, pushed leftover worktree and keeps the worktree', async () => {
    const { root, git, holder, holderGit } = await leftoverWorktree();
    try {
        const head = await holderGit.revparse(['HEAD']);
        const retry = path.join(root, 'pr-255-merge-new');
        const error = await branchInUseError(git, retry);
        assert.equal(worktreeHoldingBranch(error.message), holder, 'the holder is read from Git\'s own message');

        assert.equal(await releaseBranchFromSettledWorktree(git, BRANCH, holder), true);

        assert.equal(await holderGit.revparse(['HEAD']), head, 'the leftover worktree keeps its commit');
        assert.equal((await holderGit.raw(['branch', '--show-current'])).trim(), '', 'only its HEAD is detached');
        await addWorktreeWithoutTracking(git, retry, BRANCH, { startPoint: `origin/${BRANCH}`, resetBranch: true });
        assert.equal(await simpleGit(retry).revparse(['HEAD']), head);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

for (const [name, change] of [
    ['an uncommitted change', async (holder: string) => fs.writeFile(path.join(holder, 'file.txt'), 'edited')],
    ['an untracked file', async (holder: string) => fs.writeFile(path.join(holder, 'new.txt'), 'new')],
    ['an unpushed commit', async (holder: string) => {
        await fs.writeFile(path.join(holder, 'file.txt'), 'unpushed');
        await simpleGit(holder).add('.').commit('unpushed work');
    }],
] as const) {
    test(`keeps a worktree with ${name} holding its branch`, async () => {
        const { root, git, holder, holderGit } = await leftoverWorktree();
        try {
            await change(holder);
            assert.equal(await releaseBranchFromSettledWorktree(git, BRANCH, holder), false);
            assert.equal((await holderGit.raw(['branch', '--show-current'])).trim(), BRANCH);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
}

test('does nothing for a missing holder or a holder on another branch', async () => {
    const { root, git, holder } = await leftoverWorktree();
    try {
        assert.equal(await releaseBranchFromSettledWorktree(git, BRANCH, path.join(root, 'missing')), false);
        assert.equal(await releaseBranchFromSettledWorktree(git, 'other', holder), false);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('parses both spellings of Git\'s branch-in-use error', () => {
    assert.equal(worktreeHoldingBranch("fatal: 'a/b' is already used by worktree at '/tmp/w x'"), '/tmp/w x');
    assert.equal(worktreeHoldingBranch("fatal: 'a/b' is already checked out at '/tmp/w'"), '/tmp/w');
    assert.equal(worktreeHoldingBranch('fatal: invalid reference: a/b'), null);
});

test('a replacement frees its lost predecessor\'s branch and the predecessor keeps its uncommitted work', async () => {
    const { root, git, holder, holderGit } = await leftoverWorktree();
    try {
        await fs.writeFile(path.join(holder, 'file.txt'), 'agent work in progress');
        await fs.writeFile(path.join(holder, 'new.txt'), 'new file');
        assert.equal(await releaseBranchFromSettledWorktree(git, BRANCH, holder), false, 'not settled: it has uncommitted work');

        assert.equal(await releaseBranchFromLostAttemptWorktree(BRANCH, holder), true);

        assert.equal((await holderGit.raw(['branch', '--show-current'])).trim(), '');
        assert.equal(await fs.readFile(path.join(holder, 'file.txt'), 'utf8'), 'agent work in progress');
        assert.equal(await fs.readFile(path.join(holder, 'new.txt'), 'utf8'), 'new file');
        await addWorktreeWithoutTracking(git, path.join(root, 'replacement'), BRANCH, { startPoint: `origin/${BRANCH}`, resetBranch: true });
        assert.equal(await releaseBranchFromLostAttemptWorktree('other', holder), false, 'only a holder on that branch is released');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('finds and frees the worktree a lost attempt left on its branch in the repository clone', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lost-attempt-'));
    try {
        const clones = path.join(root, 'clones');
        const repo = path.join(clones, 'integry', 'propr');
        const holder = path.join(root, 'issue-3191-old');
        await fs.mkdir(repo, { recursive: true });
        const git = simpleGit(repo);
        await git.init(['--initial-branch=main']);
        await git.addConfig('user.name', 'Test');
        await git.addConfig('user.email', 'test@example.test');
        await fs.writeFile(path.join(repo, 'file.txt'), 'base');
        await git.add('.').commit('base');
        await git.raw(['worktree', 'add', '-b', BRANCH, holder]);
        await fs.writeFile(path.join(holder, 'file.txt'), 'uncommitted agent work');

        assert.equal(await releaseLostAttemptBranch('integry', 'propr', 'not-held', clones), null);
        assert.equal(await releaseLostAttemptBranch('integry', 'propr', BRANCH, clones), holder);
        assert.equal(await fs.readFile(path.join(holder, 'file.txt'), 'utf8'), 'uncommitted agent work');
        assert.equal(await releaseLostAttemptBranch('integry', 'missing', BRANCH, clones), null, 'no clone, nothing to free');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('frees a branch held only by the registration of a worktree whose directory was deleted', async () => {
    const { root, git, holder } = await leftoverWorktree();
    try {
        const head = (await git.revparse([`refs/heads/${BRANCH}`])).trim();
        await fs.rm(holder, { recursive: true, force: true });
        const retry = path.join(root, 'pr-3218-merge');
        const error = await branchInUseError(git, retry);
        assert.equal(worktreeHoldingBranch(error.message), holder);

        assert.equal(await releaseBranchFromSettledWorktree(git, BRANCH, holder), true);

        const listing = await git.raw(['worktree', 'list', '--porcelain']);
        assert.ok(listing.includes(`worktree ${holder}\n`), 'the registration is kept');
        assert.ok(listing.includes(`HEAD ${head}\ndetached`), 'pointing at the same commit, detached');
        assert.equal((await git.revparse([`refs/heads/${BRANCH}`])).trim(), head, 'the branch keeps its commit');
        await addWorktreeWithoutTracking(git, retry, BRANCH, { startPoint: `origin/${BRANCH}`, resetBranch: true });
        assert.equal(await releaseBranchFromSettledWorktree(git, 'other', path.join(root, 'gone')), false, 'an unknown missing holder is left alone');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

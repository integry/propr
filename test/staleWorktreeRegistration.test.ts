import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { addWorktreeWithoutTracking, cleanupExistingBranch, removeStaleWorktreeRegistration } from '../packages/core/src/git/worktreeCreation.js';

import { cleanupWorktree, safePruneWorktrees } from '../packages/core/src/git/worktreeOperations.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-stale-worktree-'));
after(() => fs.remove(root));

let repoPath: string;
let git: SimpleGit;
let run = 0;

beforeEach(async () => {
    run += 1;
    repoPath = path.join(root, `repo-${run}`);
    await fs.ensureDir(repoPath);
    git = simpleGit(repoPath);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.email', 'test@example.com').addConfig('user.name', 'Test');
    await fs.writeFile(path.join(repoPath, 'README.md'), 'hello\n');
    await git.add('.').commit('init');
    await git.branch(['feature']);
    await git.branch(['other']);
});

const worktree = (name: string) => path.join(root, `wt-${run}-${name}`);

describe('stale worktree registration', () => {
    test('protects a checkout with a missing git pointer and permits retry on a new branch', async () => {
        const previous = worktree('previous');
        await git.raw(['worktree', 'add', previous, 'feature']);
        const wt = simpleGit(previous);
        // Leave unique detached history in the administrative reflog, then reattach
        // the branch so a retry must respect its occupied registration too.
        await wt.checkout(['--detach']);
        await fs.writeFile(path.join(previous, 'history.txt'), 'recoverable history');
        await wt.add('.').commit('detached history');
        const unique = (await wt.revparse(['HEAD'])).trim();
        await wt.checkout('feature');
        assert.equal((await git.raw(['for-each-ref', `--contains=${unique}`])).trim(), '');
        await fs.writeFile(path.join(previous, 'README.md'), 'staged work');
        await wt.add('README.md');
        await fs.writeFile(path.join(previous, 'README.md'), 'unstaged work');
        await fs.writeFile(path.join(previous, 'private.txt'), 'untracked work');
        const admin = (await wt.revparse(['--absolute-git-dir'])).trim();
        const administrativeFiles = ['HEAD', 'logs/HEAD', 'index', 'gitdir', 'commondir'];
        const saved = await Promise.all(administrativeFiles.map(file => fs.readFile(path.join(admin, file))));
        const branchHead = await git.revparse(['feature']);
        // Simulate a missing pointer without deleting Git data.
        await fs.move(path.join(previous, '.git'), path.join(root, `saved-pointer-${run}`));

        assert.equal(await removeStaleWorktreeRegistration(git, previous), false);
        await cleanupWorktree(repoPath, previous, 'feature', { deleteBranch: true });
        assert.deepEqual(await safePruneWorktrees(repoPath, 0), { pruned: 0, skipped: 1 });
        await assert.rejects(cleanupExistingBranch(git, 'feature'), /Existing branch retained; use a new task branch/);
        await assert.rejects(addWorktreeWithoutTracking(git, worktree('next'), 'feature', {
            startPoint: 'main', resetBranch: true,
        }), /already (?:used by worktree|checked out at)/);
        assert.equal(await fs.pathExists(worktree('next')), false);

        await cleanupExistingBranch(git, 'feature-retry');
        await addWorktreeWithoutTracking(git, worktree('retry'), 'feature-retry', { startPoint: 'feature' });
        assert.equal(await simpleGit(worktree('retry')).revparse(['HEAD']), branchHead);
        assert.equal(await git.revparse(['feature']), branchHead);
        assert.equal(await fs.readFile(path.join(previous, 'README.md'), 'utf8'), 'unstaged work');
        assert.equal(await fs.readFile(path.join(previous, 'private.txt'), 'utf8'), 'untracked work');
        assert.ok((await git.raw(['worktree', 'list', '--porcelain'])).includes(`worktree ${previous}\n`));
        for (const [index, file] of administrativeFiles.entries()) {
            assert.deepEqual(await fs.readFile(path.join(admin, file)), saved[index], `${file} must remain intact`);
        }
        assert.ok(saved[1].toString().includes(unique), 'administrative reflog retains detached commit');
        assert.equal(await git.raw(['show', `${unique}:history.txt`]), 'recoverable history');
        assert.equal(await simpleGit(admin).raw(['show', ':README.md']), 'staged work');
    });

    test('leaves a live worktree and other stale registrations alone', async () => {
        const live = worktree('live');
        const otherStale = worktree('other-stale');
        await git.raw(['worktree', 'add', live, 'feature']);
        await git.raw(['worktree', 'add', otherStale, 'other']);
        await fs.remove(otherStale);

        assert.equal(await removeStaleWorktreeRegistration(git, live), false, 'a worktree whose directory exists is never dropped');
        const listing = await git.raw(['worktree', 'list', '--porcelain']);
        assert.ok(listing.includes(`worktree ${live}`));
        assert.ok(listing.includes(`worktree ${otherStale}`), 'only the requested registration is ever removed');
    });

    test('reports nothing to remove for an unknown path', async () => {
        assert.equal(await removeStaleWorktreeRegistration(git, worktree('never-created')), false);
    });
});

import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { removeStaleWorktreeRegistration } from '../packages/core/src/git/worktreeCreation.js';

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
    test('frees a branch whose previous worktree directory was deleted mid-cleanup', async () => {
        const previous = worktree('previous');
        await git.raw(['worktree', 'add', previous, 'feature']);
        // Mid-removal state seen in production: the directory is still there, its .git file is gone.
        await fs.remove(path.join(previous, '.git'));

        // What the failing follow-ups hit: the branch is still "in use" and a forced remove is refused.
        await assert.rejects(git.raw(['worktree', 'add', worktree('next'), 'feature']), /already used by worktree/);
        await assert.rejects(git.raw(['worktree', 'remove', previous, '--force']), /validation failed/);

        assert.equal(await removeStaleWorktreeRegistration(git, previous), true);
        await git.raw(['worktree', 'add', worktree('next'), 'feature']);
        assert.ok(await fs.pathExists(path.join(worktree('next'), 'README.md')));
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

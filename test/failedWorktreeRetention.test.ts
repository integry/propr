import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { cleanupWorktree } from '../packages/core/src/git/worktreeOperations.js';

for (const retentionStrategy of ['keep_on_failure', 'keep_for_hours']) {
    test(`${retentionStrategy} preserves edits and frees the branch for retry`, async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'failed-worktree-'));
        try {
            const repo = path.join(root, 'repo');
            const worktree = path.join(root, 'worktree');
            await fs.mkdir(repo);
            const git = simpleGit(repo);
            await git.init();
            await git.addConfig('user.name', 'Test');
            await git.addConfig('user.email', 'test@example.test');
            await fs.writeFile(path.join(repo, 'tracked.txt'), 'base');
            await git.add('.');
            await git.commit('base');
            await git.raw(['worktree', 'add', '-b', 'feature', worktree]);
            await fs.writeFile(path.join(worktree, 'tracked.txt'), 'recovered edit');
            await simpleGit(worktree).add('tracked.txt');
            await fs.writeFile(path.join(worktree, 'new.txt'), 'untracked work');
            await cleanupWorktree(repo, worktree, 'feature', { success: false, retentionStrategy });
            assert.equal(await fs.readFile(path.join(worktree, 'tracked.txt'), 'utf8'), 'recovered edit');
            assert.equal(await fs.readFile(path.join(worktree, 'new.txt'), 'utf8'), 'untracked work');
            assert.match(await simpleGit(worktree).diff(['--cached']), /recovered edit/);
            const marker = JSON.parse(await fs.readFile(path.join(worktree, '.retention-info.json'), 'utf8'));
            assert.equal(marker.success, false);
            assert.ok(Date.parse(marker.scheduledCleanup) > Date.now());
            await git.raw(['worktree', 'add', path.join(root, 'retry'), 'feature']);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
}

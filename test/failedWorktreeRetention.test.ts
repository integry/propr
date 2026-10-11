import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { addWorktreeWithoutTracking } from '../packages/core/src/git/worktreeCreation.js';
import { cleanupExpiredWorktrees, cleanupWorktree, safePruneWorktrees } from '../packages/core/src/git/worktreeOperations.js';

for (const retentionStrategy of ['keep_on_failure', 'keep_for_hours']) {
    test(`${retentionStrategy} preserves edits and frees the branch for retry`, async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'failed-worktree-'));
        try {
            const repo = path.join(root, 'repo');
            const worktree = path.join(root, 'worktree');
            await fs.mkdir(repo);
            const git = simpleGit(repo);
            await git.init(['--initial-branch=main']);
            await git.addConfig('user.name', 'Test');
            await git.addConfig('user.email', 'test@example.test');
            await fs.writeFile(path.join(repo, 'tracked.txt'), 'base');
            await git.add('.');
            await git.commit('base');
            await git.raw(['worktree', 'add', '-b', 'feature', worktree]);
            const worktreeGit = simpleGit(worktree);
            await fs.writeFile(path.join(worktree, 'tracked.txt'), 'unpublished work');
            await worktreeGit.add('.').commit('unpublished');
            const unpublished = await worktreeGit.revparse(['HEAD']);
            assert.notEqual(unpublished, await git.revparse(['main']));
            await fs.writeFile(path.join(worktree, 'tracked.txt'), 'staged work');
            await worktreeGit.add('tracked.txt');
            await fs.writeFile(path.join(worktree, 'tracked.txt'), 'unstaged work');
            await fs.writeFile(path.join(worktree, 'new.txt'), 'untracked work');

            const assertPreserved = async () => {
                assert.equal(await worktreeGit.revparse(['HEAD']), unpublished);
                assert.equal(await git.revparse(['refs/heads/feature']), unpublished);
                assert.equal(await worktreeGit.raw(['show', 'HEAD:tracked.txt']), 'unpublished work');
                assert.equal(await worktreeGit.raw(['show', ':tracked.txt']), 'staged work');
                assert.equal(await fs.readFile(path.join(worktree, 'tracked.txt'), 'utf8'), 'unstaged work');
                assert.equal(await fs.readFile(path.join(worktree, 'new.txt'), 'utf8'), 'untracked work');
                assert.ok((await git.raw(['worktree', 'list', '--porcelain'])).includes(`worktree ${worktree}\n`));
                await assert.rejects(fs.stat(path.join(worktree, '.retention-info.json')), { code: 'ENOENT' });
            };
            await cleanupWorktree(repo, worktree, 'feature', {
                success: false, retentionStrategy, retentionHours: 0, deleteBranch: true,
            });
            await assertPreserved();
            assert.match(await worktreeGit.raw(['status', '--porcelain']), /MM tracked.txt/);
            assert.equal((await worktreeGit.raw(['branch', '--show-current'])).trim(), '');

            // Even an already-expired retention period cannot authorize deletion.
            assert.deepEqual(await cleanupExpiredWorktrees(root), { cleaned: 0, retained: 1 });
            assert.deepEqual(await safePruneWorktrees(repo, 0), { pruned: 0, skipped: 1 });
            await assertPreserved();

            const retry = path.join(root, 'retry');
            await addWorktreeWithoutTracking(git, retry, 'feature', { startPoint: 'main', resetBranch: true });
            assert.equal(await simpleGit(retry).revparse(['HEAD']), unpublished);
            assert.equal(await simpleGit(retry).raw(['branch', '--show-current']), 'feature\n');
            assert.equal(await simpleGit(retry).raw(['status', '--porcelain']), '');
            assert.equal(await fs.readFile(path.join(retry, 'tracked.txt'), 'utf8'), 'unpublished work');
            await assertPreserved();
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
}

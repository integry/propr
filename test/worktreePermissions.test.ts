import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { getWorktreeOwnershipTargets } from '../packages/core/src/git/worktreePermissions.js';

const testDirectories: string[] = [];

async function makeTestDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-permissions-'));
    testDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(testDirectories.splice(0).map(directory => fs.remove(directory)));
});

describe('getWorktreeOwnershipTargets', () => {
    test('includes linked worktree metadata so a non-root agent can create index.lock', async () => {
        const root = await makeTestDirectory();
        const worktreePath = path.join(root, 'worktree');
        const linkedGitDir = path.join(root, 'clone', '.git', 'worktrees', 'task');
        await fs.ensureDir(worktreePath);
        await fs.ensureDir(linkedGitDir);
        await fs.writeFile(path.join(worktreePath, '.git'), `gitdir: ${linkedGitDir}\n`);
        await fs.writeFile(path.join(linkedGitDir, 'gitdir'), `${path.join(worktreePath, '.git')}\n`);

        assert.deepEqual(
            await getWorktreeOwnershipTargets(worktreePath),
            [worktreePath, linkedGitDir],
        );
    });

    test('resolves relative gitdir and backlink paths', async () => {
        const root = await makeTestDirectory();
        const worktreePath = path.join(root, 'worktrees', 'task');
        const linkedGitDir = path.join(root, 'clone', '.git', 'worktrees', 'task');
        await fs.ensureDir(worktreePath);
        await fs.ensureDir(linkedGitDir);
        await fs.writeFile(
            path.join(worktreePath, '.git'),
            `gitdir: ${path.relative(worktreePath, linkedGitDir)}\n`,
        );
        await fs.writeFile(
            path.join(linkedGitDir, 'gitdir'),
            `${path.relative(linkedGitDir, path.join(worktreePath, '.git'))}\n`,
        );

        assert.deepEqual(
            await getWorktreeOwnershipTargets(worktreePath),
            [worktreePath, linkedGitDir],
        );
    });

    test('does not follow a gitdir without the linked-worktree backlink', async () => {
        const root = await makeTestDirectory();
        const worktreePath = path.join(root, 'worktree');
        const unrelatedDirectory = path.join(root, 'unrelated');
        await fs.ensureDir(worktreePath);
        await fs.ensureDir(unrelatedDirectory);
        await fs.writeFile(path.join(worktreePath, '.git'), `gitdir: ${unrelatedDirectory}\n`);

        assert.deepEqual(await getWorktreeOwnershipTargets(worktreePath), [worktreePath]);
    });

    test('uses only the repository path for a normal .git directory', async () => {
        const root = await makeTestDirectory();
        const repositoryPath = path.join(root, 'repository');
        await fs.ensureDir(path.join(repositoryPath, '.git'));

        assert.deepEqual(await getWorktreeOwnershipTargets(repositoryPath), [repositoryPath]);
    });
});

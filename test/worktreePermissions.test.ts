import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, test } from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { applyWorktreeOwnership, getWorktreeOwnershipTargets } from '../packages/core/src/git/worktreePermissions.js';

const testDirectories: string[] = [];

interface GitFixture {
    root: string;
    localRepoPath: string;
    worktreePath: string;
    siblingWorktreePath: string;
    metadataPath: string;
    siblingMetadataPath: string;
}

async function makeTestDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-permissions-'));
    testDirectories.push(directory);
    return directory;
}

function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function readMetadataPath(worktreePath: string): Promise<string> {
    const gitFile = await fs.readFile(path.join(worktreePath, '.git'), 'utf8');
    const match = gitFile.match(/^gitdir:\s+([^\r\n]+)\r?\n?$/);
    assert.ok(match, 'Git should create a valid linked-worktree pointer');
    return fs.realpath(path.resolve(worktreePath, match[1]));
}

async function createGitFixture(): Promise<GitFixture> {
    const root = await makeTestDirectory();
    const localRepoPath = path.join(root, 'clone');
    const worktreePath = path.join(root, 'worktree-one');
    const siblingWorktreePath = path.join(root, 'worktree-two');

    await fs.ensureDir(localRepoPath);
    git(localRepoPath, ['init', '--initial-branch=main']);
    git(localRepoPath, ['config', 'user.name', 'Worktree Permission Test']);
    git(localRepoPath, ['config', 'user.email', 'worktree-permissions@example.test']);
    git(localRepoPath, ['config', 'worktree.useRelativePaths', 'false']);
    await fs.writeFile(path.join(localRepoPath, 'README.md'), 'initial\n');
    git(localRepoPath, ['add', 'README.md']);
    git(localRepoPath, ['commit', '-m', 'initial']);
    git(localRepoPath, ['worktree', 'add', '-b', 'worktree-one', worktreePath]);
    git(localRepoPath, ['worktree', 'add', '-b', 'worktree-two', siblingWorktreePath]);

    return {
        root,
        localRepoPath,
        worktreePath,
        siblingWorktreePath,
        metadataPath: await readMetadataPath(worktreePath),
        siblingMetadataPath: await readMetadataPath(siblingWorktreePath),
    };
}

async function writeLinkedMetadata(directory: string, gitFilePath: string, commonGitPath: string): Promise<void> {
    await fs.ensureDir(directory);
    await fs.writeFile(path.join(directory, 'gitdir'), `${gitFilePath}\n`);
    await fs.writeFile(path.join(directory, 'commondir'), `${commonGitPath}\n`);
}

async function ownershipSnapshot(directory: string): Promise<{ uid: number; gid: number; mode: number }> {
    const stats = await fs.stat(directory);
    return { uid: stats.uid, gid: stats.gid, mode: stats.mode & 0o777 };
}

afterEach(async () => {
    await Promise.all(testDirectories.splice(0).map(directory => fs.remove(directory)));
});

describe('getWorktreeOwnershipTargets', () => {
    test('selects exactly a real checkout and its own metadata and permits staging', async () => {
        const fixture = await createGitFixture();
        const worktreesRoot = path.join(fixture.localRepoPath, '.git', 'worktrees');
        const expectedTargets = [fixture.worktreePath, fixture.metadataPath];
        const gitdirPointer = (await fs.readFile(path.join(fixture.worktreePath, '.git'), 'utf8'))
            .match(/^gitdir:\s+([^\r\n]+)\r?\n?$/)?.[1];

        assert.ok(gitdirPointer && path.isAbsolute(gitdirPointer));
        assert.deepEqual(
            await getWorktreeOwnershipTargets(fixture.worktreePath, fixture.localRepoPath),
            expectedTargets,
        );

        const originalWorktreesMode = (await fs.stat(worktreesRoot)).mode & 0o777;
        const originalSiblingMode = (await fs.stat(fixture.siblingMetadataPath)).mode & 0o777;
        await fs.chmod(worktreesRoot, 0o500);
        await fs.chmod(fixture.siblingMetadataPath, 0o500);
        const siblingBefore = await ownershipSnapshot(fixture.siblingMetadataPath);
        let executedTargets: readonly string[] = [];

        try {
            await applyWorktreeOwnership(
                fixture.worktreePath,
                fixture.localRepoPath,
                async targets => {
                    executedTargets = [...targets];
                    await Promise.all(targets.map(target => fs.chmod(target, 0o700)));
                },
            );

            assert.deepEqual(executedTargets, expectedTargets);
            await fs.writeFile(path.join(fixture.worktreePath, 'staged.txt'), 'stage me\n');
            git(fixture.worktreePath, ['add', 'staged.txt']);
            assert.equal(git(fixture.worktreePath, ['diff', '--cached', '--name-only']), 'staged.txt');
            assert.equal(await fs.pathExists(path.join(fixture.metadataPath, 'index')), true);
            assert.deepEqual(await ownershipSnapshot(fixture.siblingMetadataPath), siblingBefore);
        } finally {
            await fs.chmod(worktreesRoot, originalWorktreesMode);
            await fs.chmod(fixture.siblingMetadataPath, originalSiblingMode);
        }
    });

    test('accepts a valid relative gitdir pointer within the trusted metadata root', async () => {
        const fixture = await createGitFixture();
        await fs.writeFile(
            path.join(fixture.worktreePath, '.git'),
            `gitdir: ${path.relative(fixture.worktreePath, fixture.metadataPath)}\n`,
        );
        await fs.writeFile(
            path.join(fixture.metadataPath, 'gitdir'),
            `${path.relative(fixture.metadataPath, path.join(fixture.worktreePath, '.git'))}\n`,
        );

        assert.deepEqual(
            await getWorktreeOwnershipTargets(fixture.worktreePath, fixture.localRepoPath),
            [fixture.worktreePath, fixture.metadataPath],
        );
    });

    test('rejects an external directory with a reciprocal backlink', async () => {
        const fixture = await createGitFixture();
        const externalMetadata = path.join(fixture.root, 'external-metadata');
        const gitFilePath = path.join(fixture.worktreePath, '.git');
        await writeLinkedMetadata(externalMetadata, gitFilePath, path.join(fixture.localRepoPath, '.git'));
        await fs.writeFile(gitFilePath, `gitdir: ${externalMetadata}\n`);

        assert.deepEqual(
            await getWorktreeOwnershipTargets(fixture.worktreePath, fixture.localRepoPath),
            [fixture.worktreePath],
        );
    });

    test('rejects a relative traversal escape with a reciprocal backlink', async () => {
        const fixture = await createGitFixture();
        const escapedMetadata = path.join(fixture.root, 'escaped-metadata');
        const gitFilePath = path.join(fixture.worktreePath, '.git');
        await writeLinkedMetadata(escapedMetadata, gitFilePath, path.join(fixture.localRepoPath, '.git'));
        await fs.writeFile(gitFilePath, `gitdir: ${path.relative(fixture.worktreePath, escapedMetadata)}\n`);

        assert.match(path.relative(fixture.worktreePath, escapedMetadata), /^\.\./);
        assert.deepEqual(
            await getWorktreeOwnershipTargets(fixture.worktreePath, fixture.localRepoPath),
            [fixture.worktreePath],
        );
    });

    test('rejects a symlink escape beneath the trusted metadata root', async () => {
        const fixture = await createGitFixture();
        const externalMetadata = path.join(fixture.root, 'symlink-target');
        const gitFilePath = path.join(fixture.worktreePath, '.git');
        const linkedPath = path.join(fixture.localRepoPath, '.git', 'worktrees', 'symlink-escape');
        await writeLinkedMetadata(externalMetadata, gitFilePath, path.join(fixture.localRepoPath, '.git'));
        await fs.symlink(externalMetadata, linkedPath, 'dir');
        await fs.writeFile(gitFilePath, `gitdir: ${linkedPath}\n`);

        assert.deepEqual(
            await getWorktreeOwnershipTargets(fixture.worktreePath, fixture.localRepoPath),
            [fixture.worktreePath],
        );
    });

    test('rejects malformed pointers and missing linked metadata', async () => {
        const fixture = await createGitFixture();
        const gitFilePath = path.join(fixture.worktreePath, '.git');
        await fs.writeFile(gitFilePath, `gitdir: ${fixture.metadataPath}\nunexpected\n`);
        assert.deepEqual(
            await getWorktreeOwnershipTargets(fixture.worktreePath, fixture.localRepoPath),
            [fixture.worktreePath],
        );

        await fs.writeFile(gitFilePath, `gitdir: ${fixture.metadataPath}\n`);
        await fs.remove(path.join(fixture.metadataPath, 'commondir'));
        assert.deepEqual(
            await getWorktreeOwnershipTargets(fixture.worktreePath, fixture.localRepoPath),
            [fixture.worktreePath],
        );

        await fs.writeFile(gitFilePath, `gitdir: ${path.join(fixture.root, 'missing')}\n`);
        assert.deepEqual(
            await getWorktreeOwnershipTargets(fixture.worktreePath, fixture.localRepoPath),
            [fixture.worktreePath],
        );
    });

    test('uses only the repository path for a normal .git directory', async () => {
        const root = await makeTestDirectory();
        const repositoryPath = path.join(root, 'repository');
        await fs.ensureDir(path.join(repositoryPath, '.git'));

        assert.deepEqual(
            await getWorktreeOwnershipTargets(repositoryPath, repositoryPath),
            [repositoryPath],
        );
    });
});

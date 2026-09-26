import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { commitChanges } from '../packages/core/src/git/commitOperations.js';
import { assertCommitIsAncestor } from '../packages/core/src/git/mergeOperations.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
}

async function initializeRepository(tempDir: string): Promise<string> {
    const repoPath = path.join(tempDir, 'repo');
    await git(tempDir, ['init', '--initial-branch=main', repoPath]);
    await git(repoPath, ['config', 'user.email', 'test@example.com']);
    await git(repoPath, ['config', 'user.name', 'Test User']);
    await git(repoPath, ['config', 'commit.gpgSign', 'false']);
    await writeFile(path.join(repoPath, 'shared.txt'), 'original\n', 'utf8');
    await git(repoPath, ['add', 'shared.txt']);
    await git(repoPath, ['commit', '-m', 'initial']);
    return repoPath;
}

async function createConflictedMerge(repoPath: string): Promise<{
    baseCommit: string;
    headCommit: string;
}> {
    await git(repoPath, ['checkout', '-b', 'feature']);
    await writeFile(path.join(repoPath, 'shared.txt'), 'feature version\n', 'utf8');
    await git(repoPath, ['commit', '-am', 'feature change']);
    const headCommit = await git(repoPath, ['rev-parse', 'HEAD']);

    await git(repoPath, ['checkout', 'main']);
    await writeFile(path.join(repoPath, 'shared.txt'), 'base version\n', 'utf8');
    await git(repoPath, ['commit', '-am', 'base change']);
    const baseCommit = await git(repoPath, ['rev-parse', 'HEAD']);

    await git(repoPath, ['checkout', 'feature']);
    await assert.rejects(execFileAsync('git', ['merge', 'main'], { cwd: repoPath }));
    return { baseCommit, headCommit };
}

test('finalizes a pending merge whose resolved tree equals HEAD', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-zero-tree-merge-'));
    try {
        const repoPath = await initializeRepository(tempDir);
        const { baseCommit, headCommit } = await createConflictedMerge(repoPath);

        // Selecting the feature side resolves the conflict to the exact tree
        // that was already at HEAD, but the merge ancestry is still required.
        await writeFile(path.join(repoPath, 'shared.txt'), 'feature version\n', 'utf8');
        await git(repoPath, ['add', 'shared.txt']);
        assert.equal(await git(repoPath, ['write-tree']), await git(repoPath, ['rev-parse', 'HEAD^{tree}']));

        const result = await commitChanges(repoPath, 'merge: incorporate main', null);

        assert.ok(result?.commitHash);
        assert.deepEqual(
            (await git(repoPath, ['show', '-s', '--format=%P', 'HEAD'])).split(' '),
            [headCommit, baseCommit]
        );
        assert.equal(await git(repoPath, ['rev-parse', 'HEAD^{tree}']), await git(repoPath, ['rev-parse', 'HEAD^1^{tree}']));
        await assertCommitIsAncestor(repoPath, baseCommit);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('preserves ordinary no-op behavior outside a pending merge', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-noop-commit-'));
    try {
        const repoPath = await initializeRepository(tempDir);
        const before = await git(repoPath, ['rev-parse', 'HEAD']);

        const result = await commitChanges(repoPath, 'should not be created', null);

        assert.equal(result, null);
        assert.equal(await git(repoPath, ['rev-parse', 'HEAD']), before);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('rejects a genuinely unmerged index without staging it implicitly', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-unmerged-index-'));
    try {
        const repoPath = await initializeRepository(tempDir);
        await createConflictedMerge(repoPath);

        await assert.rejects(
            commitChanges(repoPath, 'must not commit unresolved entries', null),
            /Cannot commit with unresolved index entries: shared\.txt/
        );
        assert.equal(await git(repoPath, ['diff', '--name-only', '--diff-filter=U']), 'shared.txt');
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('accepts a normal merge only when its base commit is incorporated', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-normal-merge-'));
    try {
        const repoPath = await initializeRepository(tempDir);
        await git(repoPath, ['checkout', '-b', 'feature']);
        await writeFile(path.join(repoPath, 'feature.txt'), 'feature\n', 'utf8');
        await git(repoPath, ['add', 'feature.txt']);
        await git(repoPath, ['commit', '-m', 'feature change']);

        await git(repoPath, ['checkout', 'main']);
        await writeFile(path.join(repoPath, 'base.txt'), 'base\n', 'utf8');
        await git(repoPath, ['add', 'base.txt']);
        await git(repoPath, ['commit', '-m', 'base change']);
        const baseCommit = await git(repoPath, ['rev-parse', 'HEAD']);

        await git(repoPath, ['checkout', 'feature']);
        await assert.rejects(assertCommitIsAncestor(repoPath, baseCommit), /is not incorporated into HEAD/);
        await git(repoPath, ['merge', 'main', '--no-edit']);
        await assert.doesNotReject(assertCommitIsAncestor(repoPath, baseCommit));
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

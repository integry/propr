import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { commitChanges } from '../packages/core/src/git/commitOperations.js';
import { pushBranch } from '../packages/core/src/git/repoBranching.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
}

async function configureRepository(repoPath: string): Promise<void> {
    await git(repoPath, ['config', 'user.email', 'test@example.com']);
    await git(repoPath, ['config', 'user.name', 'Test User']);
}

async function installFailingHook(
    hooksPath: string,
    hookName: string,
    markerPath: string
): Promise<void> {
    await mkdir(hooksPath, { recursive: true });
    const hookPath = path.join(hooksPath, hookName);
    await writeFile(
        hookPath,
        `#!/bin/sh\nprintf executed > "${markerPath}"\nexit 73\n`,
        'utf8'
    );
    await chmod(hookPath, 0o755);
}

async function assertMissing(filePath: string): Promise<void> {
    await assert.rejects(access(filePath));
}

test('commitChanges disables every repository commit hook', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-hookless-commit-'));
    try {
        const repoPath = path.join(tempDir, 'repo');
        const hooksPath = path.join(tempDir, 'untrusted-hooks');
        await git(tempDir, ['init', repoPath]);
        await configureRepository(repoPath);
        await git(repoPath, ['config', 'core.hooksPath', hooksPath]);

        const hookNames = [
            'pre-commit',
            'prepare-commit-msg',
            'commit-msg',
            'post-commit',
        ];
        const markers = hookNames.map(name => path.join(tempDir, `${name}.ran`));
        await Promise.all(
            hookNames.map((name, index) =>
                installFailingHook(hooksPath, name, markers[index])
            )
        );

        await writeFile(path.join(repoPath, 'README.md'), 'safe commit\n', 'utf8');
        const result = await commitChanges(repoPath, 'test: hookless commit', null);

        assert.ok(result?.commitHash);
        assert.equal(await git(repoPath, ['log', '-1', '--format=%s']), 'test: hookless commit');
        await Promise.all(markers.map(assertMissing));
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('pushBranch disables repository pre-push hooks', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-hookless-push-'));
    try {
        const remotePath = path.join(tempDir, 'remote.git');
        const repoPath = path.join(tempDir, 'repo');
        const hooksPath = path.join(tempDir, 'untrusted-hooks');
        const markerPath = path.join(tempDir, 'pre-push.ran');

        await git(tempDir, ['init', '--bare', remotePath]);
        await git(tempDir, ['init', repoPath]);
        await configureRepository(repoPath);
        await writeFile(path.join(repoPath, 'README.md'), 'initial\n', 'utf8');
        await git(repoPath, ['add', 'README.md']);
        await git(repoPath, ['commit', '-m', 'initial']);
        await git(repoPath, ['branch', '-M', 'main']);
        await git(repoPath, ['remote', 'add', 'origin', remotePath]);

        await git(repoPath, ['config', 'core.hooksPath', hooksPath]);
        await installFailingHook(hooksPath, 'pre-push', markerPath);

        const result = await pushBranch(repoPath, 'main');
        const localHead = await git(repoPath, ['rev-parse', 'HEAD']);
        const remoteHead = await git(remotePath, ['rev-parse', 'refs/heads/main']);

        assert.equal(result.rebased, false);
        assert.equal(result.commitHash, localHead);
        assert.equal(remoteHead, localHead);
        await assertMissing(markerPath);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

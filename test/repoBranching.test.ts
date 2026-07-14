import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { pushBranch } from '../packages/core/src/git/repoBranching.js';

const execGit = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execGit('git', args, { cwd });
    return stdout.trim();
}

async function configureUser(cwd: string): Promise<void> {
    await git(cwd, ['config', 'user.email', 'test@example.com']);
    await git(cwd, ['config', 'user.name', 'Test User']);
}

test('pushBranch rebases and retries when remote branch advanced', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-repo-branching-'));
    try {
        const remotePath = path.join(tempDir, 'remote.git');
        const firstClone = path.join(tempDir, 'first');
        const secondClone = path.join(tempDir, 'second');

        await git(tempDir, ['init', '--bare', remotePath]);
        await git(tempDir, ['clone', remotePath, firstClone]);
        await configureUser(firstClone);

        await writeFile(path.join(firstClone, 'README.md'), 'base\n');
        await git(firstClone, ['add', 'README.md']);
        await git(firstClone, ['commit', '-m', 'base']);
        await git(firstClone, ['branch', '-M', 'main']);
        await git(firstClone, ['push', '-u', 'origin', 'main']);

        await git(firstClone, ['checkout', '-b', 'feature']);
        await writeFile(path.join(firstClone, 'feature.txt'), 'initial\n');
        await git(firstClone, ['add', 'feature.txt']);
        await git(firstClone, ['commit', '-m', 'initial feature']);
        await git(firstClone, ['push', '-u', 'origin', 'feature']);

        await git(tempDir, ['clone', remotePath, secondClone]);
        await configureUser(secondClone);
        await git(secondClone, ['checkout', 'feature']);
        await writeFile(path.join(secondClone, 'remote.txt'), 'remote change\n');
        await git(secondClone, ['add', 'remote.txt']);
        await git(secondClone, ['commit', '-m', 'remote advance']);
        await git(secondClone, ['push', 'origin', 'feature']);

        await writeFile(path.join(firstClone, 'local.txt'), 'local change\n');
        await git(firstClone, ['add', 'local.txt']);
        await git(firstClone, ['commit', '-m', 'local follow-up']);
        const originalLocalCommit = await git(firstClone, ['rev-parse', 'HEAD']);

        const result = await pushBranch(firstClone, 'feature', { rebaseOnNonFastForward: true });
        const finalLocalCommit = await git(firstClone, ['rev-parse', 'HEAD']);
        const finalRemoteCommit = await git(firstClone, ['ls-remote', 'origin', 'refs/heads/feature']);
        const remoteLog = await git(firstClone, ['log', '--format=%s', 'origin/feature', '-3']);

        assert.strictEqual(result.rebased, true);
        assert.strictEqual(result.commitHash, finalLocalCommit);
        assert.notStrictEqual(finalLocalCommit, originalLocalCommit);
        assert.ok(finalRemoteCommit.startsWith(finalLocalCommit));
        assert.match(remoteLog, /local follow-up/);
        assert.match(remoteLog, /remote advance/);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

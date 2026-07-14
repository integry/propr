import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { ensureSeedCommitIfEmpty } from '../packages/core/src/git/seedCommit.js';

const execGit = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execGit('git', args, { cwd });
    return stdout.trim();
}

async function configureUser(cwd: string): Promise<void> {
    await git(cwd, ['config', 'user.email', 'test@example.com']);
    await git(cwd, ['config', 'user.name', 'Test User']);
}

// Regression test for the mcptest 22cb898 incident: a repo that already has
// history must never receive a destructive "Initial commit" seed, even if the
// local emptiness probe is confused.
test('ensureSeedCommitIfEmpty does not seed when the remote already has history', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-seed-'));
    try {
        const remotePath = path.join(tempDir, 'remote.git');
        const clonePath = path.join(tempDir, 'clone');

        await git(tempDir, ['init', '--bare', remotePath]);
        await git(tempDir, ['clone', remotePath, clonePath]);
        await configureUser(clonePath);
        await writeFile(path.join(clonePath, 'app.js'), 'console.log("real app");\n');
        await git(clonePath, ['add', 'app.js']);
        await git(clonePath, ['commit', '-m', 'real history']);
        await git(clonePath, ['branch', '-M', 'main']);
        await git(clonePath, ['push', '-u', 'origin', 'main']);
        const originalHead = await git(clonePath, ['rev-parse', 'HEAD']);

        const wasSeeded = await ensureSeedCommitIfEmpty(simpleGit(clonePath), {
            localRepoPath: clonePath,
            owner: 'test',
            repoName: 'repo',
            defaultBranch: 'main',
            authToken: 'unused',
            repoUrl: remotePath,
        });

        assert.strictEqual(wasSeeded, false, 'must not seed a repo that already has history');
        assert.strictEqual(await git(clonePath, ['rev-parse', 'HEAD']), originalHead, 'HEAD must be unchanged');
        assert.match(await git(remotePath, ['log', '--format=%s', '-1', 'main']), /real history/);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

// The remote-emptiness guard is the critical safeguard: even if the local clone
// genuinely has no refs, an existing remote must block the seed.
test('ensureSeedCommitIfEmpty does not seed a fresh init when the remote is non-empty', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-seed-'));
    try {
        const remotePath = path.join(tempDir, 'remote.git');
        const seedClone = path.join(tempDir, 'seed');
        const freshPath = path.join(tempDir, 'fresh');

        // Populate the remote with real history via a throwaway clone.
        await git(tempDir, ['init', '--bare', remotePath]);
        await git(tempDir, ['clone', remotePath, seedClone]);
        await configureUser(seedClone);
        await writeFile(path.join(seedClone, 'app.js'), 'console.log("real app");\n');
        await git(seedClone, ['add', 'app.js']);
        await git(seedClone, ['commit', '-m', 'real history']);
        await git(seedClone, ['branch', '-M', 'main']);
        await git(seedClone, ['push', '-u', 'origin', 'main']);

        // A fresh, ref-less local repo — the local probe alone would call this "empty".
        await git(tempDir, ['init', freshPath]);
        await configureUser(freshPath);

        const wasSeeded = await ensureSeedCommitIfEmpty(simpleGit(freshPath), {
            localRepoPath: freshPath,
            owner: 'test',
            repoName: 'repo',
            defaultBranch: 'main',
            authToken: 'unused',
            repoUrl: remotePath,
        });

        assert.strictEqual(wasSeeded, false, 'non-empty remote must block seeding');
        assert.match(await git(remotePath, ['log', '--format=%s', '-1', 'main']), /real history/);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

// A genuinely empty remote is the one case where seeding is expected to run.
test('ensureSeedCommitIfEmpty seeds a genuinely empty remote', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-seed-'));
    try {
        const remotePath = path.join(tempDir, 'remote.git');
        const clonePath = path.join(tempDir, 'clone');

        await git(tempDir, ['init', '--bare', remotePath]);
        await git(tempDir, ['clone', remotePath, clonePath]);
        await configureUser(clonePath);

        const wasSeeded = await ensureSeedCommitIfEmpty(simpleGit(clonePath), {
            localRepoPath: clonePath,
            owner: 'test',
            repoName: 'repo',
            defaultBranch: 'main',
            authToken: 'unused',
            repoUrl: remotePath,
        });

        assert.strictEqual(wasSeeded, true, 'an empty remote should be seeded');
        assert.match(await git(remotePath, ['log', '--format=%s', '-1', 'main']), /Initial commit/);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

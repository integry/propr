import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import type { Logger } from 'pino';
import { closeConnection, getPushFailure, type IssueJobData } from '@propr/core';
import { pushImplementationBranch } from '../src/jobs/issueJobPush.js';

const execGit = promisify(execFile);

after(async () => {
    await closeConnection();
});

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execGit('git', args, { cwd });
    return stdout.trim();
}

test('a failed installation token request before the push still runs the salvage ladder', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-implementation-push-'));
    const previousBundleDir = process.env.PUSH_RESCUE_BUNDLE_DIR;
    try {
        const worktreePath = path.join(tempDir, 'worktree');
        await git(tempDir, ['init', worktreePath]);
        await git(worktreePath, ['config', 'user.email', 'test@example.com']);
        await git(worktreePath, ['config', 'user.name', 'Test']);
        await writeFile(path.join(worktreePath, 'agent.txt'), 'agent work\n');
        await git(worktreePath, ['add', '.']);
        await git(worktreePath, ['commit', '-m', 'agent work']);
        process.env.PUSH_RESCUE_BUNDLE_DIR = path.join(tempDir, 'bundles');

        const authCalls: unknown[] = [];
        const octokit = {
            auth: async (options: unknown) => {
                authCalls.push(options);
                throw new Error('fatal: Authentication failed: installation access revoked');
            },
        } as unknown as Parameters<typeof pushImplementationBranch>[0]['octokit'];

        const error = await pushImplementationBranch({
            octokit,
            issueRef: { repoOwner: 'integry', repoName: 'propr', number: 2736 } as IssueJobData,
            worktreeInfo: { worktreePath, branchName: 'main' } as Parameters<typeof pushImplementationBranch>[0]['worktreeInfo'],
            repoUrl: 'https://github.com/integry/propr.git',
            taskId: 'task-5',
            correlatedLogger: { warn() {} } as unknown as Logger,
        }).then(() => assert.fail('expected a push failure'), (e: unknown) => e);

        const failure = getPushFailure(error);
        assert.ok(failure, 'the token failure is reported as a salvaged push failure');
        assert.equal(failure.rung, 'bundle');
        assert.equal(failure.diagnosis.classification, 'auth');
        assert.ok(existsSync(failure.bundlePath!));
        assert.deepEqual(authCalls[0], { type: 'installation' });
    } finally {
        if (previousBundleDir === undefined) delete process.env.PUSH_RESCUE_BUNDLE_DIR;
        else process.env.PUSH_RESCUE_BUNDLE_DIR = previousBundleDir;
        await rm(tempDir, { recursive: true, force: true });
    }
});

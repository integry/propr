import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, lstat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import {
    salvageFailedPush, createWorktreePushSalvageOperations, PushFailedError, getPushFailure, writeSalvageRetentionMarker,
    formatPushFailureMarkdown, isSalvageRetainedWorktree, buildRecoveryInstruction, quoteShellArgument, type PushSalvageEvent, type PushSalvageOperations,
} from '../packages/core/src/git/pushSalvage.js';
import { extractUnblockUrls } from '../packages/core/src/git/pushRejection.js';
import { cleanupExpiredWorktrees, cleanupWorktree } from '../packages/core/src/git/worktreeOperations.js';
import { pushBranch } from '../packages/core/src/git/repoBranching.js';

test('recovery commands quote branch names with shell metacharacters and paths with spaces', () => {
    const branchName = "fix;id>pwned;#it's";
    const quotedBranch = `'fix;id>pwned;#it'\\''s'`;
    const base = { branchName, repository: 'integry/propr' };
    const command = (instruction: string) => instruction.match(/with: `([^`]+)`/)![1];

    assert.equal(quoteShellArgument(branchName), quotedBranch);
    assert.equal(quoteShellArgument('2736/salvage'), '2736/salvage');
    assert.equal(quoteShellArgument(''), "''");
    assert.equal(
        command(buildRecoveryInstruction({ ...base, rung: 'rescue_ref', rescueRef: 'refs/propr/rescue/task-1' })),
        `git fetch origin refs/propr/rescue/task-1 && git checkout -B ${quotedBranch} FETCH_HEAD`,
    );
    assert.equal(
        command(buildRecoveryInstruction({ ...base, rung: 'bundle', bundlePath: '/data/my rescue/$HOME/task-1.bundle' })),
        `git fetch '/data/my rescue/$HOME/task-1.bundle' HEAD && git checkout -B ${quotedBranch} FETCH_HEAD`,
    );
    assert.equal(
        command(buildRecoveryInstruction({ ...base, rung: 'worktree', worktreePath: '/work trees/a;b' })),
        `git -C '/work trees/a;b' push origin 'HEAD:refs/heads/fix;id>pwned;#it'\\''s'`,
    );
});

test('generated bundle and worktree recovery commands run literally in a POSIX shell', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr rescue quoting-'));
    const branchName = 'fix;id>pwned;#';
    const command = (instruction: string) => instruction.match(/with: `([^`]+)`/)![1];
    try {
        const worktreePath = path.join(tempDir, "work tree;it's");
        await mkdir(worktreePath);
        await git(worktreePath, ['init', '-q']);
        await git(worktreePath, ['config', 'user.email', 'test@example.com']);
        await git(worktreePath, ['config', 'user.name', 'Test']);
        await writeFile(path.join(worktreePath, 'agent.txt'), 'agent work\n');
        await git(worktreePath, ['add', '.']);
        await git(worktreePath, ['commit', '-q', '-m', 'agent work']);
        const head = await git(worktreePath, ['rev-parse', 'HEAD']);
        const bundlePath = path.join(tempDir, 'my bundles', 'task-1.bundle');
        await mkdir(path.dirname(bundlePath));
        await git(worktreePath, ['bundle', 'create', bundlePath, 'HEAD']);

        const restored = path.join(tempDir, 'restored');
        await mkdir(restored);
        await git(restored, ['init', '-q']);
        await execGit('sh', ['-c', command(buildRecoveryInstruction({ rung: 'bundle', bundlePath, branchName, repository: 'integry/propr' }))], { cwd: restored });
        assert.equal(await git(restored, ['rev-parse', `refs/heads/${branchName}`]), head);
        assert.equal(existsSync(path.join(restored, 'pwned')), false);

        await git(worktreePath, ['remote', 'add', 'origin', restored]);
        await git(restored, ['checkout', '-q', '--detach']);
        await git(restored, ['branch', '-q', '-D', branchName]);
        await execGit('sh', ['-c', command(buildRecoveryInstruction({ rung: 'worktree', worktreePath, branchName, repository: 'integry/propr' }))], { cwd: tempDir });
        assert.equal(await git(restored, ['rev-parse', `refs/heads/${branchName}`]), head);
        assert.equal(existsSync(path.join(tempDir, 'pwned')), false);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

const execGit = promisify(execFile);
const UNBLOCK_URL = 'https://github.com/integry/propr/security/secret-scanning/unblock-secret/2Mf8bjCnMb7BJFkLxmEB';
const PROTECTION_ERROR = new Error(`remote: - GITHUB PUSH PROTECTION\nremote:   - Push cannot contain secrets\nremote:   ${UNBLOCK_URL}\n ! [remote rejected] b -> b (push declined due to repository rule violations)`);
const NON_FAST_FORWARD_ERROR = new Error(' ! [rejected]        b -> b (non-fast-forward)');

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execGit('git', args, { cwd });
    return stdout.trim();
}

interface FakeLadder {
    operations: PushSalvageOperations<string>;
    calls: string[];
}

function fakeLadder(outcomes: { retry?: boolean; rescue?: boolean; bundle?: boolean; retain?: boolean; retryError?: Error }, retain?: () => Promise<void>): FakeLadder {
    const calls: string[] = [];
    const step = async (name: string, ok: boolean | undefined, error = new Error(`${name} failed`)) => {
        calls.push(name);
        if (!ok) throw error;
    };
    return {
        calls,
        operations: {
            async retryPush() { await step('retry', outcomes.retry, outcomes.retryError); return 'pushed'; },
            async pushRescueRef(ref) { await step(`rescue:${ref}`, outcomes.rescue); },
            async createBundle(bundlePath) {
                await step('bundle', outcomes.bundle);
                await writeFile(bundlePath, 'bundle');
            },
            async retainWorktree() {
                calls.push('retain');
                if (retain) return retain();
                if (!outcomes.retain) throw new Error('retain failed');
            },
        },
    };
}

async function runLadder(ladder: FakeLadder, overrides: { worktreePath?: string; bundleDirectory?: string; error?: Error } = {}) {
    const events: PushSalvageEvent[] = [];
    const run = salvageFailedPush({
        taskId: 'task/1', repoOwner: 'integry', repoName: 'propr', branchName: '2736/salvage',
        worktreePath: overrides.worktreePath ?? '/tmp/does-not-matter',
        error: overrides.error ?? PROTECTION_ERROR,
        bundleDirectory: overrides.bundleDirectory ?? os.tmpdir(),
        operations: ladder.operations,
        onEvent: event => { events.push(event); },
    });
    return { run, events };
}

test('rung 1: a push that succeeds after the credential refresh needs no rescue', async () => {
    const ladder = fakeLadder({ retry: true });
    const { run, events } = await runLadder(ladder, { error: new Error('fatal: Authentication failed for https://github.com/integry/propr.git') });
    assert.equal(await run, 'pushed');
    assert.deepEqual(ladder.calls, ['retry']);
    assert.equal(events.length, 1);
    assert.equal(events[0].rung, 'retry');
    assert.equal(events[0].classification, 'auth');
});

test('rung 2: the rescue ref is recorded with its recovery instruction', async () => {
    const ladder = fakeLadder({ rescue: true, retryError: PROTECTION_ERROR });
    const { run, events } = await runLadder(ladder);
    const error = await run.then(() => assert.fail('expected a push failure'), (e: unknown) => e);
    assert.ok(error instanceof PushFailedError);
    const failure = getPushFailure(error)!;
    assert.equal(failure.rung, 'rescue_ref');
    assert.equal(failure.rescueRef, 'refs/propr/rescue/task-1');
    assert.equal(failure.diagnosis.classification, 'push_protection');
    assert.deepEqual(failure.diagnosis.unblockUrls, [UNBLOCK_URL]);
    assert.match(failure.recoveryInstruction, /git fetch origin refs\/propr\/rescue\/task-1/);
    assert.deepEqual(ladder.calls, ['retry', 'rescue:refs/propr/rescue/task-1']);
    assert.equal(events.at(-1)?.rung, 'rescue_ref');
    // The failure summary and the GitHub comment carry the unblock URL verbatim.
    assert.ok(error.message.split('\n').some(line => line.trim() === `Unblock URL: ${UNBLOCK_URL}`));
    assert.deepEqual(extractUnblockUrls(formatPushFailureMarkdown(failure)), [UNBLOCK_URL]);
});

test('rung 3: the bundle path is recorded when the rescue ref is refused', async () => {
    const bundleDirectory = await mkdtemp(path.join(os.tmpdir(), 'propr-rescue-bundles-'));
    try {
        const ladder = fakeLadder({ bundle: true });
        const { run, events } = await runLadder(ladder, { bundleDirectory });
        const failure = getPushFailure(await run.catch((e: unknown) => e))!;
        assert.equal(failure.rung, 'bundle');
        assert.equal(failure.bundlePath, path.join(bundleDirectory, 'integry', 'propr', 'task-1.bundle'));
        assert.ok(existsSync(failure.bundlePath!));
        assert.match(failure.recoveryInstruction, /git fetch .*task-1\.bundle HEAD/);
        assert.equal(events.at(-1)?.bundlePath, failure.bundlePath);
    } finally {
        await rm(bundleDirectory, { recursive: true, force: true });
    }
});

test('rung 4: when everything else fails the worktree is retained with .retention-info.json', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-rescue-worktree-'));
    const previousStrategy = process.env.WORKTREE_RETENTION_STRATEGY;
    try {
        const worktreePath = path.join(tempDir, 'worktree');
        await mkdir(worktreePath);
        const ladder = fakeLadder({}, () => writeSalvageRetentionMarker(worktreePath, { taskId: 'task/1', branchName: '2736/salvage' }));
        const { run } = await runLadder(ladder, { worktreePath, bundleDirectory: path.join(tempDir, 'bundles') });
        const failure = getPushFailure(await run.catch((e: unknown) => e))!;
        assert.equal(failure.rung, 'worktree');
        assert.equal(failure.worktreePath, worktreePath);
        assert.deepEqual(failure.attempts.map(attempt => [attempt.rung, attempt.succeeded]), [
            ['retry', false], ['rescue_ref', false], ['bundle', false], ['worktree', true],
        ]);
        const marker = JSON.parse(await readFile(path.join(worktreePath, '.retention-info.json'), 'utf8'));
        assert.equal(marker.reason, 'push_salvage');
        assert.equal(marker.taskId, 'task/1');

        // The default always_delete cleanup keeps the salvaged worktree.
        process.env.WORKTREE_RETENTION_STRATEGY = 'always_delete';
        await cleanupWorktree(tempDir, worktreePath, '2736/salvage', { deleteBranch: true, success: false });
        assert.ok(existsSync(worktreePath));
    } finally {
        if (previousStrategy === undefined) delete process.env.WORKTREE_RETENTION_STRATEGY;
        else process.env.WORKTREE_RETENTION_STRATEGY = previousStrategy;
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('every rung failing still reports a failure', async () => {
    const ladder = fakeLadder({});
    const { run, events } = await runLadder(ladder, { bundleDirectory: '/dev/null/not-a-directory' });
    const failure = getPushFailure(await run.catch((e: unknown) => e))!;
    assert.equal(failure.rung, 'none');
    assert.equal(events.at(-1)?.rung, 'none');
});

test('a rejected non-fast-forward push is saved to the rescue ref on the same remote', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-rescue-remote-'));
    try {
        const remote = path.join(tempDir, 'remote.git');
        const ours = path.join(tempDir, 'ours');
        const theirs = path.join(tempDir, 'theirs');
        await git(tempDir, ['init', '--bare', remote]);
        await git(tempDir, ['clone', remote, ours]);
        for (const clone of [ours]) {
            await git(clone, ['config', 'user.email', 'test@example.com']);
            await git(clone, ['config', 'user.name', 'Test']);
        }
        await writeFile(path.join(ours, 'README.md'), 'base\n');
        await git(ours, ['add', '.']);
        await git(ours, ['commit', '-m', 'base']);
        await git(ours, ['branch', '-M', 'feature']);
        await git(ours, ['push', 'origin', 'feature']);

        await git(tempDir, ['clone', '--branch', 'feature', remote, theirs]);
        await git(theirs, ['config', 'user.email', 'other@example.com']);
        await git(theirs, ['config', 'user.name', 'Other']);
        await writeFile(path.join(theirs, 'other.txt'), 'someone else\n');
        await git(theirs, ['add', '.']);
        await git(theirs, ['commit', '-m', 'concurrent push']);
        await git(theirs, ['push', 'origin', 'feature']);

        await writeFile(path.join(ours, 'agent.txt'), 'agent work\n');
        await git(ours, ['add', '.']);
        await git(ours, ['commit', '-m', 'agent work']);
        const agentHead = await git(ours, ['rev-parse', 'HEAD']);

        const push = (token: string) => pushBranch(ours, 'feature', { authToken: token });
        const error = await push('token').then(() => assert.fail('push should be rejected'), (e: unknown) => e);
        const salvage = await salvageFailedPush({
            taskId: 'task-2', repoOwner: 'integry', repoName: 'propr', branchName: 'feature', worktreePath: ours, error,
            bundleDirectory: path.join(tempDir, 'bundles'),
            operations: createWorktreePushSalvageOperations({
                worktreePath: ours, taskId: 'task-2', branchName: 'feature', repoUrl: remote,
                refreshToken: async () => 'token', retryPush: push,
            }),
        }).catch((e: unknown) => e);

        const failure = getPushFailure(salvage)!;
        assert.equal(failure.diagnosis.classification, 'non_fast_forward');
        assert.equal(failure.rung, 'rescue_ref');
        assert.equal(await git(remote, ['rev-parse', 'refs/propr/rescue/task-2']), agentHead);
        // The rescue ref is not a branch.
        assert.ok(!(await git(remote, ['branch', '--list'])).includes('rescue'));
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('a bundle written by the real git operations restores the branch', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-rescue-bundle-'));
    try {
        const repo = path.join(tempDir, 'repo');
        await git(tempDir, ['init', repo]);
        await git(repo, ['config', 'user.email', 'test@example.com']);
        await git(repo, ['config', 'user.name', 'Test']);
        await writeFile(path.join(repo, 'agent.txt'), 'agent work\n');
        await git(repo, ['add', '.']);
        await git(repo, ['commit', '-m', 'agent work']);
        const head = await git(repo, ['rev-parse', 'HEAD']);

        const salvage = await salvageFailedPush({
            taskId: 'task-3', repoOwner: 'integry', repoName: 'propr', branchName: 'main', worktreePath: repo,
            error: NON_FAST_FORWARD_ERROR,
            bundleDirectory: path.join(tempDir, 'bundles'),
            operations: createWorktreePushSalvageOperations({
                worktreePath: repo, taskId: 'task-3', branchName: 'main', repoUrl: path.join(tempDir, 'missing.git'),
                refreshToken: async () => 'token',
                retryPush: async () => { throw NON_FAST_FORWARD_ERROR; },
            }),
        }).catch((e: unknown) => e);

        const failure = getPushFailure(salvage)!;
        assert.equal(failure.rung, 'bundle');
        const restored = path.join(tempDir, 'restored');
        await git(tempDir, ['init', restored]);
        await git(restored, ['fetch', '--', failure.bundlePath!, 'HEAD']);
        assert.equal(await git(restored, ['rev-parse', 'FETCH_HEAD']), head);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('a bundle is self-contained when remote-tracking commits are missing from a fresh checkout', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-rescue-bundle-prereq-'));
    try {
        const remote = path.join(tempDir, 'remote.git');
        const worker = path.join(tempDir, 'worker');
        await git(tempDir, ['init', '--bare', remote]);
        await git(tempDir, ['clone', remote, worker]);
        await git(worker, ['config', 'user.email', 'test@example.com']);
        await git(worker, ['config', 'user.name', 'Test']);
        await writeFile(path.join(worker, 'README.md'), 'branch start\n');
        await git(worker, ['add', '.']);
        await git(worker, ['commit', '-m', 'branch start']);
        await git(worker, ['branch', '-M', 'feature']);
        await git(worker, ['push', 'origin', 'feature']);
        await writeFile(path.join(worker, 'agent.txt'), 'agent work\n');
        await git(worker, ['add', '.']);
        await git(worker, ['commit', '-m', 'agent work']);
        const head = await git(worker, ['rev-parse', 'HEAD']);
        // The remote was rewritten and is now unreachable; only the stale tracking ref knows the start commit.
        await rm(remote, { recursive: true, force: true });

        const salvage = await salvageFailedPush({
            taskId: 'task-5', repoOwner: 'integry', repoName: 'propr', branchName: 'feature', worktreePath: worker,
            error: NON_FAST_FORWARD_ERROR,
            bundleDirectory: path.join(tempDir, 'bundles'),
            operations: createWorktreePushSalvageOperations({
                worktreePath: worker, taskId: 'task-5', branchName: 'feature', repoUrl: remote,
                refreshToken: async () => 'token',
                retryPush: async () => { throw NON_FAST_FORWARD_ERROR; },
            }),
        }).catch((e: unknown) => e);

        const failure = getPushFailure(salvage)!;
        assert.equal(failure.rung, 'bundle');
        // A fresh repository of unrelated history has none of the worker's objects.
        const fresh = path.join(tempDir, 'fresh');
        await git(tempDir, ['init', fresh]);
        await git(fresh, ['config', 'user.email', 'test@example.com']);
        await git(fresh, ['config', 'user.name', 'Test']);
        await git(fresh, ['commit', '--allow-empty', '-m', 'rewritten history']);
        await git(fresh, ['fetch', '--', failure.bundlePath!, 'HEAD']);
        assert.equal(await git(fresh, ['rev-parse', 'FETCH_HEAD']), head);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('the salvage retention marker replaces a repository symlink instead of writing through it', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-rescue-symlink-'));
    try {
        const worktreePath = path.join(tempDir, 'worktree');
        await mkdir(worktreePath);
        const hostFile = path.join(tempDir, 'app.sqlite');
        await writeFile(hostFile, 'application state');
        await symlink(hostFile, path.join(worktreePath, '.retention-info.json'));

        await writeSalvageRetentionMarker(worktreePath, { taskId: 'task/1', branchName: '2736/salvage' });

        assert.equal(await readFile(hostFile, 'utf8'), 'application state');
        const marker = path.join(worktreePath, '.retention-info.json');
        assert.ok((await lstat(marker)).isFile());
        assert.equal(JSON.parse(await readFile(marker, 'utf8')).reason, 'push_salvage');
        assert.deepEqual(await readdir(worktreePath), ['.retention-info.json']);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('PUSH_RESCUE_RETENTION_DAYS=0 retains a salvaged worktree indefinitely', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-rescue-indefinite-'));
    const previousDays = process.env.PUSH_RESCUE_RETENTION_DAYS;
    try {
        const worktreePath = path.join(tempDir, 'worktree');
        await mkdir(worktreePath);
        process.env.PUSH_RESCUE_RETENTION_DAYS = '0';
        await writeSalvageRetentionMarker(worktreePath, { taskId: 'task/1', branchName: '2736/salvage' });
        const marker = JSON.parse(await readFile(path.join(worktreePath, '.retention-info.json'), 'utf8'));
        assert.equal(marker.retentionHours, null);
        assert.equal(marker.scheduledCleanup, null);
        assert.equal(await isSalvageRetainedWorktree(worktreePath), true);

        await cleanupWorktree(tempDir, worktreePath, '2736/salvage', { deleteBranch: true, success: false, retentionStrategy: 'always_delete' });
        const result = await cleanupExpiredWorktrees(tempDir);
        assert.equal(result.cleaned, 0);
        assert.ok(existsSync(worktreePath));
    } finally {
        if (previousDays === undefined) delete process.env.PUSH_RESCUE_RETENTION_DAYS;
        else process.env.PUSH_RESCUE_RETENTION_DAYS = previousDays;
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('a salvaged worktree past its finite retention is expired', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-rescue-expired-'));
    try {
        const worktreePath = path.join(tempDir, 'worktree');
        await mkdir(worktreePath);
        await writeSalvageRetentionMarker(worktreePath, { taskId: 'task/1', branchName: '2736/salvage', retentionHours: -1 });
        assert.equal(await isSalvageRetainedWorktree(worktreePath), false);
        const result = await cleanupExpiredWorktrees(tempDir);
        assert.equal(result.cleaned, 1);
        assert.ok(!existsSync(worktreePath));
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('a failed credential refresh keeps the original push rejection as the diagnosis', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-rescue-refresh-'));
    try {
        const repo = path.join(tempDir, 'repo');
        await git(tempDir, ['init', repo]);
        await git(repo, ['config', 'user.email', 'test@example.com']);
        await git(repo, ['config', 'user.name', 'Test']);
        await writeFile(path.join(repo, 'agent.txt'), 'agent work\n');
        await git(repo, ['add', '.']);
        await git(repo, ['commit', '-m', 'agent work']);

        let retried = false;
        const salvage = await salvageFailedPush({
            taskId: 'task-4', repoOwner: 'integry', repoName: 'propr', branchName: 'main', worktreePath: repo,
            error: PROTECTION_ERROR,
            bundleDirectory: path.join(tempDir, 'bundles'),
            operations: createWorktreePushSalvageOperations({
                worktreePath: repo, taskId: 'task-4', branchName: 'main', repoUrl: path.join(tempDir, 'missing.git'),
                refreshToken: async () => { throw new Error('fatal: Authentication failed for https://github.com/integry/propr.git'); },
                retryPush: async () => { retried = true; },
            }),
        }).catch((e: unknown) => e);

        const failure = getPushFailure(salvage)!;
        assert.equal(retried, false);
        assert.equal(failure.rung, 'bundle');
        assert.equal(failure.diagnosis.classification, 'push_protection');
        assert.deepEqual(failure.diagnosis.unblockUrls, [UNBLOCK_URL]);
        assert.equal(failure.attempts[0].rung, 'retry');
        assert.match(failure.attempts[0].error ?? '', /^Credential refresh failed: fatal: Authentication failed/);
        assert.ok((salvage as Error).message.includes(`Unblock URL: ${UNBLOCK_URL}`));
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

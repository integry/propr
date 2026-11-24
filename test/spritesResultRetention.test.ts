import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { cloneSpec, createHarness, type Harness } from './helpers/spritesHarness.ts';

const { runWithWorkspaceTransport } = await import('../packages/core/src/git/workspaceTransport.ts');
const { CloneWorkspaceTransport } = await import('../packages/core/src/git/workspaceCloneTransport.ts');
const { SPRITES_RESULTS_DIR, SPRITES_RESULT_RECOVERY_FILE } = await import('../packages/core/src/agents/runtime/sprites/spritesResultStore.ts');
const { default: logger } = await import('../packages/core/src/utils/logger.ts');

import type { AgentRunSpec } from '../packages/core/src/agents/runtime/types.ts';

const SPRITE = 'propr-w1-0';
const BUNDLE_PATH = '/tmp/propr-workspace-result/result.bundle';

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, {
        cwd, encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' },
    }).trimEnd();
}

interface Fixture {
    harness: Harness;
    remote: string;
    worktree: string;
    spec: AgentRunSpec;
    /** What the sandbox left when its result push failed: the status line and the bundle holding the only copy. */
    snapshot: string;
    bundle: Buffer;
    resultsDir: string;
    /** Each call of the worker's token lookup: `prepare`, then `complete`, then `cleanup`. */
    workerTokenCalls: number;
    transport(failWorkerTokenOnCall?: number): InstanceType<typeof CloneWorkspaceTransport>;
}

/** A worker worktree of a repository, and the bundle a run on it would leave after changing `a.txt`. */
function fixture(): Fixture {
    const harness = createHarness();
    const root = harness.root;
    const remote = path.join(root, 'remote.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    const seed = path.join(root, 'seed');
    git(root, 'init', '-q', '-b', 'main', seed);
    fs.writeFileSync(path.join(seed, 'a.txt'), 'original\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'seed');
    git(seed, 'push', '-q', remote, 'main');
    const clone = path.join(root, 'clone');
    git(root, 'clone', '-q', remote, clone);
    git(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git');
    const worktree = path.join(root, 'worktree');
    git(clone, 'worktree', 'add', '-q', '-b', 'task-1', worktree, 'origin/main');
    const base = git(worktree, 'rev-parse', 'HEAD');

    // The sandbox side, as the clone wrapper does it: a snapshot commit on the agent's HEAD, bundled against the base.
    fs.writeFileSync(path.join(seed, 'a.txt'), 'changed by the agent\n');
    git(seed, 'add', '-A');
    const snapshot = git(seed, 'commit-tree', git(seed, 'write-tree'), '-p', base, '-m', 'ProPR workspace result');
    git(seed, 'update-ref', 'refs/propr/result', snapshot);
    const bundleFile = path.join(root, 'sandbox.bundle');
    git(seed, 'bundle', 'create', '-q', bundleFile, 'refs/propr/result', `^${base}`);

    const spec = cloneSpec('claude-issue-7-abc');
    spec.workspace = { hostPath: worktree, containerPath: '/home/node/workspace', readOnly: false };
    const f: Fixture = {
        harness, remote, worktree, spec, snapshot, bundle: fs.readFileSync(bundleFile),
        resultsDir: path.join(harness.stateDir, SPRITES_RESULTS_DIR),
        workerTokenCalls: 0,
        transport: failOnCall => new CloneWorkspaceTransport({
            mintToken: async () => 'ghs_spritesResultRetentionToken0123456789',
            revokeToken: async () => undefined,
            workerToken: async () => {
                f.workerTokenCalls++;
                if (f.workerTokenCalls === failOnCall) throw new Error('GitHub App token service unavailable');
                return undefined;
            },
            remoteUrl: () => remote,
            createRunId: () => 'run-1',
        }),
    };
    return f;
}

function keptResults(f: Fixture): string[] {
    return fs.existsSync(f.resultsDir) ? fs.readdirSync(f.resultsDir).map(name => path.join(f.resultsDir, name)) : [];
}

function restores(f: Fixture): number {
    return f.harness.client.operations.filter(operation => operation.startsWith('restore')).length;
}

test('a bundle result the transport fails to retrieve stays on the worker\'s disk after the Sprite is restored and the handle is gone', async () => {
    const f = fixture();
    f.harness.client.behaviors.push({ resultStatus: `bundle ${f.snapshot}`, resultBundle: f.bundle }, {});
    // The worker's git cannot be authenticated when the result comes back: nothing reaches `fetchBundle()`.
    let failure: Error | undefined;
    await runWithWorkspaceTransport(f.harness.runtime, f.spec, { timeout: 5000, extraEnvVars: {} }, { transport: f.transport(2) })
        .catch(error => { failure = error as Error; });
    assert.ok(failure, 'the failed retrieval is reported');
    assert.equal(f.workerTokenCalls, 3, 'prepare, the failed completion and cleanup each asked for the worker token');
    const [directory, ...others] = keptResults(f);
    assert.ok(directory, 'the bundle is kept');
    assert.deepEqual(others, []);
    // The error names the durable copy, not a run that no longer exists on the Sprite.
    assert.match(failure.message, /GitHub App token service unavailable; the run's result is kept for recovery at /);
    assert.ok(failure.message.includes(`${directory} on the worker (the result bundle of run claude-issue-7-abc)`), failure.message);
    assert.ok(!failure.message.includes('the kept run'), failure.message);
    assert.ok(!failure.message.includes('refs/propr/runs/run-1/result'), 'a bundle result pushed no result ref');

    // The copy is private, complete and self-describing.
    assert.equal(fs.statSync(f.resultsDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    const bundlePath = path.join(directory, 'result.bundle');
    assert.equal(fs.statSync(bundlePath).mode & 0o777, 0o600);
    assert.ok(fs.readFileSync(bundlePath).equals(f.bundle));
    assert.equal(fs.statSync(path.join(directory, SPRITES_RESULT_RECOVERY_FILE)).mode & 0o777, 0o600);
    const recovery = JSON.parse(fs.readFileSync(path.join(directory, SPRITES_RESULT_RECOVERY_FILE), 'utf8'));
    assert.equal(recovery.run, 'claude-issue-7-abc');
    assert.equal(recovery.sprite, SPRITE);
    assert.equal(recovery.status, `bundle ${f.snapshot}`);
    assert.deepEqual({ ...recovery.bundle, sha256: undefined }, { file: 'result.bundle', ref: 'refs/propr/result', bytes: f.bundle.length, sha256: undefined });
    assert.match(recovery.bundle.sha256, /^[0-9a-f]{64}$/);
    assert.equal(recovery.worktree, f.worktree);
    assert.equal(recovery.remote, f.remote);
    assert.equal(recovery.branch, 'task-1');
    assert.equal(recovery.baseCommit, git(f.worktree, 'rev-parse', 'HEAD'));
    assert.ok(recovery.recover.includes(bundlePath));
    assert.ok(!JSON.stringify(recovery).includes('ghs_'), 'no credential is written beside the bundle');

    // The Sprite went back to its clean checkpoint regardless, and nothing was applied.
    assert.equal(restores(f), 1);
    assert.equal(git(f.worktree, 'status', '--porcelain'), '');

    // A restarted worker and the next run on the same Sprite leave the copy alone.
    const restarted = f.harness.restart();
    const next = restarted.start(cloneSpec('next'), { timeout: 5000 });
    await next.wait();
    await next.release();
    assert.deepEqual(keptResults(f), [directory]);

    // And it recovers the agent's changes as the recovery file says.
    git(f.worktree, 'bundle', 'verify', '--quiet', bundlePath);
    git(f.worktree, 'fetch', '--quiet', bundlePath, 'refs/propr/result:refs/heads/recovered-run');
    assert.equal(git(f.worktree, 'rev-parse', 'recovered-run'), f.snapshot);
    assert.equal(git(f.worktree, 'show', 'recovered-run:a.txt'), 'changed by the agent');
});

test('a bundle result written before the restore is applied from the worker\'s disk and removed on release', async () => {
    const f = fixture();
    f.harness.client.behaviors.push({ resultStatus: `bundle ${f.snapshot}`, resultBundle: f.bundle });
    const kept: string[][] = [];
    const transport = f.transport();
    const result = await runWithWorkspaceTransport(f.harness.runtime, f.spec, { timeout: 5000, extraEnvVars: {} }, {
        transport: {
            mode: 'clone',
            prepare: async spec => {
                const prepared = await transport.prepare(spec);
                return {
                    ...prepared,
                    complete: async (handle, runResult, options) => {
                        // Already on disk when the run settled, before anything asked for it.
                        kept.push(keptResults(f));
                        assert.equal(handle.resultRecoveryLocation?.(), kept[0][0]);
                        return prepared.complete(handle, runResult, options);
                    },
                };
            },
        },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(kept[0].length, 1);
    assert.equal(fs.readFileSync(path.join(f.worktree, 'a.txt'), 'utf8'), 'changed by the agent\n');
    assert.deepEqual(keptResults(f), [], 'the explicit release after a successful apply removes the copy');
    assert.equal(restores(f), 1);
});

test('a result retrieved but not applied releases the bundle copy: the worker\'s local ref is the recoverable one', async () => {
    const f = fixture();
    f.harness.client.behaviors.push({ resultStatus: `bundle ${f.snapshot}`, resultBundle: f.bundle });
    // The worktree moves during the run, so the fetched snapshot is not applied.
    const transport = f.transport();
    let failure: Error | undefined;
    await runWithWorkspaceTransport(f.harness.runtime, f.spec, { timeout: 5000, extraEnvVars: {} }, {
        transport: {
            mode: 'clone',
            prepare: async spec => {
                const prepared = await transport.prepare(spec);
                git(f.worktree, 'commit', '-q', '--allow-empty', '-m', 'moved during the run');
                return prepared;
            },
        },
    }).catch(error => { failure = error as Error; });
    assert.match(failure?.message ?? '', /moved from .* during the run.*kept for recovery at refs\/propr\/runs\/run-1 in /);
    assert.equal(git(f.worktree, 'rev-parse', 'refs/propr/runs/run-1'), f.snapshot);
    assert.deepEqual(keptResults(f), []);
});

test('a run that reported a bundle but left none names no recoverable copy', async () => {
    const f = fixture();
    f.harness.client.behaviors.push({ resultStatus: `bundle ${f.snapshot}` });
    let failure: Error | undefined;
    await runWithWorkspaceTransport(f.harness.runtime, f.spec, { timeout: 5000, extraEnvVars: {} }, { transport: f.transport() })
        .catch(error => { failure = error as Error; });
    assert.match(failure?.message ?? '', /returned no workspace result.*; no recoverable copy of the run's result remains$/);
    assert.deepEqual(keptResults(f), []);
});

test('a kept bundle outlives its handle until release, and release removes it', async () => {
    const harness = createHarness();
    harness.client.behaviors.push({ resultStatus: 'bundle abc', resultBundle: Buffer.from('BUNDLE') }, { resultStatus: 'pushed abc' });
    const first = harness.runtime.start(cloneSpec('kept/run one'), { timeout: 5000 });
    await first.wait();
    const directory = first.resultRecoveryLocation();
    assert.ok(directory?.startsWith(path.join(harness.stateDir, SPRITES_RESULTS_DIR, 'kept-run-one-')), directory);
    first.retain();
    assert.equal((await first.readFile(BUNDLE_PATH))?.toString(), 'BUNDLE');
    // A pushed result has its copy on the repository: nothing is written for it.
    const second = harness.runtime.start(cloneSpec('pushed'), { timeout: 5000 });
    await second.wait();
    assert.equal(second.resultRecoveryLocation(), undefined);
    await second.release();
    assert.deepEqual(fs.readdirSync(path.join(harness.stateDir, SPRITES_RESULTS_DIR)), [path.basename(directory!)]);
    await first.release();
    assert.equal(first.resultRecoveryLocation(), undefined);
    assert.equal(await first.readFile(BUNDLE_PATH), null);
    assert.equal(fs.existsSync(directory!), false);
});

test('a bundle that cannot be written to the worker\'s disk is still applied by this process, and the loss of durability is logged', async () => {
    const harness = createHarness();
    // The results directory cannot be created: a file is in its place.
    fs.mkdirSync(harness.stateDir, { recursive: true });
    fs.writeFileSync(path.join(harness.stateDir, SPRITES_RESULTS_DIR), 'not a directory');
    harness.client.behaviors.push({ resultStatus: 'bundle abc', resultBundle: Buffer.from('BUNDLE') });
    const errors: string[] = [];
    const logged = mock.method(logger, 'error', (_fields: unknown, message: string) => { errors.push(message); });
    try {
        const handle = harness.runtime.start(cloneSpec('unwritable'), { timeout: 5000 });
        await handle.wait();
        assert.equal(handle.resultRecoveryLocation(), undefined, 'no durable copy is claimed');
        assert.equal((await handle.readFile(BUNDLE_PATH))?.toString(), 'BUNDLE');
        assert.ok(errors.some(message => message.includes('held in memory only')), errors.join('\n'));
        await handle.release();
        assert.equal(await handle.readFile(BUNDLE_PATH), null);
    } finally {
        logged.mock.restore();
    }
});

test('a failed save leaves no partial directory behind', async () => {
    const { SpritesResultStore } = await import('../packages/core/src/agents/runtime/sprites/spritesResultStore.ts');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-sprites-result-'));
    const store = new SpritesResultStore(root, cloneSpec('partial'));
    // The recovery file cannot be serialised once the bundle is written.
    const stringify = mock.method(JSON, 'stringify', () => { throw new Error('cannot serialise'); });
    try {
        await assert.rejects(store.save(Buffer.from('BUNDLE'), { sprite: SPRITE }), /cannot serialise/);
    } finally {
        stringify.mock.restore();
    }
    assert.equal(store.location, undefined);
    assert.deepEqual(fs.readdirSync(path.join(root, SPRITES_RESULTS_DIR)), []);
    assert.equal(await store.readBundle(), null);
});

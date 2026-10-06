import { after, before, test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

// Parallel workers prepare one shared clone per repository. Another Git process
// briefly holding `.git/config.lock` must neither fail preparation as
// "corruption" nor make it delete and re-clone the shared repository.

const execGit = promisify(execFile);
const OWNER = 'acme';
const REPO = 'widget';
const REPO_URL = `https://github.com/${OWNER}/${REPO}.git`;
const TOKEN = 'ghs_testInstallationToken1234567890';
const LEGACY_URL = `https://x-access-token:${TOKEN}@github.com/${OWNER}/${REPO}.git`;
const FAST_RETRY = { attempts: 3, initialDelayMs: 20, maxDelayMs: 40 };

let rootDir: string;
let clonesDir: string;
let remotePath: string;
const previousEnv: Record<string, string | undefined> = {};

type RepoBranching = typeof import('../packages/core/src/git/repoBranching.js');
type RepoManager = typeof import('../packages/core/src/git/repoManager.js');
type HooklessGit = typeof import('../packages/core/src/git/hooklessGit.js');
let repoBranching: RepoBranching;
let repoManager: RepoManager;
let hooklessGit: HooklessGit;

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execGit('git', args, { cwd });
    return stdout.trim();
}

before(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), 'propr-shared-repo-prep-'));
    clonesDir = path.join(rootDir, 'clones');
    remotePath = path.join(rootDir, 'remote.git');
    const home = path.join(rootDir, 'home');
    await mkdir(home, { recursive: true });
    // Route GitHub URLs to local bare repositories through an isolated HOME;
    // worker Git commands inherit HOME but not GIT_* overrides.
    await writeFile(path.join(home, '.gitconfig'), [
        `[url "file://${rootDir}/github/"]`,
        '\tinsteadOf = https://github.com/',
        '[user]',
        '\temail = test@example.com',
        '\tname = Test User',
        '[init]',
        '\tdefaultBranch = main',
        '',
    ].join('\n'));
    for (const key of ['HOME', 'GIT_CLONES_BASE_PATH', 'XDG_CONFIG_HOME']) previousEnv[key] = process.env[key];
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, '.config');
    process.env.GIT_CLONES_BASE_PATH = clonesDir;

    const seed = path.join(rootDir, 'seed');
    await git(rootDir, ['init', '--bare', remotePath]);
    await git(rootDir, ['init', seed]);
    await writeFile(path.join(seed, 'README.md'), 'base\n');
    await git(seed, ['add', 'README.md']);
    await git(seed, ['commit', '-m', 'base']);
    await git(seed, ['branch', '-M', 'main']);
    await git(seed, ['push', `file://${remotePath}`, 'main']);

    repoBranching = await import('../packages/core/src/git/repoBranching.js');
    repoManager = await import('../packages/core/src/git/repoManager.js');
    hooklessGit = await import('../packages/core/src/git/hooklessGit.js');
});

after(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    await rm(rootDir, { recursive: true, force: true });
});

/** A shared clone at the worker's clone path, with origin set to `originUrl`. */
async function createSharedClone(name: string, originUrl: string): Promise<string> {
    const owner = `${OWNER}-${name}`;
    const clonePath = path.join(clonesDir, owner, REPO);
    await mkdir(path.dirname(clonePath), { recursive: true });
    await mkdir(path.join(rootDir, 'github', owner), { recursive: true });
    await symlink(remotePath, path.join(rootDir, 'github', owner, `${REPO}.git`));
    await git(rootDir, ['clone', `file://${remotePath}`, clonePath]);
    await git(clonePath, ['remote', 'set-url', 'origin', originUrl]);
    return clonePath;
}

function holdConfigLock(clonePath: string): { lockPath: string; releaseAfter: (ms: number) => Promise<void> } {
    const lockPath = path.join(clonePath, '.git', 'config.lock');
    return {
        lockPath,
        releaseAfter: ms => new Promise(resolve => setTimeout(() => { rm(lockPath, { force: true }).then(resolve); }, ms)),
    };
}

async function readLocalConfig(clonePath: string): Promise<string> {
    return readFile(path.join(clonePath, '.git', 'config'), 'utf8');
}

async function advanceRemote(message: string): Promise<string> {
    const writer = path.join(rootDir, `writer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await git(rootDir, ['clone', `file://${remotePath}`, writer]);
    await writeFile(path.join(writer, `${message}.txt`), `${message}\n`);
    await git(writer, ['add', '.']);
    await git(writer, ['commit', '-m', message]);
    await git(writer, ['push', 'origin', 'main']);
    return git(writer, ['rev-parse', 'HEAD']);
}

test('an already-correct origin is not rewritten while another process holds the config lock', async () => {
    const clonePath = await createSharedClone('clean', REPO_URL.replace(OWNER, `${OWNER}-clean`));
    const lock = holdConfigLock(clonePath);
    await writeFile(lock.lockPath, 'held by another worker\n');
    const configBefore = await readLocalConfig(clonePath);

    const repoGit = hooklessGit.createHooklessGit(clonePath);
    await repoBranching.setupAuthenticatedRemote(repoGit, REPO_URL.replace(OWNER, `${OWNER}-clean`), TOKEN, FAST_RETRY);
    // The command still authenticates through its own environment.
    await repoGit.fetch(['origin', '--prune']);

    assert.strictEqual(await readFile(lock.lockPath, 'utf8'), 'held by another worker\n', 'foreign lock must be left alone');
    assert.strictEqual(await readLocalConfig(clonePath), configBefore);
    await rm(lock.lockPath);
});

test('a legacy credential-bearing origin is scrubbed after the lock is released', async () => {
    const clonePath = await createSharedClone('legacy', LEGACY_URL);
    const lock = holdConfigLock(clonePath);
    await writeFile(lock.lockPath, 'held\n');
    const released = lock.releaseAfter(150);

    const repoGit = hooklessGit.createHooklessGit(clonePath);
    await repoBranching.setupAuthenticatedRemote(repoGit, REPO_URL, TOKEN);
    await released;

    assert.strictEqual(await git(clonePath, ['config', '--get-all', 'remote.origin.url']), REPO_URL);
    const config = await readLocalConfig(clonePath);
    assert.ok(!config.includes(TOKEN), 'token must not remain in shared config');
    assert.ok(!config.includes('extraheader'), 'per-command auth must not be persisted');
});

test('persistent config lock contention fails actionably without removing the lock or leaking credentials', async () => {
    const clonePath = await createSharedClone('stuck', LEGACY_URL);
    const lock = holdConfigLock(clonePath);
    await writeFile(lock.lockPath, 'held\n');

    const repoGit = hooklessGit.createHooklessGit(clonePath);
    await assert.rejects(
        repoBranching.setupAuthenticatedRemote(repoGit, REPO_URL, TOKEN, FAST_RETRY),
        (error: Error) => {
            assert.strictEqual(error.name, 'GitLockContentionError');
            assert.match(error.message, /after 3 attempts/);
            assert.match(error.message, /could not lock config file/);
            assert.ok(!error.message.includes(TOKEN));
            return true;
        },
    );
    assert.ok(existsSync(lock.lockPath), 'another process lock must never be removed');
    await rm(lock.lockPath);
});

test('a permanent remote error is reported unchanged and not retried as contention', async () => {
    const clonePath = await createSharedClone('noorigin', REPO_URL);
    await git(clonePath, ['remote', 'remove', 'origin']);
    await assert.rejects(
        repoBranching.setupAuthenticatedRemote(hooklessGit.createHooklessGit(clonePath), REPO_URL, TOKEN, FAST_RETRY),
        (error: Error) => error.name !== 'GitLockContentionError' && /origin/i.test(error.message),
    );
});

test('parallel preparation of a shared clone with active worktrees survives transient config lock contention', async () => {
    const clonePath = await createSharedClone('parallel', LEGACY_URL);
    const owner = `${OWNER}-parallel`;
    const worktreePath = path.join(rootDir, 'parallel-worktree');
    await git(clonePath, ['worktree', 'add', '--no-track', '-b', 'task-1', worktreePath, 'origin/main']);
    await writeFile(path.join(worktreePath, 'in-progress.txt'), 'uncommitted agent work\n');
    const advancedHead = await advanceRemote('parallel-advance');

    const lock = holdConfigLock(clonePath);
    await writeFile(lock.lockPath, 'held\n');
    const released = lock.releaseAfter(250);

    const preparations = Array.from({ length: 4 }, () => repoManager.ensureRepoCloned({
        repoUrl: REPO_URL.replace(OWNER, owner), owner, repoName: REPO, authToken: TOKEN, baseBranch: 'main',
    }));
    const results = await Promise.all(preparations);
    await released;

    assert.deepStrictEqual(results, Array(4).fill(clonePath));
    assert.strictEqual(await readFile(path.join(worktreePath, 'in-progress.txt'), 'utf8'), 'uncommitted agent work\n');
    assert.match(await git(clonePath, ['worktree', 'list']), /parallel-worktree/);
    assert.strictEqual(await git(clonePath, ['rev-parse', 'origin/main']), advancedHead);
    const config = await readLocalConfig(clonePath);
    assert.ok(!config.includes(TOKEN));
    assert.strictEqual(await git(clonePath, ['config', '--get-all', 'remote.origin.url']), REPO_URL.replace(OWNER, owner));
});

test('exhausted contention during preparation fails without corruption cleanup or re-clone', async () => {
    const owner = `${OWNER}-exhausted`;
    const clonePath = await createSharedClone('exhausted', LEGACY_URL);
    const marker = path.join(clonePath, 'user-data.txt');
    await writeFile(marker, 'keep me\n');
    const lock = holdConfigLock(clonePath);
    await writeFile(lock.lockPath, 'held\n');

    await assert.rejects(
        repoManager.ensureRepoCloned({
            repoUrl: REPO_URL.replace(OWNER, owner), owner, repoName: REPO, authToken: TOKEN, baseBranch: 'main', lockRetry: FAST_RETRY,
        }),
        (error: Error) => {
            assert.match(error.message, /stayed locked by another Git process \(not corruption; nothing was removed\)/);
            assert.doesNotMatch(error.message, /is corrupted/);
            assert.ok(!error.message.includes(TOKEN));
            return true;
        },
    );
    assert.strictEqual(await readFile(marker, 'utf8'), 'keep me\n', 'shared clone must not be removed');
    assert.ok(existsSync(lock.lockPath), 'another process lock must never be removed');
    await rm(lock.lockPath);
});

test('concurrent pushes from worktrees do not contend on shared config', async () => {
    const owner = `${OWNER}-push`;
    const repoUrl = REPO_URL.replace(OWNER, owner);
    const clonePath = await createSharedClone('push', repoUrl);
    const worktrees = await Promise.all(['a', 'b', 'c'].map(async name => {
        const worktreePath = path.join(rootDir, `push-worktree-${name}`);
        await git(clonePath, ['worktree', 'add', '--no-track', '-b', `push-${name}`, worktreePath, 'origin/main']);
        await writeFile(path.join(worktreePath, `${name}.txt`), `${name}\n`);
        await git(worktreePath, ['add', '.']);
        await git(worktreePath, ['commit', '-m', `change ${name}`]);
        return { name, worktreePath };
    }));

    const lock = holdConfigLock(clonePath);
    await writeFile(lock.lockPath, 'held\n');
    await Promise.all(worktrees.map(({ name, worktreePath }) =>
        repoBranching.pushBranch(worktreePath, `push-${name}`, { repoUrl, authToken: TOKEN })));
    assert.ok(existsSync(lock.lockPath));
    await rm(lock.lockPath);

    for (const { name, worktreePath } of worktrees) {
        const remoteRef = await git(rootDir, ['ls-remote', `file://${remotePath}`, `refs/heads/push-${name}`]);
        assert.strictEqual(remoteRef.split(/\s+/)[0], await git(worktreePath, ['rev-parse', 'HEAD']));
    }
    assert.ok(!(await readLocalConfig(clonePath)).includes(TOKEN));
});

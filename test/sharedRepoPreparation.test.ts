import { after, before, test } from 'node:test';
import assert from 'node:assert';
import { access, chmod, lchown, lstat, mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
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
type ConfigLock = typeof import('../packages/core/src/git/configLock.js');
let repoBranching: RepoBranching;
let repoManager: RepoManager;
let hooklessGit: HooklessGit;
let configLock: ConfigLock;

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execGit('git', args, { cwd });
    return stdout.trim();
}

/** True when every directory from `dir` up to `/` lets other users traverse it. */
async function traversableByOthers(dir: string): Promise<boolean> {
    try {
        for (let current = await realpath(dir); ; current = path.dirname(current)) {
            if (!((await stat(current)).mode & 0o001)) return false;
            if (current === path.dirname(current)) return true;
        }
    } catch {
        return false;
    }
}

/**
 * Where the fixture root is created. Root runs hand part of the fixture to an
 * unprivileged account, which needs to traverse the base's ancestors; when the
 * configured TMPDIR sits under a private directory a fresh fixture is created
 * in a public temp location instead of relaxing that directory.
 */
async function fixtureBase(): Promise<string> {
    if (process.getuid?.() !== 0) return os.tmpdir();
    for (const candidate of new Set([os.tmpdir(), '/tmp', '/var/tmp', '/dev/shm'])) {
        if (await traversableByOthers(candidate)) return candidate;
    }
    assert.fail(`no temp directory traversable by UID ${UNPRIVILEGED_ID} for the root permission fixtures (TMPDIR=${os.tmpdir()})`);
}

before(async () => {
    rootDir = await mkdtemp(path.join(await fixtureBase(), 'propr-shared-repo-prep-'));
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
    configLock = await import('../packages/core/src/git/configLock.js');
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

for (const reason of ['Permission denied', 'Read-only file system']) {
    test(`a config lock failure caused by "${reason}" is permanent and not retried as contention`, async () => {
        const original = new Error(`error: could not lock config file .git/config: ${reason}\nfatal: could not set 'remote.origin.url' to '${REPO_URL}'`);
        let calls = 0;
        await assert.rejects(
            configLock.withGitLockRetry('updating remote.origin.url', async () => { calls++; throw original; }, FAST_RETRY),
            (error: Error) => error === original,
        );
        assert.strictEqual(calls, 1);
        assert.strictEqual(configLock.isGitLockContentionError(original), false);
    });
}

test('a held config lock ("File exists") is retried as contention', async () => {
    let calls = 0;
    const result = await configLock.withGitLockRetry('updating remote.origin.url', async () => {
        if (++calls < 3) throw new Error('error: could not lock config file /tmp/a: b/.git/config: File exists');
        return 'done';
    }, FAST_RETRY);
    assert.strictEqual(result, 'done');
    assert.strictEqual(calls, 3);
});

// Root bypasses directory permission bits, so under root the owned fixture is
// handed to this unprivileged account and real Git runs as it instead.
const UNPRIVILEGED_ID = 65534;
let unprivilegedGitDir: string | undefined;

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A `git` on PATH that runs the real Git binary as UNPRIVILEGED_ID. */
async function createUnprivilegedGit(): Promise<string> {
    if (unprivilegedGitDir) return unprivilegedGitDir;
    let realGit: string | undefined;
    for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
        const candidate = path.join(dir, 'git');
        if (await access(candidate, constants.X_OK).then(() => true, () => false)) { realGit = candidate; break; }
    }
    assert.ok(realGit, 'git must be on PATH');
    const dir = path.join(rootDir, 'unprivileged-git');
    await mkdir(dir, { recursive: true });
    const runner = path.join(dir, 'run.mjs');
    await writeFile(runner, [
        "import { spawnSync } from 'node:child_process';",
        `const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit', uid: ${UNPRIVILEGED_ID}, gid: ${UNPRIVILEGED_ID} });`,
        'if (result.error) { console.error(result.error.message); process.exit(127); }',
        'process.exit(result.status ?? 1);',
        '',
    ].join('\n'));
    await writeFile(path.join(dir, 'git'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(runner)} "$@"\n`, { mode: 0o755 });
    unprivilegedGitDir = dir;
    return dir;
}

async function chownTree(target: string, id: number): Promise<void> {
    await lchown(target, id, id);
    for (const entry of await readdir(target, { recursive: true })) await lchown(path.join(target, entry), id, id);
}

/**
 * Make the clone's Git directory unwritable so Git cannot create `config.lock`.
 * Under root, the clone is chowned to an unprivileged account and Git runs as
 * that account, so the real permission error is produced on every Linux runner.
 */
async function denyGitDirWrites(clonePath: string): Promise<() => Promise<void>> {
    const gitDir = path.join(clonePath, '.git');
    if (process.getuid?.() !== 0) {
        await chmod(gitDir, 0o555);
        return () => chmod(gitDir, 0o755);
    }
    const gitBin = await createUnprivilegedGit();
    await chownTree(clonePath, UNPRIVILEGED_ID);
    // Under a restrictive umask every fixture directory is private, so let the
    // unprivileged Git traverse (only) this fixture's path to the clone and
    // read the isolated global config. Original modes are restored afterwards.
    const home = process.env.HOME as string;
    const grants: Array<[string, number]> = [[rootDir, 0o001], [home, 0o001], [path.join(home, '.gitconfig'), 0o004]];
    for (let dir = path.dirname(clonePath); dir !== rootDir; dir = path.dirname(dir)) grants.push([dir, 0o001]);
    const originalModes: Array<[string, number]> = [];
    for (const [target, bits] of grants) {
        const mode = (await lstat(target)).mode & 0o7777;
        originalModes.push([target, mode]);
        await chmod(target, mode | bits);
    }
    await chmod(gitDir, 0o555);
    const previousPath = process.env.PATH;
    process.env.PATH = `${gitBin}${path.delimiter}${previousPath ?? ''}`;
    return async () => {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        await chmod(gitDir, 0o755);
        for (const [target, mode] of originalModes.reverse()) await chmod(target, mode);
        await chownTree(clonePath, 0);
    };
}

test('an unwritable shared config fails immediately with the original error, not as lock contention', async () => {
    const clonePath = await createSharedClone('denied', LEGACY_URL);
    const configBefore = await readLocalConfig(clonePath);
    const restore = await denyGitDirWrites(clonePath);
    const started = Date.now();
    try {
        await assert.rejects(
            repoBranching.setupAuthenticatedRemote(hooklessGit.createHooklessGit(clonePath), REPO_URL, TOKEN, { attempts: 3, initialDelayMs: 5000, maxDelayMs: 5000 }),
            (error: Error) => {
                assert.notStrictEqual(error.name, 'GitLockContentionError');
                assert.match(error.message, /could not lock config file [^\n]*config: Permission denied/);
                assert.doesNotMatch(error.message, /failed to stat|unable to access/);
                assert.doesNotMatch(error.message, /another Git process/i);
                assert.ok(!error.message.includes(TOKEN));
                return true;
            },
        );
    } finally {
        await restore();
    }
    assert.ok(Date.now() - started < 5000, 'a permanent failure must not wait for a contention retry');
    assert.ok(!existsSync(path.join(clonePath, '.git', 'config.lock')));
    assert.strictEqual(await readLocalConfig(clonePath), configBefore, 'existing config must be preserved');
});

test('preparation of an unwritable shared clone is not reported as lock contention', async () => {
    const owner = `${OWNER}-readonly`;
    const clonePath = await createSharedClone('readonly', LEGACY_URL);
    const worktreePath = path.join(rootDir, 'readonly-worktree');
    await git(clonePath, ['worktree', 'add', '--no-track', '-b', 'task-ro', worktreePath, 'origin/main']);
    await writeFile(path.join(worktreePath, 'in-progress.txt'), 'uncommitted agent work\n');
    const configBefore = await readLocalConfig(clonePath);
    const restore = await denyGitDirWrites(clonePath);
    const started = Date.now();
    try {
        await assert.rejects(
            repoManager.ensureRepoCloned({
                repoUrl: REPO_URL.replace(OWNER, owner), owner, repoName: REPO, authToken: TOKEN, baseBranch: 'main',
                lockRetry: { attempts: 3, initialDelayMs: 5000, maxDelayMs: 5000 },
            }),
            (error: Error) => {
                assert.doesNotMatch(error.message, /stayed locked by another Git process/);
                // The real config write must be what failed, not an earlier lookup.
                assert.match(error.message, /could not lock config file [^\n]*config: Permission denied/);
                assert.doesNotMatch(error.message, /failed to stat|unable to access/);
                assert.ok(!error.message.includes(TOKEN));
                return true;
            },
        );
    } finally {
        await restore();
    }
    assert.ok(Date.now() - started < 5000, 'a permanent failure must not wait for a contention retry');
    assert.strictEqual(await readFile(path.join(worktreePath, 'in-progress.txt'), 'utf8'), 'uncommitted agent work\n');
    assert.strictEqual(await readLocalConfig(clonePath), configBefore, 'existing config must be preserved');
    assert.ok(existsSync(path.join(clonePath, '.git', 'HEAD')), 'shared clone must not be removed');
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

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs, { mkdtemp, mkdir, writeFile, readFile, rm, access, rename } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import { UnrecoverableError } from 'bullmq';
import { StorageLifecycle } from '../packages/core/src/storage/lifecycle.js';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { RepositoryPreparationBusyError, withRepositoryPreparation } from '../packages/core/src/git/repositoryPreparation.js';

process.env.GIT_SHALLOW_CLONE_DEPTH = '1';
const { ensureWorktreeObjects, fetchWithObjectRecovery, RepositoryRepairRequiredError } =
    await import('../packages/core/src/git/objectRecovery.js');
const { addWorktreeWithoutTracking } = await import('../packages/core/src/git/worktreeCreation.js');

async function fixture(t: TestContext) {
    const root = await mkdtemp(path.join(tmpdir(), 'propr-object-recovery-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const remote = path.join(root, 'remote');
    const clone = path.join(root, 'clone');
    await mkdir(remote);
    const source = simpleGit(remote);
    await source.init(['--initial-branch=main']);
    await source.addConfig('user.name', 'Test');
    await source.addConfig('user.email', 'test@example.com');
    await writeFile(path.join(remote, 'file'), 'original');
    await source.add('.').commit('original');
    await simpleGit().clone(remote, clone, ['--no-hardlinks']);
    const git = simpleGit(clone);
    await git.addConfig('user.name', 'Test');
    await git.addConfig('user.email', 'test@example.com');
    const revision = (await git.revparse(['HEAD'])).trim();
    const tree = (await git.revparse(['HEAD^{tree}'])).trim();
    const blob = (await git.revparse(['HEAD:file'])).trim();
    const removeObject = (id: string) => rm(path.join(clone, '.git', 'objects', id.slice(0, 2), id.slice(2)));
    return { root, remote, clone, git, revision, tree, blob, removeObject };
}

for (const kind of ['tree', 'blob'] as const) {
    test(`repairs a missing ${kind} before adding a worktree; keeps local work and refs`, async t => {
        const f = await fixture(t);
        const existing = path.join(f.root, 'existing');
        await f.git.raw(['worktree', 'add', '-b', 'local-only', existing]);
        const local = simpleGit(existing);
        await writeFile(path.join(existing, 'file'), 'unpublished');
        await local.add('.').commit('local only');
        await writeFile(path.join(existing, 'untracked'), 'keep me');
        const refs = await f.git.raw(['show-ref']);
        const config = await readFile(path.join(f.clone, '.git', 'config'), 'utf8');
        await f.removeObject(f[kind]);
        await assert.rejects(f.git.raw(['rev-list', '--objects', '--missing=error', f.revision]));
        const checkout = path.join(f.root, 'new');
        await addWorktreeWithoutTracking(f.git, checkout, 'task', { startPoint: f.revision });
        assert.equal(await readFile(path.join(checkout, 'file'), 'utf8'), 'original');
        assert.equal(await readFile(path.join(existing, 'file'), 'utf8'), 'unpublished');
        assert.equal(await readFile(path.join(existing, 'untracked'), 'utf8'), 'keep me');
        assert.equal(await readFile(path.join(f.clone, '.git', 'config'), 'utf8'), config);
        assert.equal((await f.git.raw(['show-ref'])).split('\n').filter(line => !line.endsWith(' refs/heads/task')).join('\n'), refs);
        await f.git.raw(['fsck', '--no-dangling']);
        await assert.rejects(access(path.join(f.clone, '.git', 'propr-object-repair-required.json')));
    });
}

test('failed repair is terminal and durable; later preparation does not fetch again', async t => {
    const f = await fixture(t);
    await f.removeObject(f.tree);
    await f.git.remote(['set-url', 'origin', path.join(f.root, 'unavailable')]);
    const checkout = path.join(f.root, 'new');
    await assert.rejects(addWorktreeWithoutTracking(f.git, checkout, 'task', { startPoint: f.revision }), error => {
        assert.ok(error instanceof RepositoryRepairRequiredError);
        assert.ok(error instanceof UnrecoverableError);
        return true;
    });
    await f.git.remote(['set-url', 'origin', f.remote]);
    await assert.rejects(ensureWorktreeObjects(f.git, f.revision), /previous automatic repair failed/);
    await assert.rejects(f.git.raw(['show-ref', '--verify', 'refs/heads/task']));
    await rm(path.join(f.clone, '.git', 'propr-object-repair-required.json'));
    await addWorktreeWithoutTracking(f.git, checkout, 'task', { startPoint: f.revision });
});

test('concurrent preparation serializes and repairs once', async t => {
    const f = await fixture(t);
    await f.removeObject(f.tree);
    await Promise.all(['one', 'two'].map(branch => addWorktreeWithoutTracking(
        simpleGit(f.clone), path.join(f.root, branch), branch, { startPoint: f.revision },
    )));
    assert.equal(await readFile(path.join(f.root, 'one', 'file'), 'utf8'), 'original');
    assert.equal(await readFile(path.join(f.root, 'two', 'file'), 'utf8'), 'original');
});

test('gate covers independent Git instances and allows nested calls', async t => {
    const f = await fixture(t);
    const order: string[] = [];
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const first = withRepositoryPreparation(f.git, async () => {
        order.push('first');
        await withRepositoryPreparation(simpleGit(f.clone), async () => { order.push('nested'); });
        entered();
        await wait;
        order.push('released');
    });
    await ready;
    const second = withRepositoryPreparation(simpleGit(f.clone), async () => { order.push('second'); });
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first', 'nested', 'released', 'second']);
});

test('ordinary invalid refs do not initiate repair', async t => {
    const f = await fixture(t);
    await assert.rejects(ensureWorktreeObjects(f.git, 'absent'));
    await assert.rejects(access(path.join(f.clone, '.git', 'propr-object-repair-required.json')));
});

test('a missing object from an unpublished commit stops without replacing local history', async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.clone, 'file'), 'only local');
    await f.git.add('.').commit('unpublished');
    const tip = (await f.git.revparse(['HEAD'])).trim();
    const tree = (await f.git.revparse(['HEAD^{tree}'])).trim();
    await f.removeObject(tree);
    await assert.rejects(ensureWorktreeObjects(f.git, tip), RepositoryRepairRequiredError);
    assert.equal((await f.git.revparse(['HEAD'])).trim(), tip);
    assert.equal(await readFile(path.join(f.clone, 'file'), 'utf8'), 'only local');
    await assert.rejects(ensureWorktreeObjects(f.git, tip), /previous automatic repair failed/);
});

test('can reuse the branch left by an earlier failed worktree add after repairing objects', async t => {
    const f = await fixture(t);
    await f.removeObject(f.tree);
    const checkout = path.join(f.root, 'new');
    await assert.rejects(f.git.raw(['worktree', 'add', '-b', 'task', checkout, f.revision]), /unable to read tree/);
    assert.equal((await f.git.revparse(['task'])).trim(), f.revision);
    await addWorktreeWithoutTracking(f.git, checkout, 'task', { startPoint: f.revision, resetBranch: true });
    assert.equal(await readFile(path.join(checkout, 'file'), 'utf8'), 'original');
});

for (const appeared of [false, true]) {
    test(`a missing distinct local tip is verified ${appeared ? 'after a branch creation conflict' : 'before reuse'}`, async t => {
        const f = await fixture(t);
        await f.git.checkoutLocalBranch('task');
        await writeFile(path.join(f.clone, 'file'), 'unpublished');
        await f.git.add('.').commit('unpublished');
        const local = (await f.git.revparse(['HEAD'])).trim();
        await f.git.checkout('main');
        const raw = f.git.raw.bind(f.git);
        if (appeared) {
            await f.git.branch(['-D', 'task']);
            t.mock.method(f.git, 'raw', async (args: string[]) => {
                if (args[0] === 'worktree' && args.includes('-b')) {
                    await writeFile(path.join(f.clone, '.git', 'refs', 'heads', 'task'), local + '\n');
                }
                return raw(args);
            });
        }
        await f.removeObject(local);
        await assert.rejects(addWorktreeWithoutTracking(f.git, path.join(f.root, 'new'), 'task', {
            startPoint: f.revision, resetBranch: true, refuseLocalOnlyCommits: true,
        }), RepositoryRepairRequiredError);
        assert.equal((await f.git.revparse(['refs/heads/task'])).trim(), local);
        assert.equal(JSON.parse(await readFile(path.join(f.clone, '.git', 'propr-object-repair-required.json'), 'utf8')).revision, local);
    });
}

test('reuse refuses a ref moved while its pinned tip was being verified', async t => {
    const f = await fixture(t);
    await f.git.checkoutLocalBranch('task');
    await writeFile(path.join(f.clone, 'file'), 'unpublished');
    await f.git.add('.').commit('unpublished');
    const local = (await f.git.revparse(['HEAD'])).trim();
    await f.git.checkout('main');
    const raw = f.git.raw.bind(f.git);
    t.mock.method(f.git, 'raw', async (args: string[]) => {
        const result = await raw(args);
        if (args[0] === 'rev-list' && args.includes('--quiet') && args.includes(local)) {
            await raw(['update-ref', 'refs/heads/task', f.revision, local]);
        }
        return result;
    });
    const checkout = path.join(f.root, 'new');
    await assert.rejects(addWorktreeWithoutTracking(f.git, checkout, 'task', {
        startPoint: f.revision, resetBranch: true,
    }), /changed while preparing/);
    await assert.rejects(access(checkout));
});

test('marker write failure stops automatic recovery before starting a donor', async t => {
    const f = await fixture(t);
    await f.removeObject(f.tree);
    const write = fs.writeFile;
    const mkdtemp = t.mock.method(fs, 'mkdtemp');
    t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof write>) => {
        if (String(args[0]).endsWith('propr-object-repair-required.json')) {
            throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
        }
        return write(...args);
    });
    await assert.rejects(ensureWorktreeObjects(f.git, f.revision), error => {
        assert.ok(error instanceof RepositoryRepairRequiredError);
        assert.match(error.message, /marker could not be recorded; inspect cache permissions or storage/);
        return true;
    });
    assert.equal(mkdtemp.mock.callCount(), 0);
});

function shortGateWait(t: TestContext) {
    const previous = process.env.GIT_REPOSITORY_PREPARATION_WAIT_MS;
    process.env.GIT_REPOSITORY_PREPARATION_WAIT_MS = '1';
    t.after(() => {
        if (previous === undefined) delete process.env.GIT_REPOSITORY_PREPARATION_WAIT_MS;
        else process.env.GIT_REPOSITORY_PREPARATION_WAIT_MS = previous;
    });
}

test('a gate timeout is retryable contention even while a live holder has a repair marker', async t => {
    const f = await fixture(t);
    shortGateWait(t);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const holder = withRepositoryPreparation(f.git, async () => { entered(); await wait; });
    await ready;
    const common = path.join(f.clone, '.git');
    const marker = path.join(common, 'propr-object-repair-required.json');
    try {
        const gate = path.join(common, 'propr-preparation', 'gate');
        const owner = await fs.readdir(gate);
        await assert.rejects(ensureWorktreeObjects(f.git, f.revision), RepositoryPreparationBusyError);
        // The marker is also present throughout a healthy repair by the holder.
        await writeFile(marker, JSON.stringify({ revision: f.revision }));
        await assert.rejects(ensureWorktreeObjects(simpleGit(f.clone), f.revision), error => {
            assert.ok(error instanceof RepositoryPreparationBusyError);
            assert.ok(!(error instanceof UnrecoverableError));
            return true;
        });
        assert.deepEqual(await fs.readdir(gate), owner);
        assert.equal(JSON.parse(await readFile(marker, 'utf8')).revision, f.revision);
    } finally {
        release();
        await holder;
    }
    // Under the acquired gate the same marker is classified against the cache.
    await f.removeObject(f.tree);
    await assert.rejects(ensureWorktreeObjects(f.git, f.revision), error => {
        assert.ok(error instanceof RepositoryRepairRequiredError);
        assert.match(error.message, /previous automatic repair failed or was interrupted/);
        return true;
    });
});

test('the gate wait is configurable and defaults when the setting is unusable', async t => {
    const f = await fixture(t);
    const waits: Array<number | undefined> = [];
    t.mock.method(StorageLifecycle.prototype, 'exclusive', async function <T>(run: () => Promise<T>, waitMs?: number) {
        waits.push(waitMs);
        return run();
    });
    const previous = process.env.GIT_REPOSITORY_PREPARATION_WAIT_MS;
    t.after(() => {
        if (previous === undefined) delete process.env.GIT_REPOSITORY_PREPARATION_WAIT_MS;
        else process.env.GIT_REPOSITORY_PREPARATION_WAIT_MS = previous;
    });
    for (const value of ['', '900000', 'soon', '-5']) {
        process.env.GIT_REPOSITORY_PREPARATION_WAIT_MS = value;
        await withRepositoryPreparation(f.git, async () => undefined);
    }
    assert.deepEqual(waits, [120_000, 900_000, 120_000, 120_000]);
});

test('the gate excludes another process that enters through a linked worktree', async t => {
    const f = await fixture(t);
    shortGateWait(t);
    const linked = path.join(f.root, 'linked');
    await f.git.raw(['worktree', 'add', '-b', 'linked', linked]);
    const child = fork(path.resolve('test/fixtures/repository-preparation/holder.ts'), [linked], {
        execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    t.after(() => { child.kill(); });
    const [message] = await once(child, 'message') as [{ held: string }];
    // The child resolved the gate from the worktree's common directory.
    assert.equal(message.held, await fs.realpath(path.join(f.clone, '.git')));
    const record = path.join(message.held, 'propr-preparation', 'gate');
    const [owner] = await fs.readdir(record);
    assert.ok(!(await readFile(path.join(record, owner), 'utf8')).includes(`"pid":${process.pid},`));
    await assert.rejects(ensureWorktreeObjects(f.git, f.revision), RepositoryPreparationBusyError);
    await assert.rejects(withRepositoryPreparation(simpleGit(linked), async () => undefined), RepositoryPreparationBusyError);

    delete process.env.GIT_REPOSITORY_PREPARATION_WAIT_MS;
    const waiting = ensureWorktreeObjects(f.git, f.revision);
    const exited = once(child, 'exit');
    child.send('release');
    assert.equal(await waiting, f.revision);
    assert.deepEqual(await exited, [0, null]);
});

test('a closure verified under the gate is not walked again during the same hold', async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.clone, 'file'), 'next');
    await f.git.add('.').commit('next');
    const tip = (await f.git.revparse(['HEAD'])).trim();
    const raw = f.git.raw.bind(f.git);
    const walks: string[][] = [];
    t.mock.method(f.git, 'raw', async (args: string[]) => {
        if (args[0] === 'rev-list' && args.includes('--missing=error')) walks.push(args.slice(4));
        return raw(args);
    });
    await withRepositoryPreparation(f.git, async () => {
        await ensureWorktreeObjects(f.git, f.revision);
        await ensureWorktreeObjects(f.git, f.revision);
        await ensureWorktreeObjects(f.git, tip);
    });
    // The second revision stops at the closure already proven in this hold.
    assert.deepEqual(walks, [[f.revision, '--'], [tip, '--not', f.revision, '--']]);
    await f.removeObject(f.tree);
    await ensureWorktreeObjects(f.git, f.revision);
    assert.equal(walks.filter(walk => walk[0] === f.revision).length >= 2, true, 'a new hold verifies again');
    await f.git.raw(['fsck', '--no-dangling']);
});

test('only restoring the marked revision clears the incident and its abandoned donor', async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.clone, 'file'), 'only local');
    await f.git.add('.').commit('unpublished');
    const local = (await f.git.revparse(['HEAD'])).trim();
    const object = path.join(f.clone, '.git', 'objects', local.slice(0, 2), local.slice(2));
    const saved = path.join(f.root, 'saved-object');
    await rename(object, saved);
    await assert.rejects(ensureWorktreeObjects(f.git, local), RepositoryRepairRequiredError);
    const marker = path.join(f.clone, '.git', 'propr-object-repair-required.json');
    const abandoned = path.join(f.clone, '.git', 'propr-object-recovery-Ab1234');
    await mkdir(abandoned);
    await writeFile(path.join(abandoned, 'pack'), 'leftover data');
    await ensureWorktreeObjects(f.git, f.revision);
    await access(marker);
    await access(abandoned);

    await rename(saved, object);
    await ensureWorktreeObjects(f.git, f.revision);
    await assert.rejects(access(marker));
    await assert.rejects(access(abandoned));
    await f.removeObject(f.blob);
    await ensureWorktreeObjects(f.git, f.revision);
});

test('the donor fetch removes HTTPS credentials from its arguments and uses process-local authentication', async t => {
    const f = await fixture(t);
    const token = 'legacy-test-installation-token';
    const home = path.join(f.root, 'home');
    const bin = path.join(f.root, 'bin');
    const trace = path.join(f.root, 'fetch-args');
    await mkdir(home);
    await mkdir(bin);
    const gitBinary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    await writeFile(path.join(home, '.gitconfig'), `[url "file://${f.remote}"]\n\tinsteadOf = https://github.com/test/repo.git\n`);
    await writeFile(path.join(bin, 'git'), `#!/bin/sh
for arg do
    if [ "$arg" = fetch ]; then
        printf '%s\\n' "$@" > "$PROPR_TEST_DONOR_TRACE"
        test "$GIT_CONFIG_KEY_1" = 'http.https://github.com/.extraheader' || exit 79
        test "$GIT_CONFIG_VALUE_1" = 'AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}' || exit 80
        break
    fi
done
exec "${gitBinary}" "$@"
`, { mode: 0o755 });
    const original = { HOME: process.env.HOME, PATH: process.env.PATH, PROPR_TEST_DONOR_TRACE: process.env.PROPR_TEST_DONOR_TRACE };
    t.after(() => {
        for (const [name, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
    process.env.HOME = home;
    process.env.PATH = `${bin}${path.delimiter}${original.PATH}`;
    process.env.PROPR_TEST_DONOR_TRACE = trace;
    await f.git.remote(['set-url', 'origin', `https://x-access-token:${token}@github.com/test/repo.git`]);
    await f.removeObject(f.tree);
    let fetches = 0;
    await fetchWithObjectRecovery(f.git, async () => {
        if (++fetches === 1) throw new Error('fatal: unresolved deltas left after unpacking');
    }, 'main', token);

    assert.equal(fetches, 2);
    const args = await readFile(trace, 'utf8');
    assert.ok(args.split('\n').includes('https://github.com/test/repo.git'));
    assert.ok(!args.includes(token));
});

test('the donor accepts historical trees that strict fsck rejects', async t => {
    const f = await fixture(t);
    const remote = simpleGit(f.remote);
    const serializedTree = path.join(f.root, 'historical-tree');
    await writeFile(serializedTree, Buffer.concat([Buffer.from('0100644 file\0'), Buffer.from(f.blob, 'hex')]));
    const tree = (await remote.raw(['hash-object', '--literally', '-w', '-t', 'tree', serializedTree])).trim();
    const revision = (await remote.raw(['commit-tree', tree, '-p', f.revision, '-m', 'Historical tree'])).trim();
    await remote.raw(['update-ref', 'refs/heads/main', revision]);
    await assert.rejects(remote.raw(['fsck', '--strict', '--no-dangling']), /zeroPaddedFilemode/);
    // A local clone copies loose objects, so the malformed tree can be removed independently.
    const clone = path.join(f.root, 'historical');
    await simpleGit().clone(f.remote, clone, ['--no-hardlinks']);
    await rm(path.join(clone, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
    assert.equal(await ensureWorktreeObjects(simpleGit(clone), revision), revision);
});

test('shallow recovery fetches through an advanced tip to the live boundary without importing older history', async t => {
    const f = await fixture(t);
    const remote = simpleGit(f.remote);
    await writeFile(path.join(f.remote, 'file'), 'shallow boundary');
    await remote.add('.').commit('boundary');
    const boundary = (await remote.revparse(['HEAD'])).trim();
    const missingBlob = (await remote.revparse(['HEAD:file'])).trim();
    await writeFile(path.join(f.remote, 'file'), 'advanced tip');
    await remote.add('.').commit('advance after shallow clone');
    const tip = (await remote.revparse(['HEAD'])).trim();

    // Keep loose objects so the fixture can remove a specific blob below the tip.
    const clone = path.join(f.root, 'shallow');
    await simpleGit().clone(f.remote, clone, ['--no-hardlinks']);
    await writeFile(path.join(clone, '.git', 'shallow'), boundary + '\n');
    for (const oid of [f.revision, missingBlob]) {
        await rm(path.join(clone, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
    }

    const git = simpleGit(clone);
    await ensureWorktreeObjects(git, tip);
    assert.equal(await git.raw(['show', `${boundary}:file`]), 'shallow boundary');
    assert.equal((await git.raw(['rev-list', '--count', tip])).trim(), '2');
    assert.equal(await readFile(path.join(clone, '.git', 'shallow'), 'utf8'), boundary + '\n');
    await assert.rejects(git.raw(['cat-file', '-t', f.revision]));
});

test('evidence for an old incident does not clear a replacement marker', async t => {
    const f = await fixture(t);
    const marker = path.join(f.clone, '.git', 'propr-object-repair-required.json');
    await writeFile(marker, JSON.stringify({ revision: f.revision, startedAt: 'earlier' }));
    await writeFile(path.join(f.clone, 'file'), 'another revision');
    await f.git.add('.').commit('another revision');
    const tip = (await f.git.revparse(['HEAD'])).trim();
    const replacement = JSON.stringify({ revision: tip, startedAt: 'later' });
    const raw = f.git.raw.bind(f.git);
    t.mock.method(f.git, 'raw', async (args: string[]) => {
        const result = await raw(args);
        if (args[0] === 'rev-list' && args.includes(f.revision)) {
            await writeFile(marker, replacement);
        }
        return result;
    });

    await ensureWorktreeObjects(f.git, tip);
    assert.equal(await readFile(marker, 'utf8'), replacement);
});

test('reuse repairs a missing published local tip before fast-forwarding it', async t => {
    const f = await fixture(t);
    await f.git.branch(['task', f.revision]);
    const remote = simpleGit(f.remote);
    await writeFile(path.join(f.remote, 'file'), 'published update');
    await remote.add('.').commit('published update');
    await f.git.fetch('origin');
    const tip = (await f.git.revparse(['origin/main'])).trim();
    await f.removeObject(f.revision);

    const checkout = path.join(f.root, 'new');
    await addWorktreeWithoutTracking(f.git, checkout, 'task', {
        startPoint: tip, resetBranch: true, refuseLocalOnlyCommits: true,
    });
    assert.equal(await readFile(path.join(checkout, 'file'), 'utf8'), 'published update');
    assert.equal((await f.git.revparse(['refs/heads/task'])).trim(), tip);
});

/** Publish a commit on `branch` in the remote, fetch it, and return its ID. */
async function publish(f: Awaited<ReturnType<typeof fixture>>, branch: string, content: string): Promise<string> {
    const remote = simpleGit(f.remote);
    await remote.raw(['checkout', '-B', branch, 'main']);
    await writeFile(path.join(f.remote, 'file'), content);
    await remote.add('.').commit(content);
    const tip = (await remote.revparse(['HEAD'])).trim();
    await remote.checkout('main');
    await f.git.fetch('origin');
    return tip;
}

/** Give the next ordinary fetch something to connect to the cached refs. */
async function advanceRemote(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
    const remote = simpleGit(f.remote);
    await writeFile(path.join(f.remote, 'file'), `advanced ${Date.now()}`);
    await remote.add('.').commit('advance main');
    return (await remote.revparse(['HEAD'])).trim();
}

const fetchMain = (f: Awaited<ReturnType<typeof fixture>>) =>
    () => f.git.raw(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
const markerPath = (f: Awaited<ReturnType<typeof fixture>>) => path.join(f.clone, '.git', 'propr-object-repair-required.json');

for (const diagnostic of ['named by Git', 'found by the ref scan'] as const) {
    test(`fetch recovery repairs a missing tip commit of a ref other than the fetched branch (${diagnostic})`, async t => {
        const f = await fixture(t);
        const other = await publish(f, 'other', 'other branch');
        const advanced = await advanceRemote(f);
        await f.removeObject(other);
        const listed = await f.git.raw(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes/origin/other']);
        assert.equal(listed.trim(), `${other} refs/remotes/origin/other`, 'ref listing must show a ref whose tip object is absent');
        await assert.rejects(fetchMain(f)(), /bad object refs\/remotes\/origin\/other/);

        let fetches = 0;
        await fetchWithObjectRecovery(f.git, async () => {
            // Some failures do not name a ref; the scan alone must then find the tip.
            if (++fetches === 1 && diagnostic === 'found by the ref scan') throw new Error('error: remote did not send all necessary objects');
            return fetchMain(f)();
        }, 'main');
        assert.equal(fetches, 2);
        assert.equal((await f.git.revparse(['origin/main'])).trim(), advanced);
        assert.equal((await f.git.raw(['cat-file', '-t', other])).trim(), 'commit');
        await assert.rejects(access(markerPath(f)));
        await f.git.raw(['fsck', '--no-dangling']);
    });
}

for (const published of [true, false]) {
    test(`fetch recovery inspects a superseded-tip backup ref whose ${published ? 'published tip is restored' : 'unpublished tip is retained for manual recovery'}`, async t => {
        const f = await fixture(t);
        let tip: string;
        if (published) {
            tip = await publish(f, 'task', 'published task work');
            await f.git.raw(['update-ref', '-d', 'refs/remotes/origin/task']);
        } else {
            await f.git.checkoutLocalBranch('task');
            await writeFile(path.join(f.clone, 'file'), 'unpublished task work');
            await f.git.add('.').commit('unpublished');
            tip = (await f.git.revparse(['HEAD'])).trim();
            await f.git.checkout('main');
            await f.git.branch(['-D', 'task']);
        }
        // The backup is now the only ref naming the tip.
        const backup = 'refs/propr/superseded/task/20260101T000000Z-' + tip.slice(0, 12);
        await f.git.raw(['update-ref', backup, tip]);
        const advanced = await advanceRemote(f);
        await f.removeObject(tip);
        await assert.rejects(fetchMain(f)(), /bad object refs\/propr\/superseded\//);
        const donors = t.mock.method(fs, 'mkdtemp');

        const recovery = () => fetchWithObjectRecovery(f.git, fetchMain(f), 'main');
        if (published) {
            await recovery();
            assert.equal((await f.git.revparse(['origin/main'])).trim(), advanced);
            await assert.rejects(access(markerPath(f)));
            await f.git.raw(['fsck', '--no-dangling']);
        } else {
            await assert.rejects(recovery(), error => {
                assert.ok(error instanceof RepositoryRepairRequiredError);
                assert.ok(error.message.includes(`ref '${backup}'`), error.message);
                return true;
            });
            assert.equal(JSON.parse(await readFile(markerPath(f), 'utf8')).revision, tip);
            // Later attempts stop at the marker without another donor.
            await assert.rejects(recovery(), /previous automatic repair failed or was interrupted/);
        }
        assert.equal(donors.mock.callCount(), 1);
        assert.equal((await f.git.raw(['rev-parse', '--verify', backup])).trim(), tip);
    });
}

test('fetch recovery restores an annotated tag object whose target commit is intact', async t => {
    const f = await fixture(t);
    await simpleGit(f.remote).raw(['tag', '-a', 'v1', '-m', 'release', f.revision]);
    await f.git.fetch(['origin', '--tags']);
    const tag = (await f.git.raw(['rev-parse', '--verify', 'refs/tags/v1'])).trim();
    assert.equal((await f.git.raw(['cat-file', '-t', tag])).trim(), 'tag');
    const advanced = await advanceRemote(f);
    await f.removeObject(tag);
    assert.equal((await f.git.raw(['cat-file', '-t', f.revision])).trim(), 'commit');
    await assert.rejects(fetchMain(f)(), /bad object refs\/tags\/v1/);

    await fetchWithObjectRecovery(f.git, fetchMain(f), 'main');
    assert.equal((await f.git.revparse(['origin/main'])).trim(), advanced);
    assert.equal((await f.git.raw(['cat-file', '-t', tag])).trim(), 'tag');
    assert.equal((await f.git.raw(['rev-parse', '--verify', 'refs/tags/v1'])).trim(), tag);
    // The donor's temporary ref never reaches the live clone.
    assert.equal((await f.git.raw(['for-each-ref', 'refs/propr'])).trim(), '');
    await assert.rejects(access(markerPath(f)));
    await f.git.raw(['fsck', '--no-dangling']);
});

test('a second damaged ref left after the one repair is recorded and stops without another donor', async t => {
    const f = await fixture(t);
    const tips = [await publish(f, 'first', 'first branch'), await publish(f, 'second', 'second branch')];
    const advanced = await advanceRemote(f);
    for (const tip of tips) await f.removeObject(tip);
    const donors = t.mock.method(fs, 'mkdtemp');
    const present = async (tip: string) => f.git.raw(['cat-file', '-t', tip]).then(() => true, () => false);

    let fetches = 0;
    const recovery = () => fetchWithObjectRecovery(f.git, () => { fetches++; return fetchMain(f)(); }, 'main');
    await assert.rejects(recovery(), error => {
        assert.ok(error instanceof RepositoryRepairRequiredError);
        assert.ok(error instanceof UnrecoverableError);
        assert.match(error.message, /objects are still missing after the one automatic repair restored another ref/);
        return true;
    });
    assert.equal(fetches, 2);
    assert.equal(donors.mock.callCount(), 1);
    const restored = await Promise.all(tips.map(present));
    assert.deepEqual([...restored].sort(), [false, true]);
    const unresolved = tips[restored.indexOf(false)];
    assert.equal(JSON.parse(await readFile(markerPath(f), 'utf8')).revision, unresolved);

    // The recorded incident blocks every later automatic attempt.
    await assert.rejects(recovery(), /previous automatic repair failed or was interrupted/);
    assert.equal(donors.mock.callCount(), 1);

    // Removing the marker authorizes exactly one more attempt, which completes the repair.
    await rm(markerPath(f));
    await recovery();
    assert.equal(donors.mock.callCount(), 2);
    assert.equal((await f.git.revparse(['origin/main'])).trim(), advanced);
    await assert.rejects(access(markerPath(f)));
    await f.git.raw(['fsck', '--no-dangling']);
});

test('an unrelated failure of the retried fetch keeps its ordinary handling', async t => {
    const f = await fixture(t);
    await f.removeObject(f.tree);
    let fetches = 0;
    await assert.rejects(fetchWithObjectRecovery(f.git, async () => {
        throw new Error(++fetches === 1 ? 'fatal: unresolved deltas left after unpacking' : 'fatal: unable to access remote: timed out');
    }, 'main'), error => {
        assert.ok(!(error instanceof RepositoryRepairRequiredError));
        assert.match((error as Error).message, /timed out/);
        return true;
    });
    assert.equal(fetches, 2);
    await assert.rejects(access(markerPath(f)));
});

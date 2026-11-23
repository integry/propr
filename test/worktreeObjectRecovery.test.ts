import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs, { mkdtemp, mkdir, writeFile, readFile, rm, access, rename } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import { UnrecoverableError } from 'bullmq';
import { StorageLifecycle } from '../packages/core/src/storage/lifecycle.js';
import { execFileSync } from 'node:child_process';
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

test('a contended gate reports its repair marker read-only and keeps its owner', async t => {
    const f = await fixture(t);
    const exclusive = StorageLifecycle.prototype.exclusive;
    t.mock.method(StorageLifecycle.prototype, 'exclusive', function <T>(this: StorageLifecycle, run: () => Promise<T>) {
        return exclusive.call(this, run, 0);
    });
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const holder = withRepositoryPreparation(f.git, async () => { entered(); await wait; });
    await ready;
    try {
        const common = path.join(f.clone, '.git');
        const gate = path.join(common, 'propr-preparation', 'gate');
        const owner = await fs.readdir(gate);
        const marker = path.join(common, 'propr-object-repair-required.json');
        await assert.rejects(ensureWorktreeObjects(f.git, f.revision), RepositoryPreparationBusyError);
        await writeFile(marker, JSON.stringify({ revision: f.revision }));
        await assert.rejects(ensureWorktreeObjects(f.git, f.revision), error => {
            assert.ok(error instanceof RepositoryRepairRequiredError);
            assert.match(error.message, /inspect the gate owner/);
            return true;
        });
        assert.deepEqual(await fs.readdir(gate), owner);
        assert.equal(JSON.parse(await readFile(marker, 'utf8')).revision, f.revision);
    } finally {
        release();
        await holder;
    }
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

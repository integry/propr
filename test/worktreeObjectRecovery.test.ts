import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import { UnrecoverableError } from 'bullmq';
import { addWorktreeWithoutTracking } from '../packages/core/src/git/worktreeCreation.js';
import { ensureWorktreeObjects, RepositoryRepairRequiredError } from '../packages/core/src/git/objectRecovery.js';
import { withRepositoryPreparation } from '../packages/core/src/git/repositoryPreparation.js';

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

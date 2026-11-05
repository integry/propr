import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StorageLifecycle } from '../src/storage/lifecycle.js';
import { GeneratedPayloadStorage } from '../src/storage/generatedPayloads.js';
import { InstanceStorageService } from '../src/storage/service.js';
const exec = promisify(execFile);
const signal = () => new AbortController().signal;
function isNamespacePermissionDenied(error: unknown): boolean {
  const failure = error as { code?: number | string; stderr?: string; signal?: string };
  // unshare can be denied before Node starts, during namespace creation or
  // uid_map setup. Match only complete diagnostics so loader errors and
  // assertion failures remain hard failures.
  return failure.code === 1 && !failure.signal
    && /^unshare: (?:unshare failed|write failed \/proc\/self\/uid_map): (?:Operation not permitted|Permission denied)\n?$/.test(failure.stderr ?? '');
}
test('namespace skips require an explicit outer unshare permission denial', () => {
  for (const diagnostic of ['write failed /proc/self/uid_map', 'unshare failed']) {
    const stderr = `unshare: ${diagnostic}: Operation not permitted\n`;
    assert.equal(isNamespacePermissionDenied({ code: 1, stderr }), true);
    assert.equal(isNamespacePermissionDenied({ code: 1, stderr: stderr.trimEnd() }), true);
    assert.equal(isNamespacePermissionDenied({ code: 1, stderr: stderr.replace('Operation not permitted', 'Permission denied') }), true);
    for (const failure of [
      { code: 0, stderr },
      { code: 2, stderr },
      { code: 32, stderr },
      { code: 'ENOENT', stderr },
      { code: 'EACCES', stderr },
      { code: 'EPERM', stderr },
      { code: 1, stderr, signal: 'SIGTERM' },
      { code: 1, stderr: '' },
      { code: 1, stderr: 'unshare: write failed /proc/self/gid_map: Operation not permitted\n' },
      { code: 1, stderr: stderr.replace('Operation not permitted', 'Invalid argument') },
      { code: 1, stderr: 'unshare: unshare failed: Invalid argument\n' },
      { code: 1, stderr: 'unshare: failed to execute node: Permission denied\n' },
      { code: 32, stderr: 'mount: permission denied\n' },
      { code: 1, stderr: 'Error [ERR_MODULE_NOT_FOUND]: Cannot find package tsx\n' },
      { code: 1, stderr: 'AssertionError [ERR_ASSERTION]: Operation not permitted\n' },
      { code: 1, stderr: `AssertionError [ERR_ASSERTION]\n${stderr}` },
      { code: 1, stderr: `${stderr}Error [ERR_MODULE_NOT_FOUND]: Cannot find package tsx\n` },
      { code: 1, stderr: `${stderr}AssertionError [ERR_ASSERTION]\n` },
      { code: 1, stderr: `${stderr}\n` },
    ]) assert.equal(isNamespacePermissionDenied(failure), false, JSON.stringify(failure));
  }
});
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-generated-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worktrees = path.join(root, 'worktrees');
  const worktree = path.join(worktrees, 'customer');
  await fs.mkdir(worktree, { recursive: true });
  const git = async (...args: string[]) => (await exec('git', ['-C', worktree, ...args])).stdout;
  await git('init'); await git('config', 'user.email', 'fixture@example.test'); await git('config', 'user.name', 'Fixture');
  await fs.writeFile(path.join(worktree, 'customer.txt'), 'customer data');
  await fs.writeFile(path.join(worktree, '.gitignore'), 'private/\nnode_modules/\n');
  await git('add', '.'); await git('commit', '-m', 'fixture');
  const remote = path.join(root, 'remote.git');
  await exec('git', ['init', '--bare', remote]); await git('remote', 'add', 'origin', remote); await git('push', 'origin', 'HEAD');
  const lifecycle = new StorageLifecycle(path.join(root, 'barrier'));
  const storageRoot = path.join(root, 'control');
  const payloads = new GeneratedPayloadStorage(worktrees, storageRoot, lifecycle);
  const service = new InstanceStorageService({ lifecycle, storageRoot, clonesRoot: path.join(root, 'clones'), roots: [{ category: 'worktrees', path: worktrees }], hasPendingTasks: async () => pending });
  let pending = false;
  const id = await service.initialize();
  const age = async (hours = 25) => fs.writeFile(path.join(lifecycle.root, 'last-use'), String(Date.now() - hours * 3_600_000));
  const generate = async () => {
    await payloads.generate(worktree, 'node_modules', 'fixture public dependency regenerated from lockfile', async directory => {
      await fs.mkdir(path.join(directory, 'dependency'));
      await fs.writeFile(path.join(directory, 'dependency', 'index.js'), 'generated dependency');
    });
    await payloads.complete(worktree, true); await age();
  };
  return { root, worktree, worktrees, lifecycle, payloads, service, id, git, age, generate, pending: (value: boolean) => { pending = value; } };
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string, prefix = '') => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!prefix && entry.name === 'node_modules') continue;
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
      else result[relative] = (await fs.readFile(path.join(directory, entry.name))).toString('hex');
    }
  };
  await visit(root); return result;
}
for (const state of ['clean-published', 'detached', 'dirty', 'ignored-private', 'stashed', 'unpublished', 'salvage-retained']) {
  test(`generated cleanup preserves byte-identical Git/private state: ${state}`, async t => {
    const f = await fixture(t); await f.generate();
    if (state === 'detached') await f.git('checkout', '--detach');
    if (state === 'dirty') { await fs.writeFile(path.join(f.worktree, 'customer.txt'), 'staged private'); await f.git('add', 'customer.txt'); await fs.writeFile(path.join(f.worktree, 'untracked'), 'private'); }
    if (state === 'ignored-private') { await fs.mkdir(path.join(f.worktree, 'private')); await fs.writeFile(path.join(f.worktree, 'private', 'secret'), 'private canary'); }
    if (state === 'stashed') { await fs.writeFile(path.join(f.worktree, 'customer.txt'), 'stash canary'); await f.git('stash'); }
    if (state === 'unpublished') await f.git('commit', '--allow-empty', '-m', 'unpublished');
    if (state === 'salvage-retained') { await f.git('update-ref', 'refs/propr/rescue/fixture', 'HEAD'); await f.payloads.complete(f.worktree, false); }
    const before = await snapshot(f.worktree);
    await f.service.updatePolicy(f.id, { enabled: true, idleHours: 24 }, 'operator');
    const preview = await f.service.preview(f.id, ['worktrees'], 'operator');
    const result = await f.service.execute(f.id, preview.confirmation, 'operator');
    assert.deepEqual(await snapshot(f.worktree), before);
    assert.equal(result.deleted.length, state === 'salvage-retained' ? 0 : 1);
    if (state !== 'salvage-retained') assert.deepEqual(await fs.readdir(path.join(f.worktree, 'node_modules')), []);
    assert.ok(result.retained.some(value => value.id === 'worktrees-coverage'));
  });
}
test('opt-in, actual use clock, pending/failed/recovery authority, and read claim race', async t => {
  const f = await fixture(t); await f.generate();
  let preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  assert.equal(preview.candidates.filter(c => !c.protectedReasons.length).length, 0);
  await f.service.updatePolicy(f.id, { enabled: true, idleHours: 1 }, 'operator');
  await f.age(23);
  preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  assert.ok(preview.candidates.some(c => c.protectedReasons.includes('recent_use')));
  await f.age();
  f.pending(true);
  preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  assert.ok(preview.candidates.some(c => c.protectedReasons.includes('busy')));
  f.pending(false);
  preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  await f.lifecycle.use(async () => {});
  const changed = await f.service.execute(f.id, preview.confirmation, 'operator');
  assert.equal(changed.deleted.length, 0);
  await f.age();
  await fs.writeFile(path.join(f.lifecycle.root, 'readers', 'abandoned-read'), '');
  preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  assert.ok(preview.candidates.some(c => c.protectedReasons.includes('busy')));
});
for (const mutation of ['private-edit', 'symlink', 'parent-symlink', 'hardlink', 'corrupt']) {
  test(`fails closed: ${mutation}`, async t => {
    const f = await fixture(t); await f.generate();
    const target = path.join(f.worktree, 'node_modules', 'dependency', 'index.js');
    const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'canary'), 'outside');
    if (mutation === 'private-edit') await fs.writeFile(target, 'private data');
    if (mutation === 'symlink') { await fs.unlink(target); await fs.symlink(path.join(outside, 'canary'), target); }
    if (mutation === 'hardlink') { await fs.unlink(target); await fs.link(path.join(outside, 'canary'), target); }
    if (mutation === 'parent-symlink') { await fs.rename(path.join(f.worktree, 'node_modules'), path.join(outside, 'node_modules')); await fs.symlink(path.join(outside, 'node_modules'), path.join(f.worktree, 'node_modules')); }
    if (mutation === 'corrupt') await fs.writeFile(path.join(f.worktree, '.git', 'HEAD'), 'broken');
    await f.service.updatePolicy(f.id, { enabled: true, idleHours: 24 }, 'operator');
    const preview = await f.service.preview(f.id, ['worktrees'], 'operator');
    const result = await f.service.execute(f.id, preview.confirmation, 'operator');
    assert.equal(result.deleted.length, 0);
    assert.equal(await fs.readFile(path.join(outside, 'canary'), 'utf8'), 'outside');
  });
}
test('fresh proof after preview protects added private data; consumed retries are rejected', async t => {
  const f = await fixture(t); await f.generate();
  await f.service.updatePolicy(f.id, { enabled: true, idleHours: 24 }, 'operator');
  const preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  await fs.writeFile(path.join(f.worktree, 'node_modules', 'private'), 'private');
  const result = await f.service.execute(f.id, preview.confirmation, 'operator');
  assert.equal(result.deleted.length, 0);
  await assert.rejects(f.service.execute(f.id, preview.confirmation, 'operator'));
  assert.equal((await f.service.result(f.id, preview.confirmation, 'operator')).state, 'completed');
  assert.ok((await f.service.usage()).generatedPayloads);
});
test('producer refuses adoption, path escape, tracked payloads and unknown names', async t => {
  const f = await fixture(t); await f.generate();
  await assert.rejects(f.payloads.generate(f.worktree, 'node_modules', 'regenerate', async () => {}), { code: 'EEXIST' });
  await assert.rejects(f.payloads.generate(f.root, 'node_modules', 'regenerate', async () => {}));
  await assert.rejects(f.payloads.generate(f.worktree, '../private' as never, 'regenerate', async () => {}));
  await f.git('add', '-f', 'node_modules/dependency/index.js'); await f.age();
  const candidates = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  assert.ok(candidates.some(c => c.protectedReasons.includes('private_work')));
});
test('bounded batches and pressure admission preserve reserve and release rejected claims', async t => {
  const f = await fixture(t); await f.generate();
  const records = path.join(f.root, 'control', 'generated-payloads');
  for (let i = 0; i < 30; i++) await fs.writeFile(path.join(records, `unknown-${i}.json`), '{}');
  const candidates = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  assert.ok(candidates.length <= 10);
  await assert.rejects(f.lifecycle.use(async () => assert.fail('must not start'), { filesystem: f.worktrees, reserveBytes: Number.MAX_SAFE_INTEGER - 1024, taskBytes: 1024 }), /disk pressure/);
  assert.deepEqual(await fs.readdir(path.join(f.lifecycle.root, 'readers')), []);
  await f.lifecycle.use(async () => {}, { filesystem: f.worktrees, reserveBytes: 1, taskBytes: 1 });
});
test('live lifecycle reader and queued admission cannot race execute', async t => {
  const f = await fixture(t); await f.generate();
  await f.service.updatePolicy(f.id, { enabled: true, idleHours: 24 }, 'operator');
  const preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  let reader: Promise<void> | undefined;
  let readerStarted = false;
  const result = await f.service.execute(f.id, preview.confirmation, 'operator', async () => {
    reader ??= f.lifecycle.use(async () => { readerStarted = true; await fs.writeFile(path.join(f.worktree, 'node_modules', 'private'), 'read claim private canary'); });
    // use() publishes intent asynchronously before waiting at the gate.
    for (let i = 0; i < 100 && !await f.lifecycle.busy(); i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(readerStarted, false);
  });
  await reader;
  assert.equal(result.deleted.length, 0);
  assert.equal(await fs.readFile(path.join(f.worktree, 'node_modules', 'private'), 'utf8'), 'read claim private canary');
});
test('real linked, detached worktree registration survives generated cleanup', async t => {
  const f = await fixture(t);
  const linked = path.join(f.worktrees, 'linked');
  await f.git('worktree', 'add', '--detach', linked, 'HEAD');
  await f.payloads.generate(linked, '.propr/test-cache', 'refetchable fixture test output', async directory => fs.writeFile(path.join(directory, 'result'), 'generated'));
  await f.payloads.complete(linked, true); await f.age();
  const before = await snapshot(f.worktree);
  const registration = await fs.readFile(path.join(linked, '.git'), 'utf8');
  await f.service.updatePolicy(f.id, { enabled: true, idleHours: 24 }, 'operator');
  const preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  const result = await f.service.execute(f.id, preview.confirmation, 'operator');
  assert.equal(result.deleted.length, 1);
  assert.equal(await fs.readFile(path.join(linked, '.git'), 'utf8'), registration);
  assert.deepEqual(await snapshot(f.worktree), before);
});
test('aborted cleanup retains payload and durable record for fresh protected retry', async t => {
  const f = await fixture(t); await f.generate();
  const candidates = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await f.lifecycle.cleanup(() => f.payloads.remove(candidates[0].id, controller.signal)), ['busy']);
  assert.equal(await fs.readFile(path.join(f.worktree, 'node_modules', 'dependency', 'index.js'), 'utf8'), 'generated dependency');
  const retry = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  assert.equal(retry[0].protectedReasons.length, 0);
});
test('entry, byte and time budgets fail closed', async t => {
  const f = await fixture(t); await f.generate();
  assert.throws(() => new GeneratedPayloadStorage(f.worktrees, path.join(f.root, 'control'), f.lifecycle, { maxEntries: NaN }), /Invalid/);
  for (const limits of [{ maxEntries: 1 }, { maxBytes: 1 }, { maxMs: 0 }]) {
    const bounded = new GeneratedPayloadStorage(f.worktrees, path.join(f.root, 'control'), f.lifecycle, limits);
    const candidates = await f.lifecycle.cleanup(s => bounded.preview(false, 24, s));
    assert.equal(candidates.filter(c => !c.protectedReasons.length).length, 0);
    assert.equal(await fs.readFile(path.join(f.worktree, 'node_modules', 'dependency', 'index.js'), 'utf8'), 'generated dependency');
  }
});
test('partial interruption is truthful and retries protect remaining state', async t => {
  const f = await fixture(t); await f.generate();
  const candidates = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  const controller = new AbortController();
  const original = fs.unlink.bind(fs);
  t.mock.method(fs, 'unlink', async (target: Parameters<typeof fs.unlink>[0]) => {
    await original(target);
    if (String(target).endsWith('/index.js')) controller.abort();
  });
  const retained = await f.lifecycle.cleanup(() => f.payloads.remove(candidates[0].id, controller.signal));
  assert.deepEqual(retained, ['busy', 'partial_generated_cleanup']);
  assert.ok((await fs.readdir(path.join(f.root, 'control', 'generated-payloads'))).some(name => name === `${candidates[0].id}.json`));
  const retry = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  assert.ok(retry[0].protectedReasons.includes('private_work'));
  assert.equal(await fs.readFile(path.join(f.worktree, 'customer.txt'), 'utf8'), 'customer data');
});
test('real same-device bind mount is rejected in an isolated mount namespace', async t => {
  const f = await fixture(t); await f.generate();
  const outside = path.join(f.root, 'mount-source'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'canary'), 'outside');
  const source = path.resolve('packages/core/src/storage/generatedPayloads.ts');
  const lifecycleSource = path.resolve('packages/core/src/storage/lifecycle.ts');
  const program = `
    import { execFileSync } from 'node:child_process';
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { GeneratedPayloadStorage } from ${JSON.stringify(source)};
    import { StorageLifecycle } from ${JSON.stringify(lifecycleSource)};
    // Decide capability in the same process that runs the assertions. Only
    // environmental mount denial gets the reserved skip exit code.
    try {
      execFileSync('mount', ['--bind', ${JSON.stringify(outside)}, ${JSON.stringify(path.join(f.worktree, 'node_modules', 'dependency'))}], { env: { ...process.env, LC_ALL: 'C' } });
    } catch (error) {
      const spawnDenied = (error.code === 'EACCES' || error.code === 'EPERM')
        && error.syscall === 'spawnSync mount' && error.path === 'mount';
      const mountDenied = error.status === 32
        && /permission denied|operation not permitted/i.test(error.stderr?.toString() ?? '');
      if (spawnDenied || mountDenied) process.exit(77);
      throw error;
    }
    const lifecycle = new StorageLifecycle(${JSON.stringify(f.lifecycle.root)});
    const storage = new GeneratedPayloadStorage(${JSON.stringify(f.worktrees)}, ${JSON.stringify(path.join(f.root, 'control'))}, lifecycle);
    const candidates = await lifecycle.cleanup(signal => storage.preview(false, 24, signal));
    assert.ok(candidates.some(candidate => candidate.protectedReasons.includes('unsafe_path')));
    assert.equal(await fs.readFile(${JSON.stringify(path.join(outside, 'canary'))}, 'utf8'), 'outside');
  `;
  try {
    await exec('unshare', ['--user', '--map-root-user', '--mount', process.execPath, '--import', 'tsx', '--input-type=module', '-e', program], { env: { ...process.env, LC_ALL: 'C' } });
  } catch (error) {
    if ((error as { code?: number }).code !== 77 && !isNamespacePermissionDenied(error)) throw error;
    t.skip('Requires a bind mount in an isolated user/mount namespace; no host mounts are changed');
  }
});
test('missing/corrupt/future use clocks and old mtimes cannot authorize cleanup', async t => {
  const f = await fixture(t); await f.generate();
  const target = path.join(f.worktree, 'node_modules');
  await fs.utimes(target, new Date(0), new Date(0));
  await f.age(23);
  let candidates = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  assert.ok(candidates[0].protectedReasons.includes('recent_use'));
  for (const clock of ['', 'corrupt', String(Date.now() + 3_600_000)]) {
    await fs.writeFile(path.join(f.lifecycle.root, 'last-use'), clock);
    candidates = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
    assert.ok(candidates[0].protectedReasons.includes('unknown_use'));
  }
  await fs.unlink(path.join(f.lifecycle.root, 'last-use'));
  candidates = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  assert.ok(candidates[0].protectedReasons.includes('unknown_use'));
});
test('policy withdrawal after preview prevents manual execution', async t => {
  const f = await fixture(t); await f.generate();
  await f.service.updatePolicy(f.id, { enabled: true, idleHours: 24 }, 'operator');
  const preview = await f.service.preview(f.id, ['worktrees'], 'operator');
  await f.service.updatePolicy(f.id, { enabled: false, idleHours: 24 }, 'operator');
  const result = await f.service.execute(f.id, preview.confirmation, 'operator');
  assert.equal(result.deleted.length, 0);
  assert.ok(result.retained.some(candidate => candidate.reasons.includes('unsupported')));
});

test('trusted producer can regenerate an owned cleaned root across durable cleanup cycles', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.worktree);
  await f.service.updatePolicy(f.id, { enabled: true, idleHours: 24 }, 'operator');
  for (let cycle = 0; cycle < 2; cycle++) {
    await f.payloads.generate(f.worktree, 'node_modules', 'fixture public dependency', async directory => {
      await fs.mkdir(path.join(directory, 'dependency'));
      await fs.writeFile(path.join(directory, 'dependency', 'index.js'), 'generated dependency');
    });
    await f.payloads.complete(f.worktree, true); await f.age();
    const preview = await f.service.preview(f.id, ['worktrees'], 'operator');
    const result = await f.service.execute(f.id, preview.confirmation, 'operator');
    assert.equal(result.deleted.length, 1);
    assert.deepEqual(await fs.readdir(path.join(f.worktree, 'node_modules')), []);
    assert.deepEqual(await snapshot(f.worktree), before);
    // A new instance must recognize the durable tombstone, without offering it
    // as another deletion or relying on process-local state.
    const restarted = new GeneratedPayloadStorage(f.worktrees, path.join(f.root, 'control'), f.lifecycle);
    assert.deepEqual(await f.lifecycle.cleanup(s => restarted.preview(false, 24, s)), []);
    f.payloads = restarted;
  }
});
for (const mutation of ['private-file', 'replacement', 'unknown-empty', 'failed-regeneration']) {
  test(`cleaned-root regeneration protects ${mutation}`, async t => {
    const f = await fixture(t); await f.generate();
    const [candidate] = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
    assert.deepEqual(await f.lifecycle.cleanup(s => f.payloads.remove(candidate.id, s)), []);
    const directory = path.join(f.worktree, 'node_modules');
    if (mutation === 'private-file') await fs.writeFile(path.join(directory, 'private'), 'private canary');
    if (mutation === 'replacement') {
      // Keep the owned inode alive so the filesystem cannot reuse it.
      await fs.rename(directory, `${directory}-owned`); await fs.mkdir(directory);
    }
    if (mutation === 'unknown-empty') await fs.unlink(path.join(f.root, 'control', 'generated-payloads', `${candidate.id}.json`));
    if (mutation === 'failed-regeneration') {
      await assert.rejects(f.payloads.generate(f.worktree, 'node_modules', 'regenerate', async () => { throw new Error('producer failed'); }), /producer failed/);
      await f.payloads.complete(f.worktree, true); await f.age();
      const restarted = new GeneratedPayloadStorage(f.worktrees, path.join(f.root, 'control'), f.lifecycle);
      const protectedCandidates = await f.lifecycle.cleanup(s => restarted.preview(false, 24, s));
      assert.ok(protectedCandidates[0].protectedReasons.includes('busy'));
      assert.deepEqual(await f.lifecycle.cleanup(s => restarted.remove(candidate.id, s)), ['busy']);
    }
    await assert.rejects(f.payloads.generate(f.worktree, 'node_modules', 'regenerate', async () => assert.fail('must not adopt')));
    if (mutation === 'private-file') assert.equal(await fs.readFile(path.join(directory, 'private'), 'utf8'), 'private canary');
  });
}

test('cleaned-root claim excludes a second trusted producer while regeneration runs', async t => {
  const f = await fixture(t); await f.generate();
  const [candidate] = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  assert.deepEqual(await f.lifecycle.cleanup(s => f.payloads.remove(candidate.id, s)), []);
  let release!: () => void;
  let started!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const production = f.payloads.generate(f.worktree, 'node_modules', 'regenerate', async directory => {
    started(); await wait;
    await fs.writeFile(path.join(directory, 'dependency'), 'generated');
  });
  await ready;
  try {
    await assert.rejects(f.payloads.generate(f.worktree, 'node_modules', 'competing', async () => assert.fail('claim already consumed')), { code: 'EEXIST' });
  } finally { release(); await production; }
  await f.payloads.complete(f.worktree, true); await f.age();
  assert.deepEqual(await f.lifecycle.cleanup(s => f.payloads.remove(candidate.id, s)), []);
});
test('replacement during trusted regeneration never registers the replacement payload', async t => {
  const f = await fixture(t); await f.generate();
  const [candidate] = await f.lifecycle.cleanup(s => f.payloads.preview(false, 24, s));
  assert.deepEqual(await f.lifecycle.cleanup(s => f.payloads.remove(candidate.id, s)), []);
  const original = path.join(f.worktree, 'node_modules');
  await assert.rejects(f.payloads.generate(f.worktree, 'node_modules', 'regenerate', async directory => {
    await fs.rename(original, `${original}-owned`); await fs.mkdir(original);
    await fs.writeFile(path.join(original, 'private'), 'private canary');
    await fs.writeFile(path.join(directory, 'dependency'), 'generated');
  }), /unsafe_path/);
  await f.payloads.complete(f.worktree, true); await f.age();
  assert.deepEqual(await f.lifecycle.cleanup(s => f.payloads.remove(candidate.id, s)), ['busy']);
  assert.equal(await fs.readFile(path.join(original, 'private'), 'utf8'), 'private canary');
});

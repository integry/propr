import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { auditRepository, repositoryIdentity, repositoryMetadataFingerprint } from '../src/storage/repositorySafety.js';
import { StorageLifecycle } from '../src/storage/lifecycle.js';
import { observeStorage } from '../src/storage/observation.js';
import { InstanceStorageService } from '../src/storage/service.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Storage Test', GIT_AUTHOR_EMAIL: 'storage@example.invalid', GIT_COMMITTER_NAME: 'Storage Test', GIT_COMMITTER_EMAIL: 'storage@example.invalid' } })).stdout;
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const clone = path.join(root, 'clone');
  await git(root, 'init', '--bare', remote);
  await git(root, 'clone', remote, clone);
  await fs.writeFile(path.join(clone, 'public'), 'published sentinel');
  await git(clone, 'add', '.'); await git(clone, 'commit', '-m', 'public'); await git(clone, 'push', 'origin', 'HEAD');
  const identity = await repositoryIdentity(clone);
  const audit = () => auditRepository(clone, identity, `file://${remote}`, { allowTestFileRemote: true });
  return { root, clone, remote, audit };
}

test('clean pushed cache has current remote proof and can be refetched', async t => {
  const f = await fixture(t);
  const result = await f.audit();
  assert.deepEqual(result.reasons, []);
  assert.ok(result.bytes! > 0); assert.ok(result.fingerprint);
  await fs.rm(f.clone, { recursive: true });
  await git(f.root, 'clone', f.remote, f.clone);
  assert.equal(await fs.readFile(path.join(f.clone, 'public'), 'utf8'), 'published sentinel');
});
for (const state of ['dirty', 'staged', 'untracked', 'ignored', 'unpublished', 'detached', 'stash', 'worktree', 'remote_missing', 'remote_diverged', 'symlink', 'alternate', 'dangling'] as const) {
  test(`retains ${state} and the unique sentinel`, async t => {
    const f = await fixture(t);
    const sentinel = path.join(f.clone, 'private');
    switch (state) {
      case 'dirty': await fs.appendFile(path.join(f.clone, 'public'), 'private sentinel'); break;
      case 'staged': await fs.writeFile(sentinel, 'private sentinel'); await git(f.clone, 'add', 'private'); break;
      case 'untracked': await fs.writeFile(sentinel, 'private sentinel'); break;
      case 'ignored': await fs.appendFile(path.join(f.clone, '.git/info/exclude'), '\nprivate\n'); await fs.writeFile(sentinel, 'private sentinel'); break;
      case 'unpublished': case 'detached': case 'dangling':
        if (state === 'detached') await git(f.clone, 'checkout', '--detach');
        await fs.writeFile(sentinel, 'private sentinel'); await git(f.clone, 'add', 'private'); await git(f.clone, 'commit', '-m', 'private');
        if (state === 'dangling') await git(f.clone, 'reset', '--hard', 'HEAD~1');
        break;
      case 'stash': await fs.appendFile(path.join(f.clone, 'public'), 'private sentinel'); await git(f.clone, 'stash'); break;
      case 'worktree': await git(f.clone, 'worktree', 'add', '--detach', path.join(f.root, 'worktree')); break;
      case 'remote_missing': await fs.rename(f.remote, `${f.remote}.offline`); break;
      case 'remote_diverged': await git(f.remote, 'update-ref', '-d', 'refs/heads/master'); break;
      case 'symlink': await fs.symlink(f.remote, path.join(f.clone, 'private')); break;
      case 'alternate': await fs.writeFile(path.join(f.clone, '.git/objects/info/alternates'), `${f.remote}/objects\n`); break;
    }
    const before = await fs.readdir(f.clone);
    assert.ok((await f.audit()).reasons.length > 0);
    assert.deepEqual(await fs.readdir(f.clone), before);
  });
}

test('filesystem scan deduplicates hard links and never follows a symlink', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-scan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'one'), 'private sentinel');
  await fs.link(path.join(root, 'one'), path.join(root, 'two'));
  await fs.symlink('/etc', path.join(root, 'outside'));
  const result = await observeStorage('fixture', [{ category: 'repository_caches', path: root }]);
  const expected = (await fs.stat(root)).blocks * 512 + (await fs.stat(path.join(root, 'one'))).blocks * 512;
  assert.equal(result.ownedBytes, expected);
  assert.equal(result.state, 'partial');
  assert.ok(!JSON.stringify(result).includes(root));
  assert.ok(result.filesystems[0].totalBytes > result.ownedBytes!);
  const bounded = await observeStorage('fixture', [{ category: 'repository_caches', path: root }], { maxEntries: 1 });
  assert.equal(bounded.categories[0].state, 'partial');
});

test('real cross-instance lifecycle barrier covers active use, resets clock and retains abandoned claims', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = new StorageLifecycle(root); const b = new StorageLifecycle(root);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = a.use(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  await started;
  assert.equal(await b.exclusive(() => b.busy()), true);
  const first = await b.lastUse();
  release(); await pending;
  assert.equal(await b.exclusive(() => b.busy()), false);
  assert.ok((await b.lastUse())! >= first!);
  await fs.writeFile(path.join(root, 'readers', 'abandoned'), '');
  assert.equal(await new StorageLifecycle(root).exclusive(() => b.busy()), true);
});

test('policy defaults persist; confirmation is instance/actor bound and single use', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-service-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const services = { lifecycle: new StorageLifecycle(root), clonesRoot: path.join(root, 'clones'), roots: [], hasPendingTasks: async () => false };
  const service = new InstanceStorageService(services);
  const id = await service.initialize();
  assert.deepEqual(await service.policy(), { enabled: false, idleHours: 24 });
  await service.updatePolicy(id, { enabled: true, idleHours: 24 }, 'admin');
  assert.deepEqual(await new InstanceStorageService(services).policy(), { enabled: true, idleHours: 24 });
  await assert.rejects(service.preview('other-instance', ['repository_caches'], 'admin'));
  const preview = await service.preview(id, ['worktrees'], 'admin');
  await assert.rejects(service.execute(id, preview.confirmation, 'other-admin'));
  const result = await service.execute(id, preview.confirmation, 'admin');
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.retained[0].reasons, ['unsupported']);
  await assert.rejects(service.execute(id, preview.confirmation, 'admin'));
  assert.deepEqual(await service.result(id, preview.confirmation, 'admin'), result);
  const expired = await service.preview(id, ['repository_caches'], 'admin');
  const previewFile = path.join(root, `preview-${expired.confirmation}.json`);
  const saved = JSON.parse(await fs.readFile(previewFile, 'utf8'));
  saved.preview.expiresAt = 'unknown';
  await fs.writeFile(previewFile, JSON.stringify(saved));
  await assert.rejects(service.execute(id, expired.confirmation, 'admin'));
  const concurrent = await service.preview(id, ['repository_caches'], 'admin');
  const attempts = await Promise.allSettled([
    service.execute(id, concurrent.confirmation, 'admin'),
    service.execute(id, concurrent.confirmation, 'admin'),
  ]);
  assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(attempt => attempt.status === 'rejected').length, 1);

});

async function serviceFixture(t: test.TestContext, proof?: typeof auditRepository) {
  const f = await fixture(t);
  const clones = path.join(f.root, 'clones');
  await fs.mkdir(path.join(clones, 'owner'), { recursive: true });
  const clone = path.join(clones, 'owner', 'repo');
  await fs.rename(f.clone, clone);
  const { createHash } = await import('node:crypto');
  const id = createHash('sha256').update('owner/repo').digest('hex');
  const control = path.join(f.root, '.clones-storage-lifecycle');
  const lifecycle = new StorageLifecycle(control);
  let pending = false;
  const service = new InstanceStorageService({
    lifecycle, clonesRoot: clones, roots: [], hasPendingTasks: async () => pending,
    auditRepository: (directory, identity, _remote, options) => (proof ?? auditRepository)(directory, identity, `file://${f.remote}`, { ...options, allowTestFileRemote: true }),
  });
  const instanceId = await service.initialize();
  await fs.mkdir(path.join(control, 'repositories'));
  await fs.writeFile(path.join(control, 'repositories', `${id}.json`), JSON.stringify({ id, owner: 'owner', name: 'repo', identity: await repositoryIdentity(clone), metadataFingerprint: await repositoryMetadataFingerprint(clone) }));
  return { ...f, clone, control, id, instanceId, lifecycle, service, setPending: (value: boolean) => { pending = value; } };
}

test('actual cleanup engine removes only the confirmed pushed cache and it refetches', async t => {
  const f = await serviceFixture(t);
  const preview = await f.service.preview(f.instanceId, ['repository_caches'], 'admin');
  assert.deepEqual(preview.candidates[0].protectedReasons, []);
  const result = await f.service.execute(f.instanceId, preview.confirmation, 'admin');
  assert.deepEqual(result.deleted, [f.id]);
  await assert.rejects(fs.stat(f.clone));
  await git(f.root, 'clone', f.remote, f.clone);
  assert.equal(await fs.readFile(path.join(f.clone, 'public'), 'utf8'), 'published sentinel');
});

for (const change of ['private_work', 'reuse', 'queued', 'swap', 'restart', 'policy'] as const) {
  test(`confirmation revalidation protects ${change}`, async t => {
    const f = await serviceFixture(t);
    const preview = await f.service.preview(f.instanceId, ['repository_caches'], change === 'policy' ? 'automatic' : 'admin');
    if (change === 'private_work') await fs.writeFile(path.join(f.clone, 'unique'), 'private sentinel');
    if (change === 'reuse') await f.lifecycle.use(async () => undefined);
    if (change === 'queued') f.setPending(true);
    if (change === 'swap') { await fs.rename(f.clone, `${f.clone}-safe`); await fs.symlink(f.remote, f.clone); }
    if (change === 'restart') {
      await new InstanceStorageService({ lifecycle: new StorageLifecycle(f.control), clonesRoot: path.dirname(path.dirname(f.clone)), roots: [], hasPendingTasks: async () => false }).initialize();
    }
    if (change === 'policy') {
      await assert.rejects(f.service.execute(f.instanceId, preview.confirmation, 'automatic'));
    } else {
      const result = await f.service.execute(f.instanceId, preview.confirmation, 'admin');
      assert.deepEqual(result.deleted, []);
      assert.ok(result.retained[0].reasons.length);
    }
    assert.ok(await fs.lstat(f.clone));
    if (change === 'private_work') assert.equal(await fs.readFile(path.join(f.clone, 'unique'), 'utf8'), 'private sentinel');
  });
}

test('automatic cleanup is disabled by default, uses actual-use clock, and removes an idle pushed cache after opt-in', async t => {
  const f = await serviceFixture(t);
  const old = Date.now() - 25 * 3_600_000;
  await fs.writeFile(path.join(f.control, 'last-use'), String(old));
  await f.service.sweep();
  assert.ok(await fs.stat(f.clone));
  await f.service.updatePolicy(f.instanceId, { enabled: true, idleHours: 24 }, 'admin');
  await f.lifecycle.use(async () => undefined);
  await f.service.sweep();
  assert.ok(await fs.stat(f.clone));
  await fs.writeFile(path.join(f.control, 'last-use'), String(old));
  await f.service.sweep();
  await assert.rejects(fs.stat(f.clone));
});

test('private history selection uses a real transactional task domain and protects changed/active tasks', async t => {
  const { default: knex } = await import('knex');
  const { taskHistoryControl } = await import('../src/storage/taskHistoryControl.js');
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  t.after(() => database.destroy());
  await database.schema.createTable('tasks', table => { table.string('task_id').primary(); });
  await database.schema.createTable('task_history', table => { table.increments('history_id'); table.string('task_id'); table.string('state'); });
  await database.schema.createTable('llm_executions', table => { table.increments('execution_id'); table.string('task_id'); table.string('end_time'); });
  await database.schema.createTable('llm_execution_details', table => { table.integer('execution_id'); table.text('output'); });
  await database.schema.createTable('task_assignees', table => { table.string('task_id'); });
  await database('tasks').insert([{ task_id: 'finished' }, { task_id: 'active' }]);
  await database('task_history').insert([{ task_id: 'finished', state: 'completed' }, { task_id: 'active', state: 'processing' }]);
  await database('llm_executions').insert({ execution_id: 1, task_id: 'finished', end_time: new Date().toISOString() });
  await database('llm_execution_details').insert({ execution_id: 1, output: 'private sentinel' });
  const control = taskHistoryControl(database);
  const [finished, active] = await control.inspect(['finished', 'active']);
  assert.deepEqual(active.candidate.protectedReasons, ['busy']);
  assert.ok(finished.fingerprint);
  await database('task_history').insert({ task_id: 'finished', state: 'recovering' });
  assert.equal(await control.erase('finished', finished.fingerprint!), false);
  assert.equal((await database('llm_execution_details').first()).output, 'private sentinel');
  await database('task_history').insert({ task_id: 'finished', state: 'completed' });
  const [updated] = await control.inspect(['finished']);
  assert.equal(await control.erase('finished', updated.fingerprint!), true);
  assert.equal((await database('llm_execution_details')).length, 0);
  assert.ok(await database('tasks').where({ task_id: 'active' }).first());
});

test('exclusive barrier blocks repository use in another process until deletion releases it', async t => {
  const { spawn } = await import('node:child_process');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-process-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lifecycle = new StorageLifecycle(root);
  const marker = path.join(root, 'started');
  let completed!: Promise<void>;
  await lifecycle.exclusive(async () => {
    // Keep paths as data rather than interpolating them into executable source.
    const source = `
      import fs from 'node:fs/promises';
      const [lifecycleUrl, root, marker] = process.argv.slice(1);
      const { StorageLifecycle } = await import(lifecycleUrl);
      console.log('ready');
      await new StorageLifecycle(root).use(() => fs.writeFile(marker, 'used'));
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, '--', new URL('../src/storage/lifecycle.ts', import.meta.url).href, root, marker], { stdio: ['ignore', 'pipe', 'pipe'] });
    completed = new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`child exited ${code}`))); });
    await new Promise<void>(resolve => child.stdout.once('data', () => resolve()));
    await new Promise(resolve => setTimeout(resolve, 100));
    await assert.rejects(fs.stat(marker));
  });
  await completed;
  assert.equal(await fs.readFile(marker, 'utf8'), 'used');
});

test('Git safety proof never executes repository hooks, filters or filesystem monitors', async t => {
  const f = await fixture(t);
  const marker = path.join(f.root, 'executed');
  await git(f.clone, 'config', 'core.fsmonitor', `touch ${marker}`);
  assert.ok((await f.audit()).reasons.length);
  await assert.rejects(fs.stat(marker));
  await git(f.clone, 'config', '--unset', 'core.fsmonitor');
  await git(f.clone, 'config', 'filter.private.clean', `touch ${marker}`);
  await fs.writeFile(path.join(f.clone, '.gitattributes'), '* filter=private');
  assert.ok((await f.audit()).reasons.length);
  await assert.rejects(fs.stat(marker));
});

test('unawaited nested repository work keeps its claim after the parent returns', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-nested-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lifecycle = new StorageLifecycle(root);
  let release!: () => void;
  let nested!: Promise<void>;
  await lifecycle.use(async () => {
    nested = lifecycle.use(() => new Promise<void>(resolve => { release = resolve; }));
  });
  assert.equal(await lifecycle.exclusive(() => lifecycle.busy()), true);
  release(); await nested;
  assert.equal(await lifecycle.exclusive(() => lifecycle.busy()), false);
});

// Exercise the production producer and worker wrappers in another process, with
// real Redis/BullMQ jobs. No lifecycle or queue mocks participate in admission.
for (const phase of ['preview', 'execute', 'quarantine'] as const) {
  for (const admission of ['producer', 'worker'] as const) {
    test(`slow ${phase} proof yields to real ${admission} admission in another process`, { timeout: 30_000 }, async t => {
      const { spawn, spawnSync } = await import('node:child_process');
      const binary = process.env.PROPR_TEST_REDIS_SERVER || 'redis-server';
      const localRedis = spawnSync(binary, ['--version']).status === 0;
      if (!localRedis && !process.env.REDIS_PORT) { t.skip('Requires redis-server or CI REDIS_PORT'); return; }
      const { createServer } = await import('node:net');
      let slow = false;
      let entered!: () => void;
      const proving = new Promise<void>(resolve => { entered = resolve; });
      let cancelled = false;
      // Accept TCP but stall the TLS handshake: real git ls-remote would wait
      // beyond the former admission deadline, without contacting any service.
      const sockets = new Set<import('node:net').Socket>();
      const remoteServer = createServer(socket => {
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.on('close', () => sockets.delete(socket));
        socket.setTimeout(11_000, () => socket.destroy());
        entered();
      });
      await new Promise<void>(resolve => remoteServer.listen(0, '127.0.0.1', resolve));
      const remotePort = (remoteServer.address() as import('node:net').AddressInfo).port;
      t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => remoteServer.close(() => resolve()));
      });
      const f = await serviceFixture(t, async (directory, identity, remote, options) => {
        if (slow && (phase !== 'quarantine' || directory.includes('.cleanup-'))) {
          const result = await auditRepository(directory, identity, `https://127.0.0.1:${remotePort}/repo.git`, options);
          cancelled = result.reasons.includes('busy');
          return result;
        }
        return auditRepository(directory, identity, remote, options);
      });
      const reservation = createServer();
      await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
      let port = (reservation.address() as import('node:net').AddressInfo).port;
      await new Promise<void>(resolve => reservation.close(() => resolve()));
      if (localRedis) {
        const redis = spawn(binary, ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'pipe'] });
        t.after(() => { redis.kill(); });
        await new Promise<void>((resolve, reject) => {
          redis.on('error', reject);
          redis.stdout.on('data', data => { if (String(data).includes('Ready to accept connections')) resolve(); });
          redis.on('exit', code => reject(new Error(`Redis exited ${code}`)));
        });
      } else { port = Number(process.env.REDIS_PORT); }
      const source = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs/promises';
        const [queueUrl, admission, clone] = process.argv.slice(2);
        const { getIssueQueue, createWorker, shutdownQueue, GITHUB_ISSUE_QUEUE_NAME } = await import(queueUrl);
        const queue = await getIssueQueue();
        let job;
        if (admission === 'worker') job = await queue.add('storage-contention', {}, { attempts: 1 });
        process.send('ready');
        await new Promise(resolve => process.once('message', resolve));
        const worker = await createWorker(GITHUB_ISSUE_QUEUE_NAME, async () => {
          assert.equal(await fs.readFile(clone + '/public', 'utf8'), 'published sentinel');
          return { success: true };
        }, { autorun: false });
        // Metrics are unrelated to this integration and have their own connections.
        worker.removeAllListeners('completed');
        worker.removeAllListeners('failed');
        const completed = new Promise((resolve, reject) => {
          worker.once('completed', resolve); worker.once('failed', (_job, error) => reject(error)); worker.once('error', reject);
        });
        if (admission === 'producer') job = await queue.add('storage-contention', {}, { attempts: 1 });
        void worker.run();
        await completed;
        const stored = await queue.getJob(job.id);
        assert.equal(await stored.getState(), 'completed');
        assert.equal(stored.attemptsMade, 1);
        assert.equal(await queue.getFailedCount(), 0);
        await worker.close();
        await queue.obliterate();
        await shutdownQueue();
        process.disconnect();
      `;
      const script = path.join(f.root, 'admission.mjs');
      await fs.writeFile(script, source);
      const child = spawn(process.execPath, ['--import', 'tsx', script, new URL('../src/queue/taskQueue.ts', import.meta.url).href, admission, f.clone], {
        env: { ...process.env, REDIS_HOST: localRedis ? '127.0.0.1' : process.env.REDIS_HOST || '127.0.0.1', REDIS_PORT: String(port), GIT_CLONES_BASE_PATH: path.join(f.root, 'clones'), GITHUB_ISSUE_QUEUE_NAME: `storage-${path.basename(f.root)}-${phase}-${admission}`, LOG_LEVEL: 'silent' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      t.after(() => { child.kill(); });
      let stderr = '';
      child.stderr.on('data', data => { stderr += data; });
      const exited = new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Admission child exited ${code}: ${stderr}`)));
      });
      // Handle early startup failure while awaiting the handshake too.
      await Promise.race([new Promise(resolve => child.once('message', resolve)), exited.then(() => { throw new Error('Child exited before ready'); })]);
      const preview = phase === 'preview' ? undefined : await f.service.preview(f.instanceId, ['repository_caches'], 'admin');
      slow = true;
      const cleanup = phase === 'preview'
        ? f.service.preview(f.instanceId, ['repository_caches'], 'admin')
        : f.service.execute(f.instanceId, preview!.confirmation, 'admin');
      await proving;
      const start = Date.now();
      child.send('admit');
      const [result] = await Promise.all([cleanup, exited]);
      assert.equal(cancelled, true, 'waiting admission cancels optional proof');
      assert.ok(Date.now() - start < 8_000, 'admission completes before the former 10-second failure deadline');
      if ('deleted' in result) { assert.deepEqual(result.deleted, []); assert.deepEqual(result.retained[0].reasons, ['busy']); }
      else assert.deepEqual(result.candidates[0].protectedReasons, ['busy']);
      assert.equal(await fs.readFile(path.join(f.clone, 'public'), 'utf8'), 'published sentinel');
      assert.deepEqual(await fs.readdir(path.join(f.control, 'readers')), []);
    });
  }
}

test('admission waits past the former deadline without stealing an exclusive gate', { timeout: 20_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-long-gate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = new StorageLifecycle(root);
  const b = new StorageLifecycle(root);
  let ran = false;
  let admission!: Promise<void>;
  await a.exclusive(async () => {
    admission = b.use(async () => { ran = true; });
    await new Promise(resolve => setTimeout(resolve, 11_000));
    assert.equal(ran, false);
    assert.equal(await a.busy(), true);
  });
  await admission;
  assert.equal(ran, true);
  assert.equal(await a.busy(), false);
});

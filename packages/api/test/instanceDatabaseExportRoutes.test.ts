import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import knex from 'knex';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { auditRepository, repositoryIdentity, repositoryMetadataFingerprint } from '../../core/src/storage/repositorySafety.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { InstanceStorageService } from '../../core/src/storage/service.js';
import { StorageLifecycle } from '../../core/src/storage/lifecycle.js';
import { STORAGE_INSTANCE_CHANGED_CODE } from '@propr/shared';

test('self-hosted admin without Connect/Fleet completes inventory, cleanup and real export; fresh authority and binding are enforced', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-storage-api-'));
  Object.assign(process.env, { DB_FILENAME: path.join(root, 'fixture.sqlite'), PROPR_DEMO_MODE: 'false', PROPR_ADMIN_USERS: '',
    PROPR_GH_RELAY_URL: 'https://unused.invalid/v1', PROPR_GH_RELAY_TOKEN: 'isolated-test-only' });
  delete process.env.PROPR_CONNECT_URL; delete process.env.PROPR_FLEET_SECRET;
  const { createInstanceStorageRoutes } = await import('../routes/instanceStorageRoutes.js');
  const { resolveInstanceAuthorization } = await import('../authorization.js');
  const { createStorageRouteEntries } = await import('../instanceStorageRouteRegistry.js');
  const { registerRouteEntries } = await import('../routeRegistry.js');
  const { closeConnection } = await import('@propr/core');
  const database = knex({ client: 'better-sqlite3', connection: { filename: path.join(root, 'customer.sqlite') }, useNullAsDefault: true });
  await database.schema.createTable('instance_members', table => { table.string('github_user_id').primary(); table.string('role'); table.string('source'); });
  await database('instance_members').insert([{ github_user_id: 'admin', role: 'admin', source: 'local' }, { github_user_id: 'other', role: 'admin', source: 'local' }, { github_user_id: 'member', role: 'member', source: 'local' }]);
  await database.schema.createTable('customer', table => { table.string('body'); });
  await database('customer').insert({ body: 'preserved customer data' });
  const clones = path.join(root, 'clones'); const clone = path.join(clones, 'sample', 'project');
  const remote = path.join(root, 'remote.git');
  await fs.mkdir(path.dirname(clone), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
  git('init', '--bare', remote); git('clone', remote, clone);
  await fs.writeFile(path.join(clone, 'customer.txt'), 'recoverable cache');
  git('-C', clone, 'add', '.'); git('-C', clone, 'commit', '-m', 'fixture'); git('-C', clone, 'push', 'origin', 'HEAD');
  const service = new InstanceStorageService({ databaseFile: path.join(root, 'customer.sqlite'), lifecycle: new StorageLifecycle(path.join(root, 'control')), clonesRoot: clones, roots: [], hasPendingTasks: async () => false,
    auditRepository: (directory, identity, _remote, options) => auditRepository(directory, identity, `file://${remote}`, { ...options, allowTestFileRemote: true }),
  });
  await service.initialize();
  const repositoryId = createHash('sha256').update('sample/project').digest('hex');
  await fs.mkdir(path.join(root, 'control', 'repositories'));
  await fs.writeFile(path.join(root, 'control', 'repositories', `${repositoryId}.json`), JSON.stringify({ id: repositoryId, owner: 'sample', name: 'project', identity: await repositoryIdentity(clone), metadataFingerprint: await repositoryMetadataFingerprint(clone) }));
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    const actor = req.get('x-actor');
    if (actor) req.user = { id: actor, username: actor } as typeof req.user;
    // Deliberately stale request authority: routes must re-resolve it from the DB.
    req.authorization = { role: 'admin', permissions: ['instance.manage_settings'], source: 'local' }; next();
  });
  registerRouteEntries(app, createStorageRouteEntries(createInstanceStorageRoutes(service, user => resolveInstanceAuthorization(user, database))));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await database.destroy(); await closeConnection(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/instance/storage/v1`;
  const call = (route: string, body?: unknown, actor = 'admin') => fetch(base + route, { headers: { 'x-actor': actor, 'Content-Type': 'application/json', 'X-ProPR-Storage': '1' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  for (const actor of ['member', 'assigned-user', 'connect-owner']) assert.equal((await call('/capabilities', undefined, actor)).status, 403);
  for (const actor of ['member', 'assigned-user', 'connect-owner']) {
    for (const [route, body] of [['/repositories', undefined], ['/exports', {}], ['/exports/opaque-id', undefined], ['/exports/opaque-id/download', {}], ['/exports/opaque-id/cancel', {}], ['/cleanup/preview', {}], ['/cleanup/execute', {}]] as const) {
      assert.equal((await call(route, body, actor)).status, 403, `${actor}: ${route}`);
    }
  }
  const capabilities = await (await call('/capabilities')).json();
  assert.ok(capabilities.features.includes('database_export'));
  const inventory = await (await call('/repositories')).json();
  assert.equal(inventory.repositories[0].name, 'sample/project');
  assert.ok(inventory.repositories[0].estimatedBytes > 0);
  const preview = await (await call('/cleanup/preview', { instanceId: capabilities.instanceId, categories: ['repository_caches'] })).json();
  const cleaned = await (await call('/cleanup/execute', { instanceId: capabilities.instanceId, confirmation: preview.confirmation })).json();
  assert.deepEqual(cleaned.deleted, [repositoryId]);
  await assert.rejects(fs.stat(clone));
  const binding = { instanceId: capabilities.instanceId, generation: capabilities.generation };
  assert.equal((await fetch(base + '/exports', { method: 'POST', headers: { 'x-actor': 'admin', 'Content-Type': 'application/json' }, body: JSON.stringify(binding) })).status, 403);
  assert.equal((await call('/exports', { ...binding, actor: 'admin' })).status, 400);
  const changed = await call('/exports', { ...binding, generation: 'other' });
  assert.equal(changed.status, 409); assert.equal((await changed.json()).code, STORAGE_INSTANCE_CHANGED_CODE);
  const accepted = await call('/exports', binding); assert.equal(accepted.status, 202);
  const job = await accepted.json(); const query = '?' + new URLSearchParams(binding);
  for (let i = 0; i < 200; i++) {
    const status = await (await call(`/exports/${job.operationId}${query}`)).json();
    if (status.state !== 'running') { assert.equal(status.state, 'ready'); break; }
    await delay(10);
  }
  assert.notEqual((await call(`/exports/${job.operationId}${query}`, undefined, 'other')).status, 200);
  assert.notEqual((await call(`/exports/${job.operationId}/download`, { ...binding, instanceId: 'another' })).status, 200);
  const downloaded = await call(`/exports/${job.operationId}/download`, binding);
  assert.equal(downloaded.status, 200); assert.equal(downloaded.headers.get('cache-control'), 'no-store');
  assert.equal(Buffer.from(await downloaded.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  // A consumed one-shot redemption is a definitive 410, distinct from a retryable 503.
  assert.equal((await call(`/exports/${job.operationId}/download`, binding)).status, 410);
  let response = await call('/exports', binding);
  for (let i = 0; response.status !== 202 && i < 100; i++) { await delay(10); response = await call('/exports', binding); }
  assert.equal(response.status, 202);
  const next = await response.json();
  await database('instance_members').where({ github_user_id: 'admin' }).update({ role: 'member' });
  for (const [route, body] of [['/repositories', undefined], [`/exports/${next.operationId}${query}`, undefined], [`/exports/${next.operationId}/download`, binding], ['/cleanup/execute', { instanceId: capabilities.instanceId, confirmation: preview.confirmation }]] as const) assert.equal((await call(route, body)).status, 403);
  await service.exports!.cancel(binding.instanceId, binding.generation, next.operationId, 'admin', async () => {});
});

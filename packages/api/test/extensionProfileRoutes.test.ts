import { up as grantMigration } from '../../core/src/db/migrations/20261013220000_extension_grant_network.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import knex from 'knex';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { ExtensionLibraryInput } from '@propr/shared';
import { ExtensionLibraryStore } from '../../core/src/extensions/extensionProfileStore.js';
import { up as libraryMigration } from '../../core/src/db/migrations/20261113000000_extension_library.js';
import { up } from '../../core/src/db/migrations/20261013210000_extension_profiles.js';
import { createApiRequestRateLimiter } from '../requestRateLimits.js';

type ProbeResponse = Readable & { statusCode: number; headers: Record<string, string> };
type ProbeOptions = { headers: Record<string, string | undefined>; agent: boolean; servername?: string };

test('extension HTTP boundary requires fresh durable administration, preflight JSON, and secret-free projections', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-api-'));
  process.env.DB_FILENAME = path.join(root, 'fixture.sqlite');
  const { createExtensionLibraryRoutes } = await import('../routes/extensionProfileRoutes.js');
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  await up(database); await grantMigration(database); await libraryMigration(database); await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }]);
  const store = new ExtensionLibraryStore(database, { SYSTEM_TASK_SECRET: 'synthetic-test-custody-root' });
  const { operatorCatalogDigest } = await import('../../core/src/extensions/operatorCatalog.js');
  const entry = { id: 'operator-docs', kind: 'stdio' as const, executable: '/usr/bin/env', args: ['node', 'CATALOG_ARGUMENT_SENTINEL', '/opt/propr/CATALOG_PATH_SENTINEL'], secretEnv: { API_KEY: 'OPERATOR_DOCS_KEY' }, tools: ['lookup', 'update'], capability: 'write' as const };
  const catalogFile = path.join(root, 'catalog.json');
  await fs.writeFile(catalogFile, JSON.stringify([entry]), { mode: 0o600 });
  store.environment.PROPR_EXTENSION_CATALOG_FILE = catalogFile; store.environment.OPERATOR_DOCS_KEY = 'CATALOG_SECRET_VALUE_SENTINEL';
  const routes = createExtensionLibraryRoutes(store); const app = express();
  // Match the production boundary: bound requests before parsing or authorization.
  const rateLimiter = createApiRequestRateLimiter({ PROPR_API_RATE_LIMIT_MAX: '100' });
  app.use(rateLimiter);
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = req.get('x-test-actor'); if (actor) req.user = { id: actor, username: 'fixture' } as typeof req.user;
    // A stale admin session is deliberately insufficient.
    req.authorization = { role: 'admin', permissions: req.get('x-test-no-permission') ? [] : ['instance.manage_settings'], source: 'local' }; next();
  });
  app.get('/', routes.list);
  app.get('/history', routes.history);
  app.post('/library', routes.save);
  app.post('/items/enabled', routes.setEnabled);
  app.post('/secrets', routes.replaceSecret);
  app.post('/validate', routes.validate);
  app.post('/skills/archive', routes.importArchive);
  app.post('/skills/github', routes.importGithub);
  app.post('/skills/github-source', routes.githubSource);
  app.post('/tools/discover', routes.discoverTools);
  app.post('/mcp/:serverName', routes.gateway);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); await database.destroy(); await (await import('@propr/core')).closeConnection(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(base + '/')).status, 401);
  assert.equal((await fetch(base + '/', { headers: { 'x-test-actor': '2' } })).status, 403);
  assert.equal((await fetch(base + '/', { headers: { 'x-test-actor': '1', 'x-test-no-permission': '1' } })).status, 403);
  const headers = { 'x-test-actor': '1', 'content-type': 'application/json', 'x-propr-extensions': '1' };
  const bundle = await store.importSkill('1', [{ path: 'SKILL.md', content: Buffer.from('---\nname: unused-skill\ndescription: Imported but never attached\n---\nSKILL_CONTENT_SENTINEL').toString('base64') }], { kind: 'archive', filename: 'unused.tar' });
  const otherInstance = { ...bundle, id: randomUUID(), instanceId: randomUUID(), name: 'other-instance' };
  await database('extension_skill_bundles').insert({ id: otherInstance.id, instance_id: otherInstance.instanceId, descriptor: JSON.stringify(otherInstance), files_json: '[]' });
  const inventory = await fetch(base + '/', { headers }).then(r => r.json());
  assert.deepEqual(inventory.bundles, [bundle]);
  assert.equal(inventory.library.revision, 0); assert.deepEqual(inventory.library.servers, []);
  assert.equal(inventory.contract.libraryLimits.servers, 32); assert.equal(inventory.contract.limits.servers, 8);
  assert.ok(!JSON.stringify(inventory).includes('SKILL_CONTENT_SENTINEL'));
  assert.ok(!JSON.stringify(inventory).includes('files_json'));
  const sentinel = 'UNMISTAKABLE_API_EXTENSION_SENTINEL';
  const descriptor = { kind: 'https', name: 'synthetic', url: 'https://8.8.8.8/mcp', enabled: true, tools: ['lookup'], capability: 'read', authentication: 'bearer' } as const;
  const input = { version: 1, servers: [descriptor], skills: [] } satisfies ExtensionLibraryInput;
  // Every cookie-authenticated mutation must reject browser-simple requests
  // and JSON requests lacking the custom header that forces a CORS preflight.
  for (const route of ['/library', '/items/enabled', '/secrets', '/validate', '/skills/archive', '/skills/github', '/skills/github-source', '/tools/discover']) {
    for (const requestHeaders of [
      { 'x-test-actor': '1', 'content-type': 'application/json' },
      { 'x-test-actor': '1', 'content-type': 'application/json', 'x-propr-extensions': 'wrong' },
      { 'x-test-actor': '1', 'content-type': 'text/plain', 'x-propr-extensions': '1' },
      { 'x-test-actor': '1', 'content-type': 'application/x-www-form-urlencoded' },
    ]) {
      assert.equal((await fetch(base + route, { method: 'POST', headers: requestHeaders, body: '{}' })).status, 403, route);
    }
  }
  const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
  const saved = await post('/library', { input, secrets: { synthetic: sentinel }, expectedRevision: 0 });
  assert.equal(saved.status, 200); const text = await saved.text(); assert.ok(!text.includes(sentinel));
  const library = JSON.parse(text).library;
  assert.equal(library.revision, 1); assert.equal(library.servers[0].autoApply, true); assert.deepEqual(library.secrets.synthetic, { fields: ['bearerToken'], configured: true });
  const revisionRows = await database('extension_library_revisions').select('*');
  for (const body of [{ input, expectedRevision: 0 }, { input, expectedRevision: 5 }, { input }, { input, expectedRevision: 1, guard: 1 }, { input: { ...input, name: 'profile' }, expectedRevision: 1 }]) {
    const refused = await post('/library', body);
    assert.ok([400, 409].includes(refused.status), JSON.stringify(body));
    assert.deepEqual(await database('extension_library_revisions').select('*'), revisionRows);
  }
  const disabled = await post('/items/enabled', { item: { kind: 'server', name: 'synthetic' }, enabled: false }).then(r => r.json());
  assert.equal(disabled.library.revision, 2); assert.equal(disabled.library.servers[0].enabled, false); assert.equal(disabled.library.secrets.synthetic.configured, true);
  for (const body of [{ item: { kind: 'server' }, enabled: false }, { item: { kind: 'profile', name: 'synthetic' }, enabled: false }, { item: { kind: 'server', name: 'synthetic', extra: 1 }, enabled: true }, { item: { kind: 'server', name: 'synthetic' }, enabled: 'no' }]) assert.equal((await post('/items/enabled', body)).status, 400);
  assert.equal((await post('/items/enabled', { item: { kind: 'server', name: 'missing' }, enabled: false })).status, 404);
  const rotated = await post('/secrets', { name: 'synthetic', secret: sentinel + '_ROTATED', expectedRevision: 2 });
  assert.equal(rotated.status, 200); assert.ok(!(await rotated.text()).includes(sentinel));
  assert.equal((await post('/secrets', { name: 'synthetic', secret: sentinel, expectedRevision: 2 })).status, 409);
  const history = await fetch(base + '/history', { headers }).then(r => r.json());
  assert.deepEqual(history.revisions.map((r: { revision: number }) => r.revision), [3, 2, 1]);
  const publicText = await fetch(base + '/', { headers }).then(r => r.text()); assert.ok(!publicText.includes(sentinel)); assert.ok(!publicText.includes('secrets_encrypted'));
  // Removing an item an automation adds explicitly is refused, naming the automation.
  await database('agent_definitions').insert({ id: 'automation-1', name: 'Weekly docs', extensions: JSON.stringify({ servers: ['synthetic'], skills: [] }) });
  const refusedRemoval = await post('/library', { input: { version: 1, servers: [], skills: [] }, expectedRevision: 3 });
  assert.equal(refusedRemoval.status, 409); assert.match((await refusedRemoval.json()).error, /Weekly docs/);
  await database('agent_definitions').delete();
  const catalogInput = { version: 1, skills: [], servers: [{ kind: 'catalog', name: 'operator', catalogId: entry.id, digest: operatorCatalogDigest(entry), enabled: true, tools: ['lookup'], capability: entry.capability }] };
  const catalogSaved = await post('/library', { input: catalogInput, expectedRevision: 3 });
  assert.equal(catalogSaved.status, 200);
  const catalogSnapshot = await catalogSaved.json();
  assert.deepEqual(catalogSnapshot.library.secrets.operator, { count: 1, configured: true });
  const catalogList = await fetch(base + '/', { headers }).then(r => r.json());
  assert.deepEqual(catalogList.catalog[0], { id: entry.id, digest: operatorCatalogDigest(entry), tools: entry.tools, capability: entry.capability, secrets: { count: 1, configured: true } });
  const catalogHistory = await fetch(base + '/history', { headers }).then(r => r.json());
  for (const projection of [catalogSnapshot, catalogList, catalogHistory]) {
    for (const sentinel of ['API_KEY', 'OPERATOR_DOCS_KEY', 'CATALOG_SECRET_VALUE_SENTINEL', entry.executable, 'CATALOG_ARGUMENT_SENTINEL', 'CATALOG_PATH_SENTINEL', catalogFile]) assert.ok(!JSON.stringify(projection).includes(sentinel), sentinel);
  }
  const catalogValidation = await post('/validate', {});
  assert.deepEqual(await catalogValidation.json(), { results: [{ name: 'operator', reachable: null, status: 'not_validated' }] });
  assert.equal((await post('/validate', { selection: {} })).status, 400);
  // Native restores deliberately remove ciphertext. Both public and authenticated
  // descriptors must produce connectivity results instead of an unseal error.
  let validationRequests = 0;
  t.mock.method(https, 'request', (_url: unknown, options: ProbeOptions, callback: (response: ProbeResponse) => void) => {
    validationRequests++;
    assert.equal(options.headers.Authorization, undefined);
    const request = Object.assign(new EventEmitter(), { end: () => {
      const response = Object.assign(Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))]), { statusCode: 200, headers: { 'content-type': 'application/json' } });
      callback(response); response.on('end', () => request.emit('close'));
    }, destroy: () => request.emit('close') });
    return request;
  });
  for (const authentication of ['none', 'bearer'] as const) {
    const restored = await store.saveLibrary('1', { ...input, servers: [{ ...descriptor, authentication }] }, authentication === 'bearer' ? { synthetic: sentinel } : {}, (await store.readLibrary('1')).revision);
    await database('extension_library_revisions').where({ revision: restored.revision }).update({ secrets_encrypted: '' });
    const validated = await post('/validate', {});
    assert.equal(validated.status, 200);
    assert.deepEqual(await validated.json(), { results: [{ name: 'synthetic', reachable: true, status: 'reachable' }] });
  }
  assert.equal(validationRequests, 2);
  for (const character of ['\x00', '\x1f', ' ', '\x7f']) {
    const source = await post('/skills/github-source', { repository: 'fixture/repo', ref: `refs/heads/test${character}ref` });
    assert.equal(source.status, 400, 'Git refs reject controls, spaces and DEL before repository access');
  }
  for (const commit of ['main', 'v1.0', 'a'.repeat(39)]) assert.equal((await post('/skills/github', { repository: 'fixture/repo', commit, directory: 'skills/test' })).status, 400);
  assert.equal((await post('/mcp/synthetic', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  await database('instance_members').where({ github_user_id: '1' }).update({ role: 'member' });
  assert.equal((await fetch(base + '/', { headers })).status, 403);
  assert.equal((await post('/items/enabled', { item: { kind: 'server', name: 'synthetic' }, enabled: false })).status, 403);
  // Exhaust the shared fixture quota, then prove every mounted handler is
  // bounded even when the request would otherwise fail authorization.
  rateLimiter.resetKey('127.0.0.1');
  for (let i = 0; i < 100; i++) assert.equal((await fetch(base + '/')).status, 401);
  for (const [method, route] of [
    ['GET', '/'], ['GET', '/history'],
    ['POST', '/library'], ['POST', '/items/enabled'], ['POST', '/secrets'], ['POST', '/validate'],
    ['POST', '/skills/archive'], ['POST', '/skills/github'], ['POST', '/skills/github-source'], ['POST', '/tools/discover'], ['POST', '/mcp/synthetic'],
  ]) {
    const limited = await fetch(base + route, { method });
    assert.equal(limited.status, 429, route);
    assert.equal((await limited.json()).code, 'RATE_LIMIT_EXCEEDED');
  }
});

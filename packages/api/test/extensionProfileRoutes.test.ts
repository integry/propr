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
import type { ExtensionProfileInput } from '@propr/shared';
import { ExtensionProfileStore } from '../../core/src/extensions/extensionProfileStore.js';
import { up } from '../../core/src/db/migrations/20261013210000_extension_profiles.js';
import { createApiRequestRateLimiter } from '../requestRateLimits.js';

type ProbeResponse = Readable & { statusCode: number; headers: Record<string, string> };
type ProbeOptions = { headers: Record<string, string | undefined>; agent: boolean; servername?: string };

test('extension HTTP boundary requires fresh durable administration, preflight JSON, and secret-free projections', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-api-'));
  process.env.DB_FILENAME = path.join(root, 'fixture.sqlite');
  const { createExtensionProfileRoutes } = await import('../routes/extensionProfileRoutes.js');
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => c.string('id').primary());
  await up(database); await grantMigration(database); await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }]);
  const store = new ExtensionProfileStore(database, { SYSTEM_TASK_SECRET: 'synthetic-test-custody-root' });
  const { operatorCatalogDigest } = await import('../../core/src/extensions/operatorCatalog.js');
  const entry = { id: 'operator-docs', kind: 'stdio' as const, executable: '/usr/bin/env', args: ['node', 'CATALOG_ARGUMENT_SENTINEL', '/opt/propr/CATALOG_PATH_SENTINEL'], secretEnv: { API_KEY: 'OPERATOR_DOCS_KEY' }, tools: ['lookup', 'update'], capability: 'write' as const };
  const catalogFile = path.join(root, 'catalog.json');
  await fs.writeFile(catalogFile, JSON.stringify([entry]), { mode: 0o600 });
  store.environment.PROPR_EXTENSION_CATALOG_FILE = catalogFile; store.environment.OPERATOR_DOCS_KEY = 'CATALOG_SECRET_VALUE_SENTINEL';
  const routes = createExtensionProfileRoutes(store); const app = express();
  // Match the production boundary: bound requests before parsing or authorization.
  const rateLimiter = createApiRequestRateLimiter({ PROPR_API_RATE_LIMIT_MAX: '100' });
  app.use(rateLimiter);
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = req.get('x-test-actor'); if (actor) req.user = { id: actor, username: 'fixture' } as typeof req.user;
    // A stale admin session is deliberately insufficient.
    req.authorization = { role: 'admin', permissions: req.get('x-test-no-permission') ? [] : ['instance.manage_settings'], source: 'local' }; next();
  });
  app.get('/profiles', routes.list);
  app.get('/profiles/:profileId/history', routes.history);
  app.post('/profiles', routes.save);
  app.post('/delete', routes.remove);
  app.post('/validate', routes.validate);
  app.post('/skills/archive', routes.importArchive);
  app.post('/skills/github', routes.importGithub);
  app.post('/skills/github-source', routes.githubSource);
  app.post('/tools/discover', routes.discoverTools);
  app.post('/mcp/:serverName', routes.gateway);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); await database.destroy(); await (await import('@propr/core')).closeConnection(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(base + '/profiles')).status, 401);
  assert.equal((await fetch(base + '/profiles', { headers: { 'x-test-actor': '2' } })).status, 403);
  assert.equal((await fetch(base + '/profiles', { headers: { 'x-test-actor': '1', 'x-test-no-permission': '1' } })).status, 403);
  const headers = { 'x-test-actor': '1', 'content-type': 'application/json', 'x-propr-extensions': '1' };
  const bundle = await store.importSkill('1', [{ path: 'SKILL.md', content: Buffer.from('---\nname: unused-skill\ndescription: Imported but never attached\n---\nSKILL_CONTENT_SENTINEL').toString('base64') }], { kind: 'archive', filename: 'unused.tar' });
  const otherInstance = { ...bundle, id: randomUUID(), instanceId: randomUUID(), name: 'other-instance' };
  await database('extension_skill_bundles').insert({ id: otherInstance.id, instance_id: otherInstance.instanceId, descriptor: JSON.stringify(otherInstance), files_json: '[]' });
  const inventory = await fetch(base + '/profiles', { headers }).then(r => r.json());
  assert.deepEqual(inventory.bundles, [bundle]);
  assert.equal(inventory.profiles.length, 0);
  assert.ok(!JSON.stringify(inventory).includes('SKILL_CONTENT_SENTINEL'));
  assert.ok(!JSON.stringify(inventory).includes('files_json'));
  const sentinel = 'UNMISTAKABLE_API_EXTENSION_SENTINEL';
  const input = { version: 1, name: 'Synthetic tools', enabled: true, agentScope: [], repositoryScope: [], mcpServers: [{ kind: 'https', name: 'synthetic', url: 'https://8.8.8.8/mcp', enabled: true, tools: ['lookup'], capability: 'read', authentication: 'bearer' }], skillBundleIds: [] } satisfies ExtensionProfileInput;
  // Every cookie-authenticated mutation must reject browser-simple requests
  // and JSON requests lacking the custom header that forces a CORS preflight.
  for (const route of ['/profiles', '/delete', '/validate', '/skills/archive', '/skills/github', '/skills/github-source', '/tools/discover']) {
    for (const requestHeaders of [
      { 'x-test-actor': '1', 'content-type': 'application/json' },
      { 'x-test-actor': '1', 'content-type': 'application/json', 'x-propr-extensions': 'wrong' },
      { 'x-test-actor': '1', 'content-type': 'text/plain', 'x-propr-extensions': '1' },
      { 'x-test-actor': '1', 'content-type': 'application/x-www-form-urlencoded' },
    ]) {
      assert.equal((await fetch(base + route, { method: 'POST', headers: requestHeaders, body: '{}' })).status, 403, route);
    }
  }
  assert.equal((await fetch(base + '/profiles', { method: 'POST', headers: { 'x-test-actor': '1', 'content-type': 'application/json' }, body: JSON.stringify({ input, secrets: { synthetic: sentinel } }) })).status, 403);
  const saved = await fetch(base + '/profiles', { method: 'POST', headers, body: JSON.stringify({ input, secrets: { synthetic: sentinel } }) });
  assert.equal(saved.status, 200); const text = await saved.text(); assert.ok(!text.includes(sentinel));
  const profile = JSON.parse(text).profile;
  const nullSaved = await fetch(base + '/profiles', { method: 'POST', headers, body: JSON.stringify({ input, secrets: {}, expected: null }) });
  assert.equal(nullSaved.status, 200);
  const nullProfile = (await nullSaved.json()).profile;
  assert.equal(nullProfile.revision, 1);
  assert.notEqual(nullProfile.profileId, profile.profileId);
  const profileRows = await database('extension_profiles').select('*');
  const revisionRows = await database('extension_profile_revisions').select('*');
  for (const expected of [{}, { instanceId: profile.instanceId, revision: 3 }, { guard: 1 }, { preflight: 1 }, { expected: { instanceId: profile.instanceId, profileId: profile.profileId, revision: profile.revision } }]) {
    const refused = await fetch(base + '/profiles', { method: 'POST', headers, body: JSON.stringify({ input, secrets: {}, expected }) });
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: 'Invalid extension selection' });
    assert.deepEqual(await database('extension_profiles').select('*'), profileRows);
    assert.deepEqual(await database('extension_profile_revisions').select('*'), revisionRows);
  }
  const publicText = await fetch(base + '/profiles', { headers }).then(r => r.text()); assert.ok(!publicText.includes(sentinel)); assert.ok(!publicText.includes('secrets_encrypted'));
  const catalogInput = { ...input, mcpServers: [{ kind: 'catalog', name: 'operator', catalogId: entry.id, digest: operatorCatalogDigest(entry), enabled: true, tools: ['lookup'], capability: entry.capability }] };
  const catalogSaved = await fetch(base + '/profiles', { method: 'POST', headers, body: JSON.stringify({ input: catalogInput }) });
  assert.equal(catalogSaved.status, 200);
  const catalogSnapshot = await catalogSaved.json();
  assert.deepEqual(catalogSnapshot.profile.secrets.operator, { count: 1, configured: true });
  const catalogList = await fetch(base + '/profiles', { headers }).then(r => r.json());
  assert.deepEqual(catalogList.catalog[0], { id: entry.id, digest: operatorCatalogDigest(entry), tools: entry.tools, capability: entry.capability, secrets: { count: 1, configured: true } });
  const catalogHistory = await fetch(base + `/profiles/${catalogSnapshot.profile.profileId}/history`, { headers }).then(r => r.json());
  for (const projection of [catalogSnapshot, catalogList, catalogHistory]) {
    for (const sentinel of ['API_KEY', 'OPERATOR_DOCS_KEY', 'CATALOG_SECRET_VALUE_SENTINEL', entry.executable, 'CATALOG_ARGUMENT_SENTINEL', 'CATALOG_PATH_SENTINEL', catalogFile]) assert.ok(!JSON.stringify(projection).includes(sentinel), sentinel);
  }
  const catalogValidation = await fetch(base + '/validate', { method: 'POST', headers, body: JSON.stringify({ selection: { instanceId: catalogSnapshot.profile.instanceId, profileId: catalogSnapshot.profile.profileId, revision: catalogSnapshot.profile.revision } }) });
  assert.deepEqual(await catalogValidation.json(), { results: [{ name: 'operator', reachable: null, status: 'not_validated' }] });
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
    const restored = await store.save('1', { ...input, mcpServers: [{ ...input.mcpServers[0], enabled: true, authentication }] }, authentication === 'bearer' ? { synthetic: sentinel } : {});
    await database('extension_profile_revisions').where({ profile_id: restored.profileId, revision: restored.revision }).update({ secrets_encrypted: '' });
    const validated = await fetch(base + '/validate', { method: 'POST', headers, body: JSON.stringify({ selection: { instanceId: restored.instanceId, profileId: restored.profileId, revision: restored.revision } }) });
    assert.equal(validated.status, 200);
    assert.deepEqual(await validated.json(), { results: [{ name: 'synthetic', reachable: true, status: 'reachable' }] });
  }
  assert.equal(validationRequests, 2);
  for (const character of ['\x00', '\x1f', ' ', '\x7f']) {
    const source = await fetch(base + '/skills/github-source', { method: 'POST', headers, body: JSON.stringify({ repository: 'fixture/repo', ref: `refs/heads/test${character}ref` }) });
    assert.equal(source.status, 400, 'Git refs reject controls, spaces and DEL before repository access');
  }
  for (const commit of ['main', 'v1.0', 'a'.repeat(39)]) assert.equal((await fetch(base + '/skills/github', { method: 'POST', headers, body: JSON.stringify({ repository: 'fixture/repo', commit, directory: 'skills/test' }) })).status, 400);
  const selection = { instanceId: profile.instanceId, profileId: profile.profileId, revision: profile.revision };
  assert.equal((await fetch(base + '/delete', { method: 'POST', headers, body: JSON.stringify({ selection: { ...selection, instanceId: randomUUID() } }) })).status, 404);
  assert.equal((await fetch(base + '/mcp/synthetic', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status, 401);
  await database('instance_members').where({ github_user_id: '1' }).update({ role: 'member' });
  assert.equal((await fetch(base + '/profiles', { headers })).status, 403);
  assert.equal((await fetch(base + '/delete', { method: 'POST', headers, body: JSON.stringify({ selection }) })).status, 403);
  // Exhaust the shared fixture quota, then prove every mounted handler is
  // bounded even when the request would otherwise fail authorization.
  rateLimiter.resetKey('127.0.0.1');
  for (let i = 0; i < 100; i++) assert.equal((await fetch(base + '/profiles')).status, 401);
  for (const [method, route] of [
    ['GET', '/profiles'], ['GET', `/profiles/${profile.profileId}/history`],
    ['POST', '/profiles'], ['POST', '/delete'], ['POST', '/validate'],
    ['POST', '/skills/archive'], ['POST', '/skills/github'], ['POST', '/skills/github-source'], ['POST', '/tools/discover'], ['POST', '/mcp/synthetic'],
  ]) {
    const limited = await fetch(base + route, { method });
    assert.equal(limited.status, 429, route);
    assert.equal((await limited.json()).code, 'RATE_LIMIT_EXCEEDED');
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import knex from 'knex';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { ExtensionLibraryStore } from '../../core/src/extensions/extensionProfileStore.js';
import { up } from '../../core/src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../../core/src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../../core/src/db/migrations/20261113000000_extension_library.js';
import { npmRegistryFixture } from '../../core/test/helpers/npmRegistryFixture.js';
import { ExtensionLibrarySave } from '../openapi/schemas.js';

const secret = 'UNMISTAKABLE_API_PACKAGE_SECRET_SENTINEL';

test('local package servers over HTTP: Check, exact pins, acknowledgement and refused launch fields', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-package-api-'));
  process.env.DB_FILENAME = path.join(root, 'fixture.sqlite');
  const registry = await npmRegistryFixture();
  const { createExtensionLibraryRoutes } = await import('../routes/extensionProfileRoutes.js');
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  await up(database); await grantMigration(database); await libraryMigration(database);
  await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }]);
  const store = new ExtensionLibraryStore(database, { SYSTEM_TASK_SECRET: 'synthetic-package-api-custody', PROPR_EXTENSION_NPM_REGISTRY: registry.url });
  const routes = createExtensionLibraryRoutes(store); const app = express();
  app.use(rateLimit({ windowMs: 60_000, limit: 600 }));
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = req.get('x-test-actor'); if (actor) req.user = { id: actor, username: 'fixture' } as typeof req.user;
    req.authorization = { role: 'admin', permissions: ['instance.manage_settings'], source: 'local' }; next();
  });
  app.get('/', routes.list);
  app.post('/library', routes.save);
  app.post('/validate', routes.validate);
  app.post('/packages/resolve', routes.resolvePackage);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); await database.destroy(); await registry.close(); await (await import('@propr/core')).closeConnection(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { 'x-test-actor': '1', 'content-type': 'application/json', 'x-propr-extensions': '1' };
  const post = (route: string, body: unknown, extra: Record<string, string> = {}) => fetch(base + route, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });

  // Check: administrators only, preflight JSON, exact version, registry lookup only.
  const check = { ecosystem: 'npm', package: 'propr-fixture-mcp', version: '1.0.0' };
  assert.equal((await post('/packages/resolve', check, { 'x-test-actor': '2' })).status, 403);
  assert.equal((await fetch(base + '/packages/resolve', { method: 'POST', headers: { 'x-test-actor': '1', 'content-type': 'application/json' }, body: JSON.stringify(check) })).status, 403);
  const resolved = await post('/packages/resolve', check);
  assert.equal(resolved.status, 200);
  assert.deepEqual((await resolved.json()).package, { ecosystem: 'npm', package: 'propr-fixture-mcp', version: '1.0.0', integrity: registry.integrity('propr-fixture-mcp', '1.0.0'), bin: 'propr-fixture-mcp', bins: ['propr-fixture-mcp'] });
  for (const body of [{ ...check, version: 'latest' }, { ...check, version: '^1.0.0' }, { ...check, ecosystem: 'pypi' }, { ...check, command: 'sh' }, { ...check, package: 'propr-fixture-scripts' }]) {
    const refused = await post('/packages/resolve', body);
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.match((await (await post('/packages/resolve', { ...check, version: '^1.0.0' })).json()).error, /exact version/);
  assert.equal((await post('/packages/resolve', { ...check, version: '3.0.0' })).status, 404);

  // Save: the integrity value is resolved by ProPR; command, argv, host paths, mounts and images are refused.
  const packageServer = { kind: 'package', name: 'local', ecosystem: 'npm', package: 'propr-fixture-mcp', version: '1.0.0', enabled: true, tools: ['echo'], capability: 'read', args: [], env: [], secretEnv: ['FIXTURE_TOKEN'] };
  for (const extra of [{ command: '/bin/sh' }, { argv: ['/bin/sh', '-c', 'id'] }, { hostPath: '/etc' }, { mounts: [{ source: '/', target: '/host' }] }, { image: 'alpine:3' }, { dockerSocket: true }, { executable: '/usr/bin/env' }, { version: 'latest' }]) {
    const refused = await post('/library', { input: { version: 1, servers: [{ ...packageServer, ...extra }], skills: [] }, secrets: {}, expectedRevision: 0, acknowledgements: ['local'] });
    assert.equal(refused.status, 400, JSON.stringify(extra));
  }
  const unacknowledged = await post('/library', { input: { version: 1, servers: [packageServer], skills: [] }, secrets: { 'local/FIXTURE_TOKEN': secret }, expectedRevision: 0 });
  assert.equal(unacknowledged.status, 400);
  assert.match((await unacknowledged.json()).error, /Confirm that the secret variables of local are readable/);
  // The request the Settings UI sends for a package secret is valid under the published contract.
  const acknowledgedSave = { input: { version: 1, servers: [packageServer], skills: [] }, secrets: { 'local/FIXTURE_TOKEN': secret }, expectedRevision: 0, acknowledgements: ['local'] };
  const contract = ExtensionLibrarySave.safeParse(acknowledgedSave);
  assert.ok(contract.success, JSON.stringify(contract.error?.issues));
  const saved = await post('/library', acknowledgedSave);
  assert.equal(saved.status, 200);
  const text = await saved.text(); assert.ok(!text.includes(secret));
  const library = JSON.parse(text).library;
  assert.equal(library.servers[0].integrity, registry.integrity('propr-fixture-mcp', '1.0.0'));
  assert.equal(library.acknowledgements.local.actor, '1');
  assert.deepEqual(library.secrets.local, { count: 1, configured: true, configuredEnv: ['FIXTURE_TOKEN'] });
  const listed = await fetch(base + '/', { headers }).then(r => r.text());
  assert.ok(!listed.includes(secret));
  assert.deepEqual(JSON.parse(listed).contract.packageEcosystems, ['npm']);
  // Nothing is started to validate a local server.
  assert.deepEqual((await (await post('/validate', {})).json()).results, [{ name: 'local', reachable: null, status: 'not_validated' }]);
});

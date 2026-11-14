import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { pluginManifestSchema, validatePluginSettings, type PluginManifest } from '@propr/shared';
import { getOfficialPlugin } from '../../plugins/src/index.js';
import { extensionTestResources } from './helpers/extensionTestResources.js';
import { up as identityMigration } from '../src/db/migrations/20261013210000_extension_profiles.js';
import { up as pluginMigration } from '../src/db/migrations/20261114000000_plugin_installations.js';
import { PluginError, PluginStore } from '../src/plugins/pluginStore.js';
import { officialPluginCatalog } from '../src/plugins/pluginCatalog.js';
import logger from '../src/utils/logger.js';

const ID = 'example-pack';
const SENTINEL = 'plugin-token-sentinel-6b1f0c';
const SIGNING_SENTINEL = 'plugin-signing-sentinel-29de';
const example = getOfficialPlugin(ID, { includeDevelopment: true })!.manifest;

/** The example manifest after a ProPR upgrade: one more permission, a new package version, and a webhook. */
function upgraded(change: { permissions?: boolean; packageVersion?: string } = {}): PluginManifest {
  const input = structuredClone(example) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  input.version = '0.2.0';
  if (change.permissions !== false) input.permissions = [...example.permissions, 'issues.comment'];
  if (change.packageVersion) input.contributes.mcpServers[1].version = change.packageVersion;
  return pluginManifestSchema.parse(input);
}
const withSigningSecret = (): PluginManifest => pluginManifestSchema.parse({
  ...structuredClone(example),
  connections: [...example.connections, { type: 'signing_secret', name: 'example-signing', label: 'Signing secret', help: 'The webhook signing secret.', helpUrl: 'https://example.com/docs/webhooks' }],
  contributes: { ...structuredClone(example.contributes), webhooks: [{ name: 'events', description: 'Example events', connection: 'example-signing' }] },
});

async function fixture(t: TestContext, initial: PluginManifest = example) {
  const database = extensionTestResources(t).database();
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }]);
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  await identityMigration(database); await pluginMigration(database);
  let manifests: PluginManifest[] = [initial];
  let clock = 1_700_000_000_000;
  const store = new PluginStore(database, { SYSTEM_TASK_SECRET: 'plugin-store-test-root' }, async () => manifests, () => clock);
  return { database, store, setCatalog: (next: PluginManifest[]) => { manifests = next; }, tick: () => { clock += 1000; } };
}

const refused = (status: number, pattern?: RegExp) => (error: unknown) => {
  assert.ok(error instanceof PluginError, String(error));
  assert.equal(error.status, status, error.message);
  if (pattern) assert.match(error.message, pattern);
  return true;
};

test('the official catalog offers the example plugin only with the development flag', async () => {
  const previous = process.env.PROPR_PLUGINS_DEVELOPMENT;
  try {
    process.env.PROPR_PLUGINS_DEVELOPMENT = '1';
    assert.ok((await officialPluginCatalog()).some(m => m.id === ID));
    delete process.env.PROPR_PLUGINS_DEVELOPMENT;
    assert.ok(!(await officialPluginCatalog()).some(m => m.id === ID));
  } finally { if (previous === undefined) delete process.env.PROPR_PLUGINS_DEVELOPMENT; else process.env.PROPR_PLUGINS_DEVELOPMENT = previous; }
});

test('install, configure, enable, disable, re-enable and uninstall the example plugin', async t => {
  const f = await fixture(t);
  const [available] = await f.store.list('1');
  assert.equal(available.state, 'available');
  assert.equal(available.installation, null);

  // The package server hands FIXTURE_TOKEN to the task container: install needs the acknowledgement.
  await assert.rejects(f.store.install('1', ID), refused(400, /example-local/));
  const installed = await f.store.install('1', ID, ['example-local']);
  assert.equal(installed.state, 'installed');
  assert.equal(installed.installation?.installedVersion, '0.1.0');
  assert.deepEqual(installed.installation?.grantedPermissions, ['events.read', 'tasks.read']);
  assert.deepEqual(installed.installation?.settings, { greeting: 'hello', verbosity: 'normal', maxItems: 10, includeDrafts: false, labels: [] });
  assert.equal(installed.installation?.repositories, null);
  assert.equal(installed.installation?.installedBy, '1');
  assert.deepEqual(installed.installation?.acknowledgements['example-local'], { actor: '1', at: 1_700_000_000_000, package: 'propr-fixture-mcp', version: '1.0.0', secretEnv: ['FIXTURE_TOKEN'] });
  assert.equal(installed.needsApproval, false);
  await assert.rejects(f.store.install('1', ID, ['example-local']), refused(409));

  // The required token connection is missing.
  assert.deepEqual(installed.enableBlockers, ['Connection Example API token (example-token) is not set']);
  await assert.rejects(f.store.setEnabled('1', ID, true), refused(409, /Example API token/));
  const oauth = installed.connections.find(c => c.name === 'example-account')!;
  assert.deepEqual({ state: oauth.state, required: oauth.required }, { state: 'not_connected', required: false });
  await assert.rejects(f.store.setConnection('1', ID, 'example-account', SENTINEL), refused(400, /OAuth/));

  const settings = await f.store.updateSettings('1', ID, { verbosity: 'detailed', maxItems: 5, labels: ['bug'], channels: { 'acme/app': '#eng' } });
  assert.deepEqual(settings.installation?.settings, { verbosity: 'detailed', maxItems: 5, labels: ['bug'], channels: { 'acme/app': '#eng' } });
  await assert.rejects(f.store.updateSettings('1', ID, { verbosity: 'loud' }), refused(400, /verbosity must be one of/));
  await assert.rejects(f.store.updateSettings('1', ID, { unknown: 1 }), refused(400, /not a setting/));
  await assert.rejects(f.store.updateSettings('1', ID, { maxItems: 51 }), refused(400, /at most 50/));
  const limited = await f.store.setRepositories('1', ID, ['acme/app', 'acme/app']);
  assert.deepEqual(limited.installation?.repositories, ['acme/app']);
  assert.equal((await f.store.setRepositories('1', ID, [])).installation?.repositories, null);
  await f.store.setRepositories('1', ID, ['acme/app']);
  await assert.rejects(f.store.setRepositories('1', ID, ['not a repository']), refused(400));

  const connected = await f.store.setConnection('1', ID, 'example-token', SENTINEL);
  assert.equal(connected.connections.find(c => c.name === 'example-token')?.state, 'connected');
  assert.equal(await f.store.connectionSecret(ID, 'example-token'), SENTINEL);
  const sealed = (await f.database('plugin_secrets').first('sealed')).sealed as string;
  assert.ok(!sealed.includes(SENTINEL));
  assert.deepEqual(connected.enableBlockers, []);

  assert.equal((await f.store.setEnabled('1', ID, true)).state, 'enabled');
  await assert.rejects(f.store.setConnection('1', ID, 'example-token', null), refused(409, /disable it first/));
  await assert.rejects(f.store.updateSettings('1', ID, {}), refused(409, /verbosity/));

  // Disabling keeps settings and connections.
  const disabled = await f.store.setEnabled('1', ID, false);
  assert.equal(disabled.state, 'installed');
  assert.equal(disabled.installation?.settings.verbosity, 'detailed');
  assert.deepEqual(disabled.installation?.repositories, ['acme/app']);
  assert.equal(disabled.connections.find(c => c.name === 'example-token')?.state, 'connected');
  assert.equal((await f.store.setEnabled('1', ID, true)).state, 'enabled');

  await assert.rejects(f.store.uninstall('1', ID, 'yes'), refused(400, /repeating the plugin id/));
  const removed = await f.store.uninstall('1', ID, ID);
  assert.equal(removed.state, 'available');
  assert.equal((await f.database('plugin_secrets').count({ n: '*' }))[0].n, 0);
  assert.equal((await f.database('plugin_installations').count({ n: '*' }))[0].n, 0);
  // A reinstall starts from the defaults, not connected.
  const again = await f.store.install('1', ID, ['example-local']);
  assert.equal(again.installation?.settings.verbosity, 'normal');
  assert.equal(again.connections.find(c => c.name === 'example-token')?.state, 'not_connected');

  const detail = await f.store.get('1', ID);
  assert.deepEqual(detail.audit.map(e => e.action).reverse(), [
    'install', 'update_settings', 'set_repositories', 'set_repositories', 'set_repositories', 'set_connection', 'enable', 'disable', 'enable', 'uninstall', 'install',
  ]);
  assert.ok(detail.audit.every(e => e.actor === '1'));
  assert.deepEqual(detail.audit.find(e => e.action === 'update_settings')?.detail, { changed: ['channels', 'greeting', 'includeDrafts', 'labels', 'maxItems', 'verbosity'] });
});

test('enabling is refused while a required setting is missing', async t => {
  const f = await fixture(t);
  await f.store.install('1', ID, ['example-local']);
  await f.store.setConnection('1', ID, 'example-token', SENTINEL);
  const view = await f.store.updateSettings('1', ID, { greeting: 'hi' });
  assert.deepEqual(view.enableBlockers, ['Required setting Verbosity (verbosity) is missing']);
  await assert.rejects(f.store.setEnabled('1', ID, true), refused(409, /Required setting Verbosity/));
  await f.store.updateSettings('1', ID, { greeting: 'hi', verbosity: 'quiet' });
  assert.equal((await f.store.setEnabled('1', ID, true)).state, 'enabled');
});

test('a manifest that adds a permission needs approval and keeps the old grant until approved', async t => {
  const f = await fixture(t);
  await f.store.install('1', ID, ['example-local']);
  await f.store.setConnection('1', ID, 'example-token', SENTINEL);
  await f.store.setEnabled('1', ID, true);
  f.setCatalog([upgraded()]);

  const view = await f.store.get('1', ID);
  assert.equal(view.needsApproval, true);
  assert.deepEqual(view.pendingPermissions, ['issues.comment']);
  assert.deepEqual(view.installation?.grantedPermissions, ['events.read', 'tasks.read']);
  assert.equal(view.installation?.installedVersion, '0.1.0');
  assert.equal(view.state, 'enabled', 'the plugin keeps running with its old grant');
  // Other writes keep the old grant and version.
  await f.store.setRepositories('1', ID, ['acme/app']);
  assert.equal((await f.store.get('1', ID)).installation?.installedVersion, '0.1.0');
  await assert.rejects(f.store.approve('2', ID), refused(403));

  const approved = await f.store.approve('1', ID);
  assert.equal(approved.needsApproval, false);
  assert.deepEqual(approved.installation?.grantedPermissions, ['events.read', 'tasks.read', 'issues.comment']);
  assert.equal(approved.installation?.installedVersion, '0.2.0');
  await assert.rejects(f.store.approve('1', ID), refused(409, /Nothing awaits approval/));
  const event = (await f.store.get('1', ID)).audit[0];
  assert.equal(event.action, 'approve');
  assert.deepEqual(event.detail.added, ['issues.comment']);
});

test('a manifest upgrade without new permissions advances the installed version on the next write', async t => {
  const f = await fixture(t);
  await f.store.install('1', ID, ['example-local']);
  f.setCatalog([upgraded({ permissions: false })]);
  assert.equal((await f.store.get('1', ID)).needsApproval, false);
  assert.equal((await f.store.setRepositories('1', ID, null)).installation?.installedVersion, '0.2.0');
});

test('a changed package version needs the secret acknowledgement again before enabling', async t => {
  const f = await fixture(t);
  await f.store.install('1', ID, ['example-local']);
  await f.store.setConnection('1', ID, 'example-token', SENTINEL);
  f.setCatalog([upgraded({ permissions: false, packageVersion: '1.0.1' })]);
  const view = await f.store.get('1', ID);
  assert.equal(view.needsApproval, true);
  assert.deepEqual(view.pendingAcknowledgements, [{ server: 'example-local', package: 'propr-fixture-mcp', version: '1.0.1', secretEnv: ['FIXTURE_TOKEN'] }]);
  await assert.rejects(f.store.setEnabled('1', ID, true), refused(409, /example-local/));
  await assert.rejects(f.store.approve('1', ID), refused(400, /example-local/));
  f.tick();
  const approved = await f.store.approve('1', ID, ['example-local']);
  assert.equal(approved.installation?.acknowledgements['example-local'].version, '1.0.1');
  assert.equal(approved.installation?.acknowledgements['example-local'].at, 1_700_000_001_000);
  assert.equal((await f.store.setEnabled('1', ID, true)).state, 'enabled');
});

test('a plugin an upgrade removed from the registry can only be disabled or uninstalled', async t => {
  const f = await fixture(t);
  await f.store.install('1', ID, ['example-local']);
  f.setCatalog([]);
  const [view] = await f.store.list('1');
  assert.deepEqual({ id: view.id, available: view.available, manifest: view.manifest, state: view.state }, { id: ID, available: false, manifest: null, state: 'installed' });
  await assert.rejects(f.store.setEnabled('1', ID, true), refused(409, /no longer/));
  await assert.rejects(f.store.updateSettings('1', ID, {}), refused(409, /no longer/));
  assert.equal((await f.store.setEnabled('1', ID, false)).state, 'installed');
  assert.equal((await f.store.uninstall('1', ID, ID)).state, 'available');
  assert.deepEqual(await f.store.list('1'), []);
  await assert.rejects(f.store.get('1', ID), refused(404));
});

test('signing secrets are write-only and every management route needs a durable administrator', async t => {
  const f = await fixture(t, withSigningSecret());
  await assert.rejects(f.store.list('2'), refused(403));
  await assert.rejects(f.store.get('2', ID), refused(403));
  await assert.rejects(f.store.install('2', ID, ['example-local']), refused(403));
  await f.store.install('1', ID, ['example-local']);
  for (const call of [
    () => f.store.updateSettings('2', ID, {}), () => f.store.setRepositories('2', ID, null), () => f.store.setConnection('2', ID, 'example-token', SENTINEL),
    () => f.store.setEnabled('2', ID, false), () => f.store.approve('2', ID), () => f.store.uninstall('2', ID, ID), () => f.store.list('not-a-user'),
  ]) await assert.rejects(call(), refused(403));
  await assert.rejects(f.store.get('1', '../etc'), refused(404));

  const view = await f.store.setConnection('1', ID, 'example-signing', SIGNING_SENTINEL);
  const signing = view.connections.find(c => c.name === 'example-signing')!;
  assert.deepEqual(signing, { name: 'example-signing', type: 'signing_secret', label: 'Signing secret', required: false, state: 'connected', setBy: '1', setAt: 1_700_000_000_000 });
  await assert.rejects(f.store.setConnection('1', ID, 'example-token', 'has spaces'), refused(400));
  const cleared = await f.store.setConnection('1', ID, 'example-signing', null);
  assert.equal(cleared.connections.find(c => c.name === 'example-signing')?.state, 'not_connected');
  assert.equal((await f.store.get('1', ID)).audit[0].action, 'clear_connection');
});

test('secrets never appear in views, audit, logs or with another instance identity', async t => {
  const logged: string[] = [];
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    const original = logger[level];
    (logger as unknown as Record<string, unknown>)[level] = (...args: unknown[]) => { logged.push(JSON.stringify(args)); return (original as (...a: unknown[]) => void).apply(logger, args); };
    t.after(() => { (logger as unknown as Record<string, unknown>)[level] = original; });
  }
  const f = await fixture(t, withSigningSecret());
  const outputs: unknown[] = [];
  outputs.push(await f.store.install('1', ID, ['example-local']));
  outputs.push(await f.store.setConnection('1', ID, 'example-token', SENTINEL));
  outputs.push(await f.store.setConnection('1', ID, 'example-signing', SIGNING_SENTINEL));
  outputs.push(await f.store.setEnabled('1', ID, true));
  outputs.push(await f.store.list('1'), await f.store.get('1', ID));
  const audit = await f.database('plugin_audit').select();
  for (const text of [JSON.stringify(outputs), JSON.stringify(audit), logged.join('\n')]) {
    assert.ok(!text.includes(SENTINEL) && !text.includes(SIGNING_SENTINEL));
  }
  assert.ok(logged.some(line => line.includes('Plugin management action')));
  // The sealed secret is bound to this instance, plugin and connection.
  await f.database('extension_instance_identity').update({ instance_id: '00000000-0000-4000-8000-000000000000' });
  await assert.rejects(f.store.connectionSecret(ID, 'example-token'), /unavailable/);
});

test('settings validation covers every setting type', () => {
  const { settings } = example;
  assert.deepEqual(validatePluginSettings(settings, { includeDrafts: 'yes' }), { ok: false, errors: ['includeDrafts must be true or false'] });
  assert.deepEqual(validatePluginSettings(settings, { maxItems: 2.5 }), { ok: false, errors: ['maxItems must be a whole number'] });
  assert.deepEqual(validatePluginSettings(settings, { labels: [1] }), { ok: false, errors: ['labels must be a list of text values'] });
  assert.deepEqual(validatePluginSettings(settings, { channels: { bad: 'x' } }), { ok: false, errors: ['channels must map owner/repo to text'] });
  assert.deepEqual(validatePluginSettings(settings, []), { ok: false, errors: ['Settings must be an object'] });
  assert.deepEqual(validatePluginSettings(settings, { greeting: null, verbosity: 'quiet' }), { ok: true, settings: { verbosity: 'quiet' } });
});

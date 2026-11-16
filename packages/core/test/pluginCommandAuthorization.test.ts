import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExtensionSet, type PluginManifest } from '@propr/shared';
import { getOfficialPlugin, loadPluginHandlers } from '../../plugins/src/index.js';
import { extensionTestResources } from './helpers/extensionTestResources.js';
import { ENVIRONMENT, FIXTURE_REGISTRY, recordingBackend } from './helpers/pluginHandlerFixture.js';
import { up as identityMigration } from '../src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../src/db/migrations/20261113000000_extension_library.js';
import { up as oauthMigration } from '../src/db/migrations/20261113120000_extension_oauth.js';
import { up as pluginMigration } from '../src/db/migrations/20261114000000_plugin_installations.js';
import { up as stateMigration } from '../src/db/migrations/20261114180000_plugin_state.js';
import { up as journalMigration } from '../src/db/migrations/20261112160000_create_repository_events.js';
import { up as taskDomainMigration } from '../src/db/migrations/20261114120000_add_task_repository_event_domain.js';
import { up as deliveriesMigration } from '../src/db/migrations/20261115000000_plugin_event_deliveries.js';
import { up as webhookKeysMigration } from '../src/db/migrations/20261116000000_plugin_webhook_keys.js';
import { up as commandSettingsMigration } from '../src/db/migrations/20261116120000_plugin_command_settings.js';
import { PluginError, PluginStore } from '../src/plugins/pluginStore.js';
import { resolvePluginCommand, type PluginCommandRequest } from '../src/plugins/pluginCommands.js';
import { consumePluginCommandWriteGrant } from '../src/plugins/pluginCommandSettings.js';
import { PluginCommandRunner, enqueuePluginCommandDelivery } from '../src/plugins/pluginCommandDeliveries.js';
import { listPluginActivity } from '../src/plugins/pluginDeliveries.js';
import { pluginStateStore } from '../src/plugins/pluginStateStore.js';

const ONE = 'fixture-deploy-one';
const TWO = 'fixture-deploy-two';
const fixtureManifest = (id: string): PluginManifest => getOfficialPlugin(id, { root: FIXTURE_REGISTRY, includeDevelopment: true })!.manifest;

async function fixture(t: TestContext, manifests: PluginManifest[] = [fixtureManifest(ONE), fixtureManifest(TWO)]) {
  const database = extensionTestResources(t).database();
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }]);
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  for (const migrate of [identityMigration, grantMigration, libraryMigration, oauthMigration, pluginMigration, stateMigration, journalMigration, taskDomainMigration, deliveriesMigration, webhookKeysMigration, commandSettingsMigration]) await migrate(database);
  const catalog = async () => manifests;
  const store = new PluginStore(database, ENVIRONMENT, catalog);
  const enable = async (id: string) => { await store.install('1', id); return store.setEnabled('1', id, true); };
  const writers = new Set<string>(['maintainer']);
  const permissionChecks: string[] = [];
  const resolve = (body: string, request: Partial<PluginCommandRequest> = {}) => resolvePluginCommand(
    { body, repository: 'owner/app', target: 'pull_request', author: 'maintainer', number: 42, ...request },
    {
      database, catalog, library: async () => (await store.library.head()).snapshot,
      writePermission: async (repository, login) => { permissionChecks.push(`${repository}:${login}`); return writers.has(login); },
    },
  );
  const managed = async (id: string, item: string) => (await store.library.head()).snapshot.servers.find(s => s.managedBy?.plugin === id && s.managedBy.item === item)!;
  const audit = async (id: string) => (await store.get('1', id)).audit.map(event => ({ action: event.action, detail: event.detail }));
  return { database, store, catalog, enable, resolve, managed, audit, permissionChecks };
}

test('a needsWrite command is refused until an administrator allows it, and then only for commenters with write permission', async t => {
  const f = await fixture(t);
  await f.enable(ONE);

  const off = await f.resolve('/deploy-one-release v2');
  assert.equal(off.status, 'refused');
  if (off.status === 'refused') assert.match(off.message, /an administrator has not allowed it: "Allow this command to use write access" is off for \/deploy-one-release on the Plugins page\. Nothing was started\.$/);
  assert.deepEqual(f.permissionChecks, [], 'the switch is checked before GitHub is asked');
  assert.equal(await f.database('plugin_command_write_grants').count({ n: '*' }).first().then(r => Number(r?.n)), 0);

  const view = await f.store.setCommandWrite('1', ONE, 'deploy-one-release', true);
  assert.deepEqual(view.commands?.find(c => c.name === 'deploy-one-release'), { name: 'deploy-one-release', needsWrite: true, writeAllowed: true, writeChangedBy: '1', writeChangedAt: view.commands?.find(c => c.name === 'deploy-one-release')?.writeChangedAt });

  const outsider = await f.resolve('/deploy-one-release v2', { author: 'drive-by' });
  assert.equal(outsider.status, 'refused');
  if (outsider.status === 'refused') assert.match(outsider.message, /needs write access: only people with write permission on owner\/app can run it\. Nothing was started\.$/);
  assert.deepEqual(f.permissionChecks, ['owner/app:drive-by']);

  const allowed = await f.resolve('/deploy-one-release v2');
  assert.equal(allowed.status, 'resolved');
  if (allowed.status !== 'resolved') return;
  const writeServer = await f.managed(ONE, 'deploy-one-api');
  const readServer = await f.managed(ONE, 'deploy-one-docs');
  assert.deepEqual(allowed.run.extensions.servers.sort(), [writeServer.name, readServer.name].sort(), 'both servers the command names are added');
  assert.deepEqual(allowed.run.writeGrant && { ...allowed.run.writeGrant, id: 'id' }, { id: 'id', repository: 'owner/app', number: 42, servers: [writeServer.name] }, 'the grant covers the write server only');

  // Switching it off again refuses the next comment.
  await f.store.setCommandWrite('1', ONE, 'deploy-one-release', false);
  assert.equal((await f.resolve('/deploy-one-release')).status, 'refused');
  assert.deepEqual((await f.audit(ONE)).filter(e => e.action === 'set_command_write').map(e => e.detail), [
    { command: 'deploy-one-release', allowWrite: false, previous: true },
    { command: 'deploy-one-release', allowWrite: true, previous: false },
  ]);
});

test('the write grant is consumed once, by the run it was made for: a retry or a later run gets none', async t => {
  const f = await fixture(t);
  await f.enable(ONE);
  await f.store.setCommandWrite('1', ONE, 'deploy-one-release', true);
  const resolved = await f.resolve('/deploy-one-release');
  assert.equal(resolved.status, 'resolved');
  if (resolved.status !== 'resolved') return;
  const grant = resolved.run.writeGrant!;
  const scope = { pluginId: ONE, command: 'deploy-one-release', repository: 'Owner/App', number: 42 };
  assert.equal(await consumePluginCommandWriteGrant(f.database, grant.id, { ...scope, number: 43, taskId: 'other-pr' }), null, 'bound to its pull request');
  assert.equal(await consumePluginCommandWriteGrant(f.database, grant.id, { ...scope, command: 'deploy-one', taskId: 'other' }), null, 'bound to its command');
  assert.deepEqual(await consumePluginCommandWriteGrant(f.database, grant.id, { ...scope, taskId: 'task-1' }), grant.servers);
  assert.equal(await consumePluginCommandWriteGrant(f.database, grant.id, { ...scope, taskId: 'task-1-retry' }), null, 'a retry of the run');
  assert.equal(await consumePluginCommandWriteGrant(f.database, grant.id, { ...scope, taskId: 'later-followup' }), null, 'a later follow-up');
  const row = await f.database('plugin_command_write_grants').where({ id: grant.id }).first();
  assert.equal(row.consumed_by, 'task-1');
  // An expired grant is refused too.
  const late = await f.resolve('/deploy-one-release');
  if (late.status !== 'resolved') return assert.fail('resolved');
  assert.equal(await consumePluginCommandWriteGrant(f.database, late.run.writeGrant!.id, { ...scope, taskId: 'task-2' }, Date.now() + 25 * 60 * 60 * 1000), null);
});

test('with the grant the run resolves exactly the plugin\'s write server; other write servers stay out', async t => {
  const f = await fixture(t);
  await f.enable(ONE);
  await f.enable(TWO);
  await f.store.setCommandWrite('1', ONE, 'deploy-one-release', true);
  const resolved = await f.resolve('/deploy-one-release');
  if (resolved.status !== 'resolved') return assert.fail('resolved');
  const { snapshot } = await f.store.library.head();
  const context = { repository: 'owner/app', agentAlias: 'claude', runtime: 'claude', additional: resolved.run.extensions };
  const granted = resolveExtensionSet(snapshot, { ...context, allowWrite: true, writeServers: resolved.run.writeGrant!.servers });
  const names = granted.servers.map(s => s.name);
  assert.ok(names.includes((await f.managed(ONE, 'deploy-one-api')).name));
  assert.ok(!names.includes((await f.managed(TWO, 'deploy-two-api')).name), 'another plugin\'s auto-applied write server is not covered');
  assert.ok(names.includes((await f.managed(TWO, 'deploy-two-docs')).name), 'read servers still apply');
  const without = resolveExtensionSet(snapshot, { ...context, allowWrite: false });
  assert.ok(!without.servers.some(s => s.capability === 'write'));
  assert.deepEqual(without.skipped.filter(s => s.source === 'additional').map(s => s.reason), ['write_not_authorized']);
});

test('only administrators change the write switch and shared command owners, and only for commands that have them', async t => {
  const f = await fixture(t);
  await f.enable(ONE);
  await f.enable(TWO);
  await assert.rejects(f.store.setCommandWrite('2', ONE, 'deploy-one-release', true), (error: PluginError) => error.status === 403);
  await assert.rejects(f.store.setSharedCommandOwner('2', ONE, 'deploy', ONE), (error: PluginError) => error.status === 403);
  await assert.rejects(f.store.setCommandWrite('1', ONE, 'deploy-one', true), /does not use write access/);
  await assert.rejects(f.store.setCommandWrite('1', ONE, 'missing', true), /Command not found/);
  await assert.rejects(f.store.setCommandWrite('1', ONE, 'deploy-one-release', 'yes'), /allowed must be true or false/);
  await assert.rejects(f.store.setSharedCommandOwner('1', ONE, 'deploy-one', ONE), /is not a shared command/);
  await assert.rejects(f.store.setSharedCommandOwner('1', ONE, 'deploy', 'example-pack'), /is not installed or does not offer \/deploy/);
  assert.equal((await f.database('plugin_command_settings').count({ n: '*' }).first())?.n, 0);
  assert.equal((await f.database('plugin_shared_command_owners').count({ n: '*' }).first())?.n, 0);
});

test('two plugins share /deploy: specific commands work, the plain name follows the owner setting, and without one it names the specific commands', async t => {
  const f = await fixture(t);
  await f.enable(ONE);
  // Both mark /deploy shared, so enabling the second is not refused.
  const enabled = await f.enable(TWO);
  assert.equal(enabled.state, 'enabled');

  const specific = await f.resolve('/deploy-two staging');
  assert.equal(specific.status, 'handler');
  if (specific.status === 'handler') assert.deepEqual(specific.delivery, { pluginId: TWO, pluginName: 'Deploy two', command: 'deploy-two', handler: 'deploy', argument: 'staging' });

  const ambiguous = await f.resolve('/deploy staging');
  assert.equal(ambiguous.status, 'refused');
  if (ambiguous.status === 'refused') {
    assert.equal(ambiguous.message, '/deploy is offered by more than one plugin here: use /deploy-one (Deploy one), /deploy-two (Deploy two) instead. An administrator can choose which plugin /deploy runs on the Plugins page. Nothing was started.');
  }

  const view = await f.store.setSharedCommandOwner('1', ONE, 'deploy', TWO);
  assert.deepEqual(view.commands?.find(c => c.name === 'deploy')?.sharedOwner && { ...view.commands.find(c => c.name === 'deploy')!.sharedOwner!, setAt: 0 }, {
    owner: TWO, setBy: '1', setAt: 0,
    candidates: [
      { pluginId: ONE, pluginName: 'Deploy one', specific: ['deploy-one'], enabled: true },
      { pluginId: TWO, pluginName: 'Deploy two', specific: ['deploy-two'], enabled: true },
    ],
  });
  // The setting belongs to the instance: the other plugin shows the same choice.
  assert.equal((await f.store.get('1', TWO)).commands?.find(c => c.name === 'deploy')?.sharedOwner?.owner, TWO);
  const owned = await f.resolve('/deploy staging');
  assert.equal(owned.status === 'handler' && owned.delivery.pluginId, TWO);
  assert.equal((await f.resolve('/deploy-one')).status === 'handler', true, 'the other plugin\'s specific command still works');

  // Recorded on the plugin it was set from and on the new owner.
  assert.deepEqual((await f.audit(ONE)).filter(e => e.action === 'set_shared_command_owner').map(e => e.detail), [{ command: 'deploy', owner: TWO, previous: null }]);
  assert.deepEqual((await f.audit(TWO)).filter(e => e.action === 'set_shared_command_owner').map(e => e.detail), [{ command: 'deploy', owner: TWO, previous: null, changedFrom: ONE }]);

  // With the owner disabled, the only enabled plugin runs the plain name.
  await f.store.setEnabled('1', TWO, false);
  const only = await f.resolve('/deploy');
  assert.equal(only.status === 'handler' && only.delivery.pluginId, ONE);

  // Cleared: with both enabled again it names the specific commands.
  await f.store.setEnabled('1', TWO, true);
  await f.store.setSharedCommandOwner('1', TWO, 'deploy', null);
  assert.equal((await f.resolve('/deploy', { target: 'issue' })).status, 'refused');

  // Uninstalling the owner clears its choice.
  await f.store.setSharedCommandOwner('1', TWO, 'deploy', TWO);
  await f.store.setEnabled('1', TWO, false);
  await f.store.uninstall('1', TWO, TWO);
  assert.equal(await f.database('plugin_shared_command_owners').first(), undefined);
});

test('a command name one plugin shares and another does not still blocks enabling', async t => {
  const unshared = fixtureManifest(TWO);
  const rival: PluginManifest = { ...unshared, contributes: { ...unshared.contributes, commands: unshared.contributes.commands.map(c => (c.name === 'deploy' ? { ...c, shared: false } : c)) } };
  const f = await fixture(t, [fixtureManifest(ONE), rival]);
  await f.enable(ONE);
  await f.store.install('1', TWO);
  await assert.rejects(f.store.setEnabled('1', TWO, true), /Command \/deploy is also contributed by the enabled plugin Deploy one/);
});

test('a handler command is delivered to its handler with the comment context, comments back through ctx.propr and appears in Activity', async t => {
  const f = await fixture(t);
  await f.enable(ONE);
  const resolved = await f.resolve('/deploy-one production now');
  if (resolved.status !== 'handler') return assert.fail('a handler command');
  const context = { repository: 'owner/app', number: 42, target: 'pull_request' as const, actor: 'maintainer', commentId: 9001 };
  assert.equal(await enqueuePluginCommandDelivery(f.database, resolved.delivery, context), true);
  assert.equal(await enqueuePluginCommandDelivery(f.database, resolved.delivery, context), false, 'a redelivered comment is recorded once');

  const { backend, calls } = recordingBackend();
  const runner = new PluginCommandRunner({
    database: f.database, environment: ENVIRONMENT, catalog: f.catalog, backend,
    handlers: id => loadPluginHandlers(id, { root: FIXTURE_REGISTRY, includeDevelopment: true }),
  });
  assert.equal(await runner.pass(), 1);
  assert.equal(await runner.pass(), 0, 'a succeeded delivery is not attempted again');

  assert.deepEqual(await pluginStateStore(f.database, ONE).get('seen'), [
    { id: 'cmd-pull_request-9001', command: 'deploy-one', args: 'production now', repository: 'owner/app', number: 42, target: 'pull_request', actor: 'maintainer', attempt: 1 },
  ]);
  const comment = calls.find(call => call.operation === 'comment')!;
  assert.deepEqual(comment.args.slice(0, 2), ['owner/app', 42]);
  assert.match(String(comment.args[2]), /^Deploying for @maintainer \(\/deploy-one\)/);
  assert.equal(comment.args[3], 'pull_request');

  const { deliveries } = await listPluginActivity(f.database, ONE);
  assert.equal(deliveries.length, 1);
  const [delivery] = deliveries;
  assert.equal(delivery.kind, 'command');
  assert.equal(delivery.deliveryId, 'cmd-pull_request-9001');
  assert.equal(delivery.eventType, 'command.deploy-one');
  assert.equal(delivery.repository, 'owner/app');
  assert.equal(delivery.eventSeq, 42);
  assert.equal(delivery.handler, 'deploy');
  assert.equal(delivery.status, 'succeeded');
  assert.equal(delivery.attempt, 1);
  assert.ok(delivery.logs.some(line => line.message === '/deploy-one on owner/app#42'));
  await runner.stop();
});

test('a failing handler command is retried on the delivery schedule, and a disabled plugin\'s command is not delivered', async t => {
  const f = await fixture(t);
  await f.enable(ONE);
  let now = 1_000_000;
  const delivery = { pluginId: ONE, pluginName: 'Deploy one', command: 'deploy', handler: 'deploy', argument: 'fail' };
  await enqueuePluginCommandDelivery(f.database, delivery, { repository: 'owner/app', number: 7, target: 'issue', actor: 'maintainer', commentId: 1 }, now);
  const { backend } = recordingBackend();
  const runner = new PluginCommandRunner({
    database: f.database, environment: ENVIRONMENT, catalog: f.catalog, backend, now: () => now, retryDelaysMs: [60_000],
    handlers: id => loadPluginHandlers(id, { root: FIXTURE_REGISTRY, includeDevelopment: true }),
  });
  assert.equal(await runner.pass(), 1);
  let [row] = (await listPluginActivity(f.database, ONE)).deliveries;
  assert.equal(row.status, 'retrying');
  assert.equal(row.nextAttemptAt, now + 60_000);
  assert.match(row.error ?? '', /deploy failed on purpose/);
  assert.equal(await runner.pass(), 0, 'not due yet');
  now += 60_000;
  assert.equal(await runner.pass(), 1);
  [row] = (await listPluginActivity(f.database, ONE)).deliveries;
  assert.equal(row.status, 'failed');
  assert.equal(row.attempt, 2);

  await enqueuePluginCommandDelivery(f.database, { ...delivery, argument: '' }, { repository: 'owner/app', number: 7, target: 'issue', actor: 'maintainer', commentId: 2 }, now);
  await f.database('plugin_installations').where({ plugin_id: ONE }).update({ enabled: false });
  assert.equal(await runner.pass(), 0);
  [row] = (await listPluginActivity(f.database, ONE)).deliveries;
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'Not delivered: the plugin was disabled');
  assert.equal(await enqueuePluginCommandDelivery(f.database, delivery, { repository: 'owner/app', number: 7, target: 'issue', actor: 'maintainer', commentId: 3 }, now), false, 'a disabled plugin records no delivery');
});

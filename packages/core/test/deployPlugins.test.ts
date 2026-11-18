import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pluginManifestSchema, resolveExtensionSet, type PluginManifest } from '@propr/shared';
import { getOfficialPlugin } from '../../plugins/src/index.js';
import { extensionTestResources } from './helpers/extensionTestResources.js';
import { up as identityMigration } from '../src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../src/db/migrations/20261113000000_extension_library.js';
import { up as oauthMigration } from '../src/db/migrations/20261113120000_extension_oauth.js';
import { up as pluginMigration } from '../src/db/migrations/20261114000000_plugin_installations.js';
import { up as pluginStateMigration } from '../src/db/migrations/20261114180000_plugin_state.js';
import { up as journalMigration } from '../src/db/migrations/20261112160000_create_repository_events.js';
import { up as deliveriesMigration } from '../src/db/migrations/20261115000000_plugin_event_deliveries.js';
import { up as webhookKeysMigration } from '../src/db/migrations/20261116000000_plugin_webhook_keys.js';
import { up as commandSettingsMigration } from '../src/db/migrations/20261116120000_plugin_command_settings.js';
import { PluginStore } from '../src/plugins/pluginStore.js';
import { PluginContributions } from '../src/plugins/pluginContributions.js';
import { officialPluginAssets } from '../src/plugins/pluginAssets.js';
import { resolvePluginCommand, type PluginCommandRequest } from '../src/plugins/pluginCommands.js';
import { automationTemplateCatalog } from '../src/plugins/pluginTemplates.js';
import { ExtensionLibraryStore, type ExtensionLaunchContext } from '../src/extensions/extensionProfileStore.js';
import { ExtensionOAuthStore, setExtensionOAuth } from '../src/extensions/extensionOAuthStore.js';
import { extensionGatewayCall } from '../src/extensions/mcpGateway.js';
import { OAUTH_MCP_URL, OAUTH_URLS, syntheticOAuthProvider } from '../../../test/fixtures/extensionOAuthFixture.js';

/**
 * The official deployment plugins (Cloudflare, Vercel) through ProPR's real
 * plugin store, extension library, command resolution and template catalog:
 * connecting and enabling gives a read item applied automatically and a write
 * item that is not; `/deploy` adds the write server only with the command's
 * write switch on and a commenter with write permission; the instruction
 * states the allowed target; two deployment plugins share `/deploy`. Vercel's
 * servers point at the synthetic OAuth MCP endpoint (no network); Cloudflare's
 * API token server is reached through a synthetic upstream at the gateway.
 */

const CF = 'cloudflare';
const VC = 'vercel';
const READ_TOKEN = 'cf-read-token-sentinel-0001';
const DEPLOY_TOKEN = 'cf-deploy-token-sentinel-0002';

function manifest(id: string): PluginManifest {
  const input = structuredClone(getOfficialPlugin(id, { includeDevelopment: false })!.manifest) as { contributes: { mcpServers: { url: string; authentication: string }[] } };
  for (const server of input.contributes.mcpServers) if (server.authentication === 'oauth') server.url = OAUTH_MCP_URL;
  return pluginManifestSchema.parse(input);
}

async function fixture(t: TestContext) {
  const resources = extensionTestResources(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-plugins-'));
  resources.defer(() => fs.rm(root, { recursive: true, force: true }));
  resources.defer(async () => { await (await import('../src/db/connection.js')).closeConnection(); });
  const database = resources.database();
  await database.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); c.text('extensions'); });
  await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }]);
  for (const migration of [identityMigration, grantMigration, libraryMigration, oauthMigration, pluginMigration, pluginStateMigration, journalMigration, deliveriesMigration, webhookKeysMigration, commandSettingsMigration]) await migration(database);
  const environment = { SYSTEM_TASK_SECRET: 'synthetic-plugin-custody', PROPR_EGRESS_SOCKET_DIR: path.join(root, 'egress'), PATH: process.env.PATH };
  const manifests = [manifest(CF), manifest(VC)];
  const catalog = async () => manifests;
  const plugins = new PluginStore(database, environment, catalog, Date.now, new PluginContributions(new ExtensionLibraryStore(database, environment), officialPluginAssets));
  const library = plugins.library;
  // Vercel's authorization server offers dynamic registration and client ID metadata documents.
  const synthetic = syntheticOAuthProvider({ advertise: { dynamic: true, metadataDocument: true } });
  setExtensionOAuth(library, new ExtensionOAuthStore(library, { transport: synthetic.transport, retryDelayMs: 1 }));

  let session = 0;
  const signIn = async (connection: string) => {
    const id = `session-${++session}`;
    const { authorizationUrl } = await plugins.startOAuth('1', VC, connection, id, OAUTH_URLS);
    return plugins.completeOAuth('1', VC, connection, id, synthetic.authorize(authorizationUrl));
  };
  const setUp = {
    async [CF]() {
      await plugins.install('1', CF);
      await plugins.setConnection('1', CF, 'read-token', READ_TOKEN);
      await plugins.setConnection('1', CF, 'deploy-token', DEPLOY_TOKEN);
      return plugins.setEnabled('1', CF, true);
    },
    async [VC]() {
      await plugins.install('1', VC);
      await signIn('vercel-read');
      await signIn('vercel-deploy');
      return plugins.setEnabled('1', VC, true);
    },
  };
  const writers = new Set(['maintainer']);
  const resolve = (body: string, request: Partial<PluginCommandRequest> = {}) => resolvePluginCommand(
    { body, repository: 'owner/app', target: 'pull_request', author: 'maintainer', number: 42, ...request },
    { database, catalog, library: async () => (await library.head()).snapshot, writePermission: async (_repository, login) => writers.has(login) },
  );
  const managed = async (id: string, item: string) => (await library.head()).snapshot.servers.find(s => s.managedBy?.plugin === id && s.managedBy.item === item)!;
  const skill = async (id: string) => (await library.head()).snapshot.skills.find(s => s.managedBy?.plugin === id)!;
  /** What an ordinary run (no command) resolves from the library. */
  const ordinaryRun = async () => resolveExtensionSet(await library.readLibrary('1'), { repository: 'owner/app', agentAlias: 'claude', runtime: 'claude', allowWrite: false }).servers.map(s => s.name);
  return { database, plugins, library, catalog, synthetic, setUp, signIn, resolve, managed, skill, ordinaryRun };
}

test('connecting and enabling each deployment plugin gives its read and write items; only Vercel\'s read item is applied automatically', async t => {
  const f = await fixture(t);
  for (const [id, read, write, readAutoApply] of [[CF, 'cloudflare', 'cloudflare-write', false], [VC, 'vercel', 'vercel-write', true]] as const) {
    const enabled = await f.setUp[id]();
    assert.equal(enabled.state, 'enabled', id);
    assert.ok(enabled.connections.every(c => c.state === 'connected'), `${id}: every connection is connected`);
    const readItem = await f.managed(id, read);
    const writeItem = await f.managed(id, write);
    assert.deepEqual([readItem.capability, readItem.autoApply, readItem.managedBy?.active], ['read', readAutoApply, true], `${id} read item`);
    assert.deepEqual([writeItem.capability, writeItem.autoApply, writeItem.managedBy?.active], ['write', false, true], `${id} write item`);
    assert.equal((await f.skill(id)).autoApply, true);
  }
  // An ordinary run gets Vercel's read server and neither write server, even with write allowed. Cloudflare's read
  // server is not applied automatically: its execute tool calls any endpoint, so only its token keeps it read-only.
  assert.deepEqual((await f.ordinaryRun()).sort(), ['vercel']);
  const unrestricted = resolveExtensionSet(await f.library.readLibrary('1'), { repository: 'owner/app', agentAlias: 'claude', runtime: 'claude' });
  assert.deepEqual(unrestricted.servers.map(s => s.name).sort(), ['vercel'], 'an item that is not auto-applied stays out of runs that do not add it');

  // An administrator's later choice of automatic apply survives a resync (here, a settings change).
  const { snapshot, revision } = await f.library.head().then(async head => ({ snapshot: head.snapshot, revision: (await f.library.readLibrary('1')).revision }));
  await f.library.saveLibrary('1', { version: 1, servers: snapshot.servers.map(s => (s.name === 'vercel-write' ? { ...s, autoApply: true } : s)), skills: snapshot.skills }, {}, revision);
  await f.plugins.updateSettings('1', VC, { teamId: 'team_1' });
  assert.equal((await f.managed(VC, 'vercel-write')).autoApply, true);
});

test('the read server sends the read-only token and lists only its allow-list; the write server sends the deploy token, only under a write grant', async t => {
  const f = await fixture(t);
  await f.setUp[CF]();
  const tokens: (string | undefined)[] = [];
  const catalog = ['docs', 'search', 'execute', 'whoami', 'not-listed'].map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
  const upstream = async (_endpoint: string, body: unknown, token?: string) => {
    tokens.push(token);
    const request = body as { id: number; method: string };
    return { jsonrpc: '2.0', id: request.id, result: request.method === 'tools/list' ? { tools: catalog } : {} };
  };
  const grant = async (context: ExtensionLaunchContext) => {
    const prepared = await f.library.resolveLaunch(context, false);
    const token = await f.library.createGrant(prepared, randomUUID(), undefined, context.allowWrite);
    await f.library.activateGrant(token, prepared, context);
    return { token, servers: prepared.set.servers.map(s => s.name) };
  };
  // Not applied automatically: an ordinary run gets no Cloudflare server until an administrator turns automatic apply on.
  assert.deepEqual((await grant({ agentAlias: 'claude', runtime: 'claude', repositories: ['owner/app'], allowWrite: false })).servers, []);
  const head = await f.library.head();
  await f.library.saveLibrary('1', { version: 1, servers: head.snapshot.servers.map(s => (s.name === 'cloudflare' ? { ...s, autoApply: true } : s)), skills: head.snapshot.skills }, {}, (await f.library.readLibrary('1')).revision);
  const ordinary = await grant({ agentAlias: 'claude', runtime: 'claude', repositories: ['owner/app'], allowWrite: false });
  assert.deepEqual(ordinary.servers, ['cloudflare']);
  const listed = await extensionGatewayCall(f.library, ordinary.token, 'cloudflare', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, upstream) as { result: { tools: { name: string }[] } };
  assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(), ['docs', 'execute', 'search', 'whoami']);
  assert.deepEqual(tokens, [READ_TOKEN]);
  await assert.rejects(extensionGatewayCall(f.library, ordinary.token, 'cloudflare-write', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, upstream));

  // The command's run: the write server is added explicitly and covered by the write grant.
  await f.plugins.setCommandWrite('1', CF, 'deploy-cloudflare', true);
  const resolved = await f.resolve('/deploy-cloudflare');
  assert.equal(resolved.status, 'resolved');
  if (resolved.status !== 'resolved') return;
  const deploy = await grant({ agentAlias: 'claude', runtime: 'claude', repositories: ['owner/app'], allowWrite: true, writeServers: resolved.run.writeGrant!.servers, additional: resolved.run.extensions });
  assert.deepEqual(deploy.servers.sort(), ['cloudflare', 'cloudflare-write']);
  await extensionGatewayCall(f.library, deploy.token, 'cloudflare-write', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, upstream);
  assert.equal(tokens.at(-1), DEPLOY_TOKEN);
});

test('/deploy queues one task with the skill and both servers only when the write switch is on and the commenter has write permission; otherwise it is refused', async t => {
  const f = await fixture(t);
  await f.setUp[VC]();
  for (const command of ['deploy', 'deploy-vercel']) {
    const off = await f.resolve(`/${command}`);
    assert.equal(off.status, 'refused');
    if (off.status === 'refused') assert.match(off.message, new RegExp(`^/${command} of the Vercel plugin needs write access, and an administrator has not allowed it: "Allow this command to use write access" is off for /${command} on the Plugins page\\. Nothing was started\\.$`));
  }
  await f.plugins.setCommandWrite('1', VC, 'deploy', true);
  const outsider = await f.resolve('/deploy', { author: 'drive-by' });
  assert.equal(outsider.status, 'refused');
  if (outsider.status === 'refused') assert.match(outsider.message, /needs write access: only people with write permission on owner\/app can run it\. Nothing was started\.$/);
  // Allowing /deploy does not allow /deploy-vercel: each command has its own switch.
  assert.equal((await f.resolve('/deploy-vercel')).status, 'refused');

  const allowed = await f.resolve('/deploy');
  assert.equal(allowed.status, 'resolved');
  if (allowed.status !== 'resolved') return;
  const read = await f.managed(VC, 'vercel');
  const write = await f.managed(VC, 'vercel-write');
  assert.deepEqual([allowed.run.pluginId, allowed.run.command, allowed.run.kind], [VC, 'deploy', 'prompt']);
  assert.deepEqual(allowed.run.extensions, { servers: [read.name, write.name], skills: [(await f.skill(VC)).bundleId] });
  assert.deepEqual(allowed.run.writeGrant && { ...allowed.run.writeGrant, id: 'id' }, { id: 'id', repository: 'owner/app', number: 42, servers: [write.name] });
  assert.equal(await f.database('plugin_command_write_grants').count({ n: '*' }).first().then(r => Number(r?.n)), 1, 'one grant: one queued run');
  // Issues have no /deploy: it is a pull request command.
  assert.equal((await f.resolve('/deploy', { target: 'issue' })).status, 'none');
});

test('/deploy production: the instruction states preview only until "Allow production deploys from commands" is on, from the installation\'s saved settings', async t => {
  const f = await fixture(t);
  await f.setUp[CF]();
  await f.plugins.setCommandWrite('1', CF, 'deploy', true);
  const instruction = async (body: string) => {
    const resolved = await f.resolve(body);
    assert.equal(resolved.status, 'resolved');
    return resolved.status === 'resolved' ? resolved.run.instruction : '';
  };
  const off = await instruction('/deploy production');
  assert.match(off, /^- Allowed target: preview only\. "Allow production deploys from commands" is off, so refuse a production request and explain how to allow it\.$/m);
  assert.match(off, /^- Default project per repository for owner\/app: not set$/m);

  await f.plugins.updateSettings('1', CF, { accountId: '0123456789abcdef0123456789abcdef', projects: { 'Owner/App': 'app-pages' }, allowProductionDeploys: true });
  const on = await instruction('/deploy production');
  assert.match(on, /^- Allowed target: preview by default; production only when the argument explicitly asks for production/m);
  assert.match(on, /^- Account ID: "0123456789abcdef0123456789abcdef"$/m);
  assert.match(on, /^- Default project per repository for owner\/app: "app-pages"$/m);
  assert.doesNotMatch(on, /Allowed target: preview only/);
});

test('with Cloudflare and Vercel enabled the specific commands work and plain /deploy follows the shared-command owner setting', async t => {
  const f = await fixture(t);
  await f.setUp[CF]();
  const second = await f.setUp[VC]();
  assert.equal(second.state, 'enabled', 'both mark /deploy shared, so enabling the second is not refused');
  for (const [id, command] of [[CF, 'deploy'], [CF, 'deploy-cloudflare'], [VC, 'deploy'], [VC, 'deploy-vercel']] as const) await f.plugins.setCommandWrite('1', id, command, true);

  const ambiguous = await f.resolve('/deploy');
  assert.equal(ambiguous.status, 'refused');
  if (ambiguous.status === 'refused') assert.equal(ambiguous.message, '/deploy is offered by more than one plugin here: use /deploy-cloudflare (Cloudflare), /deploy-vercel (Vercel) instead. An administrator can choose which plugin /deploy runs on the Plugins page. Nothing was started.');
  for (const [command, id] of [['deploy-cloudflare', CF], ['deploy-vercel', VC]] as const) {
    const specific = await f.resolve(`/${command}`);
    assert.equal(specific.status === 'resolved' && specific.run.pluginId, id, command);
  }

  await f.plugins.setSharedCommandOwner('1', CF, 'deploy', VC);
  const owned = await f.resolve('/deploy');
  assert.equal(owned.status === 'resolved' && owned.run.pluginId, VC);
  if (owned.status === 'resolved') assert.deepEqual(owned.run.writeGrant?.servers, [(await f.managed(VC, 'vercel-write')).name], 'only the owner\'s write server');
  await f.plugins.setSharedCommandOwner('1', VC, 'deploy', CF);
  const switched = await f.resolve('/deploy');
  assert.equal(switched.status === 'resolved' && switched.run.pluginId, CF);
  assert.equal((await f.resolve('/deploy-vercel')).status === 'resolved', true, 'the other plugin\'s specific command still works');
});

test('each deployment template is offered only while its plugin is enabled', async t => {
  const f = await fixture(t);
  const offered = async () => (await automationTemplateCatalog(f.database, f.catalog)).templates.filter(template => template.plugin).map(template => [template.id, template.plugin!.id, template.autonomy]);
  await f.plugins.install('1', CF);
  assert.deepEqual(await offered(), [], 'installed but not enabled');
  await f.setUp[VC]();
  await f.plugins.setConnection('1', CF, 'read-token', READ_TOKEN);
  await f.plugins.setConnection('1', CF, 'deploy-token', DEPLOY_TOKEN);
  await f.plugins.setEnabled('1', CF, true);
  assert.deepEqual(await offered(), [['cloudflare-deploy-preview-ready', CF, 'dry_run'], ['vercel-deploy-preview-ready', VC, 'dry_run']]);
  await f.plugins.setEnabled('1', VC, false);
  assert.deepEqual(await offered(), [['cloudflare-deploy-preview-ready', CF, 'dry_run']]);
});

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pluginManifestSchema, type ExtensionLibraryInput, type ExtensionLibraryServerInput, type PluginManifest } from '@propr/shared';
import { getOfficialPlugin } from '../../plugins/src/index.js';
import { extensionTestResources } from './helpers/extensionTestResources.js';
import { npmRegistryFixture } from './helpers/npmRegistryFixture.js';
import { up as identityMigration } from '../src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../src/db/migrations/20261113000000_extension_library.js';
import { up as oauthMigration } from '../src/db/migrations/20261113120000_extension_oauth.js';
import { up as pluginMigration } from '../src/db/migrations/20261114000000_plugin_installations.js';
import { PluginError, PluginStore } from '../src/plugins/pluginStore.js';
import { PluginContributions } from '../src/plugins/pluginContributions.js';
import { officialPluginAssets, type PluginAssetSource } from '../src/plugins/pluginAssets.js';
import { ExtensionLibraryStore } from '../src/extensions/extensionProfileStore.js';
import { extensionOAuth } from '../src/extensions/extensionOAuthStore.js';
import { automationTemplateCatalog, pluginTemplateIds } from '../src/plugins/pluginTemplates.js';
import { AUTOMATION_TEMPLATE_CATALOG } from '@propr/shared';
import { ExtensionOAuthStore, setExtensionOAuth } from '../src/extensions/extensionOAuthStore.js';
import { chooseRegistration, type AuthorizationServerMetadata } from '../src/extensions/extensionOAuth.js';
import { executeWithExtensions, currentExtensionLaunch } from '../src/extensions/extensionLaunch.js';
import { taskRunExtensionRequest } from '../src/extensions/extensionRunResolution.js';
import { ExtensionPackageCache, type NpmRunner } from '../src/extensions/packageCache.js';
import type { AgentConfig, AgentExtensionRequest, AgentTaskOptions } from '../src/agents/types.js';
import logger from '../src/utils/logger.js';
import { OAUTH_MCP_URL, OAUTH_URLS, PREREGISTERED_CLIENT, syntheticOAuthProvider, type SyntheticOAuthOptions } from '../../../test/fixtures/extensionOAuthFixture.js';

const ID = 'example-pack';
const TOKEN_SENTINEL = 'PLUGIN_PACKAGE_TOKEN_SENTINEL_7c41e9_DO_NOT_DISCLOSE';
const claude = { type: 'claude', alias: 'claude-main', id: randomUUID(), enabled: true, dockerImage: 'synthetic', configPath: '/unused', supportedModels: ['synthetic'] } as AgentConfig;
const result = { success: true, executionTimeMs: 0, modifiedFiles: [], commitMessage: null, logs: '', modelUsed: 'synthetic' };
const issueTask = (repository = 'team/repo'): AgentExtensionRequest => taskRunExtensionRequest({ kind: 'issue', repository, labels: [] });

/** The example plugin, its remote server pointed at the synthetic OAuth MCP endpoint (an address literal: no DNS in tests). */
function exampleManifest(change: (input: Record<string, any>) => void = () => {}): PluginManifest { // eslint-disable-line @typescript-eslint/no-explicit-any
  const input = structuredClone(getOfficialPlugin(ID, { includeDevelopment: true })!.manifest) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  input.contributes.mcpServers[0].url = OAUTH_MCP_URL;
  change(input);
  return pluginManifestSchema.parse(input);
}

async function fixture(t: TestContext, options: { advertise?: SyntheticOAuthOptions['advertise'] } = {}) {
  const resources = extensionTestResources(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-contributions-'));
  const registry = await npmRegistryFixture();
  resources.defer(() => registry.close());
  const previous = process.env.PROPR_EGRESS_SOCKET_DIR; process.env.PROPR_EGRESS_SOCKET_DIR = path.join(root, 'egress');
  resources.defer(async () => {
    if (previous === undefined) delete process.env.PROPR_EGRESS_SOCKET_DIR; else process.env.PROPR_EGRESS_SOCKET_DIR = previous;
    await fs.chmod(root, 0o755); await fs.rm(root, { recursive: true, force: true }).catch(async () => { await import('node:child_process').then(c => c.execFileSync('chmod', ['-R', 'u+w', root])); await fs.rm(root, { recursive: true, force: true }); });
  });
  resources.defer(async () => { await (await import('../src/db/connection.js')).closeConnection(); });
  const database = resources.database();
  await database.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); c.text('extensions'); });
  await database.schema.createTable('tasks', c => c.string('task_id').primary());
  await database.schema.createTable('task_history', c => { c.string('task_id'); c.string('state'); c.string('timestamp'); c.text('reason'); c.text('metadata'); });
  await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }, { github_user_id: '2', role: 'member' }]);
  await identityMigration(database); await grantMigration(database); await libraryMigration(database); await oauthMigration(database); await pluginMigration(database);
  const environment = { SYSTEM_TASK_SECRET: 'synthetic-plugin-custody', PROPR_EXTENSION_NPM_REGISTRY: registry.url, PROPR_EGRESS_SOCKET_DIR: path.join(root, 'egress'), PATH: process.env.PATH };
  let manifests = [exampleManifest()];
  const catalog = async () => manifests;
  /** Skill assets as shipped, unless a test makes them unavailable or changes them. */
  let skillAssets: 'shipped' | 'unavailable' | 'changed' = 'shipped';
  const assets: PluginAssetSource = {
    automationTemplate: (manifest, templatePath) => officialPluginAssets.automationTemplate(manifest, templatePath),
    async skillFiles(manifest, skillPath) {
      if (skillAssets === 'unavailable') throw new Error('asset folder missing');
      const files = await officialPluginAssets.skillFiles(manifest, skillPath);
      if (skillAssets === 'shipped') return files;
      return files.map(file => (file.path === 'SKILL.md' ? { ...file, content: Buffer.from(`${Buffer.from(file.content, 'base64').toString()}\nChanged by an upgrade.\n`).toString('base64') } : file));
    },
  };
  const plugins = new PluginStore(database, environment, catalog, Date.now, new PluginContributions(new ExtensionLibraryStore(database, environment), assets));
  const library = plugins.library;
  const synthetic = syntheticOAuthProvider({ advertise: options.advertise ?? { dynamic: true } });
  setExtensionOAuth(library, new ExtensionOAuthStore(library, { transport: synthetic.transport, retryDelayMs: 1 }));
  let installs = 0;
  const npm: NpmRunner = (args, options) => new Promise((resolve, reject) => {
    installs++;
    const child = spawn('npm', args, { ...options, stdio: 'ignore' });
    child.on('error', reject); child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`npm ${code}`))));
  });
  const cache = new ExtensionPackageCache(environment, npm);
  const worktree = path.join(root, 'worktree'); await fs.mkdir(worktree);
  /** Launch one run; what its container would receive and what its task event records. */
  const run = async (extensions: AgentExtensionRequest = issueTask()) => {
    const taskId = randomUUID();
    await database('tasks').insert({ task_id: taskId });
    let launched: AgentTaskOptions | undefined; let mounts: string[] = [];
    const options: AgentTaskOptions = { extensions, taskId, issueRef: { repoOwner: 'team', repoName: 'repo', number: 1 }, worktreePath: worktree, prompt: 'Run', githubToken: '' };
    await executeWithExtensions(claude, options, async prepared => {
      const launch = currentExtensionLaunch();
      if (launch) { await launch.beforeLaunch(); mounts = launch.mounts; }
      launched = prepared;
      return result;
    }, library, { packageCache: cache });
    const history = await database('task_history').where({ task_id: taskId });
    const event = history.map(h => JSON.parse(h.metadata)).find(m => m.event === 'extensions.resolved');
    const policy = launched!.toolPolicy;
    return {
      launched: launched!, mounts, event, history,
      local: policy?.localMcpServers?.map(s => s.name) ?? [], remote: policy?.mcpServers?.map(s => s.name) ?? [],
      skills: [...(launched!.prompt.matchAll(/for ([a-z-]+)\. Declared/g))].map(m => m[1]),
    };
  };
  /** Sign in the plugin's OAuth connection through the plugin routes' Core methods. */
  const connect = async () => {
    const { authorizationUrl } = await plugins.startOAuth('1', ID, 'example-account', 'session-a', OAUTH_URLS);
    return plugins.completeOAuth('1', ID, 'example-account', 'session-a', synthetic.authorize(authorizationUrl));
  };
  /** Install with the acknowledgement, store the token and enable. */
  const enable = async () => {
    await plugins.install('1', ID, ['example-local']);
    await plugins.setConnection('1', ID, 'example-token', TOKEN_SENTINEL);
    return plugins.setEnabled('1', ID, true);
  };
  const head = async () => library.readLibrary('1');
  const save = async (mutate: (input: ExtensionLibraryInput) => ExtensionLibraryInput, secrets: Record<string, string | null> = {}) => {
    const current = await head();
    return library.saveLibrary('1', mutate({ version: 1, servers: current.servers, skills: current.skills }), secrets, current.revision);
  };
  return { environment, assets, database, plugins, library, cache, registry, synthetic, run, connect, enable, head, save, catalog, installs: () => installs, setCatalog: (next: PluginManifest[]) => { manifests = next; }, setSkillAssets: (next: typeof skillAssets) => { skillAssets = next; } };
}

/** A refusal with this status: plugin refusals are PluginError, library refusals ExtensionError. */
const refused = (status: number, pattern?: RegExp) => (error: unknown) => {
  const refusal = error as PluginError;
  assert.ok(refusal instanceof Error && typeof refusal.status === 'number', String(error));
  assert.equal(refusal.status, status, refusal.message);
  if (pattern) assert.match(refusal.message, pattern);
  return true;
};

test('enabling the example plugin adds managed library items and its template; runs get them; disable, re-enable and uninstall', async t => {
  const f = await fixture(t);
  await f.plugins.install('1', ID, ['example-local']);
  // Installed but disabled: the managed items exist, inactive, so the OAuth connection can be signed in first.
  let library = await f.head();
  assert.deepEqual(library.servers.map(s => [s.name, s.kind, s.managedBy]), [
    ['example-remote', 'https', { plugin: ID, item: 'example-remote', active: false, registrations: ['metadata_document', 'dynamic', 'preregistered'] }],
    ['example-local', 'package', { plugin: ID, item: 'example-local', active: false }],
  ]);
  assert.equal(library.skills.length, 1);
  assert.deepEqual(library.skillBundles.map(b => [b.name, b.source]), [['example-notes', { kind: 'plugin', plugin: ID, version: '0.1.0', path: 'skills/example-notes' }]]);
  assert.equal((await automationTemplateCatalog(f.database, f.catalog)).templates.some(t => t.plugin), false, 'templates of a disabled plugin are hidden');

  await f.plugins.setConnection('1', ID, 'example-token', TOKEN_SENTINEL);
  await f.connect();
  const enabled = await f.plugins.setEnabled('1', ID, true);
  assert.deepEqual(enabled.connections.map(c => [c.name, c.state]), [['example-account', 'connected'], ['example-token', 'connected']]);
  assert.deepEqual(enabled.contributions?.mcpServers.map(s => [s.name, s.managed?.name, s.managed?.active]), [['example-remote', 'example-remote', true], ['example-local', 'example-local', true]]);
  assert.equal(enabled.contributions?.skills[0].managed?.bundleId, library.skills[0].bundleId);
  assert.deepEqual(enabled.contributions?.automationTemplates, [{ id: 'example-weekly-digest', catalogId: 'example-weekly-digest', available: true, href: '/api/automation-definitions/templates' }]);
  library = await f.head();
  // Managed items default to automatic apply on, for every repository while the plugin has no repository limit.
  for (const item of [...library.servers, ...library.skills]) assert.deepEqual([item.enabled, item.autoApply, item.repositories, item.managedBy?.active], [true, true, [], true]);
  const local = library.servers[1];
  assert.equal(local.kind === 'package' && local.integrity, exampleManifest().contributes.mcpServers[1].kind === 'package' && (exampleManifest().contributes.mcpServers[1] as { integrity: string }).integrity);
  assert.deepEqual(library.acknowledgements?.['example-local'], { actor: '1', at: (await f.plugins.get('1', ID)).installation!.acknowledgements['example-local'].at, package: 'propr-fixture-mcp', version: '1.0.0', secretEnv: ['FIXTURE_TOKEN'] });
  assert.deepEqual(library.secrets['example-local'], { count: 1, configured: true, configuredEnv: ['FIXTURE_TOKEN'] });

  const catalog = await automationTemplateCatalog(f.database, f.catalog);
  const template = catalog.templates.find(t => t.plugin);
  assert.deepEqual([template?.id, template?.name, template?.plugin], ['example-weekly-digest', 'Example weekly digest', { id: ID, name: 'Example pack' }]);
  assert.match(template!.prompt, /\S/);

  // A run in a matching repository gets the remote server, the package server and the skill through normal resolution.
  const first = await f.run();
  assert.deepEqual([first.remote, first.local, first.skills], [['example-remote'], ['example-local'], ['example-notes']]);
  assert.equal(f.installs(), 1, 'the package is installed once');
  assert.ok(first.mounts.some(m => /target=\/opt\/propr\/packages\/0,readonly/.test(m)), 'mounted read-only');
  const bridge = JSON.parse(Buffer.from(first.launched.toolPolicy!.localMcpServers![0].bridgeConfig, 'base64url').toString());
  assert.deepEqual(bridge.secretEnv, { FIXTURE_TOKEN: 'PROPR_EXTENSION_STDIO_0_0_SECRET' });
  assert.deepEqual(bridge.env, { FIXTURE_GREETING: 'hello' });
  assert.equal(first.launched.toolPolicy!.localMcpServers![0].env?.PROPR_EXTENSION_STDIO_0_0_SECRET, TOKEN_SENTINEL);
  await f.cache.verify(library.servers[1] as Extract<typeof library.servers[number], { kind: 'package' }>);
  await f.run();
  assert.equal(f.installs(), 1, 'later runs reuse the verified install');

  // The administrator may change enabled, limits and automatic apply.
  await f.save(input => ({ ...input, servers: input.servers.map(s => (s.name === 'example-local' ? { ...s, repositories: ['team/repo'], agents: ['claude-main'] } : s)) }));
  assert.deepEqual((await f.run(issueTask('team/other'))).local, []);
  // A client that rebuilds an item from its editable fields (no managedBy) keeps the item managed.
  const rebuilt = await f.save(input => ({ ...input, skills: input.skills.map(({ bundleId, enabled, repositories, autoApply }) => ({ bundleId, enabled, repositories, autoApply, agents: ['claude-main'] })) }));
  assert.deepEqual([rebuilt.skills[0].agents, rebuilt.skills[0].managedBy?.plugin], [['claude-main'], ID]);
  // Nothing else of a managed item can change through the library API.
  const pkg = (change: Record<string, unknown>) => (input: ExtensionLibraryInput) => ({ ...input, servers: input.servers.map(s => (s.name === 'example-local' ? { ...s, ...change } as ExtensionLibraryServerInput : s)) });
  for (const change of [{ package: 'propr-fixture-multi' }, { version: '2.0.0' }, { integrity: `sha512-${'A'.repeat(86)}==` }, { args: ['--evil'] }, { env: [{ name: 'FIXTURE_GREETING', value: 'changed' }] }, { secretEnv: [] }, { tools: ['echo'] }, { capability: 'write' }, { managedBy: { plugin: ID, item: 'example-local', active: false } }]) {
    await assert.rejects(f.save(pkg(change)), refused(409, /managed by plugin example-pack/), JSON.stringify(change));
  }
  await assert.rejects(f.save(input => ({ ...input, servers: input.servers.map(s => (s.name === 'example-remote' ? { ...s, url: 'https://8.8.4.4/mcp' } : s)) })), refused(409, /managed by plugin/));
  await assert.rejects(f.save(input => ({ ...input, servers: input.servers.filter(s => s.name !== 'example-remote') })), refused(409, /uninstall the plugin/));
  await assert.rejects(f.save(input => ({ ...input, skills: [] })), refused(409, /uninstall the plugin/));
  await assert.rejects(f.save(input => input, { 'example-local/FIXTURE_TOKEN': 'other-value' }), refused(409, /comes from its plugin/));
  await assert.rejects(f.library.replaceSecret('1', 'example-local/FIXTURE_TOKEN', null), refused(409, /plugin/));
  await assert.rejects(f.save(input => ({ ...input, servers: [...input.servers, { kind: 'https', name: 'forged', url: OAUTH_MCP_URL, enabled: false, tools: [], capability: 'read', authentication: 'none', repositories: [], agents: [], autoApply: true, managedBy: { plugin: ID, item: 'forged', active: true } }] })), refused(400, /Only ProPR/));

  // Disabling deactivates the managed items and hides the template.
  await f.plugins.setEnabled('1', ID, false);
  const off = await f.run();
  assert.equal(off.launched.toolPolicy, undefined);
  assert.ok(!off.launched.prompt.includes('example-notes'));
  assert.equal((await automationTemplateCatalog(f.database, f.catalog)).templates.some(t => t.plugin), false);
  // Re-enabling restores them with settings and connections intact.
  const again = await f.plugins.setEnabled('1', ID, true);
  assert.equal(again.connections[0].state, 'connected');
  const restored = await f.head();
  assert.deepEqual(restored.servers.find(s => s.name === 'example-local')?.repositories, ['team/repo']);
  const back = await f.run();
  assert.deepEqual([back.remote, back.local, back.skills], [['example-remote'], ['example-local'], ['example-notes']]);

  // Uninstall is refused while an automation adds a managed item explicitly, naming the automation.
  await f.database('agent_definitions').insert({ id: 'a1', name: 'Nightly notes', extensions: JSON.stringify({ servers: ['example-local'], skills: [] }) });
  await assert.rejects(f.plugins.uninstall('1', ID, ID), refused(409, /"Nightly notes" \(example-local\)/));
  assert.equal((await f.plugins.get('1', ID)).state, 'enabled', 'the refused uninstall changed nothing');
  await f.database('agent_definitions').where({ id: 'a1' }).delete();
  await f.plugins.uninstall('1', ID, ID);
  const removed = await f.head();
  assert.deepEqual([removed.servers, removed.skills], [[], []]);
  assert.equal((await f.database('extension_oauth_connections').select()).length, 0, 'the OAuth connection goes with its server');
  assert.equal((await f.run()).launched.toolPolicy, undefined);
});

test('a missing package secret skips the server for the run; without a current acknowledgement it is never launched', async t => {
  const f = await fixture(t);
  await f.enable();
  // As after a native export: the connection value is gone. The next plugin change syncs it.
  await f.database('plugin_secrets').delete();
  await f.plugins.updateSettings('1', ID, { verbosity: 'quiet' });
  const missing = await f.run();
  assert.deepEqual(missing.local, []);
  assert.deepEqual(missing.event.skipped.filter((s: { name: string }) => s.name === 'example-local'), [{ kind: 'server', name: 'example-local', reason: 'secret_not_configured', source: 'auto' }]);
  assert.deepEqual(missing.skills, ['example-notes'], 'the run proceeds with the other items');
  assert.equal(f.installs(), 0);

  // An upgrade that changes the package needs the acknowledgement again: until approved the server stays inactive.
  await f.plugins.setConnection('1', ID, 'example-token', TOKEN_SENTINEL);
  f.setCatalog([exampleManifest(input => { input.version = '0.2.0'; input.contributes.mcpServers[1].version = '1.0.1'; })]);
  const pending = await f.plugins.updateSettings('1', ID, { verbosity: 'normal' });
  assert.equal(pending.needsApproval, true);
  const local = (await f.head()).servers.find(s => s.name === 'example-local')!;
  assert.deepEqual([local.kind === 'package' && local.version, local.managedBy?.active], ['1.0.1', false]);
  assert.equal((await f.head()).acknowledgements?.['example-local'], undefined, 'the library records no acknowledgement for it');
  const unacknowledged = await f.run();
  assert.deepEqual(unacknowledged.local, []);
  assert.equal(f.installs(), 0, 'never installed or launched');
});

test('a managed OAuth server is left out of runs until its plugin connection is connected; disconnecting removes it', async t => {
  const f = await fixture(t);
  const view = await f.enable();
  assert.equal(view.connections[0].state, 'not_connected');
  const before = await f.run();
  assert.deepEqual(before.remote, []);
  assert.deepEqual(before.event.skipped.find((s: { name: string }) => s.name === 'example-remote'), { kind: 'server', name: 'example-remote', reason: 'oauth_not_connected', source: 'auto' });
  await assert.rejects(f.plugins.setConnection('1', ID, 'example-account', 'value'), refused(400, /sign-in/));
  await assert.rejects(f.plugins.startOAuth('2', ID, 'example-account', 'session-a', OAUTH_URLS), refused(403));
  await assert.rejects(f.plugins.startOAuth('1', ID, 'example-token', 'session-a', OAUTH_URLS), refused(404));
  // A sign-in of another plugin connection or library server cannot be completed here.
  await assert.rejects(f.plugins.completeOAuth('1', ID, 'example-account', 'session-a', { state: 'x'.repeat(43), code: 'c' }), refused(400));
  const connected = await f.connect();
  assert.equal(connected.connections[0].state, 'connected');
  assert.deepEqual((await f.run()).remote, ['example-remote']);
  const disconnected = await f.plugins.disconnectOAuth('1', ID, 'example-account');
  assert.equal(disconnected.connections[0].state, 'not_connected');
  assert.deepEqual((await f.run()).remote, []);
  const audit = (await f.plugins.get('1', ID)).audit.map(a => a.action);
  assert.deepEqual(audit.slice(0, 3), ['disconnect_oauth', 'complete_oauth', 'start_oauth']);
});

test('a name collision with an existing library item prefixes the managed item with the plugin id', async t => {
  const f = await fixture(t);
  await f.library.saveLibrary('1', { version: 1, servers: [{ kind: 'https', name: 'example-local', url: OAUTH_MCP_URL, enabled: true, tools: [], capability: 'read', authentication: 'none', repositories: [], agents: [], autoApply: false }], skills: [] }, {}, 0);
  await f.enable();
  const library = await f.head();
  assert.deepEqual(library.servers.map(s => [s.name, s.managedBy?.item ?? null]), [['example-local', null], ['example-remote', 'example-remote'], ['example-pack-example-local', 'example-local']]);
  assert.deepEqual(library.secrets['example-pack-example-local'], { count: 1, configured: true, configuredEnv: ['FIXTURE_TOKEN'] });
  assert.deepEqual((await f.run()).local, ['example-pack-example-local']);
  // The administrator's own item stays editable and removable.
  await f.save(input => ({ ...input, servers: input.servers.filter(s => s.name !== 'example-local') }));
});

test('plugin secrets never appear in responses, library revisions, task events or logs', async t => {
  const f = await fixture(t);
  const lines: string[] = [];
  for (const level of ['info', 'warn', 'error', 'debug'] as const) t.mock.method(logger, level, (...args: unknown[]) => { lines.push(JSON.stringify(args)); });
  const views = [await f.enable(), await f.connect()];
  const runs = [await f.run(), await f.run()];
  const visible = JSON.stringify([
    views, await f.plugins.list('1'), await f.plugins.get('1', ID), await f.head(), await f.library.history('1'),
    runs.map(r => [r.event, r.history, r.launched.toolPolicy?.localMcpServers?.map(s => s.bridgeConfig)]),
    await f.database('extension_library_revisions').select('snapshot', 'secrets_encrypted'), await f.database('plugin_secrets').select('sealed'), await f.database('plugin_audit').select(),
    await automationTemplateCatalog(f.database, f.catalog), lines,
  ]);
  assert.ok(!visible.includes(TOKEN_SENTINEL));
});

test('disabling deactivates the existing managed items even when the upgraded manifest drops a referenced server and its skill assets are unavailable', async t => {
  const f = await fixture(t);
  await f.enable();
  const before = await f.head();
  await f.database('agent_definitions').insert({ id: 'a1', name: 'Nightly notes', extensions: JSON.stringify({ servers: ['example-local'], skills: [] }) });
  // A ProPR upgrade drops the package server from the manifest, and the skill folder cannot be read.
  f.setCatalog([exampleManifest(input => { input.version = '0.2.0'; input.contributes.mcpServers = input.contributes.mcpServers.filter((s: { name: string }) => s.name !== 'example-local'); })]);
  f.setSkillAssets('unavailable');
  const disabled = await f.plugins.setEnabled('1', ID, false);
  assert.equal(disabled.state, 'installed');
  const after = await f.head();
  // The items stay as they were, only deactivated: the upgrade is not applied by the disable.
  assert.deepEqual(after.servers.map(s => [s.name, s.managedBy?.active]), [['example-remote', false], ['example-local', false]]);
  assert.deepEqual(after.skills.map(s => [s.bundleId, s.managedBy?.active]), [[before.skills[0].bundleId, false]]);
  const off = await f.run({ ...issueTask(), servers: ['example-local'] });
  assert.equal(off.launched.toolPolicy, undefined, 'a deactivated item never applies, even where an automation adds it');
  assert.ok(!off.launched.prompt.includes('example-notes'));
  // Operations that do apply the upgrade keep its validation: unavailable assets, then the referenced removal.
  await assert.rejects(f.plugins.updateSettings('1', ID, { verbosity: 'quiet' }), refused(409, /Skill example-notes of the plugin is unavailable/));
  f.setSkillAssets('shipped');
  await assert.rejects(f.plugins.updateSettings('1', ID, { verbosity: 'quiet' }), refused(409, /"Nightly notes" \(example-local\).*before upgrading it/));
  await f.database('agent_definitions').where({ id: 'a1' }).delete();
  await f.plugins.updateSettings('1', ID, { verbosity: 'quiet' });
  assert.deepEqual((await f.head()).servers.map(s => s.name), ['example-remote'], 'once unreferenced, the upgrade removes the dropped server');
});

test('a skill upgrade that replaces the bundle an automation adds explicitly is refused until the automation stops adding it', async t => {
  const f = await fixture(t);
  await f.enable();
  // The automation adds the plugin skill explicitly; automatic apply is off, so only that reference applies it.
  await f.save(input => ({ ...input, skills: input.skills.map(s => ({ ...s, autoApply: false })) }));
  const original = (await f.head()).skills[0].bundleId;
  await f.database('agent_definitions').insert({ id: 'a1', name: 'Nightly notes', extensions: JSON.stringify({ servers: [], skills: [original] }) });
  assert.deepEqual((await f.run({ ...issueTask(), skills: [original] })).skills, ['example-notes']);

  // An upgrade changes the skill's files under the same manifest name: the skill would get a new bundle id.
  f.setSkillAssets('changed');
  await assert.rejects(f.plugins.updateSettings('1', ID, { verbosity: 'quiet' }), refused(409, new RegExp(`"Nightly notes" \\(${original}\\).*before upgrading it`)));
  const kept = await f.head();
  assert.deepEqual(kept.skills.map(s => s.bundleId), [original], 'the refused change left the library reference in place');
  assert.equal(kept.skillBundles.length, 1, 'no replacement bundle was stored');
  assert.deepEqual((await f.run({ ...issueTask(), skills: [original] })).skills, ['example-notes'], 'the automation keeps its skill');
  // Disabling still works without applying the upgrade.
  await f.plugins.setEnabled('1', ID, false);
  assert.deepEqual((await f.head()).skills.map(s => [s.bundleId, s.managedBy?.active]), [[original, false]]);

  // Once the automation no longer adds it, the upgrade applies and the skill gets its new bundle.
  await f.database('agent_definitions').where({ id: 'a1' }).delete();
  await f.plugins.setEnabled('1', ID, true);
  const upgraded = await f.head();
  assert.notEqual(upgraded.skills[0].bundleId, original);
  assert.equal(upgraded.skills[0].managedBy?.active, true);
});

test('a plugin OAuth connection signs in only through the registration methods it permits, through plugin and extension routes alike', async t => {
  const onlyMetadataDocument = () => exampleManifest(input => { input.connections.find((c: { name: string }) => c.name === 'example-account').registrations = ['metadata_document']; });
  // The provider offers dynamic registration but no client metadata documents.
  const f = await fixture(t);
  f.setCatalog([onlyMetadataDocument()]);
  await f.enable();
  const remote = (await f.head()).servers.find(s => s.name === 'example-remote')!;
  assert.deepEqual(remote.managedBy?.registrations, ['metadata_document']);
  await assert.rejects(f.plugins.startOAuth('1', ID, 'example-account', 'session-a', OAUTH_URLS), refused(409, /none of the client registration methods the plugin permits \(metadata_document\)/));
  await assert.rejects(extensionOAuth(f.library).startSignIn('1', 'session-a', 'example-remote', OAUTH_URLS), refused(409, /registration methods the plugin permits/));
  assert.equal(f.synthetic.state.registrations, 0, 'no client was registered dynamically');
  assert.equal((await f.database('extension_oauth_pending').select()).length, 0, 'a refused start leaves no sign-in record');
  // The restriction is part of the read-only definition: a library save cannot drop it.
  await assert.rejects(f.save(input => ({ ...input, servers: input.servers.map(s => (s.name === 'example-remote' ? { ...s, managedBy: { plugin: ID, item: 'example-remote', active: true } } : s)) })), refused(409, /managed by plugin/));

  // A provider that supports client metadata documents signs in with one.
  const g = await fixture(t, { advertise: { metadataDocument: true, dynamic: true } });
  g.setCatalog([onlyMetadataDocument()]);
  await g.enable();
  const connected = await g.connect();
  assert.equal(connected.connections[0].state, 'connected');
  assert.equal(g.synthetic.state.registrations, 0);
  assert.equal((await g.database('extension_oauth_connections').first('registration')).registration, 'metadata_document');
});

test('disabling works when the stored credentials cannot be decrypted, and carries them over sealed', async t => {
  const f = await fixture(t);
  await f.enable();
  await f.connect();
  // As after a raw restore under another encryption root: neither plugin connections nor library credentials open.
  const restored = new PluginStore(f.database, { ...f.environment, SYSTEM_TASK_SECRET: 'another-encryption-root' }, f.catalog, Date.now, new PluginContributions(new ExtensionLibraryStore(f.database, { ...f.environment, SYSTEM_TASK_SECRET: 'another-encryption-root' }), f.assets));
  await assert.rejects(restored.updateSettings('1', ID, { verbosity: 'quiet' }), 'applying the manifest needs the credentials');
  const before = await f.database('extension_library_revisions').orderBy('revision', 'desc').first('revision', 'secrets_encrypted');
  const disabled = await restored.setEnabled('1', ID, false);
  assert.equal(disabled.state, 'installed');
  const after = await f.head();
  assert.deepEqual([...after.servers, ...after.skills].map(item => item.managedBy?.active), [false, false, false], 'every managed item is deactivated');
  assert.deepEqual(after.secrets['example-local'], { count: 1, configured: true, configuredEnv: ['FIXTURE_TOKEN'] }, 'credential statuses carry over');
  const latest = await f.database('extension_library_revisions').orderBy('revision', 'desc').first('revision', 'secrets_encrypted');
  assert.equal(latest.revision, before.revision + 1);
  assert.equal(latest.secrets_encrypted, `${before.revision}:${before.secrets_encrypted}`, 'the sealed bytes carry over undecrypted');
  assert.equal((await f.run()).launched.toolPolicy, undefined);
  // Under the original root, re-enabling restores the items with their credentials and OAuth connection.
  const again = await f.plugins.setEnabled('1', ID, true);
  assert.deepEqual(again.connections.map(c => c.state), ['connected', 'connected']);
  const back = await f.run();
  assert.deepEqual([back.remote, back.local], [['example-remote'], ['example-local']]);
  assert.equal(back.launched.toolPolicy!.localMcpServers![0].env?.PROPR_EXTENSION_STDIO_0_0_SECRET, TOKEN_SENTINEL);
});

test('a plugin OAuth connection that permits only pre-registration signs in with the client configured on the plugin', async t => {
  // The provider offers neither dynamic registration nor client metadata documents.
  const f = await fixture(t, { advertise: {} });
  f.setCatalog([exampleManifest(input => { input.connections.find((c: { name: string }) => c.name === 'example-account').registrations = ['preregistered']; })]);
  await f.enable();
  await assert.rejects(f.plugins.startOAuth('1', ID, 'example-account', 'session-a', OAUTH_URLS), refused(409), 'no client configured yet');
  // Validation of the configuration route.
  await assert.rejects(f.plugins.setOAuthClient('2', ID, 'example-account', { clientId: PREREGISTERED_CLIENT.id }), refused(403));
  await assert.rejects(f.plugins.setOAuthClient('1', ID, 'example-token', { clientId: PREREGISTERED_CLIENT.id }), refused(404));
  for (const invalid of [{}, { clientId: 'has space' }, { clientId: PREREGISTERED_CLIENT.id, extra: 1 }, { clientId: PREREGISTERED_CLIENT.id, clientSecret: '' }, 'client']) {
    await assert.rejects(f.plugins.setOAuthClient('1', ID, 'example-account', invalid), refused(400), JSON.stringify(invalid));
  }

  const configured = await f.plugins.setOAuthClient('1', ID, 'example-account', { clientId: PREREGISTERED_CLIENT.id, clientSecret: PREREGISTERED_CLIENT.secret });
  assert.deepEqual([configured.connections[0].state, configured.connections[0].setBy], ['not_connected', '1']);
  let library = await f.head();
  const remote = library.servers.find(s => s.name === 'example-remote')!;
  assert.equal(remote.kind === 'https' && remote.clientId, PREREGISTERED_CLIENT.id, 'the client id is projected into the managed server');
  assert.deepEqual(library.secrets['example-remote'], { fields: ['clientSecret'], configured: true });
  // The client stays plugin-owned: the library cannot replace its secret.
  await assert.rejects(f.library.replaceSecret('1', 'example-remote', 'other-secret'), refused(409, /plugin/));
  const connected = await f.connect();
  assert.equal(connected.connections[0].state, 'connected');
  assert.equal((await f.database('extension_oauth_connections').first('registration', 'client_id')).client_id, PREREGISTERED_CLIENT.id);
  assert.deepEqual((await f.run()).remote, ['example-remote']);
  const visible = JSON.stringify([connected, await f.plugins.get('1', ID), await f.head(), await f.database('extension_library_revisions').select('snapshot'), await f.database('plugin_audit').select()]);
  assert.ok(!visible.includes(PREREGISTERED_CLIENT.secret), 'the client secret is never returned');

  // Clearing the client removes it from the managed server and discards the connection made with it.
  const cleared = await f.plugins.setOAuthClient('1', ID, 'example-account', null);
  assert.equal(cleared.connections[0].state, 'not_connected');
  library = await f.head();
  const plain = library.servers.find(s => s.name === 'example-remote')!;
  assert.equal(plain.kind === 'https' && plain.clientId, undefined);
  assert.equal(library.secrets['example-remote'], undefined);
  assert.equal((await f.database('extension_oauth_connections').select()).length, 0);
  assert.deepEqual((await f.plugins.get('1', ID)).audit.slice(0, 1).map(a => a.action), ['clear_oauth_client']);

  // A connection that does not permit pre-registration refuses a client.
  f.setCatalog([exampleManifest(input => { input.connections.find((c: { name: string }) => c.name === 'example-account').registrations = ['metadata_document']; })]);
  await assert.rejects(f.plugins.setOAuthClient('1', ID, 'example-account', { clientId: PREREGISTERED_CLIENT.id }), refused(409, /does not permit a pre-registered client/));
});

test('a configured client signs in with pre-registration even when the connection lists automatic methods first and the provider offers them', async t => {
  // The example connection permits metadata_document, dynamic, preregistered in that order; the provider offers both automatic methods.
  const f = await fixture(t, { advertise: { metadataDocument: true, dynamic: true } });
  await f.enable();
  assert.deepEqual((await f.head()).servers.find(s => s.name === 'example-remote')!.managedBy?.registrations, ['metadata_document', 'dynamic', 'preregistered']);
  await f.plugins.setOAuthClient('1', ID, 'example-account', { clientId: PREREGISTERED_CLIENT.id, clientSecret: PREREGISTERED_CLIENT.secret });
  const connected = await f.connect();
  assert.equal(connected.connections[0].state, 'connected');
  const row = await f.database('extension_oauth_connections').first('registration', 'client_id');
  assert.deepEqual([row.registration, row.client_id], ['preregistered', PREREGISTERED_CLIENT.id]);
  assert.equal(f.synthetic.state.registrations, 0, 'no client was registered dynamically');
  assert.equal((await f.plugins.get('1', ID)).connections[0].state, 'connected', 'reads keep reporting it connected');
  assert.deepEqual((await f.run()).remote, ['example-remote'], 'runs include the server');
  // The extension route chooses the same way.
  const { authorizationUrl } = await extensionOAuth(f.library).startSignIn('1', 'session-b', 'example-remote', OAUTH_URLS);
  assert.equal(new URL(authorizationUrl).searchParams.get('client_id'), PREREGISTERED_CLIENT.id);
});

test('a configured client id selects only pre-registration, and nothing when the allowed methods exclude it', () => {
  const metadata = { issuer: 'https://issuer.example', authorization_endpoint: 'https://issuer.example/a', token_endpoint: 'https://issuer.example/t', registration_endpoint: 'https://issuer.example/r', client_id_metadata_document_supported: true } as AuthorizationServerMetadata;
  const clientMetadataUrl = 'https://propr.example/client.json';
  assert.equal(chooseRegistration(metadata, { clientId: 'configured', clientMetadataUrl, allowed: ['metadata_document', 'dynamic', 'preregistered'] }), 'preregistered');
  assert.equal(chooseRegistration(metadata, { clientId: 'configured', clientMetadataUrl }), 'preregistered');
  assert.equal(chooseRegistration(metadata, { clientId: 'configured', clientMetadataUrl, allowed: ['metadata_document', 'dynamic'] }), null);
  assert.equal(chooseRegistration(metadata, { clientMetadataUrl, allowed: ['dynamic', 'metadata_document', 'preregistered'] }), 'dynamic');
});

test('a plugin repository limit up to the plugin maximum is copied onto its managed items; a larger one is refused as a plugin limit', async t => {
  const f = await fixture(t);
  await f.enable();
  const repositories = Array.from({ length: 65 }, (_, i) => `team/repo-${i}`);
  const limited = await f.plugins.setRepositories('1', ID, repositories);
  assert.deepEqual(limited.installation?.repositories, repositories);
  let library = await f.head();
  assert.deepEqual([...library.servers, ...library.skills].filter(item => item.managedBy).map(item => item.repositories.length), [65, 65, 65]);
  // The administrator can still save the library with those items, and keep editing their limits.
  await f.save(input => ({ ...input, servers: input.servers.map(s => (s.name === 'example-local' ? { ...s, repositories: [...repositories.slice(1), 'team/repo'] } : s)) }));
  const inside = await f.run(); const outside = await f.run(issueTask('team/repo-0'));
  assert.deepEqual([inside.local, outside.local], [['example-local'], []], 'the edited limit applies to runs');

  const maximum = Array.from({ length: 256 }, (_, i) => `team/repo-${i}`);
  await f.plugins.setRepositories('1', ID, maximum);
  library = await f.head();
  assert.deepEqual([...library.servers, ...library.skills].filter(item => item.managedBy).map(item => item.repositories.length), [256, 256, 256]);
  const before = library.revision;
  await assert.rejects(f.plugins.setRepositories('1', ID, [...maximum, 'team/one-more']), refused(400, /up to 256 owner\/repo names/));
  assert.equal((await f.head()).revision, before, 'a refused limit leaves the library unchanged');
  assert.equal((await f.plugins.get('1', ID)).installation?.repositories?.length, 256);
});

test('plugin template ids stay unique when a prefixed id equals another template id', () => {
  const manifest = (id: string, templates: string[]) => exampleManifest(input => {
    input.id = id; input.name = id;
    input.contributes.automationTemplates = templates.map(t => ({ id: t, path: 'templates/example-weekly-digest' }));
  });
  const shipped = AUTOMATION_TEMPLATE_CATALOG.templates[0].id;
  const manifests = [
    manifest('alpha', ['digest', 'digest-x']), manifest('beta', ['digest', 'digest-x', 'x']), manifest('gamma', ['alpha-digest', shipped]),
    manifest('delta', ['alpha-digest-2']), manifest('alpha-digest', ['x']),
  ];
  const ids = pluginTemplateIds(manifests);
  const all = [...AUTOMATION_TEMPLATE_CATALOG.templates.map(t => t.id), ...[...ids.values()].flatMap(m => [...m.values()])];
  assert.equal(new Set(all).size, all.length, `catalog ids are unique: ${all.join(', ')}`);
  assert.equal(ids.get('gamma')!.get('alpha-digest'), 'alpha-digest', 'a template whose id nobody else uses keeps it');
  assert.equal(ids.get('delta')!.get('alpha-digest-2'), 'alpha-digest-2');
  assert.equal(ids.get('alpha')!.get('digest'), 'alpha-digest-3', 'a generated id never takes another template\'s own id');
  assert.equal(ids.get('beta')!.get('digest'), 'beta-digest');
  assert.equal(ids.get('gamma')!.get(shipped), `gamma-${shipped}`);
  assert.equal(ids.get('alpha')!.get('digest-x'), 'alpha-digest-x');
  assert.equal(ids.get('alpha-digest')!.get('x'), 'alpha-digest-x-2', 'a generated id never takes another generated id');
  assert.deepEqual(pluginTemplateIds(manifests), ids, 'the allocation is deterministic');
});

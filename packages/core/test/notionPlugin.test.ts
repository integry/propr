import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EXTENSION_LIMITS, pluginManifestSchema, taskRunExtensionRequest, type PluginManifest } from '@propr/shared';
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
import { ExtensionLibraryStore, type ExtensionLaunchContext } from '../src/extensions/extensionProfileStore.js';
import { ExtensionOAuthStore, setExtensionOAuth } from '../src/extensions/extensionOAuthStore.js';
import { executeWithExtensions } from '../src/extensions/extensionLaunch.js';
import { extensionGatewayCall } from '../src/extensions/mcpGateway.js';
import type { AgentConfig, AgentExtensionRequest, AgentTaskOptions } from '../src/agents/types.js';
import { OAUTH_MCP_URL, OAUTH_URLS, syntheticOAuthProvider } from '../../../test/fixtures/extensionOAuthFixture.js';

/**
 * The official Notion plugin through ProPR's real plugin store, extension
 * library and run resolution: install, sign in and enable give one read-only
 * managed server and the skill, applied in the plugin's repository limit only.
 * The server URL is pointed at the synthetic OAuth MCP endpoint (no network).
 */

const ID = 'notion';
const claude = { type: 'claude', alias: 'claude-main', id: randomUUID(), enabled: true, dockerImage: 'synthetic', configPath: '/unused', supportedModels: ['synthetic'] } as AgentConfig;
const result = { success: true, executionTimeMs: 0, modifiedFiles: [], commitMessage: null, logs: '', modelUsed: 'synthetic' };
const task = (repository: string, kind: 'issue' | 'pull_request' = 'issue'): AgentExtensionRequest => taskRunExtensionRequest({ kind, repository, labels: [] });

function notionManifest(): PluginManifest {
  const input = structuredClone(getOfficialPlugin(ID, { includeDevelopment: false })!.manifest) as { contributes: { mcpServers: { url: string }[] } };
  input.contributes.mcpServers[0].url = OAUTH_MCP_URL;
  return pluginManifestSchema.parse(input);
}

async function fixture(t: TestContext) {
  const resources = extensionTestResources(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notion-plugin-'));
  resources.defer(() => fs.rm(root, { recursive: true, force: true }));
  resources.defer(async () => { await (await import('../src/db/connection.js')).closeConnection(); });
  const database = resources.database();
  await database.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); c.text('extensions'); });
  await database.schema.createTable('tasks', c => c.string('task_id').primary());
  await database.schema.createTable('task_history', c => { c.string('task_id'); c.string('state'); c.string('timestamp'); c.text('reason'); c.text('metadata'); });
  await database('instance_members').insert([{ github_user_id: '1', role: 'admin' }]);
  for (const migration of [identityMigration, grantMigration, libraryMigration, oauthMigration, pluginMigration, pluginStateMigration, journalMigration, deliveriesMigration, webhookKeysMigration, commandSettingsMigration]) await migration(database);
  const environment = { SYSTEM_TASK_SECRET: 'synthetic-plugin-custody', PROPR_EGRESS_SOCKET_DIR: path.join(root, 'egress'), PATH: process.env.PATH };
  const manifests = [notionManifest()];
  const plugins = new PluginStore(database, environment, async () => manifests, Date.now, new PluginContributions(new ExtensionLibraryStore(database, environment), officialPluginAssets));
  const library = plugins.library;
  // Notion's authorization server offers dynamic registration and client ID metadata documents.
  const synthetic = syntheticOAuthProvider({ advertise: { dynamic: true } });
  setExtensionOAuth(library, new ExtensionOAuthStore(library, { transport: synthetic.transport, retryDelayMs: 1 }));
  const worktree = path.join(root, 'worktree'); await fs.mkdir(worktree);
  const run = async (extensions: AgentExtensionRequest) => {
    const taskId = randomUUID();
    await database('tasks').insert({ task_id: taskId });
    let launched: AgentTaskOptions | undefined;
    const options: AgentTaskOptions = { extensions, taskId, issueRef: { repoOwner: 'team', repoName: 'repo', number: 1 }, worktreePath: worktree, prompt: 'Run', githubToken: '' };
    await executeWithExtensions(claude, options, async prepared => { launched = prepared; return result; }, library);
    const history = await database('task_history').where({ task_id: taskId });
    const event = history.map(h => JSON.parse(h.metadata)).find(m => m.event === 'extensions.resolved');
    return {
      event,
      remote: launched!.toolPolicy?.mcpServers?.map(s => s.name) ?? [],
      skills: [...launched!.prompt.matchAll(/for ([a-z-]+)\. Declared/g)].map(m => m[1]),
    };
  };
  const connect = async () => {
    const { authorizationUrl } = await plugins.startOAuth('1', ID, 'notion-account', 'session-a', OAUTH_URLS);
    return plugins.completeOAuth('1', ID, 'notion-account', 'session-a', synthetic.authorize(authorizationUrl));
  };
  /** A run grant for a matching repository, as the task container's gateway token. */
  const grant = async () => {
    const context: ExtensionLaunchContext = { agentAlias: claude.alias, runtime: 'claude', repositories: ['team/specs'], allowWrite: false };
    const prepared = await library.resolveLaunch(context, false);
    const token = await library.createGrant(prepared, randomUUID());
    await library.activateGrant(token, prepared, context);
    return token;
  };
  return { plugins, library, run, connect, grant, synthetic, head: () => library.readLibrary('1') };
}

test('install, sign-in and enable give one read-only managed Notion server and the skill, applied in the plugin\'s repository limit only', async t => {
  const f = await fixture(t);
  const installed = await f.plugins.install('1', ID);
  assert.deepEqual(installed.connections.map(c => [c.name, c.state]), [['notion-account', 'not_connected']]);
  await f.plugins.setRepositories('1', ID, ['team/specs']);
  const connected = await f.connect();
  assert.deepEqual(connected.connections.map(c => [c.name, c.state]), [['notion-account', 'connected']]);
  const enabled = await f.plugins.setEnabled('1', ID, true);
  assert.equal(enabled.state, 'enabled');

  const library = await f.head();
  assert.equal(library.servers.length, 1, 'exactly one managed server');
  const [server] = library.servers;
  assert.deepEqual([server.name, server.kind, server.capability, server.managedBy?.plugin, server.managedBy?.active], ['notion', 'https', 'read', ID, true]);
  assert.deepEqual(server.tools, getOfficialPlugin(ID, { includeDevelopment: false })!.manifest.contributes.mcpServers[0].tools);
  assert.deepEqual(library.skillBundles.map(b => [b.name, b.source]), [['notion-context', { kind: 'plugin', plugin: ID, version: '1.0.0', path: 'skills/notion-context' }]]);
  for (const item of [...library.servers, ...library.skills]) assert.deepEqual([item.enabled, item.autoApply, item.repositories], [true, true, ['team/specs']], 'automatic apply within the plugin\'s repositories');

  // A matching issue or pull request run gets the server and the staged skill; another repository gets neither.
  for (const kind of ['issue', 'pull_request'] as const) {
    const inside = await f.run(task('team/specs', kind));
    assert.deepEqual([inside.remote, inside.skills], [['notion'], ['notion-context']], kind);
  }
  const outside = await f.run(task('team/other'));
  assert.deepEqual([outside.remote, outside.skills], [[], []]);

  // Without the sign-in the server is skipped for the run; the skill still tells the agent to say so.
  await f.plugins.disconnectOAuth('1', ID, 'notion-account');
  const signedOut = await f.run(task('team/specs'));
  assert.deepEqual(signedOut.remote, []);
  assert.deepEqual(signedOut.event.skipped.find((s: { name: string }) => s.name === 'notion'), { kind: 'server', name: 'notion', reason: 'oauth_not_connected', source: 'auto' });
});

test('the managed Notion server keeps its read capability and tool list: the library refuses a write capability or another tool', async t => {
  const f = await fixture(t);
  await f.plugins.install('1', ID);
  await f.plugins.setEnabled('1', ID, true);
  const current = await f.head();
  for (const change of [{ capability: 'write' }, { tools: [...(current.servers[0].tools ?? []), 'notion-update-page'] }]) {
    await assert.rejects(
      f.library.saveLibrary('1', { version: 1, servers: current.servers.map(s => ({ ...s, ...change }) as typeof s), skills: current.skills }, {}, current.revision),
      (error: unknown) => (error as { status?: number }).status === 409 && /managed by plugin notion/.test((error as Error).message),
      JSON.stringify(change),
    );
  }
});

test('the gateway lists only the allow-listed tools from Notion\'s full documented catalog', async t => {
  const f = await fixture(t);
  await f.plugins.install('1', ID);
  await f.plugins.setRepositories('1', ID, ['team/specs']);
  await f.connect();
  await f.plugins.setEnabled('1', ID, true);
  const allowed = getOfficialPlugin(ID, { includeDevelopment: false })!.manifest.contributes.mcpServers[0].tools!;
  const documented = JSON.parse(await fs.readFile(new URL('../../plugins/notion/fixtures/tools.json', import.meta.url), 'utf8')) as { tools: { name: string }[] };
  const catalog = documented.tools.map(tool => ({ name: tool.name, description: `Notion ${tool.name}`, inputSchema: { type: 'object' } }));
  assert.ok(catalog.length > EXTENSION_LIMITS.tools, 'the documented catalog is larger than one allow-list may be');
  // The synthetic OAuth MCP server still checks the signed-in access token; only its catalog is Notion's.
  const upstream = (tools: unknown[]) => async (endpoint: string, body: unknown, token?: string) => {
    const response = await f.synthetic.send(endpoint, body, token);
    return (body as { method: string }).method === 'tools/list' ? { ...response, result: { tools } } : response;
  };
  const token = await f.grant();
  const listed = await extensionGatewayCall(f.library, token, 'notion', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, upstream(catalog)) as { result: { tools: { name: string }[] } };
  assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(), [...allowed].sort());
  // A documented write tool stays unavailable, and an unbounded catalog is still refused.
  await assert.rejects(extensionGatewayCall(f.library, token, 'notion', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'notion-update-page', arguments: {} } }, upstream(catalog)), /tool unavailable/);
  const oversized = Array.from({ length: EXTENSION_LIMITS.upstreamTools + 1 }, (_, i) => ({ name: `tool-${i}` }));
  await assert.rejects(extensionGatewayCall(f.library, token, 'notion', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, upstream(oversized)), /catalog unavailable/);
});

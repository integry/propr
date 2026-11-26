import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionLibraryInput, ExtensionLibraryServer, ExtensionLibraryServerInput, ResolvedExtensionSet } from '@propr/shared';
import { extensionTestResources } from './helpers/extensionTestResources.js';
import { ExtensionLibraryStore } from '../src/extensions/extensionProfileStore.js';
import { executeWithExtensions, currentExtensionLaunch } from '../src/extensions/extensionLaunch.js';
import { taskRunExtensionRequest } from '../src/extensions/extensionRunResolution.js';
import { applyRuntimeSupport, extensionRuntimeSupport, serverExtensionClass, type ExtensionRuntimeSupport } from '../src/extensions/extensionRuntimeSupport.js';
import type { AgentConfig, AgentExecutionResult, AgentExtensionRequest, AgentTaskOptions } from '../src/agents/types.js';
import { up } from '../src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../src/db/migrations/20261113000000_extension_library.js';

const server = (extra: Partial<ExtensionLibraryServerInput> = {}): ExtensionLibraryServerInput => ({ kind: 'https', name: 'docs', url: 'https://8.8.8.8/mcp', enabled: true, tools: ['lookup'], capability: 'read', authentication: 'none', repositories: [], agents: [], autoApply: true, ...extra } as ExtensionLibraryServerInput);
const skillFiles = () => [{ path: 'SKILL.md', content: Buffer.from('---\nname: release-notes\ndescription: Writes release notes\n---\nWrite them.').toString('base64') }];
const result = { success: true, executionTimeMs: 0, modifiedFiles: [], commitMessage: null, logs: '', modelUsed: 'synthetic' };
const claude = { type: 'claude', alias: 'claude-main', id: randomUUID(), enabled: true, dockerImage: 'synthetic', configPath: '/unused', supportedModels: ['synthetic'] } as AgentConfig;
const issueTask = (): AgentExtensionRequest => taskRunExtensionRequest({ kind: 'issue', repository: 'team/repo' });
/** A Sprites-like runtime: uploads skills, reaches the gateway at a public URL, installs package servers, has no operator catalog executables. */
const remote = (capabilities: Partial<ExtensionRuntimeSupport['capabilities']> = {}): ExtensionRuntimeSupport => ({
  kind: 'sprites', capabilities: { skills: true, remoteMcp: true, packageMcp: true, catalogMcp: false, ...capabilities }, bindMounts: false, mcpEndpoint: 'https://propr.example/api/mcp',
});

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-remote-'));
  const previous = process.env.PROPR_EGRESS_SOCKET_DIR; process.env.PROPR_EGRESS_SOCKET_DIR = root;
  extensionTestResources(t).defer(async () => { if (previous === undefined) delete process.env.PROPR_EGRESS_SOCKET_DIR; else process.env.PROPR_EGRESS_SOCKET_DIR = previous; await fs.rm(root, { recursive: true, force: true }); });
  extensionTestResources(t).defer(async () => { await (await import('../src/db/connection.js')).closeConnection(); });
  const database = extensionTestResources(t).database();
  await database.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await database.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  await database.schema.createTable('tasks', c => c.string('task_id').primary());
  await database.schema.createTable('task_history', c => { c.string('task_id'); c.string('state'); c.string('timestamp'); c.text('reason'); c.text('metadata'); });
  await database('instance_members').insert({ github_user_id: '1', role: 'admin' });
  await up(database); await grantMigration(database); await libraryMigration(database);
  const store = new ExtensionLibraryStore(database, { SYSTEM_TASK_SECRET: 'synthetic-remote-custody' });
  const bundle = await store.importSkill('1', skillFiles(), { kind: 'archive', filename: 'skill.tar' });
  const save = async (library: Omit<ExtensionLibraryInput, 'version'>) => store.saveLibrary('1', { version: 1, ...library }, {}, (await store.readLibrary('1')).revision);
  const run = async (extensions: AgentExtensionRequest, runtimeSupport: ExtensionRuntimeSupport) => {
    const taskId = randomUUID();
    await database('tasks').insert({ task_id: taskId });
    let launched: { prepared: AgentTaskOptions; launch: ReturnType<typeof currentExtensionLaunch> } | undefined;
    const options: AgentTaskOptions = { extensions, taskId, issueRef: { repoOwner: 'team', repoName: 'repo', number: 1 }, worktreePath: root, prompt: 'Run', githubToken: '' };
    const returned: AgentExecutionResult = await executeWithExtensions(claude, options, async prepared => {
      const launch = currentExtensionLaunch();
      if (launch) await launch.beforeLaunch();
      launched = { prepared, launch };
      return result;
    }, store, { runtimeSupport });
    const history = await database('task_history').where({ task_id: taskId });
    const entry = history.find(h => JSON.parse(h.metadata).event === 'extensions.resolved');
    return { launched: launched!, returned, event: entry && JSON.parse(entry.metadata), reason: entry?.reason as string | undefined };
  };
  return { save, run, bundle, root };
}

test('a remote runtime receives validated skill files and gateway URL servers instead of Docker mounts', async t => {
  const { save, run, bundle, root } = await fixture(t);
  await save({ servers: [server()], skills: [{ bundleId: bundle.id, enabled: true, repositories: [], agents: [], autoApply: true }] });
  const { launched, returned, event } = await run(issueTask(), remote());
  const launch = launched.launch!;
  assert.deepEqual(launch.mounts, [], 'nothing is bind-mounted into a remote run');
  assert.deepEqual(launch.requires, { skills: ['release-notes'], remoteMcp: ['docs'], packageMcp: [], catalogMcp: [] });
  assert.equal(launch.packageInstall, undefined, 'nothing to install without package servers');
  assert.deepEqual(launch.skillFiles!.map(file => file.path), [`${bundle.id}/SKILL.md`]);
  assert.match(launch.skillFiles![0].content.toString(), /Write them\./);
  assert.equal(launch.gatewayUrl, 'https://propr.example/api/extensions/mcp');
  assert.deepEqual(launched.prepared.toolPolicy!.mcpServers!.map(s => s.url), ['https://propr.example/api/extensions/mcp/docs']);
  assert.match(launched.prepared.prompt, new RegExp(`/opt/propr/extensions/${bundle.id}/SKILL.md`));
  assert.deepEqual(await fs.readdir(root), [], 'no worker staging directory is created for an upload runtime');
  assert.equal(returned.extensionNotice, undefined);
  assert.equal(event.runtimeUnsupported, undefined);
});

test('auto-applied items a remote runtime cannot apply are dropped with a note; the run keeps going', async t => {
  const { save, run, bundle } = await fixture(t);
  await save({ servers: [server()], skills: [{ bundleId: bundle.id, enabled: true, repositories: [], agents: [], autoApply: true }] });
  const { launched, returned, event, reason } = await run(issueTask(), remote({ remoteMcp: false }));
  assert.deepEqual(launched.launch!.requires, { skills: ['release-notes'], remoteMcp: [], packageMcp: [], catalogMcp: [] });
  assert.deepEqual(launched.prepared.toolPolicy!.mcpServers, []);
  assert.deepEqual(event.servers, []);
  assert.deepEqual(event.skipped, [{ kind: 'server', name: 'docs', reason: 'agent_runtime_unsupported', source: 'auto' }]);
  assert.deepEqual(event.runtimeUnsupported.servers, ['docs']);
  assert.match(reason!, /agent runtime "sprites" cannot apply/);
  assert.match(returned.extensionNotice!, /Agent runtime "sprites" cannot run URL MCP servers.*MCP server "docs"/);

  // Nothing left to apply: the run still launches, without extensions, and still carries the note.
  const none = await run(issueTask(), remote({ remoteMcp: false, skills: false }));
  assert.equal(none.launched.launch, undefined);
  assert.equal(none.launched.prepared.extensions, null);
  assert.match(none.returned.extensionNotice!, /skill bundle "release-notes"/);
});

test('explicitly added items a remote runtime cannot apply refuse the run with the capability error naming them', async t => {
  const { save, run, bundle } = await fixture(t);
  await save({ servers: [server(), server({ name: 'manual', autoApply: false })], skills: [{ bundleId: bundle.id, enabled: true, repositories: [], agents: [], autoApply: false }] });
  await assert.rejects(run({ ...issueTask(), servers: ['manual'] }, remote({ remoteMcp: false })),
    (error: Error & { capability?: string }) => error.name === 'AgentRuntimeCapabilityError' && error.capability === 'remote_mcp' && /"manual"/.test(error.message) && !/"docs"/.test(error.message));
  await assert.rejects(run({ ...issueTask(), skills: [bundle.id] }, remote({ skills: false })),
    (error: Error & { capability?: string }) => error.capability === 'skills' && /"release-notes"/.test(error.message));
});

test('package servers run on a remote runtime that installs them; catalog stdio servers are a separate class it can lack', async () => {
  const pkg = { kind: 'package', name: 'local-files' } as ExtensionLibraryServer;
  const stdio = { kind: 'catalog', name: 'operator-tool', catalogId: 'tool' } as ExtensionLibraryServer;
  const url = { kind: 'https', name: 'docs' } as ExtensionLibraryServer;
  const set: ResolvedExtensionSet = { servers: [pkg, stdio, url], skills: [], skipped: [], omitted: [] };
  const classify = (s: ExtensionLibraryServer) => serverExtensionClass(s, s.name === 'operator-tool' ? 'stdio' : 'https');
  assert.equal(serverExtensionClass({ kind: 'catalog', name: 'internal' } as ExtensionLibraryServer, 'https'), 'remoteMcp');
  assert.equal(serverExtensionClass(pkg), 'packageMcp');
  assert.equal(serverExtensionClass(stdio, 'stdio'), 'catalogMcp');
  const auto = await applyRuntimeSupport(set, issueTask(), remote(), classify);
  assert.deepEqual(auto.set.servers.map(s => s.name), ['local-files', 'docs'], 'package servers are kept: Sprites and Fly install them');
  assert.deepEqual(auto.dropped!.servers, ['operator-tool']);
  assert.match(auto.dropped!.message, /cannot run operator catalog stdio MCP servers/);
  const explicitPackage = await applyRuntimeSupport(set, { ...issueTask(), servers: ['local-files'] }, remote(), classify);
  assert.deepEqual(explicitPackage.set.servers.map(s => s.name), ['local-files', 'docs']);
  await assert.rejects(applyRuntimeSupport(set, { ...issueTask(), servers: ['operator-tool'] }, remote(), classify),
    (error: Error & { capability?: string }) => error.capability === 'catalog_mcp' && /"operator-tool"/.test(error.message));
  // A custom runtime without the capability keeps the interim rule for package servers: dropped when auto-applied, refused when explicit.
  const custom = remote({ packageMcp: false });
  assert.deepEqual((await applyRuntimeSupport(set, issueTask(), custom, classify)).dropped!.servers, ['local-files', 'operator-tool']);
  await assert.rejects(applyRuntimeSupport(set, { ...issueTask(), servers: ['local-files'] }, custom, classify),
    (error: Error & { capability?: string }) => error.capability === 'package_mcp' && /"local-files"/.test(error.message));
  const docker = await applyRuntimeSupport(set, { ...issueTask(), servers: ['local-files'] }, { ...remote({ catalogMcp: true }), bindMounts: true }, classify);
  assert.equal(docker.set, set, 'a runtime that applies every class keeps the set untouched');
});

test('the run\'s runtime decides support: Docker applies all, Sprites and Fly upload skills and reach the gateway at their MCP URL', async () => {
  assert.deepEqual((await extensionRuntimeSupport({}, 'open', {})).capabilities, { skills: true, remoteMcp: true, packageMcp: true, catalogMcp: true });
  const sprites = await extensionRuntimeSupport({ runtime: 'sprites' }, 'open', { PROPR_SPRITES_MCP_URL: 'https://propr.example/api/mcp' });
  assert.deepEqual(sprites, { kind: 'sprites', capabilities: { skills: true, remoteMcp: true, packageMcp: true, catalogMcp: false }, bindMounts: false, mcpEndpoint: 'https://propr.example/api/mcp' });
  assert.equal((await extensionRuntimeSupport({ runtime: 'fly-machines' }, 'open', { API_PUBLIC_URL: 'https://propr.example' })).capabilities.packageMcp, true);
  const fly = await extensionRuntimeSupport({ runtime: 'fly-machines' }, 'open', { API_PUBLIC_URL: 'https://propr.example' });
  assert.equal(fly.mcpEndpoint, 'https://propr.example/api/mcp');
  assert.equal(fly.capabilities.remoteMcp, true);
  // Without a URL the run can reach, URL servers have no gateway: they are treated as unsupported.
  assert.equal((await extensionRuntimeSupport({ runtime: 'sprites' }, 'open', {})).capabilities.remoteMcp, false);
});

test('a run with only skills does not need a gateway URL; an MCP URL the gateway cannot be derived from leaves URL servers unsupported', async t => {
  const { save, run, bundle } = await fixture(t);
  await save({ servers: [], skills: [{ bundleId: bundle.id, enabled: true, repositories: [], agents: [], autoApply: true }] });
  // A proxy path not ending in /api/mcp: the gateway URL cannot be derived, but no URL server needs it.
  const proxied = { ...remote(), mcpEndpoint: 'https://proxy.example/propr-mcp' };
  const { launched } = await run(issueTask(), proxied);
  assert.deepEqual(launched.launch!.requires!.skills, ['release-notes']);
  assert.equal(launched.launch!.gatewayUrl, undefined);
  const support = await extensionRuntimeSupport({ runtime: 'sprites' }, 'open', { PROPR_SPRITES_MCP_URL: 'https://proxy.example/propr-mcp' });
  assert.equal(support.capabilities.remoteMcp, false, 'auto-applied URL servers are dropped with the note instead of failing the run');
  assert.equal(support.capabilities.skills, true);
});

test('a catalog server that does not resolve is unavailable, not a URL server the runtime lacks', async () => {
  const stdio = { kind: 'catalog', name: 'gone', catalogId: 'tool' } as ExtensionLibraryServer;
  const set: ResolvedExtensionSet = { servers: [stdio], skills: [], skipped: [], omitted: [] };
  const filtered = await applyRuntimeSupport(set, issueTask(), remote({ remoteMcp: false }), () => 'unavailable');
  assert.equal(filtered.dropped, undefined, 'not dropped as an unsupported class; the launch reports the catalog error as on Docker');
  assert.deepEqual(filtered.set.servers.map(s => s.name), ['gone']);
});

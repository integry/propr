import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { ExtensionLibraryInput, ExtensionLibraryServerInput } from '@propr/shared';
import { extensionTestResources } from './helpers/extensionTestResources.js';
import { npmRegistryFixture } from './helpers/npmRegistryFixture.js';
import { ExtensionLibraryStore } from '../src/extensions/extensionProfileStore.js';
import { executeWithExtensions, currentExtensionLaunch } from '../src/extensions/extensionLaunch.js';
import { taskRunExtensionRequest } from '../src/extensions/extensionRunResolution.js';
import { extensionGatewayCall } from '../src/extensions/mcpGateway.js';
import { ExtensionPackageCache, type NpmRunner } from '../src/extensions/packageCache.js';
import { resolveNpmPackage } from '../src/extensions/packageRegistry.js';
import { claudeToolPolicyArgs, codexToolPolicyArgs } from '../src/agents/agentToolPolicy.js';
import type { AgentConfig, AgentExtensionRequest, AgentTaskOptions } from '../src/agents/types.js';
import { up } from '../src/db/migrations/20261013210000_extension_profiles.js';
import { up as grantMigration } from '../src/db/migrations/20261013220000_extension_grant_network.js';
import { up as libraryMigration } from '../src/db/migrations/20261113000000_extension_library.js';

const secret = 'UNMISTAKABLE_PACKAGE_SECRET_SENTINEL_DO_NOT_DISCLOSE';
const plainValue = 'plain-greeting-value';
const result = { success: true, executionTimeMs: 0, modifiedFiles: [], commitMessage: null, logs: '', modelUsed: 'synthetic' };
const claude = { type: 'claude', alias: 'claude-main', id: randomUUID(), enabled: true, dockerImage: 'synthetic', configPath: '/unused', supportedModels: ['synthetic'] } as AgentConfig;
const codex = { ...claude, type: 'codex', alias: 'codex-main' } as AgentConfig;
type PackageServerInput = Extract<ExtensionLibraryServerInput, { kind: 'package' }>;
const packageServer = (extra: Record<string, unknown> = {}): PackageServerInput => ({
  kind: 'package', name: 'local-tools', ecosystem: 'npm', package: 'propr-fixture-mcp', version: '1.0.0', enabled: true, tools: ['echo', 'secret_length'], capability: 'read',
  args: ['--flag', 'value'], env: [{ name: 'FIXTURE_GREETING', value: plainValue }], secretEnv: [], repositories: [], agents: [], autoApply: true, ...extra,
} as PackageServerInput);
const issueTask = (labels: string[] = [], allowWrite = false): AgentExtensionRequest => taskRunExtensionRequest({ kind: 'issue', repository: 'team/repo', labels: labels.map(name => ({ name })), allowWrite });

async function fixture(t: TestContext) {
  const resources = extensionTestResources(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-packages-'));
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
  await database.schema.createTable('agent_definitions', c => { c.string('id').primary(); c.string('name'); });
  await database.schema.createTable('tasks', c => c.string('task_id').primary());
  await database.schema.createTable('task_history', c => { c.string('task_id'); c.string('state'); c.string('timestamp'); c.text('reason'); c.text('metadata'); });
  await database('instance_members').insert({ github_user_id: '1', role: 'admin' });
  await up(database); await grantMigration(database); await libraryMigration(database);
  const environment = { SYSTEM_TASK_SECRET: 'synthetic-package-custody', PROPR_EXTENSION_NPM_REGISTRY: registry.url, PROPR_EGRESS_SOCKET_DIR: path.join(root, 'egress'), PATH: process.env.PATH };
  const store = new ExtensionLibraryStore(database, environment);
  let installs = 0;
  const realNpm: NpmRunner = (args, options) => new Promise((resolve, reject) => {
    installs++;
    const child = spawn('npm', args, { ...options, stdio: 'ignore' });
    child.on('error', reject); child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`npm ${code}`))));
  });
  const cache = new ExtensionPackageCache(environment, realNpm);
  // eslint-disable-next-line max-params -- test helper mirrors the save inputs
  const save = async (servers: ExtensionLibraryServerInput[], secrets: Record<string, string | null> = {}, acknowledgements?: string[]) => store.saveLibrary('1', { version: 1, servers, skills: [] } as ExtensionLibraryInput, secrets, (await store.readLibrary('1')).revision, acknowledgements);
  const worktree = path.join(root, 'worktree'); await fs.mkdir(worktree);
  /** Launch one run; report what its container would receive and what its task event records. */
  const run = async (extensions: AgentExtensionRequest = issueTask(), config: AgentConfig = claude) => {
    const taskId = randomUUID();
    await database('tasks').insert({ task_id: taskId });
    let launched: AgentTaskOptions | undefined; let mounts: string[] = [];
    const options: AgentTaskOptions = { extensions, taskId, issueRef: { repoOwner: 'team', repoName: 'repo', number: 1 }, worktreePath: worktree, prompt: 'Run', githubToken: '' };
    await executeWithExtensions(config, options, async prepared => {
      const launch = currentExtensionLaunch();
      if (launch) { await launch.beforeLaunch(); mounts = launch.mounts; }
      launched = prepared;
      return result;
    }, store, { packageCache: cache });
    const history = await database('task_history').where({ task_id: taskId });
    return { launched: launched!, mounts, taskId, event: history.map(h => JSON.parse(h.metadata)).find(m => m.event === 'extensions.resolved'), history };
  };
  return { database, store, registry, cache, save, run, root, worktree, environment, installs: () => installs };
}

/** Speak MCP to the bridge as the agent CLI would, against the package installed in the worker cache. */
async function bridgeSession(t: TestContext, bridgeConfig: string, env: Record<string, string>, installDirectory: string) {
  const config = JSON.parse(Buffer.from(bridgeConfig, 'base64url').toString());
  // The task container mounts the install at /opt/propr/packages/<n>; outside a container use the worker path.
  config.args[0] = config.args[0].replace(/^\/opt\/propr\/packages\/\d+/, installDirectory);
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../../../scripts/extension-stdio-bridge.mjs'), Buffer.from(JSON.stringify(config)).toString('base64url')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const reader = createInterface({ input: child.stdout }); const pending = new Map<number, (rpc: any) => void>();
  reader.on('line', line => { const rpc = JSON.parse(line); pending.get(rpc.id)?.(rpc); pending.delete(rpc.id); });
  t.after(async () => { reader.close(); if (child.exitCode === null) { child.kill(); await new Promise(r => child.once('close', r)); } });
  let id = 0;
  return (method: string, params?: unknown) => new Promise<any>((resolve, reject) => {
    const current = ++id; const timer = setTimeout(() => reject(new Error(`No reply to ${method}`)), 8000);
    pending.set(current, rpc => { clearTimeout(timer); resolve(rpc); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, ...(params ? { params } : {}) }) + '\n');
  });
}

test('Check resolves an exact version to its registry integrity value and executable; ranges, tags and install scripts are refused', async t => {
  const { registry, environment } = await fixture(t);
  const resolved = await resolveNpmPackage({ package: 'propr-fixture-mcp', version: '1.0.0' }, environment);
  assert.deepEqual({ ...resolved }, { ecosystem: 'npm', package: 'propr-fixture-mcp', version: '1.0.0', integrity: registry.integrity('propr-fixture-mcp', '1.0.0'), bin: 'propr-fixture-mcp', bins: ['propr-fixture-mcp'], binPath: 'bin/server.js' });
  for (const version of ['latest', '^1.0.0', '1.x', '>=1.0.0', '1.0', 'v1.0.0', '1.0.0+build']) await assert.rejects(resolveNpmPackage({ package: 'propr-fixture-mcp', version }, environment), /exact version/);
  await assert.rejects(resolveNpmPackage({ package: 'propr-fixture-mcp', version: '9.9.9' }, environment), /not found/);
  await assert.rejects(resolveNpmPackage({ package: 'propr-fixture-multi', version: '2.0.0' }, environment), /several executables \(alpha, beta\)/);
  assert.equal((await resolveNpmPackage({ package: 'propr-fixture-multi', version: '2.0.0', bin: 'beta' }, environment)).binPath, 'b.js');
  await assert.rejects(resolveNpmPackage({ package: 'propr-fixture-multi', version: '2.0.0', bin: 'gamma' }, environment), /no executable named gamma/);
  await assert.rejects(resolveNpmPackage({ package: 'propr-fixture-scripts', version: '1.0.0' }, environment), /install scripts.*unsupported/);
  await assert.rejects(resolveNpmPackage({ package: '../etc', version: '1.0.0' }, environment), /package name/);
  // Nothing was downloaded: Check reads version documents only.
  assert.ok(registry.requests.every(url => !url.endsWith('.tgz')));
});

test('a package server is saved with an exact version and the resolved integrity value; commands, paths, mounts and images are refused', async t => {
  const { store, registry, save } = await fixture(t);
  const library = await save([packageServer({ integrity: `sha512-${'A'.repeat(86)}==` })]);
  const saved = library.servers[0];
  assert.equal(saved.kind, 'package');
  assert.equal(saved.kind === 'package' && saved.integrity, registry.integrity('propr-fixture-mcp', '1.0.0'), 'a client-sent integrity value is replaced by the registry value');
  assert.equal(library.acknowledgements, undefined, 'a server without secret variables needs no acknowledgement');
  for (const version of ['latest', '^1.2.0', '~1.0.0', '*']) await assert.rejects(save([packageServer({ version })]), /Invalid extension library/);
  for (const extra of [{ command: 'sh' }, { argv: ['sh', '-c', 'id'] }, { url: 'https://8.8.8.8/mcp' }, { path: '/usr/bin/env' }, { mounts: ['/:/host'] }, { image: 'alpine' }, { dockerImage: 'alpine' }, { executable: '/bin/sh' }, { ecosystem: 'pypi' }, { env: [{ name: 'NODE_OPTIONS', value: '--require /tmp/x' }] }, { env: [{ name: 'PATH', value: '/tmp' }] }, { secretEnv: ['LD_PRELOAD'] }, { args: ['a\nb'] }]) {
    await assert.rejects(save([packageServer(extra)]), /Invalid extension library/, JSON.stringify(extra));
  }
  await assert.rejects(save([packageServer({ env: [{ name: 'TOKEN', value: 'x' }], secretEnv: ['TOKEN'] })], {}, ['local-tools']), /Invalid extension library/);
  // An unchanged version keeps its integrity without asking the registry again.
  const before = registry.requests.length;
  await save([{ ...packageServer(), tools: ['echo'] }]);
  assert.equal(registry.requests.length, before);
  assert.equal((await store.readLibrary('1')).revision, 2);
});

test('secret variables need an acknowledgement recorded on the revision and are never disclosed', async t => {
  const { store, database, save } = await fixture(t);
  const withSecret = packageServer({ secretEnv: ['FIXTURE_TOKEN'] });
  await assert.rejects(save([withSecret], { 'local-tools/FIXTURE_TOKEN': secret }), /Confirm that the secret variables of local-tools/);
  await assert.rejects(save([withSecret], { 'local-tools/OTHER': secret }, ['local-tools']), /Invalid secret replacement/);
  await assert.rejects(save([withSecret], {}, ['someone-else']), /Invalid secret acknowledgement/);
  const before = Date.now();
  const library = await save([withSecret], { 'local-tools/FIXTURE_TOKEN': secret }, ['local-tools']);
  const acknowledgement = library.acknowledgements?.['local-tools'];
  assert.equal(acknowledgement?.actor, '1');
  assert.ok(acknowledgement && acknowledgement.at >= before);
  assert.deepEqual({ ...acknowledgement, at: 0 }, { actor: '1', at: 0, package: 'propr-fixture-mcp', version: '1.0.0', secretEnv: ['FIXTURE_TOKEN'] });
  assert.deepEqual(library.secrets['local-tools'], { count: 1, configured: true, configuredEnv: ['FIXTURE_TOKEN'] });
  // Unrelated saves and toggles carry the acknowledgement; a version change needs a new one.
  const unrelated = await save([withSecret, { ...packageServer(), name: 'other' }]);
  assert.deepEqual(unrelated.acknowledgements?.['local-tools'], acknowledgement);
  assert.deepEqual(unrelated.secrets['local-tools'], library.secrets['local-tools']);
  const toggled = await store.setItemEnabled('1', { kind: 'server', name: 'local-tools' }, false);
  assert.deepEqual(toggled.acknowledgements?.['local-tools'], acknowledgement);
  assert.equal(toggled.secrets['local-tools'].configured, true);
  await assert.rejects(save([{ ...withSecret, secretEnv: ['FIXTURE_TOKEN', 'SECOND'] }]), /Confirm that the secret variables/);
  // Clearing and replacing one variable is a write-only operation.
  const cleared = await store.replaceSecret('1', 'local-tools/FIXTURE_TOKEN', null);
  assert.deepEqual(cleared.secrets['local-tools'], { count: 1, configured: false, configuredEnv: [] });
  const replaced = await store.replaceSecret('1', 'local-tools/FIXTURE_TOKEN', secret);
  assert.equal(replaced.secrets['local-tools'].configured, true);
  await assert.rejects(store.replaceSecret('1', 'local-tools/UNKNOWN', secret), /unavailable/);
  // Changing the package never transfers a stored secret.
  const moved = await save([{ ...withSecret, package: 'propr-fixture-multi', version: '2.0.0', bin: 'alpha' }, { ...packageServer(), name: 'other' }], {}, ['local-tools']);
  assert.deepEqual(moved.secrets['local-tools'], { count: 1, configured: false, configuredEnv: [] });
  const everything = JSON.stringify([await store.readLibrary('1'), await store.history('1'), await database('extension_library_revisions').select('*')]);
  assert.ok(!everything.includes(secret));
});

test('a matching run launches the package through the stdio bridge for Claude and Codex; installed once, read-only, outside the workspace, without lifecycle scripts', async t => {
  const { save, run, registry, worktree, root, installs, cache, store } = await fixture(t);
  await save([packageServer({ secretEnv: ['FIXTURE_TOKEN'] }), packageServer({ name: 'elsewhere', repositories: ['other/repo'] })], { 'local-tools/FIXTURE_TOKEN': secret }, ['local-tools']);
  const first = await run();
  const local = first.launched.toolPolicy!.localMcpServers!;
  assert.deepEqual(local.map(s => s.name), ['local-tools'], 'only servers matching the repository apply');
  assert.equal(installs(), 1);
  assert.ok(!await fs.stat(registry.marker).catch(() => null), 'no lifecycle script ran during install');
  const installed = await cache.verify((await store.readLibrary('1')).servers[0] as any);
  assert.ok(!path.relative(worktree, installed.localDirectory).match(/^[^.]/), 'the install is not inside the task workspace');
  assert.ok(installed.localDirectory.startsWith(root));
  assert.deepEqual(first.mounts, ['--mount', `type=bind,source=${installed.hostDirectory},target=/opt/propr/packages/0,readonly,bind-recursive=disabled`]);
  // Installed files are read-only (root ignores file modes).
  if (process.getuid?.() !== 0) await assert.rejects(fs.writeFile(path.join(installed.localDirectory, 'node_modules', 'propr-fixture-mcp', 'bin', 'server.js'), 'tampered'), /EACCES/);
  // The secret value travels through an environment name only.
  const config = JSON.parse(Buffer.from(local[0].bridgeConfig, 'base64url').toString());
  assert.deepEqual(config, { name: 'local-tools', executable: '/usr/local/bin/node', args: ['/opt/propr/packages/0/node_modules/propr-fixture-mcp/bin/server.js', '--flag', 'value'], tools: ['echo', 'secret_length'], env: { FIXTURE_GREETING: plainValue }, secretEnv: { FIXTURE_TOKEN: 'PROPR_EXTENSION_STDIO_0_0_SECRET' } });
  assert.deepEqual(local[0].env, { PROPR_EXTENSION_STDIO_0_0_SECRET: secret });
  for (const policy of [claudeToolPolicyArgs(first.launched.toolPolicy!), codexToolPolicyArgs(first.launched.toolPolicy!)]) {
    assert.ok(policy.cliArgs.join(' ').includes('/opt/propr/extension-stdio-bridge.mjs'));
    assert.ok(policy.cliArgs.join(' ').includes(local[0].bridgeConfig));
    assert.ok(!JSON.stringify(policy).includes(secret), 'no secret in launch arguments or config JSON');
    assert.equal(policy.env.PROPR_EXTENSION_STDIO_0_0_SECRET, secret);
  }
  assert.equal(first.launched.toolPolicy!.mcpServers!.length, 0, 'package servers never go through the HTTPS gateway');
  // The event lists the server with its version, never variables or secrets.
  assert.deepEqual(first.event.packages, [{ name: 'local-tools', ecosystem: 'npm', package: 'propr-fixture-mcp', version: '1.0.0' }]);
  assert.ok(!JSON.stringify(first.history).includes(secret) && !JSON.stringify(first.history).includes(plainValue));
  // The agent lists and calls the allowed tools through the bridge.
  const call = await bridgeSession(t, local[0].bridgeConfig, { ...local[0].env }, installed.localDirectory);
  assert.equal((await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'agent', version: '1' } })).result.serverInfo.name, 'local-tools');
  assert.deepEqual((await call('tools/list')).result.tools.map((tool: { name: string }) => tool.name), ['echo', 'secret_length']);
  assert.deepEqual((await call('tools/call', { name: 'echo', arguments: { text: 'hi' } })).result.content[0].text, `dep:${plainValue}:hi:--flag,value`);
  assert.equal((await call('tools/call', { name: 'secret_length', arguments: {} })).result.content[0].text, `${secret.length}:[REDACTED]`, 'the bridge redacts configured secrets');
  assert.equal((await call('tools/call', { name: 'hidden', arguments: {} })).error.message, 'MCP capability unavailable');
  // Later runs (Codex too) reuse the install.
  const second = await run(issueTask(), codex);
  assert.deepEqual(second.launched.toolPolicy!.localMcpServers!.map(s => s.name), ['local-tools']);
  assert.equal(installs(), 1);
  assert.ok(codexToolPolicyArgs(second.launched.toolPolicy!).cliArgs.some(arg => arg.includes('env_vars=["PROPR_EXTENSION_STDIO_0_0_SECRET"]')));
});

test('changed installed files refuse the server at launch; the run proceeds without it and records why', async t => {
  const { save, run, cache, store } = await fixture(t);
  await save([packageServer()]);
  await run();
  const installed = await cache.verify((await store.readLibrary('1')).servers[0] as any);
  const file = path.join(installed.localDirectory, 'node_modules', 'propr-fixture-dep', 'index.js');
  await fs.chmod(path.dirname(file), 0o755); await fs.chmod(file, 0o644);
  await fs.writeFile(file, "exports.prefix = 'tampered:';\n");
  const refused = await run();
  assert.equal(refused.launched.toolPolicy, undefined, 'the run launches without the server');
  assert.deepEqual(refused.event.servers, []);
  assert.deepEqual(refused.event.skipped, [{ kind: 'server', name: 'local-tools', reason: 'package_integrity_mismatch', source: 'auto' }]);
  // A forged manifest cannot hide the change either.
  const manifestFile = path.join(installed.localDirectory, '.propr-package.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  await fs.chmod(installed.localDirectory, 0o755); await fs.chmod(manifestFile, 0o644);
  await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, tree: 'f'.repeat(64) }));
  assert.equal((await run()).event.skipped[0].reason, 'package_integrity_mismatch');
});

test('write capability needs write authorization; opt-out labels and disabling remove a package server; the gateway refuses it', async t => {
  const { save, run, store } = await fixture(t);
  await save([packageServer({ capability: 'write' })]);
  const names = async (extensions: AgentExtensionRequest) => (await run(extensions)).launched.toolPolicy?.localMcpServers?.map(s => s.name) ?? [];
  assert.deepEqual(await names(issueTask()), []);
  assert.deepEqual(await names(issueTask([], true)), ['local-tools']);
  assert.deepEqual(await names(issueTask(['disable-mcps'], true)), []);
  assert.deepEqual(await names(issueTask(['disable-extensions'], true)), []);
  await store.setItemEnabled('1', { kind: 'server', name: 'local-tools' }, false);
  assert.deepEqual(await names(issueTask([], true)), []);
  await store.setItemEnabled('1', { kind: 'server', name: 'local-tools' }, true);
  assert.deepEqual(await names(issueTask([], true)), ['local-tools']);
  // The run limit counts package servers with every other kind.
  const many = Array.from({ length: 9 }, (_, i) => packageServer({ name: `local-${i}` }));
  await save(many);
  const limited = await run();
  assert.equal(limited.launched.toolPolicy!.localMcpServers!.length, 8);
  assert.deepEqual(limited.event.omitted.map((o: { name: string }) => o.name), ['local-8']);
  // A grant never reaches a local package server through Core.
  const launch = await store.resolveLaunch({ agentAlias: 'claude-main', runtime: 'claude', repositories: ['team/repo'], allowWrite: true }, false);
  const token = await store.createGrant(launch, randomUUID());
  await store.activateGrant(token, launch, { agentAlias: 'claude-main', runtime: 'claude', repositories: ['team/repo'], allowWrite: true });
  await assert.rejects(extensionGatewayCall(store, token, 'local-0', { jsonrpc: '2.0', id: 1, method: 'tools/list' }), /task container/);
});

test('a missing secret skips the server; a native export erases package secrets', async t => {
  const { save, run, store, database } = await fixture(t);
  await save([packageServer({ secretEnv: ['FIXTURE_TOKEN'] })], {}, ['local-tools']);
  const skipped = await run();
  assert.deepEqual(skipped.event.skipped, [{ kind: 'server', name: 'local-tools', reason: 'secret_not_configured', source: 'auto' }]);
  await store.replaceSecret('1', 'local-tools/FIXTURE_TOKEN', secret);
  // As the native export does: credential custody is erased; the public revision remains.
  await database('extension_library_revisions').update({ secrets_encrypted: '' });
  const exported = await store.readLibrary('1');
  assert.deepEqual(exported.secrets['local-tools'], { count: 1, configured: false, configuredEnv: [] });
  assert.ok(!JSON.stringify(await database('extension_library_revisions').select('*')).includes(secret));
});

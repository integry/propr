import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
class FakeRedis {
  status = 'ready'; on() { return this; } async eval() { return 0; }
  async get() { return null; } async quit() { return 'OK'; } disconnect() {}
}
await mock.module('ioredis', { namedExports: { Redis: FakeRedis, default: FakeRedis } });
await mock.module('../packages/core/src/agents/agentGitAccess.js', { namedExports: {
  prepareAgentGitAccess: async () => ({ githubToken: '', gitMountArgs: [] }),
  prepareAnalysisGitAccess: async () => ({ githubToken: '', gitMountArgs: [] }),
  agentOwnsGit: () => false, buildAgentGitCredentialArgs: () => [], buildAgentGitMountArgs: () => [],
} });
const helpers = await import('../packages/core/src/claude/claudeHelpers.js');
await mock.module('../packages/core/src/claude/claudeHelpers.js', { namedExports: { ...helpers,
  setWorktreeOwnership: async () => {}, verifyWorktreeStructure: () => '', verifyWorktreePostExecution: () => {},
} });
const utils = await import('../packages/core/src/agents/impl/utils/index.js');
await mock.module('../packages/core/src/agents/impl/utils/index.js', { namedExports: { ...utils,
  executeWithUsageTracking: async (_runtime: string, run: () => Promise<unknown>) => ({ result: await run() }),
} });
const executor = await import('../packages/core/src/claude/docker/dockerExecutor.js');
await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', { namedExports: { ...executor,
  // Keep the real spawn/environment path; unrelated admission and Redis are
  // bypassed for the synthetic Docker executable.
  executeDockerCommand: (command: string, args: string[], options: any) => executor.executeDockerCommand(command, args, {
    ...options, streamToRedis: false, costCapExempt: true, networkPolicyExempt: 'Synthetic Claude Docker subprocess fixture',
  }),
} });
const { ClaudeAgent } = await import('../packages/core/src/agents/impl/ClaudeAgent.js');
const { claudeToolPolicyArgs } = await import('../packages/core/src/agents/agentToolPolicy.js');
const { db, closeConnection } = await import('../packages/core/src/db/connection.js');
after(closeConnection);

test('ClaudeAgent forwards non-enumerable local MCP secrets through its Docker builder to the subprocess', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-extension-env-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const key = 'PROPR_EXTENSION_STDIO_0_0_SECRET'; const token = 'SYNTHETIC_CLAUDE_STDIO_SECRET';
  await db.schema.createTable('system_configs', c => { c.string('key').primary(); c.text('value'); });
  await db.schema.createTable('config', c => { c.string('key').primary(); c.text('value'); });
  await db.schema.createTable('instance_members', c => { c.string('github_user_id').primary(); c.string('role'); });
  await db.schema.createTable('agent_definitions', c => c.string('id').primary());
  await db('instance_members').insert({ github_user_id: '1', role: 'admin' });
  await (await import('../packages/core/src/db/migrations/20261013210000_extension_profiles.js')).up(db);
  await (await import('../packages/core/src/db/migrations/20261013220000_extension_grant_network.js')).up(db);
  const { ExtensionProfileStore } = await import('../packages/core/src/extensions/extensionProfileStore.js');
  const { operatorCatalogDigest } = await import('../packages/core/src/extensions/operatorCatalog.js');
  const catalog = { id: 'docs', kind: 'stdio' as const, executable: '/usr/bin/env', args: ['node', '--version'], tools: ['lookup'], capability: 'read' as const, secretEnv: { API_KEY: 'SYNTHETIC_OPERATOR_KEY' } };
  const catalogFile = path.join(root, 'catalog.json'); await fs.writeFile(catalogFile, JSON.stringify([catalog]), { mode: 0o600 });
  const previousEnv = { SYSTEM_TASK_SECRET: process.env.SYSTEM_TASK_SECRET, PROPR_EXTENSION_CATALOG_FILE: process.env.PROPR_EXTENSION_CATALOG_FILE, SYNTHETIC_OPERATOR_KEY: process.env.SYNTHETIC_OPERATOR_KEY };
  Object.assign(process.env, { SYSTEM_TASK_SECRET: 'synthetic-custody-key', PROPR_EXTENSION_CATALOG_FILE: catalogFile, SYNTHETIC_OPERATOR_KEY: token });
  t.after(() => { for (const [name, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const profile = await new ExtensionProfileStore(db).save('1', { version: 1, name: 'Synthetic Claude docs', enabled: true, agentScope: [], repositoryScope: [], skillBundleIds: [], mcpServers: [{ kind: 'catalog', name: 'docs', catalogId: catalog.id, digest: operatorCatalogDigest(catalog), enabled: true, tools: ['lookup'], capability: 'read' }] });

  const capture = path.join(root, 'capture.json');
  await fs.writeFile(path.join(root, 'docker'), `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ value: process.env.${key}, args: process.argv.slice(2) }));
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({type:'result',is_error:false,result:'Synthetic completed task',usage:{input_tokens:1,output_tokens:1}})));
`, { mode: 0o755 });
  const previous = process.env.PATH; process.env.PATH = root + path.delimiter + previous;
  t.after(() => { process.env.PATH = previous; });
  const agent = new ClaudeAgent({ id: 'synthetic', type: 'claude', alias: 'claude', enabled: true, dockerImage: 'synthetic', configPath: root, supportedModels: ['synthetic'], defaultModel: 'synthetic' });
  t.mock.method(agent as any, 'persistExecutionLogs', async () => {});
  t.mock.method(agent as any, 'resolveEffectiveReasoningLevel', async () => '');
  const toolPolicy = { allowWeb: false, exclusiveMcp: true, localMcpServers: [{ name: 'docs', bridgeConfig: 'synthetic', env: { [key]: token } }] };
  assert.ok(!Object.keys(claudeToolPolicyArgs(toolPolicy)).includes('env'));
  const result = await agent.executeTask({ taskId: 'claude-extension-env', worktreePath: root, issueRef: { repoOwner: 'fixture', repoName: 'repo', number: 1 }, prompt: 'Synthetic task', githubToken: '', extensionActorId: '1', extensionProfile: { instanceId: profile.instanceId, profileId: profile.profileId, revision: profile.revision } });
  assert.equal(result.success, true, result.error);
  const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
  assert.equal(captured.value, token);
  assert.ok(captured.args.some((arg: string, index: number) => arg === '-e' && captured.args[index + 1] === key));
  assert.ok(captured.args.includes('--strict-mcp-config'));
  assert.ok(!JSON.stringify(captured.args).includes(token));
  assert.ok(!JSON.stringify(result).includes(token));
  assert.equal(result.success, true);
});

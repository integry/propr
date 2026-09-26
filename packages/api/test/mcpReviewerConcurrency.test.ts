import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ToolDeps } from '../mcp/tools.js';
import type { McpPrincipal } from '../mcp/policy.js';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('real MCP catalog and shared persistence reject stale repository and agent snapshots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-concurrency-'));
  process.env.DATA_DIR = root; process.env.DB_FILENAME = path.join(root, 'core.sqlite'); process.env.NODE_ENV = 'test';
  const core = await import('@propr/core');
  let pauseRepoRead = 0, pauseAgentRead = false;
  let loaded = barrier(), resume = barrier();
  const boundary = await mock.module('@propr/core', { namedExports: { ...core,
    loadMonitoredReposRaw: async () => { const snapshot = await core.loadMonitoredReposRaw(); if (pauseRepoRead && --pauseRepoRead === 0) { loaded.release(); await resume.promise; } return snapshot; },
    loadAgents: async () => { const snapshot = await core.loadAgents(); if (pauseAgentRead) { pauseAgentRead = false; loaded.release(); await resume.promise; } return snapshot; },
  } });
  const registry = core.AgentRegistry.getInstance();
  const refresh = mock.method(registry, 'refresh', async () => {});
  try {
    await core.runMigrations();
    await core.saveMonitoredRepos(['acme/one', 'acme/two'].map(name => ({ id: randomUUID(), name, enabled: true, baseBranch: 'main' })));
    await core.saveAgents(['one', 'two'].map(id => ({ id, alias: id, type: 'claude', enabled: false, supportedModels: ['test-model'], defaultModel: 'test-model', dockerImage: '', configPath: '~/.claude' })));
    const { McpStore } = await import('../mcp/store.js');
    const { McpOAuthProvider } = await import('../mcp/oauth.js');
    const { McpPolicy } = await import('../mcp/policy.js');
    const { createToolCatalog, executeTool } = await import('../mcp/tools.js');
    const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'fixture-instance', encryptionKey: randomBytes(32) };
    const policy = new McpPolicy(new McpOAuthProvider(new McpStore(core.db, config.encryptionKey), config), config);
    const principal = { user: { id: '123', username: 'fixture' }, authorization: { permissions: ['instance.manage_settings', 'instance.manage_agents'], role: 'admin', source: 'local' }, scopes: ['read', 'manage'],
      grant: { id: 'config-grant', repositories: ['acme/one', 'acme/two', 'acme/three'] }, github: { request: async () => ({ data: { permissions: { push: true } } }) } } as unknown as McpPrincipal;
    const deps = { db: core.db, policy, redisClient: { lPush: async () => 1, lTrim: async () => 'OK', set: async () => 'OK', get: async () => null, eval: async () => 1, publish: async () => 1 }, taskQueue: {}, runtimeBuildQueue: {} } as unknown as ToolDeps;
    const catalog = createToolCatalog(deps);
    let key = 0;
    const call = async (name: string, args: Record<string, unknown>) => (await executeTool(catalog.find(tool => tool.name === name)!, { ...args, ...(catalog.find(tool => tool.name === name)!.readOnly ? {} : { idempotencyKey: `config-test-${key++}` }) }, principal, deps)).data as Record<string, unknown> & { result: { changed?: boolean } };
    // Pause after the adapter has loaded its list (policy loads it first).
    pauseRepoRead = 2;
    const first = call('update_repository_configuration', { repository: 'acme/one', baseBranch: 'first-branch' });
    await loaded.promise;
    assert.equal((await call('update_repository_configuration', { repository: 'acme/two', baseBranch: 'second-branch' })).state, 'completed');
    resume.release();
    assert.equal((await first).state, 'failed');
    assert.equal((await core.loadMonitoredReposRaw()).find(repo => repo.name === 'acme/two')!.baseBranch, 'second-branch');
    assert.equal((await call('update_repository_configuration', { repository: 'acme/one', baseBranch: 'first-branch' })).state, 'completed');
    assert.equal((await core.loadMonitoredReposRaw()).find(repo => repo.name === 'acme/two')!.baseBranch, 'second-branch');
    loaded = barrier(); resume = barrier(); pauseAgentRead = true;
    const staleAgent = call('update_agent_configuration', { agentId: 'one', alias: 'first-agent' });
    await loaded.promise;
    assert.equal((await call('update_agent_configuration', { agentId: 'two', alias: 'second-agent' })).state, 'completed');
    resume.release(); assert.equal((await staleAgent).state, 'failed');
    assert.equal((await core.loadAgents()).find(agent => agent.id === 'two')!.alias, 'second-agent');
    const created = await call('create_agent_configuration', { agentId: 'three', type: 'codex', alias: 'third-agent', supportedModels: ['test-model'], defaultModel: 'test-model' });
    assert.equal(created.state, 'completed', JSON.stringify(created));
    assert.equal((await core.loadAgents()).find(agent => agent.id === 'three')!.enabled, false);
    assert.equal((await call('remove_agent_configuration', { agentId: 'three' })).state, 'completed');
    const syntheticId = randomUUID();
    const configuration = { id: syntheticId, alias: 'pool', enabled: false, defaultModel: 'balanced', models: [{ id: 'balanced', members: [{ id: randomUUID(), directAgentAlias: 'second-agent', model: 'test-model' }] }] };
    assert.equal((await call('create_synthetic_agent', { agentId: syntheticId, configuration })).state, 'completed');
    assert.equal((await core.loadSyntheticAgents())[0].models[0].members[0].directAgentAlias, 'second-agent');
    assert.equal((await call('remove_agent_configuration', { agentId: 'two' })).state, 'failed');
    assert.equal((await call('remove_synthetic_agent', { agentId: syntheticId })).state, 'completed');
    assert.equal((await call('create_repository_configuration', { repository: 'acme/three', baseBranch: 'main' })).state, 'completed');
    assert.equal((await call('remove_repository_configuration', { repository: 'acme/three' })).state, 'completed');
    const denied = await call('create_repository_configuration', { repository: 'outside/grant', baseBranch: 'main' });
    assert.equal(denied.state, 'browser_required'); assert.equal(denied.result.changed, false);
    assert.ok(!(await core.loadMonitoredReposRaw()).some(repo => repo.name === 'outside/grant'));
    const settings = { worker_concurrency: 7, analysis_model_fast: 'one:test-model', planner_context_model: 'one:test-model', pr_review_prompt: 'Require evidence', pr_review_context_enabled: false, pr_review_context_model: '', pr_review_max_context_tokens: 12000, pr_review_context_budget_percent: 60 };
    assert.equal((await call('update_execution_settings', { settings })).state, 'completed');
    const read = await call('get_execution_settings', {});
    for (const [key, value] of Object.entries(settings)) assert.equal(read[key], value);
    assert.equal((await call('update_indexing_configuration', { enabled: false, agent_alias: '', fallback_agent_alias: '', custom_prompt: 'Bounded summaries' })).state, 'completed');
    assert.equal((await call('get_indexing_configuration', {})).custom_prompt, 'Bounded summaries');
    assert.equal((await call('update_provider_policy', { enabled: false, url: 'http://localhost:3456' })).state, 'completed');
    assert.equal((await call('get_provider_policy', {})).enabled, false);
    await assert.rejects(call('update_provider_policy', { enabled: true, url: 'https://user:secret@example.com' }));
    principal.authorization.permissions = [];
    await assert.rejects(call('create_repository_configuration', { repository: 'acme/three', baseBranch: 'main' }), /instance.manage_settings/);
  } finally {
    resume.release(); refresh.mock.restore(); boundary.restore();
    await core.closeConnection(); await rm(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ToolDeps } from '../mcp/tools.js';
import type { McpPrincipal } from '../mcp/policy.js';

test('MCP repository configuration sets, reads and clears the merge-conflict auto-resolve override', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-auto-resolve-'));
  process.env.DATA_DIR = root; process.env.DB_FILENAME = path.join(root, 'core.sqlite'); process.env.NODE_ENV = 'test';
  const core = await import('@propr/core');
  try {
    await core.runMigrations();
    await core.saveConfig('auto_resolve_merge_conflicts', false);
    await core.saveMonitoredRepos([
      { id: randomUUID(), name: 'acme/one', enabled: true, baseBranch: 'main' },
      { id: randomUUID(), name: 'acme/one', enabled: true, baseBranch: 'release' },
      { id: randomUUID(), name: 'acme/two', enabled: true, baseBranch: 'main' },
    ]);
    const { McpStore } = await import('../mcp/store.js');
    const { McpOAuthProvider } = await import('../mcp/oauth.js');
    const { McpPolicy } = await import('../mcp/policy.js');
    const { createToolCatalog, executeTool } = await import('../mcp/tools.js');
    const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'fixture-instance', encryptionKey: randomBytes(32) };
    const policy = new McpPolicy(new McpOAuthProvider(new McpStore(core.db, config.encryptionKey), config), config);
    const principal = { user: { id: '123', username: 'fixture' }, authorization: { permissions: ['instance.manage_settings'], role: 'admin', source: 'local' }, scopes: ['read', 'manage'],
      grant: { id: 'config-grant', repositories: ['acme/one', 'acme/two'] }, github: { request: async () => ({ data: { permissions: { push: true } } }) } } as unknown as McpPrincipal;
    const deps = { db: core.db, policy, redisClient: { lPush: async () => 1, lTrim: async () => 'OK', set: async () => 'OK', get: async () => null, eval: async () => 1, publish: async () => 1 }, taskQueue: {}, runtimeBuildQueue: {} } as unknown as ToolDeps;
    const catalog = createToolCatalog(deps);
    let key = 0;
    const call = async (name: string, args: Record<string, unknown>) => {
      const tool = catalog.find(candidate => candidate.name === name)!;
      return (await executeTool(tool, { ...args, ...(tool.readOnly ? {} : { idempotencyKey: `auto-resolve-${key++}` }) }, principal, deps)).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const stored = async (name: string) => (await core.loadMonitoredReposRaw()).filter(repo => repo.name === name).map(repo => repo.autoResolveMergeConflicts);

    const inherited = await call('get_repository_configuration', { repository: 'acme/one' });
    assert.equal(inherited.autoResolveMergeConflicts, null);
    assert.deepEqual(inherited.effective.autoResolveMergeConflicts, { enabled: false, source: 'instance', repositoryOverride: null, instanceDefault: false });

    const enabled = await call('update_repository_configuration', { repository: 'acme/one', autoResolveMergeConflicts: true });
    assert.equal(enabled.state, 'completed', JSON.stringify(enabled));
    assert.deepEqual(await stored('acme/one'), [true, true], 'the override is shared by every branch entry');
    assert.deepEqual(await stored('acme/two'), [undefined]);
    const overridden = await call('get_repository_configuration', { repository: 'ACME/ONE' });
    assert.equal(overridden.autoResolveMergeConflicts, true);
    assert.deepEqual(overridden.effective.autoResolveMergeConflicts, { enabled: true, source: 'repository', repositoryOverride: true, instanceDefault: false });

    // An unrelated update that omits the field keeps the override.
    assert.equal((await call('update_repository_configuration', { repository: 'acme/one', alias: 'One' })).state, 'completed');
    assert.deepEqual(await stored('acme/one'), [true, true]);

    const cleared = await call('update_repository_configuration', { repository: 'acme/one', autoResolveMergeConflicts: null });
    assert.equal(cleared.state, 'completed', JSON.stringify(cleared));
    assert.deepEqual(await stored('acme/one'), [undefined, undefined]);
    const reverted = await call('get_repository_configuration', { repository: 'acme/one' });
    assert.equal(reverted.effective.autoResolveMergeConflicts.source, 'instance');
    assert.equal(reverted.effective.autoResolveMergeConflicts.enabled, false);
  } finally {
    await core.closeConnection();
    await rm(root, { recursive: true, force: true });
  }
});

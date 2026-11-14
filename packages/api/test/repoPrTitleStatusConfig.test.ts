import type { RepoToMonitor } from '@propr/core';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { normalizeRepoConfig, preserveRepoSettings, withDefaultRepoOptions } from '../routes/configRepoValidation.js';
import type { ToolDeps } from '../mcp/tools.js';
import type { McpPrincipal } from '../mcp/policy.js';

const entry = (id: string, name: string, extra: Partial<RepoToMonitor> = {}): RepoToMonitor => ({ id, name, enabled: true, ...extra });

test('prTitleStatus is validated as a boolean and defaults on', () => {
  const normalized = normalizeRepoConfig({ id: 'a', name: 'integry/propr', enabled: true });
  assert.ok(normalized.ok);
  assert.equal(normalized.value.prTitleStatus, true);
  const off = normalizeRepoConfig({ id: 'a', name: 'integry/propr', enabled: true, prTitleStatus: false });
  assert.ok(off.ok);
  assert.equal(off.value.prTitleStatus, false);
  const invalid = normalizeRepoConfig({ id: 'a', name: 'integry/propr', enabled: true, prTitleStatus: 'yes' });
  assert.deepEqual(invalid, { ok: false, error: 'Invalid prTitleStatus format for integry/propr: must be a boolean' });
  assert.equal(withDefaultRepoOptions(entry('a', 'integry/propr')).prTitleStatus, true);
  assert.equal(withDefaultRepoOptions(entry('a', 'integry/propr', { prTitleStatus: false })).prTitleStatus, false);
});

test('prTitleStatus is repository-wide and kept by clients that omit it', () => {
  const previous = [entry('main', 'integry/propr', { prTitleStatus: false }), entry('dev', 'integry/propr', { baseBranch: 'dev' }), entry('other', 'integry/other')];
  const normalize = (incoming: unknown[]) => incoming.map(repo => {
    const result = normalizeRepoConfig(repo);
    assert.ok(result.ok);
    return result.value;
  });
  // A legacy client that does not know the field keeps the stored repository value.
  const legacy = [entry('main', 'integry/propr'), entry('dev', 'integry/propr', { baseBranch: 'dev' }), entry('other', 'integry/other')];
  assert.deepEqual(preserveRepoSettings(previous, normalize(legacy), legacy).map(repo => [repo.id, repo.prTitleStatus]), [['main', false], ['dev', false], ['other', true]]);
  // An explicit change on one branch entry applies to every entry of the repository.
  const on = [entry('main', 'integry/propr', { prTitleStatus: true }), entry('dev', 'integry/propr', { baseBranch: 'dev' }), entry('other', 'integry/other', { prTitleStatus: false })];
  assert.deepEqual(preserveRepoSettings(previous, normalize(on), on).map(repo => [repo.id, repo.prTitleStatus]), [['main', true], ['dev', true], ['other', false]]);
  const off = [entry('main', 'integry/propr', { prTitleStatus: false }), entry('dev', 'integry/propr', { baseBranch: 'dev' }), entry('other', 'integry/other')];
  assert.deepEqual(preserveRepoSettings(previous, normalize(off), off).map(repo => [repo.id, repo.prTitleStatus]), [['main', false], ['dev', false], ['other', true]]);
});

test('MCP repository configuration sets and reads prTitleStatus', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-pr-title-status-'));
  process.env.DATA_DIR = root; process.env.DB_FILENAME = path.join(root, 'core.sqlite'); process.env.NODE_ENV = 'test';
  const core = await import('@propr/core');
  try {
    await core.runMigrations();
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
      return (await executeTool(tool, { ...args, ...(tool.readOnly ? {} : { idempotencyKey: `pr-title-status-${key++}` }) }, principal, deps)).data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const stored = async (name: string) => (await core.loadMonitoredReposRaw()).filter(repo => repo.name === name).map(repo => repo.prTitleStatus);

    assert.equal((await call('get_repository_configuration', { repository: 'acme/one' })).prTitleStatus, true, 'on by default');
    const disabled = await call('update_repository_configuration', { repository: 'acme/one', prTitleStatus: false });
    assert.equal(disabled.state, 'completed', JSON.stringify(disabled));
    assert.deepEqual(await stored('acme/one'), [false, false]);
    assert.deepEqual(await stored('acme/two'), [true]);
    assert.equal((await call('get_repository_configuration', { repository: 'acme/one' })).prTitleStatus, false);
    assert.equal(await core.loadRepositoryPrTitleStatus('ACME/one'), false);
    assert.equal(await core.loadRepositoryPrTitleStatus('acme/two'), true);

    assert.equal((await call('update_repository_configuration', { repository: 'acme/one', alias: 'One' })).state, 'completed');
    assert.deepEqual(await stored('acme/one'), [false, false], 'an update that omits the field keeps it');

    assert.equal((await call('update_repository_configuration', { repository: 'acme/one', prTitleStatus: true })).state, 'completed');
    assert.deepEqual(await stored('acme/one'), [true, true]);
  } finally {
    await core.closeConnection();
    await rm(root, { recursive: true, force: true });
  }
});

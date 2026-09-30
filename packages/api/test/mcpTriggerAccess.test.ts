import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { McpPrincipal } from '../mcp/policy.js';
import type { ToolDeps } from '../mcp/tools.js';

test('trigger access tools split bots, preserve revisions and reject unsafe or environment-owned writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-trigger-access-'));
  const previousEnvironment = {
    dataDir: process.env.DATA_DIR,
    database: process.env.DB_FILENAME,
    allowlist: process.env.GITHUB_USER_WHITELIST,
    blocklist: process.env.GITHUB_USER_BLACKLIST,
  };
  process.env.DATA_DIR = root;
  process.env.DB_FILENAME = path.join(root, 'core.sqlite');
  process.env.NODE_ENV = 'test';
  const core = await import('@propr/core');
  try {
    await core.runMigrations();
    const { McpStore } = await import('../mcp/store.js');
    const { McpOAuthProvider } = await import('../mcp/oauth.js');
    const { McpPolicy } = await import('../mcp/policy.js');
    const { McpError } = await import('../mcp/config.js');
    const { createToolCatalog, executeTool } = await import('../mcp/tools.js');
    const mcpConfig = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'fixture-instance', encryptionKey: randomBytes(32) };
    const policy = new McpPolicy(new McpOAuthProvider(new McpStore(core.db, mcpConfig.encryptionKey), mcpConfig), mcpConfig);
    const principal = {
      user: { id: '123', username: 'admin' },
      authorization: { permissions: ['instance.manage_settings'], role: 'admin', source: 'local' },
      scopes: ['manage'],
      grant: { id: 'trigger-access-grant', repositories: [] },
      github: {},
    } as unknown as McpPrincipal;
    const deps = {
      db: core.db,
      policy,
      redisClient: { set: async () => 'OK', get: async () => null, eval: async () => 1, publish: async () => 1, lPush: async () => 1, lTrim: async () => 'OK' },
      taskQueue: {},
      runtimeBuildQueue: {},
    } as unknown as ToolDeps;
    const catalog = createToolCatalog(deps);
    const get = catalog.find(tool => tool.name === 'get_trigger_access_configuration')!;
    const update = catalog.find(tool => tool.name === 'update_trigger_access_configuration')!;
    assert.equal(get.permission, 'instance.manage_settings');
    assert.equal(update.permission, 'instance.manage_settings');

    const withoutPermission = { ...principal, authorization: { ...principal.authorization, permissions: [] } };
    await assert.rejects(executeTool(get, {}, withoutPermission, deps), /instance.manage_settings/);
    await assert.rejects(executeTool(update, { expectedRevision: '0'.repeat(64), addUsers: ['alice'], idempotencyKey: 'denied-trigger-write' }, withoutPermission, deps), /instance.manage_settings/);

    process.env.GITHUB_USER_WHITELIST = 'environment-user,dependabot[bot]';
    process.env.GITHUB_USER_BLACKLIST = 'blocked-user';
    const environmentRead = (await get.run({ principal, args: {} })).data as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.deepEqual(environmentRead.users.allowlist, ['environment-user']);
    assert.deepEqual(environmentRead.users.blocklist, ['blocked-user']);
    assert.deepEqual(environmentRead.bots.allowlist, ['dependabot[bot]']);
    assert.equal(environmentRead.users.source.allowlist, 'environment');
    assert.equal(environmentRead.users.editable.allowlist, false);
    await assert.rejects(
      update.run({ principal, args: update.schema.parse({ expectedRevision: environmentRead.revision, addUsers: ['alice'], idempotencyKey: 'environment-write' }) }),
      (error: unknown) => error instanceof McpError && error.code === 'SETTING_ENVIRONMENT_MANAGED' && error.status === 409 && error.message.includes('GITHUB_USER_WHITELIST'),
    );

    delete process.env.GITHUB_USER_WHITELIST;
    delete process.env.GITHUB_USER_BLACKLIST;
    await core.saveSettings({ github_user_whitelist: ['alice'] });
    const initial = (await get.run({ principal, args: {} })).data as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const added = (await update.run({ principal, args: update.schema.parse({ expectedRevision: initial.revision, addBots: ['renovate'], idempotencyKey: 'add-renovate-bot' }) })).data as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.deepEqual(added.users.allowlist, ['alice']);
    assert.deepEqual(added.bots.allowlist, ['renovate[bot]']);
    assert.deepEqual((await core.loadSettings()).github_user_whitelist, ['alice', 'renovate[bot]']);
    process.env.GITHUB_USER_WHITELIST = 'alice,renovate[bot]';
    assert.equal(core.filterCommentByAuthor('renovate[bot]', 'Bot').shouldFilter, false);
    delete process.env.GITHUB_USER_WHITELIST;

    const beforeConcurrentUiSave = (await get.run({ principal, args: {} })).data as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    await core.saveSettings({ github_user_whitelist: ['ui-user'] });
    await assert.rejects(
      update.run({ principal, args: update.schema.parse({ expectedRevision: beforeConcurrentUiSave.revision, addUsers: ['mcp-user'], idempotencyKey: 'stale-trigger-write' }) }),
      (error: unknown) => error instanceof McpError && error.code === 'STALE_REVISION',
    );
    assert.deepEqual((await core.loadSettings()).github_user_whitelist, ['ui-user']);

    const current = (await get.run({ principal, args: {} })).data as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const removal = { expectedRevision: current.revision, removeUsers: ['ui-user'], idempotencyKey: 'remove-final-user' };
    await assert.rejects(
      update.run({ principal, args: update.schema.parse(removal) }),
      (error: unknown) => error instanceof McpError && error.code === 'CONFIRMATION_REQUIRED',
    );
    await update.run({ principal, args: update.schema.parse({ ...removal, confirmOpenAccess: true, idempotencyKey: 'confirm-open-access' }) });
    assert.deepEqual((await core.loadSettings()).github_user_whitelist, []);
  } finally {
    await core.closeConnection();
    await rm(root, { recursive: true, force: true });
    if (previousEnvironment.dataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousEnvironment.dataDir;
    if (previousEnvironment.database === undefined) delete process.env.DB_FILENAME; else process.env.DB_FILENAME = previousEnvironment.database;
    if (previousEnvironment.allowlist === undefined) delete process.env.GITHUB_USER_WHITELIST; else process.env.GITHUB_USER_WHITELIST = previousEnvironment.allowlist;
    if (previousEnvironment.blocklist === undefined) delete process.env.GITHUB_USER_BLACKLIST; else process.env.GITHUB_USER_BLACKLIST = previousEnvironment.blocklist;
  }
});

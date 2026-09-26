import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import express, { type Express, type RequestHandler } from 'express';
import knex, { type Knex } from 'knex';
import { z } from 'zod';
import { closeConnection } from '@propr/core';
import { createAdminMcpRoutes } from '../routes/adminMcpRoutes.js';
import {
  assertNoDuplicateRoutes,
  createManagementRouteEntries,
  registerRouteEntries,
} from '../routeRegistry.js';
import { McpError } from '../mcp/config.js';
import { McpStore } from '../mcp/store.js';
import { McpOAuthProvider, type McpGrant } from '../mcp/oauth.js';
import { McpPolicy, type McpPrincipal } from '../mcp/policy.js';
import { mountMcp } from '../mcp/server.js';
import { renderConnectedApp } from '../mcp/browser.js';
import { createToolCatalog, executeTool, ok, type McpTool, type ToolDeps } from '../mcp/tools.js';
import {
  loadMcpGrantActivity,
  pruneMcpAccessLog,
  recordMcpAccess,
  MCP_ACCESS_LOG_RETENTION_MS,
  type McpAccessLogRow,
} from '../mcp/accessLog.js';

after(async () => closeConnection());

const MIGRATIONS = { directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) };

async function createDatabase(): Promise<Knex> {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.migrate.latest(MIGRATIONS);
  return db;
}

function createDeps(db: Knex): ToolDeps {
  const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'test-instance', encryptionKey: randomBytes(32) };
  const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
  policy.repository = async () => { /* repository authorization is covered elsewhere */ };
  return { db, policy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never };
}

const principal = (overrides: Partial<McpPrincipal> = {}): McpPrincipal => ({
  user: { id: '123', login: 'tester', username: 'tester', displayName: 'Test', email: null, avatarUrl: null, accessToken: 'fixture' },
  authorization: { role: 'member', permissions: [], source: 'local' },
  grant: {
    id: 'grant-1', ownerId: '123', clientId: 'client-1', clientName: 'Claude', instanceId: 'test-instance',
    resource: 'https://instance.example/api/mcp', scopes: ['read'], repositories: ['acme/repo'],
    createdAt: Date.now(), expiresAt: Date.now() + 60_000, revoked: false, membershipSource: 'local',
  },
  scopes: ['read'],
  github: {} as never,
  ...overrides,
} as McpPrincipal);

const rows = (db: Knex) => db<McpAccessLogRow>('mcp_access_log').orderBy('id').select('*');

test('a successful tool call writes exactly one access row describing the invocation', async t => {
  const db = await createDatabase();
  t.after(() => db.destroy());
  const deps = createDeps(db);
  const tool = createToolCatalog(deps).find(candidate => candidate.name === 'list_goals')!;

  const result = await executeTool(tool, { repository: 'acme/repo' }, principal(), deps);
  assert.deepEqual((result.data as { goals: unknown[] }).goals, []);

  const [row, ...rest] = await rows(db);
  assert.deepEqual(rest, []);
  assert.equal(row.kind, 'tool');
  assert.equal(row.name, 'list_goals');
  assert.equal(row.repository, 'acme/repo');
  assert.equal(row.scope, 'read');
  assert.equal(Boolean(row.read_only), true);
  assert.equal(row.status, 200);
  assert.equal(row.outcome, 'success');
  assert.equal(row.error_code, null);
  assert.equal(row.owner_id, '123');
  assert.equal(row.grant_id, 'grant-1');
  assert.equal(row.client_id, 'client-1');
  assert.equal(row.client_name, 'Claude');
  assert.equal(row.membership_source, 'local');
  assert.equal(row.operation_id, null);
  assert.ok(row.result_bytes > 0);
  assert.ok(row.duration_ms >= 0);
  assert.ok(Number(row.occurred_at) > Date.now() - 60_000);
});

test('permission denials and internal errors are recorded with their outcome and error code', async t => {
  const db = await createDatabase();
  t.after(() => db.destroy());
  const deps = createDeps(db);

  const guarded: McpTool = {
    name: 'guarded_fixture', description: 'fixture', scope: 'read', readOnly: true,
    permission: 'instance.manage_settings', schema: z.object({}).strict(), run: async () => ok({}),
  };
  const broken: McpTool = {
    name: 'broken_fixture', description: 'fixture', scope: 'read', readOnly: true,
    schema: z.object({}).strict(), run: async () => { throw new Error('fixture failure'); },
  };
  const invalid: McpTool = {
    name: 'strict_fixture', description: 'fixture', scope: 'read', readOnly: true,
    schema: z.object({ repository: z.string() }).strict(), run: async () => ok({}),
  };

  await assert.rejects(executeTool(guarded, {}, principal(), deps), /requires instance.manage_settings/);
  await assert.rejects(executeTool(broken, {}, principal(), deps), /fixture failure/);
  await assert.rejects(executeTool(invalid, { unexpected: true }, principal(), deps));

  const recorded = await rows(db);
  assert.deepEqual(recorded.map(row => [row.name, row.outcome, row.error_code, row.status]), [
    ['guarded_fixture', 'denied', 'INSUFFICIENT_INSTANCE_PERMISSION', 403],
    ['broken_fixture', 'error', 'INTERNAL_ERROR', 500],
    ['strict_fixture', 'denied', 'INVALID_INPUT', 400],
  ]);
  // A thrown failure never carries its message into the table.
  assert.ok(!JSON.stringify(recorded).includes('fixture failure'));
});

test('a recorder failure changes neither the tool result nor the request', async t => {
  const db = await createDatabase();
  t.after(() => db.destroy());
  const deps = createDeps(db);
  const tool = createToolCatalog(deps).find(candidate => candidate.name === 'list_goals')!;
  await db.schema.dropTable('mcp_access_log');

  const result = await executeTool(tool, { repository: 'acme/repo' }, principal(), deps);
  assert.deepEqual((result.data as { goals: unknown[] }).goals, []);
  assert.equal(await db.schema.hasTable('mcp_access_log'), false);
});

test('an argument carrying a secret produces a row containing none of it', async t => {
  const db = await createDatabase();
  t.after(() => db.destroy());
  const deps = createDeps(db);
  const secret = 'ghp_fixtureSuperSecretCredential0123456789';
  const leaky: McpTool = {
    name: 'echo_fixture', description: 'fixture', scope: 'read', readOnly: true,
    schema: z.object({ repository: z.string(), token: z.string(), message: z.string() }).strict(),
    run: async ({ args }) => ok({ token: args.token, message: args.message }),
  };

  await executeTool(leaky, { repository: 'acme/repo', token: secret, message: `Deploy with ${secret}` }, principal(), deps);

  const [row] = await rows(db);
  const serialized = JSON.stringify(row);
  assert.ok(!serialized.includes(secret), serialized);
  assert.ok(!serialized.includes('ghp_'), serialized);
  assert.ok(!serialized.includes('Deploy with'), serialized);
  assert.equal(row.name, 'echo_fixture');
  assert.equal(row.outcome, 'success');
  assert.ok(row.result_bytes > 0);
});

test('retention prunes rows outside the window and enforces the row ceiling', async t => {
  const db = await createDatabase();
  t.after(() => db.destroy());
  const now = Date.UTC(2026, 8, 23, 12);
  // Inserted directly: recording a row would also schedule the opportunistic
  // sweep, and this test owns when pruning happens.
  const entry = (occurredAt: number, name: string) => db('mcp_access_log').insert({
    occurred_at: occurredAt, owner_id: '123', kind: 'tool', name, status: 200,
    outcome: 'success', read_only: false, duration_ms: 0, result_bytes: 0,
  });

  await entry(now - MCP_ACCESS_LOG_RETENTION_MS - 1, 'ancient');
  await entry(now - MCP_ACCESS_LOG_RETENTION_MS + 1, 'inside_window');
  await entry(now, 'fresh');

  assert.equal(await pruneMcpAccessLog(db, { now }), 1);
  assert.deepEqual((await rows(db)).map(row => row.name), ['inside_window', 'fresh']);

  assert.equal(await pruneMcpAccessLog(db, { now, maxRows: 1 }), 1);
  assert.deepEqual((await rows(db)).map(row => row.name), ['fresh']);

  // An empty table prunes to a no-op rather than failing.
  assert.equal(await pruneMcpAccessLog(db, { now, maxRows: 0 }), 1);
  assert.equal(await pruneMcpAccessLog(db, { now }), 0);
});

test('an authentication failure at /api/mcp records an auth row without a principal', async t => {
  const db = await createDatabase();
  t.after(() => db.destroy());
  const previous = { ...process.env };
  Object.assign(process.env, {
    MCP_ENABLED: 'true',
    MCP_PUBLIC_ORIGIN: 'https://instance.example',
    MCP_INSTANCE_ID: 'access-log-test-instance',
    MCP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  });
  t.after(() => { for (const key of ['MCP_ENABLED', 'MCP_PUBLIC_ORIGIN', 'MCP_INSTANCE_ID', 'MCP_ENCRYPTION_KEY']) delete process.env[key]; Object.assign(process.env, previous); });

  const app = express();
  app.use(express.json());
  mountMcp(app, { db, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never });

  await withServer(app, async origin => {
    const unauthenticated = await fetch(`${origin}/api/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    });
    assert.equal(unauthenticated.status, 401);

    const revoked = await fetch(`${origin}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer propr_mcp_revoked_fixture_token', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }),
    });
    assert.equal(revoked.status, 401);
  });

  const recorded = await rows(db);
  assert.equal(recorded.length, 2);
  for (const row of recorded) {
    assert.equal(row.kind, 'auth');
    assert.equal(row.name, 'authenticate');
    assert.equal(row.outcome, 'denied');
    assert.equal(row.status, 401);
    assert.equal(row.owner_id, null);
    assert.equal(row.grant_id, null);
    assert.equal(row.client_id, null);
  }
  assert.equal(recorded[0].error_code, 'MISSING_BEARER');
  assert.equal(recorded[0].request_id, '7');
  assert.ok(recorded[1].error_code && recorded[1].error_code !== 'MISSING_BEARER');
  assert.equal(recorded[1].protocol_version, '2025-11-25');
  // The presented credential itself is never stored.
  assert.ok(!JSON.stringify(recorded).includes('propr_mcp_revoked_fixture_token'));
});

async function withServer(app: Express, run: (origin: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function adminApp(db: Knex): Express {
  const routes = createAdminMcpRoutes({ database: db });
  const app = express();
  app.get('/api/admin/mcp/logs', routes.getLogs as RequestHandler);
  app.get('/api/admin/mcp/logs/stats', routes.getLogStats as RequestHandler);
  return app;
}

interface LogsResponse { data: Array<Record<string, unknown>>; pagination: Record<string, unknown> }

async function seedAccessLog(db: Knex): Promise<number> {
  const base = Date.UTC(2026, 8, 20, 12);
  const fixtures = [
    { occurredAt: base + 1000, ownerId: '123', clientId: 'client-1', clientName: 'Claude', kind: 'tool' as const, name: 'list_goals', repository: 'acme/repo', scope: 'read', readOnly: true, status: 200, outcome: 'success' as const, durationMs: 10 },
    { occurredAt: base + 2000, ownerId: '123', clientId: 'client-1', clientName: 'Claude', kind: 'tool' as const, name: 'create_goal', repository: 'acme/repo', scope: 'execute', status: 403, outcome: 'denied' as const, errorCode: 'REPOSITORY_FORBIDDEN', durationMs: 20 },
    { occurredAt: base + 3000, ownerId: '456', clientId: 'client-2', clientName: 'Other', kind: 'resource' as const, name: 'plans', repository: 'other/repo', scope: 'read', readOnly: true, status: 200, outcome: 'success' as const, durationMs: 30 },
    { occurredAt: base + 4000, ownerId: '456', clientId: 'client-2', clientName: 'Other', kind: 'prompt' as const, name: 'plan_change', status: 200, outcome: 'success' as const, durationMs: 40 },
    { occurredAt: base + 5000, kind: 'auth' as const, name: 'authenticate', status: 401, outcome: 'denied' as const, errorCode: 'ACCESS_REVOKED', durationMs: 50 },
    { occurredAt: base + 6000, ownerId: '123', clientId: 'client-1', clientName: 'Claude', kind: 'tool' as const, name: 'list_goals', repository: 'acme/repo', scope: 'read', readOnly: true, status: 500, outcome: 'error' as const, errorCode: 'INTERNAL_ERROR', durationMs: 60 },
  ];
  for (const fixture of fixtures) await recordMcpAccess(db, fixture);
  return base;
}

test('the access log list endpoint paginates newest-first and validates every filter', async t => {
  const db = await createDatabase();
  t.after(() => db.destroy());
  const base = await seedAccessLog(db);

  await withServer(adminApp(db), async origin => {
    const get = async (query: string) => {
      const response = await fetch(`${origin}/api/admin/mcp/logs${query}`);
      return { status: response.status, body: await response.json() as LogsResponse & { error?: string; code?: string } };
    };

    const all = await get('');
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.data.map(row => row.name), ['list_goals', 'authenticate', 'plan_change', 'plans', 'create_goal', 'list_goals']);
    assert.deepEqual(all.body.pagination, { page: 1, limit: 50, offset: 0, total: 6, totalPages: 1, hasNextPage: false, hasPreviousPage: false });
    assert.equal(all.body.data[0].outcome, 'error');
    assert.equal(all.body.data[0].readOnly, true);
    assert.equal(all.body.data[1].clientId, null);

    const firstPage = await get('?limit=2');
    assert.deepEqual(firstPage.body.data.map(row => row.name), ['list_goals', 'authenticate']);
    assert.deepEqual(firstPage.body.pagination, { page: 1, limit: 2, offset: 0, total: 6, totalPages: 3, hasNextPage: true, hasPreviousPage: false });
    const lastPage = await get('?limit=2&page=3');
    assert.deepEqual(lastPage.body.data.map(row => row.name), ['create_goal', 'list_goals']);
    assert.equal(lastPage.body.pagination.hasNextPage, false);
    assert.equal(lastPage.body.pagination.hasPreviousPage, true);

    assert.deepEqual((await get('?ownerId=456')).body.data.map(row => row.name), ['plan_change', 'plans']);
    assert.deepEqual((await get('?clientId=client-1')).body.data.map(row => row.name), ['list_goals', 'create_goal', 'list_goals']);
    assert.deepEqual((await get('?repository=acme%2Frepo')).body.data.map(row => row.name), ['list_goals', 'create_goal', 'list_goals']);
    assert.deepEqual((await get('?name=list_goals')).body.data.map(row => row.outcome), ['error', 'success']);
    assert.deepEqual((await get('?kind=auth')).body.data.map(row => row.errorCode), ['ACCESS_REVOKED']);
    assert.deepEqual((await get('?outcome=denied')).body.data.map(row => row.name), ['authenticate', 'create_goal']);
    assert.deepEqual((await get(`?since=${base + 4000}`)).body.data.map(row => row.name), ['list_goals', 'authenticate', 'plan_change']);
    assert.deepEqual((await get(`?until=${base + 2000}`)).body.data.map(row => row.name), ['create_goal', 'list_goals']);
    assert.deepEqual((await get(`?since=${base + 2000}&until=${base + 3000}`)).body.data.map(row => row.name), ['plans', 'create_goal']);
    assert.deepEqual((await get(`?since=${new Date(base + 4000).toISOString()}`)).body.data.map(row => row.name), ['list_goals', 'authenticate', 'plan_change']);
    assert.deepEqual((await get('?ownerId=123&kind=tool&outcome=success')).body.data.map(row => row.name), ['list_goals']);

    for (const query of ['?kind=banana', '?outcome=maybe', '?repository=not-a-repo', '?name=has%20space', '?ownerId=' + 'x'.repeat(65),
      '?since=yesterday', '?until=nope', `?since=${base + 3000}&until=${base + 1000}`, '?limit=0', '?limit=201', '?page=0', '?sort=name']) {
      const rejected = await get(query);
      assert.equal(rejected.status, 400, query);
      assert.equal(rejected.body.code, 'INVALID_INPUT', query);
    }
    assert.equal((await get('?limit=200')).status, 200);

    // A resource row carries its path as its name, and that name must be filterable.
    await recordMcpAccess(db, { occurredAt: base + 7000, kind: 'resource', name: 'activity/recent', status: 200, outcome: 'success', durationMs: 5 });
    assert.deepEqual((await get('?name=activity%2Frecent')).body.data.map(row => [row.kind, row.name]), [['resource', 'activity/recent']]);
  });
});

test('the stats endpoint aggregates a bounded window and stays correct when empty', async t => {
  const db = await createDatabase();
  t.after(() => db.destroy());

  await withServer(adminApp(db), async origin => {
    const get = async (query: string) => {
      const response = await fetch(`${origin}/api/admin/mcp/logs/stats${query}`);
      return { status: response.status, body: await response.json() as { data: Record<string, any>; code?: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };

    const empty = await get('');
    assert.equal(empty.status, 200);
    assert.equal(empty.body.data.total, 0);
    assert.deepEqual(empty.body.data.outcomes, { success: 0, denied: 0, error: 0 });
    assert.deepEqual(empty.body.data.topTools, []);
    assert.deepEqual(empty.body.data.topClients, []);
    assert.deepEqual(empty.body.data.topRepositories, []);
    assert.deepEqual(empty.body.data.errorCodes, []);
    assert.deepEqual(empty.body.data.durationMs, { p50: null, p95: null });

    const base = await seedAccessLog(db);
    const populated = await get(`?since=${base}&until=${base + 10_000}`);
    assert.equal(populated.status, 200);
    assert.deepEqual(populated.body.data.window, { since: base, until: base + 10_000 });
    assert.equal(populated.body.data.total, 6);
    assert.deepEqual(populated.body.data.outcomes, { success: 3, denied: 2, error: 1 });
    assert.deepEqual(populated.body.data.topTools, [{ name: 'list_goals', count: 2 }, { name: 'create_goal', count: 1 }]);
    assert.deepEqual(populated.body.data.topClients, [
      { clientId: 'client-1', clientName: 'Claude', count: 3 },
      { clientId: 'client-2', clientName: 'Other', count: 2 },
    ]);
    assert.deepEqual(populated.body.data.topRepositories, [{ repository: 'acme/repo', count: 3 }, { repository: 'other/repo', count: 1 }]);
    assert.deepEqual(populated.body.data.errorCodes, [
      { errorCode: 'ACCESS_REVOKED', count: 1 }, { errorCode: 'INTERNAL_ERROR', count: 1 }, { errorCode: 'REPOSITORY_FORBIDDEN', count: 1 },
    ]);
    assert.deepEqual(populated.body.data.durationMs, { p50: 30, p95: 60 });

    const narrowed = await get(`?since=${base + 3000}&until=${base + 4000}`);
    assert.equal(narrowed.body.data.total, 2);
    assert.deepEqual(narrowed.body.data.topTools, []);

    const tooWide = await get(`?since=0&until=${MCP_ACCESS_LOG_RETENTION_MS + 1}`);
    assert.equal(tooWide.status, 400);
    assert.equal(tooWide.body.code, 'INVALID_INPUT');
    assert.equal((await get('?page=2')).status, 400);
  });
});

test('the access log endpoints require the same instance permission as the other admin MCP routes', async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.authorization = req.header('x-test-role') === 'admin'
      ? { role: 'admin', permissions: ['instance.manage_settings'], source: 'local' }
      : { role: 'member', permissions: [], source: 'implicit' };
    next();
  });
  const terminal: RequestHandler = (_req, res) => { res.json({ ok: true }); };
  const routes = createManagementRouteEntries({
    adminRoutes: new Proxy({}, { get: () => terminal }) as never,
    adminMcpRoutes: new Proxy({}, { get: () => terminal }) as never,
    agentLoginRoutes: new Proxy({}, { get: () => terminal }) as never,
    agentRuntimeRoutes: new Proxy({}, { get: () => terminal }) as never,
    agentVersionRoutes: new Proxy({}, { get: () => terminal }) as never,
    configRoutes: new Proxy({}, { get: () => terminal }) as never,
    visualPreviewAuthRoutes: new Proxy({}, { get: () => terminal }) as never,
  });
  assertNoDuplicateRoutes(routes);
  registerRouteEntries(app, routes);

  await withServer(app, async origin => {
    for (const path of ['/api/admin/mcp/logs', '/api/admin/mcp/logs/stats']) {
      const denied = await fetch(`${origin}${path}`);
      assert.equal(denied.status, 403, path);
      assert.equal((await denied.json() as { code: string }).code, 'INSUFFICIENT_INSTANCE_PERMISSION');
      const allowed = await fetch(`${origin}${path}`, { headers: { 'x-test-role': 'admin' } });
      assert.equal(allowed.status, 200, path);
    }
  });
});

test('connected apps show last-seen and recent request counts from the access log', async t => {
  const db = await createDatabase();
  t.after(() => db.destroy());
  const now = Date.now();
  await recordMcpAccess(db, { occurredAt: now - 2 * 3_600_000, grantId: 'grant-1', kind: 'tool', name: 'list_goals', status: 200, outcome: 'success' });
  await recordMcpAccess(db, { occurredAt: now - 40 * 3_600_000, grantId: 'grant-1', kind: 'tool', name: 'list_goals', status: 200, outcome: 'success' });

  const activity = (await loadMcpGrantActivity(db, ['grant-1', 'grant-2'], now))!;
  assert.equal(activity.get('grant-1')!.lastSeenAt, now - 2 * 3_600_000);
  assert.equal(activity.get('grant-1')!.recentRequests, 1);
  assert.equal(activity.get('grant-2'), undefined);

  const grant: McpGrant = {
    id: 'grant-1', ownerId: '123', clientId: 'client-1', clientName: 'Claude', instanceId: 'test-instance',
    resource: 'https://instance.example/api/mcp', scopes: ['read'], repositories: ['acme/repo'],
    createdAt: now - 3 * 86_400_000, expiresAt: now + 3_600_000, revoked: false, membershipSource: 'local',
  };
  const used = renderConnectedApp(grant, '', activity.get('grant-1'));
  assert.match(used, /Last used 2h ago/);
  assert.match(used, /1 request in the last 24h/);
  assert.match(renderConnectedApp(grant, '', { lastSeenAt: now, recentRequests: 4 }), /4 requests in the last 24h/);
  // No retained rows (history predating the log, or pruned) is not proof of non-use.
  const unrecorded = renderConnectedApp(grant, '', activity.get('grant-2'));
  assert.match(unrecorded, /No recorded activity/);
  assert.doesNotMatch(unrecorded, /Never used|Last used/);

  // Pruning a grant's last retained row leaves no evidence either way.
  assert.equal(await pruneMcpAccessLog(db, { now, retentionMs: 3_600_000 }), 2);
  const pruned = (await loadMcpGrantActivity(db, ['grant-1'], now))!;
  assert.equal(pruned.size, 0);
  assert.match(renderConnectedApp(grant, '', pruned.get('grant-1')), /No recorded activity/);

  // A log that cannot be read is reported as unavailable, not as an empty result.
  await db.schema.dropTable('mcp_access_log');
  assert.equal(await loadMcpGrantActivity(db, ['grant-1'], now), null);
  const unavailable = renderConnectedApp(grant, '', null);
  assert.match(unavailable, /Activity unavailable/);
  assert.doesNotMatch(unavailable, /No recorded activity|Never used|Last used/);
});

test('resource reads and prompt fetches are recorded once, under their own surface', async t => {
  const db = await createDatabase();
  t.after(() => db.destroy());
  const deps = createDeps(db);
  const { withMcpSurface } = await import('../mcp/accessLog.js');
  const catalog = createToolCatalog(deps);
  const tool = catalog.find(candidate => candidate.name === 'list_goals')!;

  await withMcpSurface(db, principal(), { kind: 'resource', name: 'goals' }, async () =>
    executeTool(tool, { repository: 'acme/repo' }, principal(), deps));
  await withMcpSurface(db, principal(), { kind: 'prompt', name: 'plan_change' }, async () => ({ messages: [] }));
  await assert.rejects(withMcpSurface(db, principal(), { kind: 'resource', name: 'plans' }, async () => {
    throw new McpError('NOT_FOUND', 'Resource not found.', 404);
  }));

  assert.deepEqual((await rows(db)).map(row => [row.kind, row.name, row.outcome, row.error_code]), [
    ['resource', 'goals', 'success', null],
    ['prompt', 'plan_change', 'success', null],
    ['resource', 'plans', 'denied', 'NOT_FOUND'],
  ]);
});

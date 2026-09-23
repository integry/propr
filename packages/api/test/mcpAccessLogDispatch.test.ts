import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import express, { type Express } from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import knex, { type Knex } from 'knex';
import { z } from 'zod';
import { closeConnection } from '@propr/core';
import { McpError } from '../mcp/config.js';
import { McpStore } from '../mcp/store.js';
import { McpOAuthProvider } from '../mcp/oauth.js';
import { McpPolicy, type McpPrincipal } from '../mcp/policy.js';
import { serveMcpRequest } from '../mcp/server.js';
import { createToolCatalog, executeTool, type McpTool, type ToolDeps } from '../mcp/tools.js';
import { pruneMcpAccessLog, MCP_ACCESS_LOG_RETENTION_MS, type McpAccessLogRow } from '../mcp/accessLog.js';

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

const principal = (): McpPrincipal => ({
  user: { id: '123', login: 'tester', username: 'tester', displayName: 'Test', email: null, avatarUrl: null, accessToken: 'fixture' },
  authorization: { role: 'member', permissions: [], source: 'local' },
  grant: {
    id: 'grant-1', ownerId: '123', clientId: 'client-1', clientName: 'Claude', instanceId: 'test-instance',
    resource: 'https://instance.example/api/mcp', scopes: ['read'], repositories: ['acme/repo'],
    createdAt: Date.now(), expiresAt: Date.now() + 60_000, revoked: false, membershipSource: 'local',
  },
  scopes: ['read'],
  github: {} as never,
} as McpPrincipal);

const rows = (db: Knex) => db<McpAccessLogRow>('mcp_access_log').orderBy('id').select('*');

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

// The protocol SDK validates a tool's registered input schema and a prompt's
// argument schema before it dispatches the callback that records invocations,
// so these rejections are only observable over a real MCP request.
test('a call the protocol SDK rejects before dispatch is still recorded once', async t => {
  const db = await createDatabase();
  t.after(() => db.destroy());
  const deps = createDeps(db);
  const catalog = createToolCatalog(deps);
  const app = express();
  app.use(express.json());
  app.all('/api/mcp', async (req, res) => { await serveMcpRequest({ principal: principal(), deps, catalog }, req, res); });

  await withServer(app, async origin => {
    const client = new Client({ name: 'access-log-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`)));
    try {
      // Listing the surfaces is not an invocation and records nothing.
      assert.ok((await client.listTools()).tools.some(tool => tool.name === 'list_goals'));
      const valid = await client.callTool({ name: 'list_goals', arguments: { repository: 'acme/repo' } });
      assert.notEqual(valid.isError, true, JSON.stringify(valid));
      // Rejected by the registered input schema, before the tool callback runs.
      const invalid = await client.callTool({ name: 'list_goals', arguments: { repository: 'acme/repo', unexpected: true } });
      assert.equal(invalid.isError, true);
      await assert.rejects(client.callTool({ name: 'no_such_tool', arguments: {} }), /no_such_tool/);
      // Rejected by the prompt argument schema, before the prompt callback runs.
      await client.getPrompt({ name: 'plan_change', arguments: { request: 'Improve reliability' } });
      await assert.rejects(client.getPrompt({ name: 'plan_change', arguments: { request: 'x'.repeat(4097) } }));
    } finally {
      await client.close();
    }
  });

  const recorded = await rows(deps.db);
  assert.deepEqual(recorded.map(row => [row.kind, row.name, row.outcome, row.error_code, row.status]), [
    ['tool', 'list_goals', 'success', null, 200],
    ['tool', 'list_goals', 'denied', 'INVALID_INPUT', 400],
    ['tool', 'no_such_tool', 'denied', 'NOT_FOUND', 404],
    ['prompt', 'plan_change', 'success', null, 200],
    ['prompt', 'plan_change', 'denied', 'INVALID_INPUT', 400],
  ]);
  // The rejected arguments themselves never reach the table.
  assert.ok(!JSON.stringify(recorded).includes('x'.repeat(64)));
  for (const row of recorded) assert.equal(row.owner_id, '123');
});

// A mutation answers with a durable receipt instead of throwing, so its access
// row must be classified from the failure that receipt carries.
test('a failed mutation is recorded with its own outcome, on the first attempt and on replay', async t => {
  const db = await createDatabase();
  t.after(() => db.destroy());
  const deps = createDeps(db);
  const schema = z.object({ repository: z.string(), idempotencyKey: z.string() }).strict();
  const mutation = (name: string, run: McpTool['run']): McpTool => ({ name, description: 'fixture', scope: 'read', schema, run });
  const denied = mutation('denied_fixture', async () => { throw new McpError('REPOSITORY_FORBIDDEN', 'Denied', 403); });
  const broken = mutation('broken_fixture', async () => { throw new Error('fixture failure'); });
  const queued = mutation('queued_fixture', async () => ({ status: 202, data: { state: 'queued' } }));

  const args = { repository: 'acme/repo', idempotencyKey: 'mutation-fixture-1' };
  const receipt = await executeTool(denied, args, principal(), deps);
  assert.equal((receipt.data as { state: string }).state, 'failed');
  const replayed = await executeTool(denied, args, principal(), deps);
  assert.equal((replayed.data as { operationId: string }).operationId, (receipt.data as { operationId: string }).operationId);
  await executeTool(broken, { ...args, idempotencyKey: 'mutation-fixture-2' }, principal(), deps);
  await executeTool(queued, { ...args, idempotencyKey: 'mutation-fixture-3' }, principal(), deps);

  const recorded = await rows(deps.db);
  assert.deepEqual(recorded.map(row => [row.name, row.outcome, row.error_code, row.status]), [
    ['denied_fixture', 'denied', 'REPOSITORY_FORBIDDEN', 403],
    ['denied_fixture', 'denied', 'REPOSITORY_FORBIDDEN', 400],
    ['broken_fixture', 'error', 'INTERNAL_ERROR', 500],
    ['queued_fixture', 'success', null, 200],
  ]);
  // Each row still carries the durable handle an operator follows.
  for (const row of recorded) assert.ok(row.operation_id);
  assert.ok(!JSON.stringify(recorded).includes('fixture failure'));
});

test('one sweep clears an expiration backlog and an excess deeper than a single batch', async t => {
  const db = await createDatabase();
  t.after(() => db.destroy());
  const now = Date.UTC(2026, 8, 23, 12);
  const insert = async (count: number, occurredAt: number, name: string) => {
    // SQLite compounds a multi-row insert into a UNION, so keep each one small.
    for (let start = 0; start < count; start += 400) {
      await db('mcp_access_log').insert(Array.from({ length: Math.min(400, count - start) }, () => ({
        occurred_at: occurredAt, owner_id: '123', kind: 'tool', name, status: 200,
        outcome: 'success', read_only: false, duration_ms: 0, result_bytes: 0,
      })));
    }
  };

  await insert(11_000, now - MCP_ACCESS_LOG_RETENTION_MS - 1, 'ancient');
  await insert(12_000, now, 'fresh');

  assert.equal(await pruneMcpAccessLog(db, { now, maxRows: 1000 }), 22_000);
  const [remaining] = await db('mcp_access_log').count<Array<{ count: string | number }>>({ count: '*' });
  assert.equal(Number(remaining.count), 1000);
  assert.equal(await db('mcp_access_log').where({ name: 'ancient' }).first(), undefined);
  assert.equal(await pruneMcpAccessLog(db, { now, maxRows: 1000 }), 0);
});

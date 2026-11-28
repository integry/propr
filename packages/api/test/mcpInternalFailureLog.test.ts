/**
 * A tool failure the caller only sees as INTERNAL_ERROR, or as OUTCOME_UNKNOWN
 * caused by one, carries no detail in its envelope by design; the underlying
 * error is logged with its stack, the tool and the operation ID so an operator
 * can find out what happened. Refusals the caller can act on are not logged.
 */
import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { z } from 'zod';
import { closeConnection, logger } from '@propr/core';
import { McpError } from '../mcp/config.js';
import { McpStore } from '../mcp/store.js';
import { McpOAuthProvider } from '../mcp/oauth.js';
import { McpPolicy, type McpPrincipal } from '../mcp/policy.js';
import { executeTool, ok, type McpTool, type ToolDeps } from '../mcp/tools.js';

after(async () => closeConnection());

const MIGRATIONS = { directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) };

async function createDeps(): Promise<{ db: Knex; deps: ToolDeps }> {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.migrate.latest(MIGRATIONS);
  const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'test-instance', encryptionKey: randomBytes(32) };
  const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
  policy.repository = async () => {};
  policy.admit = async () => {};
  return { db, deps: { db, policy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never } };
}

const principal = {
  user: { id: '123', login: 'tester', username: 'tester', displayName: 'Test', email: null, avatarUrl: null, accessToken: 'fixture' },
  authorization: { role: 'member', permissions: [], source: 'local' },
  grant: { id: 'grant-1', ownerId: '123', clientId: 'client-1', clientName: 'Claude', instanceId: 'test-instance',
    resource: 'https://instance.example/api/mcp', scopes: ['read', 'execute'], repositories: ['acme/repo'],
    createdAt: Date.now(), expiresAt: Date.now() + 60_000, revoked: false, membershipSource: 'local' },
  scopes: ['read', 'execute'],
  github: {} as never,
} as unknown as McpPrincipal;

const mutation = (name: string, run: () => Promise<never>): McpTool => ({
  name, description: 'fixture', scope: 'execute',
  schema: z.object({ repository: z.string(), idempotencyKey: z.string() }).strict(), run,
});

function captureErrors() {
  const calls: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const spy = mock.method(logger, 'error', (fields: Record<string, unknown>, message: string) => {
    if (message === 'MCP tool failed internally') calls.push({ fields, message });
  });
  return { calls, restore: () => spy.mock.restore() };
}

test('an internal failure of a mutation is logged with its stack and operation ID, though its receipt only says OUTCOME_UNKNOWN', async t => {
  const { db, deps } = await createDeps();
  t.after(() => db.destroy());
  const { calls, restore } = captureErrors();
  t.after(restore);
  const tool = mutation('broken_mutation_fixture', async () => { throw new Error('An active epic execution queue already exists for this plan.'); });

  const result = await executeTool(tool, { repository: 'acme/repo', idempotencyKey: 'broken-mutation-1' }, principal, deps);
  const receipt = result.data as { operationId: string; state: string; result: { error: { code: string; cause: { code: string } } } };
  assert.equal(receipt.state, 'unknown');
  assert.equal(receipt.result.error.code, 'OUTCOME_UNKNOWN');
  assert.equal(receipt.result.error.cause.code, 'INTERNAL_ERROR');

  assert.equal(calls.length, 1);
  const [{ fields }] = calls;
  assert.equal(fields.tool, 'broken_mutation_fixture');
  assert.equal(fields.operationId, receipt.operationId);
  assert.equal(fields.repository, 'acme/repo');
  assert.equal(fields.errorCode, 'INTERNAL_ERROR');
  assert.equal(fields.errMessage, 'An active epic execution queue already exists for this plan.');
  assert.match(String(fields.stack), /mcpInternalFailureLog\.test\.ts/);
});

test('an internal failure of a read tool is logged; refusals the caller can act on are not', async t => {
  const { db, deps } = await createDeps();
  t.after(() => db.destroy());
  const { calls, restore } = captureErrors();
  t.after(restore);
  const broken: McpTool = { name: 'broken_read_fixture', description: 'fixture', scope: 'read', readOnly: true,
    schema: z.object({}).strict(), run: async () => { throw new Error('read exploded'); } };
  const refused = mutation('refused_mutation_fixture', async () => { throw new McpError('EPIC_EXECUTION_ACTIVE', 'Still running.', 409); });
  const healthy: McpTool = { name: 'healthy_fixture', description: 'fixture', scope: 'read', readOnly: true, schema: z.object({}).strict(), run: async () => ok({}) };

  await assert.rejects(executeTool(broken, {}, principal, deps), /read exploded/);
  const refusal = await executeTool(refused, { repository: 'acme/repo', idempotencyKey: 'refused-mutation-1' }, principal, deps);
  assert.equal((refusal.data as { state: string }).state, 'failed');
  await executeTool(healthy, {}, principal, deps);

  assert.deepEqual(calls.map(call => [call.fields.tool, call.fields.operationId, call.fields.errMessage]), [['broken_read_fixture', null, 'read exploded']]);
});

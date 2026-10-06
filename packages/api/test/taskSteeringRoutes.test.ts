import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { after, beforeEach, describe, test } from 'node:test';
import type { Request, Response } from 'express';
import knex from 'knex';
import { TASK_STEER_MAX_LENGTH, TASK_STEER_MAX_PER_RUN, taskSteeringRedisKey, type TaskSteeringCapability } from '@propr/shared';

const originalNodeEnv = process.env.NODE_ENV;
const originalDbFilename = process.env.DB_FILENAME;
const isolatedDbDir = await mkdtemp(path.join(tmpdir(), 'propr-task-steering-routes-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILENAME = path.join(isolatedDbDir, 'propr.sqlite');

const { closeConnection } = await import('@propr/core');
const { createTaskSteeringRoutes, steerAuthorSource } = await import('../routes/taskSteeringRoutes.js');
const { up: createTaskSteers } = await import('../../core/src/db/migrations/20261006000000_create_task_steers.js');

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await database.schema.createTable('tasks', table => {
  table.text('task_id').primary();
  table.text('task_type').notNullable();
});
await createTaskSteers(database);
await database('tasks').insert({ task_id: 'task-1', task_type: 'issue' });

const redis = new Map<string, string>();
const redisClient = { get: async (key: string) => redis.get(key) ?? null };
const routes = createTaskSteeringRoutes({ db: database, redisClient });

after(async () => {
  await database.destroy();
  await closeConnection();
  await rm(isolatedDbDir, { recursive: true, force: true });
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalDbFilename === undefined) delete process.env.DB_FILENAME;
  else process.env.DB_FILENAME = originalDbFilename;
});

function announce(capability: TaskSteeringCapability, agentType = 'claude', runKey = 'run:1'): void {
  redis.set(taskSteeringRedisKey('task-1'), JSON.stringify({
    capability, agentAlias: `${agentType}-default`, agentType, runKey, startedAt: new Date().toISOString(),
  }));
}

async function call(
  handler: 'steer' | 'list',
  options: { body?: Record<string, unknown>; taskId?: string; authenticationMethod?: string; user?: Record<string, unknown> | null } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const result = { status: 200, json: {} as Record<string, unknown> };
  const response = {
    status(code: number) { result.status = code; return this; },
    json(payload: Record<string, unknown>) { result.json = payload; return this; },
  } as unknown as Response;
  await routes[handler]({
    params: { taskId: options.taskId ?? 'task-1' },
    body: options.body ?? {},
    user: options.user === null ? undefined : options.user ?? { id: 42, login: 'octocat', username: 'octocat' },
    authenticationMethod: options.authenticationMethod ?? 'session',
  } as unknown as Request, response);
  return result;
}

beforeEach(async () => {
  redis.clear();
  await database('task_steers').delete();
});

describe('task steering capability matrix', () => {
  test('rejects a task that is not running with 409 and its capability', async () => {
    redis.set('worker:state:task-1', JSON.stringify({ issueRef: { agentAlias: 'claude-default', agentType: 'claude' } }));
    const result = await call('steer', { body: { message: 'Use the helper' } });
    assert.equal(result.status, 409);
    assert.equal(result.json.code, 'TASK_NOT_RUNNING');
    assert.equal(result.json.capability, 'live');
    assert.match(String(result.json.error), /not running/);
  });

  for (const agentType of ['opencode', 'vibe', 'codex', 'antigravity']) {
    test(`rejects a running ${agentType} task whose agent declares no steering`, async () => {
      announce('none', agentType);
      const result = await call('steer', { body: { message: 'Use the helper' } });
      assert.equal(result.status, 409);
      assert.equal(result.json.code, 'STEERING_UNSUPPORTED');
      assert.equal(result.json.capability, 'none');
      assert.equal(result.json.agentType, agentType);
      assert.equal(await database('task_steers').count({ count: '*' }).first().then(row => Number(row?.count)), 0);
    });
  }

  for (const capability of ['live', 'next-step'] as const) {
    test(`accepts a steer for a running ${capability} agent`, async () => {
      announce(capability);
      const result = await call('steer', { body: { message: 'Use the helper' } });
      assert.equal(result.status, 202);
      assert.equal(result.json.capability, capability);
      const steer = result.json.steer as Record<string, unknown>;
      assert.equal(steer.author, 'octocat');
      assert.equal(steer.authorSource, 'session');
      assert.equal(steer.runKey, 'run:1');
      assert.equal(steer.deliveredAt, null);
    });
  }
});

describe('task steering validation and limits', () => {
  test('requires a non-empty message no longer than the limit', async () => {
    announce('live');
    assert.equal((await call('steer', { body: { message: '   ' } })).status, 400);
    const tooLong = await call('steer', { body: { message: 'x'.repeat(TASK_STEER_MAX_LENGTH + 1) } });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.json.maxMessageLength, TASK_STEER_MAX_LENGTH);
    assert.equal((await call('steer', { body: { message: 'x'.repeat(TASK_STEER_MAX_LENGTH) } })).status, 202);
  });

  test('rejects unknown tasks and anonymous callers', async () => {
    announce('live');
    assert.equal((await call('steer', { taskId: 'missing-task', body: { message: 'hi' } })).status, 404);
    assert.equal((await call('steer', { user: null, body: { message: 'hi' } })).status, 401);
  });

  test('accepts at most the per-run limit, and a replacement run starts a new budget', async () => {
    announce('live');
    for (let index = 0; index < TASK_STEER_MAX_PER_RUN; index += 1) {
      assert.equal((await call('steer', { body: { message: `steer ${index}` } })).status, 202);
    }
    const limited = await call('steer', { body: { message: 'one more' } });
    assert.equal(limited.status, 409);
    assert.equal(limited.json.code, 'STEER_LIMIT_REACHED');
    announce('live', 'claude', 'run:2');
    assert.equal((await call('steer', { body: { message: 'replacement run' } })).status, 202);
  });
});

describe('task steering attribution', () => {
  test('records the session, bearer-token or MCP identity of the author', async () => {
    announce('live');
    await call('steer', { body: { message: 'from the browser' } });
    await call('steer', { body: { message: 'from a token' }, authenticationMethod: 'instance_token' });
    await call('steer', { body: { message: 'from MCP' }, authenticationMethod: 'mcp', user: { id: 7, login: 'mcp-user', username: 'mcp-user' } });
    const listed = await call('list');
    assert.equal(listed.status, 200);
    assert.equal(listed.json.running, true);
    assert.deepEqual((listed.json.steers as Array<Record<string, unknown>>).map(steer => [steer.author, steer.authorSource, steer.message]), [
      ['octocat', 'session', 'from the browser'],
      ['octocat', 'token', 'from a token'],
      ['mcp-user', 'mcp', 'from MCP'],
    ]);
  });

  test('maps request authentication methods to author sources', () => {
    assert.equal(steerAuthorSource({ authenticationMethod: 'github_bearer' } as Request), 'token');
    assert.equal(steerAuthorSource({ authenticationMethod: 'session' } as Request), 'session');
    assert.equal(steerAuthorSource({} as Request), 'session');
  });
});

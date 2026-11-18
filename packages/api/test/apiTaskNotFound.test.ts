import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, describe, it, mock } from 'node:test';
import type { Response } from 'express';
import knex, { type Knex } from 'knex';
import type { RedisClientType } from 'redis';
import type { FlatRequest } from '../requestTypes.js';

// file-changes reads core's own Redis cache first; no Redis runs in unit tests.
const core = await import('@propr/core');
mock.module('@propr/core', { namedExports: { ...core, getStoredFileChanges: async () => null } });
const { createFileChangesRoutes } = await import('../routes/fileChangesRoutes.js');
const { createLiveDetailsRoutes } = await import('../routes/liveDetailsRoutes.js');
const { createTaskHistoryRoutes } = await import('../routes/taskHistoryRoutes.js');
const { taskReferenceExists } = await import('../routes/taskExistence.js');
const { createDemoRedisClient } = await import('../demoMode.js');

const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/src/db/migrations');
const databases: Knex[] = [];
after(async () => { mock.restoreAll(); await core.closeConnection(); });
afterEach(async () => { await Promise.all(databases.splice(0).map(database => database.destroy())); });

async function migratedDatabase(): Promise<Knex> {
  const database = knex({
    client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 },
    migrations: { directory: migrations, loadExtensions: ['.js'] },
  });
  databases.push(database);
  await database.migrate.latest();
  return database;
}

async function redis(keys: Record<string, string> = {}): Promise<RedisClientType> {
  // The demo facade implements the commands the live output reader uses.
  const client = createDemoRedisClient();
  for (const [key, value] of Object.entries(keys)) await client.set(key, value);
  return client;
}

function recorder() {
  const sent: { status: number; body?: unknown } = { status: 200 };
  const response = {
    status(code: number) { sent.status = code; return response; },
    type() { return response; },
    set() { return response; },
    setHeader() { return response; },
    json(value: unknown) { sent.body = JSON.parse(JSON.stringify(value)); return response; },
    send(value: string) { sent.body = typeof value === 'string' ? JSON.parse(value) : value; return response; },
  } as unknown as Response;
  return { response, sent };
}

type Handler = (req: FlatRequest, res: Response) => Promise<void>;
async function call(handler: Handler, taskId: string) {
  const { response, sent } = recorder();
  await handler({ params: { taskId }, query: {} } as unknown as FlatRequest, response);
  return sent;
}

function handlers(db: Knex, redisClient: RedisClientType, job?: unknown): Record<string, Handler> {
  const taskQueue = { getJob: async (id: string) => (id === 'queued-task' ? job : undefined) } as never;
  return {
    history: createTaskHistoryRoutes({ db, redisClient, taskQueue }).getTaskHistory,
    'live-details': createLiveDetailsRoutes({ db, redisClient, taskQueue }).getLiveDetails,
    'file-changes': createFileChangesRoutes({ db, redisClient, taskQueue }).getFileChanges,
  };
}

describe('task detail routes answer 404 for an unknown task id', () => {
  it('returns TASK_NOT_FOUND from history, live-details and file-changes', async () => {
    const db = await migratedDatabase();
    for (const [route, handler] of Object.entries(handlers(db, await redis()))) {
      const sent = await call(handler, 'no-such-task');
      assert.equal(sent.status, 404, route);
      assert.deepEqual(sent.body, { error: 'Task not found', code: 'TASK_NOT_FOUND' }, route);
    }
  });

  it('keeps answering 200 for a task known only by history, live state or the queue', async () => {
    const db = await migratedDatabase();
    await db('tasks').insert({ task_id: 'history-task', repository: 'acme/app', task_type: 'issue', issue_number: 7, created_at: new Date().toISOString() });
    await db('task_history').insert({ task_id: 'history-task', state: 'pending', timestamp: new Date().toISOString() });
    const liveState = JSON.stringify({ history: [{ state: 'processing', timestamp: new Date().toISOString() }] });
    const job = { id: 'queued-task', data: { repoOwner: 'acme', repoName: 'repo', number: 1, title: 'Queued' }, timestamp: Date.now(), getState: async () => 'waiting' };
    for (const taskId of ['history-task', 'live-task', 'queued-task']) {
      for (const [route, handler] of Object.entries(handlers(db, await redis({ 'worker:state:live-task': liveState }), job))) {
        const sent = await call(handler, taskId);
        assert.equal(sent.status, 200, `${route} of ${taskId}: ${JSON.stringify(sent.body)}`);
      }
    }
  });

  it('taskReferenceExists checks rows, history, live state and jobs', async () => {
    const db = await migratedDatabase();
    assert.equal(await taskReferenceExists({ db }, ''), false);
    assert.equal(await taskReferenceExists({ db, redisClient: await redis(), taskQueue: { getJob: async () => undefined } as never }, 'missing'), false);
    assert.equal(await taskReferenceExists({ db, redisClient: await redis({ 'worker:state:raw-job': '{}' }) }, 'normalized', 'raw-job'), true);
    assert.equal(await taskReferenceExists({ db, taskQueue: { getJob: async (id: string) => (id === 'job-1' ? {} : undefined) } as never }, 'job-1'), true);
  });
});

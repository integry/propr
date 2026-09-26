import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { after, afterEach, test } from 'node:test';
import express from 'express';
import type { Request, Response as ExpressResponse } from 'express';
import knex, { type Knex } from 'knex';
import { resetConfiguredDemoMode } from '../demoMode.js';

const originalNodeEnv = process.env.NODE_ENV;
const originalDbFilename = process.env.DB_FILENAME;
const originalDemoMode = process.env.PROPR_DEMO_MODE;
const originalWhitelist = process.env.GITHUB_USER_WHITELIST;
const originalBearerAuth = process.env.ENABLE_BEARER_AUTH;
const isolatedDbDir = await mkdtemp(path.join(tmpdir(), 'propr-task-delete-routes-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILENAME = path.join(isolatedDbDir, 'propr.sqlite');

function restoreEnv(): void {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalDbFilename === undefined) delete process.env.DB_FILENAME;
  else process.env.DB_FILENAME = originalDbFilename;
  if (originalDemoMode === undefined) delete process.env.PROPR_DEMO_MODE;
  else process.env.PROPR_DEMO_MODE = originalDemoMode;
  if (originalWhitelist === undefined) delete process.env.GITHUB_USER_WHITELIST;
  else process.env.GITHUB_USER_WHITELIST = originalWhitelist;
  if (originalBearerAuth === undefined) delete process.env.ENABLE_BEARER_AUTH;
  else process.env.ENABLE_BEARER_AUTH = originalBearerAuth;
}

async function createDatabase(): Promise<Knex> {
  const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });

  await database.schema.createTable('task_history', table => {
    table.text('task_id').notNullable();
    table.text('state').notNullable();
    table.text('timestamp').notNullable();
  });
  await database.schema.createTable('tasks', table => {
    table.text('task_id').notNullable();
  });
  await database.schema.createTable('llm_executions', table => {
    table.text('execution_id').notNullable();
    table.text('task_id').notNullable();
  });
  await database.schema.createTable('llm_execution_details', table => {
    table.text('execution_id').notNullable();
  });

  return database;
}

function applyIsolatedCoreEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.DB_FILENAME = path.join(isolatedDbDir, 'propr.sqlite');
}

async function loadTaskDeleteRouteRegistry() {
  return import('../taskDeleteRouteRegistry.js');
}

async function seedCompletedTask(database: Knex, taskId: string): Promise<void> {
  await database('tasks').insert({ task_id: taskId });
  await database('task_history').insert({
    task_id: taskId,
    state: 'completed',
    timestamp: new Date().toISOString(),
  });
  await database('llm_executions').insert({ execution_id: `${taskId}-execution`, task_id: taskId });
  await database('llm_execution_details').insert({ execution_id: `${taskId}-execution` });
}

async function createDeleteApp(database: Knex, authenticated: boolean): Promise<express.Express> {
  applyIsolatedCoreEnv();
  process.env.PROPR_DEMO_MODE = 'true';
  const [
    { ensureAuthenticated },
    { createTaskRoutes },
    { createTaskDeleteRouteEntries },
  ] = await Promise.all([
    import('../auth.js'),
    import('../routes/taskRoutes.js'),
    loadTaskDeleteRouteRegistry(),
  ]);

  applyIsolatedCoreEnv();
  process.env.PROPR_DEMO_MODE = 'false';
  process.env.GITHUB_USER_WHITELIST = 'alice';
  process.env.ENABLE_BEARER_AUTH = 'false';
  resetConfiguredDemoMode();

  const app = express();
  app.use('/api', (req, _res, next) => {
    req.isAuthenticated = () => authenticated;
    if (authenticated) {
      req.user = {
        id: '1',
        login: 'alice',
        username: 'alice',
        displayName: 'Alice',
        email: null,
        avatarUrl: null,
      };
    }
    next();
  });
  app.use('/api', ensureAuthenticated);

  const taskRoutes = createTaskRoutes({ db: database });
  for (const [method, pathPattern, ...handlers] of createTaskDeleteRouteEntries({ taskRoutes })) {
    app[method](pathPattern, ...handlers);
  }
  return app;
}

async function fetchFromApp(app: express.Express, path: string, init?: RequestInit): Promise<globalThis.Response> {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${port}${path}`, init);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

afterEach(() => {
  resetConfiguredDemoMode();
  restoreEnv();
  applyIsolatedCoreEnv();
});

after(async () => {
  applyIsolatedCoreEnv();
  process.env.PROPR_DEMO_MODE = 'true';
  const { closeConnection } = await import('@propr/core');
  await closeConnection();
  restoreEnv();
  await rm(isolatedDbDir, { recursive: true, force: true });
});

test('task delete route entries register plural and singular paths with the same handler', async () => {
  const { createTaskDeleteRouteEntries } = await loadTaskDeleteRouteRegistry();
  const handler = (_req: Request, res: ExpressResponse) => res.status(204).send();
  const entries = createTaskDeleteRouteEntries({ taskRoutes: { deleteTask: handler } });

  assert.deepEqual(entries.map(([method, path]) => [method, path]), [
    ['delete', '/api/tasks/:taskId'],
    ['delete', '/api/task/:taskId'],
  ]);
  assert.equal(entries[0][2], handler);
  assert.equal(entries[1][2], handler);
  assert.equal(entries[0][2], entries[1][2]);
});

test('both task delete paths require authentication', async () => {
  const database = await createDatabase();
  try {
    const app = await createDeleteApp(database, false);
    for (const path of ['/api/tasks/task-1', '/api/task/task-1']) {
      const response = await fetchFromApp(app, path, { method: 'DELETE' });
      assert.equal(response.status, 401, path);
    }
  } finally {
    await database.destroy();
  }
});

test('both task delete paths use the shared handler behavior', async () => {
  const database = await createDatabase();
  try {
    const app = await createDeleteApp(database, true);

    await seedCompletedTask(database, 'task-delete-plural');
    const pluralResponse = await fetchFromApp(app, '/api/tasks/task-delete-plural?force=true', { method: 'DELETE' });
    assert.equal(pluralResponse.status, 204);

    await seedCompletedTask(database, 'task-delete-singular');
    const singularResponse = await fetchFromApp(app, '/api/task/task-delete-singular?force=true', { method: 'DELETE' });
    assert.equal(singularResponse.status, 204);

    assert.equal(await database('task_history').count<{ count: number }>({ count: '*' }).first().then(row => row?.count), 0);
    assert.equal(await database('llm_executions').count<{ count: number }>({ count: '*' }).first().then(row => row?.count), 0);
    assert.equal(await database('llm_execution_details').count<{ count: number }>({ count: '*' }).first().then(row => row?.count), 0);
    assert.equal(await database('tasks').count<{ count: number }>({ count: '*' }).first().then(row => row?.count), 0);
  } finally {
    await database.destroy();
  }
});

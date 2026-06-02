import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import express from 'express';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import { DEMO_MODE_READ_ONLY_CODE } from '@propr/shared';
import { db } from '@propr/core';
import * as configManager from '@propr/core';
import { setupAuth, ensureAuthenticated } from '../auth.js';
import { configureDemoMode, createDemoRedisClient, demoModeReadOnlyMiddleware, getDemoUser, isDemoMode, resetConfiguredDemoMode } from '../demoMode.js';
import { buildDemoRepositoryMetadata, clearDemoRepositoryMetadataCache } from '../routes/demoRepositoryMetadata.js';
import { createGitHubRoutes } from '../routes/githubRoutes.js';
import { createPlannerRoutes } from '../routes/plannerRoutes.js';
import { createRepoTodoRoutes } from '../routes/repoTodoRoutes.js';
import { createQueueRoutes } from '../routes/queueRoutes.js';
import { createStatusRoutes } from '../routes/statusRoutes.js';
import { normalizeRepoConfig } from '../routes/configRepoValidation.js';

const originalDemoMode = process.env.PROPR_DEMO_MODE;
const originalFrontendUrl = process.env.FRONTEND_URL;

async function cleanupDemoData(): Promise<void> {
  if (await db.schema.hasTable('repo_todos')) await db('repo_todos').delete();
  if (await db.schema.hasTable('repo_todo_categories')) await db('repo_todo_categories').delete();
  if (await db.schema.hasTable('task_drafts')) await db('task_drafts').delete();
  if (await db.schema.hasTable('repositories')) await db('repositories').delete();
  if (await db.schema.hasTable('system_configs')) await db('system_configs').where({ key: 'repos_to_monitor' }).delete();
}

function createJsonResponse(): { response: ExpressResponse; status: () => number; body: () => unknown } {
  let statusCode = 200;
  let payload: unknown;
  const response = {
    set() { return response; },
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(body: unknown) {
      payload = body;
      return response;
    }
  } as unknown as ExpressResponse;
  return { response, status: () => statusCode, body: () => payload };
}

async function fetchFromApp(app: express.Express, path: string, init?: RequestInit): Promise<globalThis.Response> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    return await fetch(`http://127.0.0.1:${address.port}${path}`, init);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

afterEach(async () => {
  resetConfiguredDemoMode();
  clearDemoRepositoryMetadataCache();
  if (originalDemoMode === undefined) delete process.env.PROPR_DEMO_MODE;
  else process.env.PROPR_DEMO_MODE = originalDemoMode;
  if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = originalFrontendUrl;
  await cleanupDemoData();
});

after(async () => {
  await db.destroy();
});

test('demoModeReadOnlyMiddleware rejects mutating requests in demo mode', () => {
  process.env.PROPR_DEMO_MODE = 'true';
  let statusCode: number | undefined;
  let payload: unknown;
  let nextCalled = false;
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(body: unknown) {
      payload = body;
      return response;
    }
  } as unknown as ExpressResponse;

  demoModeReadOnlyMiddleware({ method: 'POST' } as Request, response, (() => { nextCalled = true; }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 405);
  assert.deepEqual(payload, {
    code: DEMO_MODE_READ_ONLY_CODE,
    error: 'Demo mode is read-only. Changes are not allowed.'
  });
});

test('demoModeReadOnlyMiddleware blocks auth metadata mutations', () => {
  process.env.PROPR_DEMO_MODE = 'true';
  const { response, status, body } = createJsonResponse();

  demoModeReadOnlyMiddleware(
    { method: 'POST', path: '/auth/demo-mode', originalUrl: '/api/auth/demo-mode' } as Request,
    response,
    (() => { assert.fail('next should not be called'); }) as NextFunction
  );

  assert.equal(status(), 405);
  assert.deepEqual(body(), {
    code: DEMO_MODE_READ_ONLY_CODE,
    error: 'Demo mode is read-only. Changes are not allowed.'
  });
});

test('isDemoMode accepts common truthy environment values', () => {
  process.env.PROPR_DEMO_MODE = 'TRUE';
  assert.equal(isDemoMode(), true);
  process.env.PROPR_DEMO_MODE = '1';
  assert.equal(isDemoMode(), true);
});

test('configured demo mode keeps auth and middleware on the same startup value', async () => {
  process.env.PROPR_DEMO_MODE = '1';
  configureDemoMode();
  process.env.PROPR_DEMO_MODE = 'false';
  let nextCalled = false;
  const authRequest = { headers: {}, isAuthenticated: () => false } as unknown as Request;
  const authResponse = { set() { return authResponse; } } as unknown as ExpressResponse;

  await ensureAuthenticated(authRequest, authResponse, (() => { nextCalled = true; }) as NextFunction);
  assert.equal(nextCalled, true);
  assert.deepEqual(authRequest.user, getDemoUser());

  const { response, status, body } = createJsonResponse();
  demoModeReadOnlyMiddleware({ method: 'POST' } as Request, response, (() => { assert.fail('next should not be called'); }) as NextFunction);
  assert.equal(status(), 405);
  assert.deepEqual(body(), {
    code: DEMO_MODE_READ_ONLY_CODE,
    error: 'Demo mode is read-only. Changes are not allowed.'
  });
});

test('demo Redis facade covers read-only route Redis usage', async () => {
  const redis = createDemoRedisClient();
  assert.equal(await redis.ping(), 'PONG');
  assert.equal(await redis.set('lock', 'owner', { NX: true, EX: 60 }), 'OK');
  assert.equal(await redis.set('lock', 'other', { NX: true, EX: 60 }), null);
  assert.equal(await redis.get('lock'), 'owner');
  assert.equal(await redis.expire('lock', 60), true);
  assert.equal(await redis.exists('lock'), 1);
  assert.equal(await redis.lPush('system:activity:log', JSON.stringify({ description: 'one' })), 1);
  assert.equal(await redis.rPush('system:activity:log', JSON.stringify({ description: 'two' })), 2);
  assert.equal((await redis.lRange('system:activity:log', 0, -1)).length, 2);
  assert.equal(await redis.sAdd('active:repositories', ['integry/propr', 'integry/propr']), 1);
  assert.deepEqual(await redis.sMembers('active:repositories'), ['integry/propr']);
  assert.equal(await redis.incr('metrics:jobs:processed'), 1);
  assert.deepEqual(await redis.keys('metrics:*'), ['metrics:jobs:processed']);
  assert.equal(await redis.hSet('demo:hash', { field: 'value' }), 1);
  assert.equal(await redis.hGet('demo:hash', 'field'), 'value');
  assert.deepEqual(await redis.hGetAll('demo:hash'), { field: 'value' });
  assert.deepEqual(await redis.zRange('demo:zset', 0, -1), []);
  assert.equal(await (redis as unknown as { setex: (key: string, seconds: number, value: string) => Promise<string | null> }).setex('lowercase-setex', 60, 'ok'), 'OK');
  assert.equal(await redis.get('lowercase-setex'), 'ok');
  assert.equal(await redis.del(['lock', 'metrics:jobs:processed']), 2);
  await assert.rejects(
    () => (redis as unknown as { flushAll: () => Promise<string> }).flushAll(),
    /Demo Redis facade blocks unsupported Redis command "flushAll"/
  );
});

test('demo Express GET routes work with the in-memory Redis facade', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  process.env.FRONTEND_URL = 'http://localhost:5173';
  configureDemoMode();
  const redis = createDemoRedisClient();
  await redis.lPush('system:activity:log', JSON.stringify({ description: 'Demo activity', timestamp: '2026-05-26T00:00:00.000Z' }));
  const taskQueue = {
    getWaitingCount: async () => 0,
    getActiveCount: async () => 0,
    getCompletedCount: async () => 0,
    getFailedCount: async () => 0,
    getDelayedCount: async () => 0,
  } as never;
  const app = express();
  app.use(express.json());
  app.use('/api', demoModeReadOnlyMiddleware);
  setupAuth(app);
  app.use('/api', ensureAuthenticated);
  const statusRoutes = createStatusRoutes({ redisClient: redis });
  const queueRoutes = createQueueRoutes({ redisClient: redis, taskQueue });
  app.get('/api/status', statusRoutes.getStatus);
  app.get('/api/activity', queueRoutes.getActivity);
  app.post('/api/activity', (_req, res) => res.json({ ok: true }));

  const statusResponse = await fetchFromApp(app, '/api/status');
  assert.equal(statusResponse.status, 200);
  const statusBody = await statusResponse.json() as { redis: string; worker: string };
  assert.equal(statusBody.redis, 'connected');
  assert.equal(statusBody.worker, 'stopped');

  const activityResponse = await fetchFromApp(app, '/api/activity');
  assert.equal(activityResponse.status, 200);
  assert.equal((await activityResponse.json() as Array<{ description: string }>)[0].description, 'Demo activity');

  const blockedResponse = await fetchFromApp(app, '/api/activity', { method: 'POST' });
  assert.equal(blockedResponse.status, 405);
});

test('ensureAuthenticated attaches the synthetic demo user', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  let nextCalled = false;
  const request = { headers: {}, isAuthenticated: () => false } as unknown as Request;
  const response = { set() { return response; } } as unknown as ExpressResponse;

  await ensureAuthenticated(request, response, (() => { nextCalled = true; }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.deepEqual(request.user, getDemoUser());
  assert.equal(request.user?.login, 'demo');
  assert.equal(request.user?.username, 'demo');
  assert.equal(request.user?.accessToken, undefined);
});

test('ensureAuthenticated ignores bearer auth and attaches the synthetic demo user in demo mode', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  let nextCalled = false;
  const request = { headers: { authorization: 'Bearer ghp_test' }, isAuthenticated: () => false } as unknown as Request;
  const { response, status } = createJsonResponse();

  await ensureAuthenticated(request, response, (() => { nextCalled = true; }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.equal(status(), 200);
  assert.deepEqual(request.user, getDemoUser());
});

test('demo repository metadata resolves enabled configured repositories', () => {
  const repos = [
    { id: '1', name: 'integry/propr', enabled: true, baseBranch: 'develop', defaultBranch: 'main' },
    { id: '2', name: 'integry/propr', enabled: true, baseBranch: 'release' },
    { id: '3', name: 'integry/private', enabled: true, baseBranch: 'main' },
    { id: '4', name: 'integry/disabled', enabled: false, baseBranch: 'main' },
  ];

  assert.equal(buildDemoRepositoryMetadata(repos, 'other/repo'), null);
  assert.equal(buildDemoRepositoryMetadata(repos, 'integry/disabled'), null);
  assert.deepEqual(buildDemoRepositoryMetadata(repos, 'integry/private')?.branches, ['main']);
  assert.deepEqual(buildDemoRepositoryMetadata(repos, 'integry/propr'), {
    repository: 'integry/propr',
    defaultBranch: 'main',
    branches: ['main', 'develop', 'release'],
    isPrivate: null,
    description: 'Repository metadata is unavailable in read-only demo mode.'
  });
});

test('repository config branch validation documents ProPR-supported branch names', () => {
  assert.deepEqual(normalizeRepoConfig({
    name: 'integry/propr',
    enabled: true,
    baseBranch: 'release/2026',
    defaultBranch: 'main'
  }).ok, true);

  const invalid = normalizeRepoConfig({
    name: 'integry/propr',
    enabled: true,
    baseBranch: 'feature/with whitespace'
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.match(invalid.error, /unsupported by ProPR/);
  }
});

test('/api/github/repos returns configured and persisted repositories in demo mode', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  await db.migrate.latest();
  await configManager.saveMonitoredRepos([
    { id: '1', name: 'integry/propr', enabled: true },
    { id: '2', name: 'integry/private', enabled: true },
    { id: '3', name: 'integry/disabled', enabled: false },
  ]);
  await db('task_drafts').insert({
    draft_id: randomUUID(),
    user_id: 'real-user',
    repository: 'integry/from-draft',
    name: 'Persisted draft'
  });
  await db('repositories').insert({
    full_name: 'integry/indexed',
    branch: 'release',
    indexing_status: 'completed',
  });
  const routes = createGitHubRoutes({ redisClient: {} as never, taskQueue: {} as never, db });
  const { response, body } = createJsonResponse();

  await routes.getRepos({ user: getDemoUser() } as Request, response);

  assert.deepEqual(body(), { repos: ['integry/from-draft', 'integry/indexed', 'integry/private', 'integry/propr'] });
});

test('demo repository metadata resolves persisted repositories without configured allowlists', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  await db.migrate.latest();
  await db('repositories').insert({
    full_name: 'integry/indexed',
    branch: 'release',
    indexing_status: 'completed',
  });
  const routes = createGitHubRoutes({ redisClient: {} as never, taskQueue: {} as never, db });
  const { response, body, status } = createJsonResponse();

  await routes.getBranches({ params: { owner: 'integry', repo: 'indexed' }, user: getDemoUser() } as unknown as Request, response);

  assert.equal(status(), 200);
  assert.deepEqual(body(), { branches: ['release'], defaultBranch: 'release' });
});

test('demo repository metadata ignores malformed database repository names', () => {
  assert.deepEqual(buildDemoRepositoryMetadata([], 'integry/indexed', [
    { repository: 'integry/indexed', branch: 'release' },
    { repository: 'integry/indexed/extra', branch: 'main' },
    { repository: 'integry/with whitespace', branch: 'main' },
  ]), {
    repository: 'integry/indexed',
    defaultBranch: 'release',
    branches: ['release'],
    isPrivate: null,
    description: 'Repository metadata is unavailable in read-only demo mode.'
  });
  assert.deepEqual(buildDemoRepositoryMetadata([], 'integry/indexed/extra', [
    { repository: 'integry/indexed/extra', branch: 'main' },
  ]), null);
});

test('planner demo reads use the curated database without owner or repository allowlists', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  await db.migrate.latest();
  await configManager.saveMonitoredRepos([
    { id: '1', name: 'integry/propr', enabled: true },
    { id: '2', name: 'integry/private', enabled: true },
  ]);
  const visibleDraftId = randomUUID();
  const otherOwnerDraftId = randomUUID();
  const otherRepoDraftId = randomUUID();
  await db('task_drafts').insert([
    { draft_id: visibleDraftId, user_id: 'demo', repository: 'integry/propr', name: 'Visible draft' },
    { draft_id: otherOwnerDraftId, user_id: 'real-user', repository: 'integry/propr', name: 'Other owner draft' },
    { draft_id: otherRepoDraftId, user_id: 'demo', repository: 'integry/private', name: 'Other repo draft' },
  ]);
  const routes = createPlannerRoutes({ db });
  const listResponse = createJsonResponse();

  await routes.listDrafts({ query: {}, user: getDemoUser() } as Request, listResponse.response);

  const listedDraftIds = (listResponse.body() as { drafts: Array<{ draft_id: string }> }).drafts
    .map(draft => draft.draft_id)
    .sort();
  assert.deepEqual(listedDraftIds, [
    visibleDraftId,
    otherOwnerDraftId,
    otherRepoDraftId,
  ].sort());

  const otherOwnerResponse = createJsonResponse();
  await routes.getDraft({ params: { id: otherOwnerDraftId }, user: getDemoUser() } as unknown as Request, otherOwnerResponse.response);

  assert.equal(otherOwnerResponse.status(), 200);
  assert.equal((otherOwnerResponse.body() as { draft_id: string }).draft_id, otherOwnerDraftId);
});

test('repo todo demo reads use the curated database without owner filters', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  await db.migrate.latest();
  const demoCategoryId = randomUUID();
  const otherCategoryId = randomUUID();
  const demoTodoId = randomUUID();
  const otherTodoId = randomUUID();
  await db('repo_todo_categories').insert([
    { category_id: demoCategoryId, user_id: 'demo', repository: 'integry/propr', name: 'Demo category', order_index: 2 },
    { category_id: otherCategoryId, user_id: 'real-user', repository: 'integry/propr', name: 'Other category', order_index: 1 },
  ]);
  await db('repo_todos').insert([
    { todo_id: demoTodoId, user_id: 'demo', repository: 'integry/propr', category_id: demoCategoryId, content: 'Demo todo', order_index: 2 },
    { todo_id: otherTodoId, user_id: 'real-user', repository: 'integry/propr', category_id: otherCategoryId, content: 'Other todo', order_index: 1 },
  ]);
  const routes = createRepoTodoRoutes();
  const categoryResponse = createJsonResponse();
  const todoResponse = createJsonResponse();
  const singleTodoResponse = createJsonResponse();

  await routes.getCategories({ query: { repository: 'integry/propr' }, user: getDemoUser() } as unknown as Request, categoryResponse.response);
  await routes.getTodos({ query: { repository: 'integry/propr' }, user: getDemoUser() } as unknown as Request, todoResponse.response);
  await routes.getTodo({ params: { todoId: otherTodoId }, user: getDemoUser() } as unknown as Request, singleTodoResponse.response);

  assert.deepEqual(
    (categoryResponse.body() as { categories: Array<{ categoryId: string }> }).categories.map(category => category.categoryId).sort(),
    [demoCategoryId, otherCategoryId].sort()
  );
  assert.deepEqual(
    (categoryResponse.body() as { categories: Array<{ categoryId: string }> }).categories.map(category => category.categoryId),
    [otherCategoryId, demoCategoryId]
  );
  assert.deepEqual(
    (todoResponse.body() as { todos: Array<{ todoId: string }> }).todos.map(todo => todo.todoId).sort(),
    [demoTodoId, otherTodoId].sort()
  );
  assert.deepEqual(
    (todoResponse.body() as { todos: Array<{ todoId: string }> }).todos.map(todo => todo.todoId),
    [otherTodoId, demoTodoId]
  );
  assert.equal(singleTodoResponse.status(), 200);
  assert.equal((singleTodoResponse.body() as { todoId: string }).todoId, otherTodoId);
});

test('auth demo-mode metadata endpoint reports startup environment value', async () => {
  process.env.PROPR_DEMO_MODE = 'true';
  process.env.FRONTEND_URL = 'http://localhost:5173';
  const app = express();
  setupAuth(app);
  process.env.PROPR_DEMO_MODE = 'false';
  assert.equal(isDemoMode(), true);

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/demo-mode`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { demoMode: true });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

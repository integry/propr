/**
 * Every route with a `repository` filter resolves it through the shared
 * repository scope: any capitalization of a configured repository reads that
 * repository's rows under its configured name, and a repository this instance
 * does not configure is `REPOSITORY_NOT_ACCESSIBLE` rather than an empty 200.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { createRepositoryScopeResolver } from '../repositoryScope.js';
import { createCostExportRoutes } from '../routes/costExport.js';
import { createDashboardRoutes } from '../routes/dashboardRoutes.js';
import { createPlannerRoutes } from '../routes/plannerRoutes.js';
import { createRepoTodoRoutes } from '../routes/repoTodoRoutes.js';
import { createRepositoryMediaRoutes } from '../routes/repositoryMediaRoutes.js';
import { createReviewScoreRoutes } from '../routes/reviewScoreStats.js';
import { createStatsRoutes } from '../routes/statsRoutes.js';
import { createTaskRoutes } from '../routes/taskRoutes.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = (req: Request, res: Response) => Promise<void> | void;

const NOW = new Date('2026-11-16T12:00:00.000Z');
const UNKNOWN = 'facebook/react';
let db: Knex;

/** The instance configures `integry/propr` (lowercase); GitHub access is not what these tests exercise. */
const repositoryScope = createRepositoryScopeResolver({
  configuredRepositories: async () => [{ name: 'integry/propr', enabled: true }],
  checksGitHubAccess: () => false,
});

before(async () => {
  db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  const at = new Date(NOW.getTime() - 60 * 60_000).toISOString();
  await db('tasks').insert({ task_id: 'task-1', repository: 'integry/propr', task_type: 'issue', issue_number: 5, pr_number: 3583, created_at: at });
  await db('task_history').insert({ task_id: 'task-1', state: 'completed', timestamp: at });
  await db('llm_executions').insert({
    task_id: 'task-1', start_time: at, end_time: at, duration_ms: 1000, model_name: 'opus', success: true, num_turns: 1,
    cost_usd: 2, input_tokens: 100, output_tokens: 10,
  });
  await db('review_scores').insert({
    repository_id: 'integry/propr', pr_number: 3583, task_id: 'task-1', score: 8, source: 'review', created_at: at,
  });
  await db('task_drafts').insert({ draft_id: 'draft-1', user_id: 'user-1', repository: 'integry/propr', name: 'Plan', status: 'draft' });
});
after(async () => { await db.destroy(); await closeConnection(); });

async function call(handler: Handler, query: Json, extra: Json = {}): Promise<{ status: number; body: Json }> {
  const sent = { status: 200, body: {} as Json };
  const res = {
    status(code: number) { sent.status = code; return res; },
    json(body: Json) { sent.body = JSON.parse(JSON.stringify(body)); return res; },
    setHeader() { return res; },
    send(body: unknown) { sent.body = { sent: body }; return res; },
  } as unknown as Response;
  await handler({ query, params: {}, body: {}, user: { id: 'user-1' }, path: '/test', ...extra } as unknown as Request, res);
  return sent;
}

function assertNotAccessible(result: { status: number; body: Json }, label: string): void {
  assert.equal(result.status, 404, `${label}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.code, 'REPOSITORY_NOT_ACCESSIBLE', label);
}

test('cost, tasks and pull request scores match a configured repository in any capitalization', async () => {
  const cost = createCostExportRoutes({ db, now: () => NOW, repositoryScope });
  const lower = await call(cost.getCost, { period: '7d', repository: 'integry/propr' });
  const upper = await call(cost.getCost, { period: '7d', repository: 'integry/PROPR' });
  assert.equal(lower.status, 200);
  assert.equal(upper.status, 200);
  assert.equal(upper.body.totals.executions, 1);
  assert.deepEqual(upper.body.totals, lower.body.totals);
  assert.equal(upper.body.repository, 'integry/propr', 'the canonical configured name is echoed');

  const tasks = createTaskRoutes({ db, repositoryScope });
  const taskPage = await call(tasks.getTasks, { repository: 'INTEGRY/PROPR' });
  assert.equal(taskPage.status, 200);
  assert.equal(taskPage.body.total, 1);

  const scores = createReviewScoreRoutes({ db, now: () => NOW, repositoryScope });
  const history = await call(scores.getPullRequestScores, { repository: 'INTEGRY/propr' }, { params: { number: '3583' } });
  assert.equal(history.status, 200);
  assert.equal(history.body.repository, 'integry/propr');
  assert.equal(history.body.scores.length, 1);

  const dashboardStats = await call(createStatsRoutes({ db, now: () => NOW, repositoryScope }).getDashboardStats, { period: '7d', repository: 'Integry/Propr' });
  assert.equal(dashboardStats.status, 200);
  assert.equal(dashboardStats.body.repository, 'integry/propr');
  assert.equal(dashboardStats.body.tasks, 1);

  const drafts = await call(createPlannerRoutes({ db, repositoryScope }).listDrafts, { repository: 'INTEGRY/PROPR' });
  assert.equal(drafts.status, 200);
  assert.equal(drafts.body.drafts.length, 1);
});

test('an unknown repository is REPOSITORY_NOT_ACCESSIBLE on every repository-filtered read, and `all` still works', async () => {
  const dashboard = createDashboardRoutes({
    db, repositoryScope, now: () => NOW,
    redisClient: { sMembers: async () => [], hGetAll: async () => ({}) } as never,
    taskQueue: { isPaused: async () => false, getActiveCount: async () => 0 } as never,
    liveDetails: async () => null,
    isSummaryEnabled: async () => false,
  });
  const stats = createStatsRoutes({ db, now: () => NOW, repositoryScope });
  const scores = createReviewScoreRoutes({ db, now: () => NOW, repositoryScope });
  const cost = createCostExportRoutes({ db, now: () => NOW, repositoryScope });
  const reads: Array<[string, Handler, Json, Json?]> = [
    ['stats/dashboard', stats.getDashboardStats, { period: '7d' }],
    ['stats/review-scores', scores.getSummary, { period: '7d' }],
    ['stats/cost', cost.getCost, { period: '7d' }],
    ['tasks', createTaskRoutes({ db, repositoryScope }).getTasks, {}],
    ['dashboard/summary', dashboard.getSummary, {}],
    ['dashboard/attention', dashboard.getAttention, {}],
    ['dashboard/active', dashboard.getActive, {}],
    ['dashboard/outcomes', dashboard.getOutcomes, {}],
    ['dashboard/narrative', dashboard.getNarrative, {}],
    ['planner/drafts', createPlannerRoutes({ db, repositoryScope }).listDrafts, {}],
  ];
  for (const [label, handler, query] of reads) {
    assertNotAccessible(await call(handler, { ...query, repository: UNKNOWN }), label);
    assert.notEqual((await call(handler, { ...query, repository: 'all' })).status, 404, `${label} all`);
  }

  assertNotAccessible(await call(scores.getPullRequestScores, { repository: UNKNOWN }, { params: { number: '3583' } }), 'pull-requests/scores');
  const media = createRepositoryMediaRoutes({ db, repositoryScope, reader: { enabledRepositories: async () => new Set(), project: async () => [] } as never });
  assertNotAccessible(await call(media.getMedia, { repository: UNKNOWN }), 'repos/media');
  const todos = createRepoTodoRoutes({ repositoryScope });
  assertNotAccessible(await call(todos.getTodos, { repository: UNKNOWN }), 'repos/todos');
  assertNotAccessible(await call(todos.getCategories, { repository: UNKNOWN }), 'repos/todos/categories');
  assertNotAccessible(await call(todos.createTodo, {}, { body: { repository: UNKNOWN, content: 'x' } }), 'POST repos/todos');
});

test('the task list allows at most 200 rows per page', async () => {
  const tasks = createTaskRoutes({ db, repositoryScope });
  assert.equal((await call(tasks.getTasks, { limit: '200' })).status, 200);
  assert.equal((await call(tasks.getTasks, { limit: '201' })).status, 400);
  assert.equal((await call(tasks.getTasks, { limit: '1000' })).status, 400);
});

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
import { collectNarrativeFacts } from '../routes/dashboardNarrative.js';
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

test('a repository configured in another capitalization still reads its stored rows, under its configured name', async () => {
  // Stored rows say `integry/propr`; the instance configures `Integry/ProPR`.
  const configuredAs = createRepositoryScopeResolver({
    configuredRepositories: async () => [{ name: 'Integry/ProPR', enabled: true }],
    checksGitHubAccess: () => false,
  });
  const cost = createCostExportRoutes({ db, now: () => NOW, repositoryScope: configuredAs });
  const stats = createStatsRoutes({ db, now: () => NOW, repositoryScope: configuredAs });
  const scores = createReviewScoreRoutes({ db, now: () => NOW, repositoryScope: configuredAs });
  const tasks = createTaskRoutes({ db, repositoryScope: configuredAs });
  const dashboard = createDashboardRoutes({
    db, repositoryScope: configuredAs, now: () => NOW,
    redisClient: { sMembers: async () => [], hGetAll: async () => ({}) } as never,
    taskQueue: { isPaused: async () => false, getActiveCount: async () => 0 } as never,
    liveDetails: async () => null,
    isSummaryEnabled: async () => false,
  });
  // Dashboard work sources beyond tasks: a plan issue waiting on a decision and a running goal.
  await db('plan_issues').insert({ draft_id: 'draft-1', repository: 'integry/propr', issue_number: 9, status: 'under_review' });
  await db('goals').insert({
    goal_id: 'goal-1', owner_id: 'user-1', owner_login: 'alice', repository: 'integry/propr', objective: 'Ship', launch_strategy: 'direct',
    initial_prompt: 'Ship', agent_id: 'codex', agent_alias: 'codex', agent_type: 'codex', requested_model: 'model-a',
    desired_state: 'running', current_task_id: 'goal-task-1', artifact_refs: '[]', artifact_stats: '{}',
  });
  await db('task_drafts').insert({ draft_id: 'draft-generating', user_id: 'user-1', repository: 'integry/propr', name: 'Generating', status: 'generating' });
  try {
    // The narrative reads the configured name it is given; a generating plan stored lowercase is live work.
    const narrative = await collectNarrativeFacts(db, 'Integry/ProPR', NOW, { ownerId: 'user-1' });
    assert.ok(narrative.facts.live.some(item => item.id === 'draft-generating'), 'narrative plans');

    // Both the stored spelling and any other one resolve to the configured name and find the stored rows.
    for (const spelling of ['integry/propr', 'INTEGRY/PROPR']) {
      const json = await call(cost.getCost, { period: '7d', repository: spelling, group_by: 'repository' });
      assert.equal(json.status, 200, spelling);
      assert.equal(json.body.repository, 'Integry/ProPR', `${spelling}: the configured name is echoed`);
      assert.equal(json.body.totals.executions, 1, `${spelling}: cost totals`);
      assert.deepEqual(json.body.rows.map((row: Json) => [row.repository, row.executions]), [['integry/propr', 1]], `${spelling}: rows keep the stored name`);
      const csv = await call(cost.getCostCsv, { period: '7d', repository: spelling, group_by: 'repository' });
      assert.equal(csv.status, 200, spelling);
      assert.equal(String(csv.body.sent).trimEnd().split('\r\n').length, 2, `${spelling}: the CSV has a data row: ${csv.body.sent}`);

      const dashboardStats = await call(stats.getDashboardStats, { period: '7d', repository: spelling });
      assert.equal(dashboardStats.body.repository, 'Integry/ProPR', spelling);
      assert.equal(dashboardStats.body.tasks, 1, `${spelling}: dashboard stats`);

      const scoreSummary = await call(scores.getSummary, { period: '7d', repository: spelling });
      assert.equal(scoreSummary.status, 200, spelling);
      assert.equal(scoreSummary.body.repository, 'Integry/ProPR', spelling);
      assert.equal(scoreSummary.body.scores_recorded, 1, `${spelling}: review scores`);

      const taskPage = await call(tasks.getTasks, { repository: spelling });
      assert.equal(taskPage.body.total, 1, `${spelling}: tasks`);

      const outcomes = await call(dashboard.getOutcomes, { repository: spelling });
      assert.equal(outcomes.status, 200, `${spelling}: ${JSON.stringify(outcomes.body)}`);
      assert.equal(outcomes.body.repository, 'Integry/ProPR', spelling);
      assert.deepEqual(outcomes.body.items.map((item: Json) => item.taskId), ['task-1'], `${spelling}: completed work`);

      const summary = await call(dashboard.getSummary, { repository: spelling });
      assert.equal(summary.body.repository, 'Integry/ProPR', spelling);
      assert.equal(summary.body.completedRecently, 1, `${spelling}: recent completions ${JSON.stringify(summary.body)}`);
      const attention = await call(dashboard.getAttention, { repository: spelling });
      assert.ok(attention.body.items.some((item: Json) => item.issueNumber === 9), `${spelling}: plan issue decision ${JSON.stringify(attention.body)}`);
      const active = await call(dashboard.getActive, { repository: spelling });
      assert.ok(JSON.stringify(active.body).includes('goal-1'), `${spelling}: running goal ${JSON.stringify(active.body)}`);
    }
  } finally {
    await db('plan_issues').where({ draft_id: 'draft-1' }).delete();
    await db('goals').where({ goal_id: 'goal-1' }).delete();
    await db('task_drafts').where({ draft_id: 'draft-generating' }).delete();
  }
});

test('repository media reads and projects a configured repository under its configured spelling', async () => {
  const configuredAs = createRepositoryScopeResolver({
    configuredRepositories: async () => [{ name: 'Integry/ProPR', enabled: true }],
    checksGitHubAccess: () => false,
  });
  const policyChecks: string[][] = [];
  const projected: Array<{ repository: string; prNumbers: number[] }> = [];
  const reader = {
    enabledRepositories: async (repositories: string[]) => {
      policyChecks.push(repositories);
      return new Set(repositories.map(name => name.toLowerCase()));
    },
    project: async (sources: Array<{ repository: string; prNumbers: number[] }>) => {
      projected.push(...sources);
      return [{ previews: [{ url: 'https://example.test/preview.png' }] }];
    },
  };
  const media = createRepositoryMediaRoutes({ db, repositoryScope: configuredAs, reader: reader as never });
  const result = await call(media.getMedia, { repository: 'INTEGRY/propr' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(policyChecks, [['Integry/ProPR']], 'the preview policy is checked for the configured repository');
  assert.deepEqual(projected, [{ repository: 'Integry/ProPR', prNumbers: [3583] }], 'the stored lowercase row is found and projected under the configured name');
  assert.deepEqual(result.body.previews, [{ url: 'https://example.test/preview.png' }]);
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

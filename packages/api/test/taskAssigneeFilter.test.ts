import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { after, afterEach, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { parseTaskAssignmentFilter, type TaskAssignmentFilter } from '@propr/shared';

const originalNodeEnv = process.env.NODE_ENV;
const originalDbFilename = process.env.DB_FILENAME;
const isolatedDbDir = await mkdtemp(path.join(tmpdir(), 'propr-task-assignee-filter-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILENAME = path.join(isolatedDbDir, 'propr.sqlite');

const { closeConnection } = await import('@propr/core');
const { getTasksFromDb } = await import('../routes/taskHelpers.js');
const { createTaskRoutes } = await import('../routes/taskRoutes.js');
type TaskQuery = Parameters<typeof getTasksFromDb>[0];

const databases: Knex[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => database.destroy()));
});

after(async () => {
  await closeConnection();
  await rm(isolatedDbDir, { recursive: true, force: true });
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalDbFilename === undefined) delete process.env.DB_FILENAME;
  else process.env.DB_FILENAME = originalDbFilename;
});

const OCTOCAT = '583231';
const HUBOT = '480938';
/** An account that held the `octocat` login before a rename. */
const FORMER_OCTOCAT = '17';

/**
 * Runs, newest first:
 *  - `issue-1-b` and `issue-1-a`: two runs of acme/widget#1; only the older is assigned (octocat).
 *  - `issue-2`: acme/widget#2, assigned to hubot.
 *  - `issue-3`: acme/widget#3, nobody assigned.
 *  - `other-4`: other/repo#4, assigned to octocat.
 *  - `stale-5`: acme/widget#5, assigned to the account that used to be `octocat`.
 */
async function createDatabase(): Promise<Knex> {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  databases.push(database);
  await database.schema.createTable('tasks', table => {
    table.string('task_id').primary();
    table.string('repository');
    table.string('task_type');
    table.string('model_name');
    table.timestamp('created_at');
    table.text('initial_job_data');
    table.text('final_result');
    table.integer('issue_number');
    table.integer('pr_number');
    table.string('commit_hash');
  });
  await database.schema.createTable('task_history', table => {
    table.increments('history_id').primary();
    table.string('task_id');
    table.string('state');
    table.timestamp('timestamp');
    table.text('reason');
    table.text('metadata');
  });
  await database.schema.createTable('plan_issues', table => {
    table.increments('id').primary();
    table.string('task_id');
    table.string('status');
  });
  await database.schema.createTable('github_user_profiles', table => {
    table.string('github_user_id', 64).primary();
    table.string('login', 255).notNullable();
    table.text('avatar_url');
    table.string('display_name', 255);
    table.text('refreshed_at');
    table.text('created_at').notNullable();
    table.text('updated_at').notNullable();
  });
  await database.schema.createTable('task_assignees', table => {
    table.string('task_id', 255).notNullable();
    table.string('github_user_id', 64).notNullable();
    table.text('synced_at').notNullable();
    table.text('created_at').notNullable();
    table.primary(['task_id', 'github_user_id']);
  });

  const runs: Array<[string, string, number, string, string]> = [
    ['issue-1-b', 'acme/widget', 1, 'processing', '2026-10-01T06:00:00.000Z'],
    ['stale-5', 'acme/widget', 5, 'completed', '2026-10-01T05:00:00.000Z'],
    ['other-4', 'other/repo', 4, 'completed', '2026-10-01T04:00:00.000Z'],
    ['issue-3', 'acme/widget', 3, 'failed', '2026-10-01T03:00:00.000Z'],
    ['issue-2', 'acme/widget', 2, 'completed', '2026-10-01T02:00:00.000Z'],
    ['issue-1-a', 'acme/widget', 1, 'completed', '2026-10-01T01:00:00.000Z'],
  ];
  await database('tasks').insert(runs.map(([taskId, repository, issueNumber, , createdAt]) => ({
    task_id: taskId, repository, task_type: 'issue', issue_number: issueNumber, created_at: createdAt,
    initial_job_data: JSON.stringify({ title: `Work on ${taskId}` }),
  })));
  await database('task_history').insert(runs.map(([taskId, , , state, createdAt]) => ({
    task_id: taskId, state, timestamp: createdAt,
  })));
  const at = '2026-10-01T00:00:00.000Z';
  await database('github_user_profiles').insert([
    { github_user_id: OCTOCAT, login: 'octocat', display_name: 'The Octocat', avatar_url: 'https://avatars.example/1', created_at: at, updated_at: '2026-10-02T00:00:00.000Z' },
    { github_user_id: HUBOT, login: 'hubot', display_name: null, avatar_url: null, created_at: at, updated_at: at },
    { github_user_id: FORMER_OCTOCAT, login: 'OctoCat', display_name: null, avatar_url: null, created_at: at, updated_at: '2026-09-01T00:00:00.000Z' },
  ]);
  await database('task_assignees').insert([
    { task_id: 'issue-1-a', github_user_id: OCTOCAT, synced_at: at, created_at: at },
    { task_id: 'issue-2', github_user_id: HUBOT, synced_at: at, created_at: at },
    { task_id: 'issue-2', github_user_id: '999', synced_at: at, created_at: at },
    { task_id: 'other-4', github_user_id: OCTOCAT, synced_at: at, created_at: at },
    { task_id: 'stale-5', github_user_id: FORMER_OCTOCAT, synced_at: at, created_at: at },
  ]);
  return database;
}

function filter(value: string): TaskAssignmentFilter {
  const parsed = parseTaskAssignmentFilter(value);
  assert.ok(parsed.ok, value);
  return parsed.filter;
}

async function list(db: Knex, overrides: Partial<TaskQuery> = {}) {
  return await getTasksFromDb({ db, status: 'all', repository: 'all', limit: 50, offset: 0, ...overrides });
}

const ids = (page: { tasks: unknown[] }): string[] => page.tasks.map(task => String((task as { id: string }).id));

test('without an assignee filter the page is unchanged and every task carries its assignees', async () => {
  const db = await createDatabase();
  const plain = await list(db);
  const all = await list(db, { assignee: filter('all') });
  assert.deepEqual(ids(plain), ['issue-1-b', 'stale-5', 'other-4', 'issue-3', 'issue-2', 'issue-1-a']);
  assert.deepEqual({ ...all, tasks: ids(all) }, { ...plain, tasks: ids(plain) });
  assert.equal(plain.total, 6);

  const byId = new Map(plain.tasks.map(task => [(task as { id: string }).id, (task as { assignees: unknown }).assignees]));
  assert.deepEqual(byId.get('issue-1-b'), []);
  assert.deepEqual(byId.get('issue-3'), []);
  assert.deepEqual(byId.get('issue-1-a'), [
    { id: OCTOCAT, login: 'octocat', displayName: 'The Octocat', avatarUrl: 'https://avatars.example/1' },
  ]);
  // An assignee without a cached profile is listed under its id, after named ones.
  assert.deepEqual(byId.get('issue-2'), [
    { id: '999', login: '999', displayName: null, avatarUrl: null },
    { id: HUBOT, login: 'hubot', displayName: null, avatarUrl: null },
  ]);

  const grouped = await list(db, { groupByTask: true });
  const groupedAll = await list(db, { groupByTask: true, assignee: filter('all') });
  assert.deepEqual({ ...groupedAll, tasks: ids(groupedAll) }, { ...grouped, tasks: ids(grouped) });
  assert.equal(grouped.total, 5);
  assert.equal(grouped.totalRuns, 6);
});

test('me lists only the acting user\'s tasks and lists nothing without one', async () => {
  const db = await createDatabase();
  assert.deepEqual(ids(await list(db, { assignee: filter('me'), actingUserId: HUBOT })), ['issue-2']);
  assert.deepEqual(ids(await list(db, { assignee: filter('me'), actingUserId: OCTOCAT })), ['other-4', 'issue-1-a']);
  const anonymous = await list(db, { assignee: filter('me'), actingUserId: null, groupByTask: true });
  assert.deepEqual(anonymous, { tasks: [], total: 0, offset: 0, limit: 50, totalRuns: 0 });
});

test('a login list lists the union of their tasks and an unknown login lists nothing', async () => {
  const db = await createDatabase();
  const union = await list(db, { assignee: filter('@Octocat, hubot') });
  // `octocat` is the account that holds the login now, not the one renamed away from it.
  assert.deepEqual(ids(union), ['other-4', 'issue-2', 'issue-1-a']);
  assert.equal(union.total, 3);

  const unknown = await list(db, { assignee: filter('nobody-here') });
  assert.deepEqual(unknown, { tasks: [], total: 0, offset: 0, limit: 50 });
  assert.deepEqual(ids(await list(db, { assignee: filter('nobody-here,hubot') })), ['issue-2']);
});

test('unassigned lists runs, or with grouping tasks, that nobody is assigned to', async () => {
  const db = await createDatabase();
  const runs = await list(db, { assignee: filter('unassigned') });
  assert.deepEqual(ids(runs), ['issue-1-b', 'issue-3']);
  assert.equal(runs.total, 2);

  // Task #1 has an assigned run, so as a task it is assigned.
  const tasks = await list(db, { assignee: filter('unassigned'), groupByTask: true });
  assert.deepEqual(ids(tasks), ['issue-3']);
  assert.equal(tasks.total, 1);
  assert.equal(tasks.totalRuns, 1);
});

test('grouped paging counts tasks matching the filter and returns all of their runs', async () => {
  const db = await createDatabase();
  const firstPage = await list(db, { assignee: filter('octocat'), groupByTask: true, limit: 1 });
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.totalRuns, 3);
  // Only the older run of task #1 is assigned, yet the task's newer run is listed with it.
  assert.deepEqual(ids(firstPage), ['issue-1-b', 'issue-1-a']);

  const secondPage = await list(db, { assignee: filter('octocat'), groupByTask: true, limit: 1, offset: 1 });
  assert.equal(secondPage.total, 2);
  assert.deepEqual(ids(secondPage), ['other-4']);

  const thirdPage = await list(db, { assignee: filter('octocat'), groupByTask: true, limit: 1, offset: 2 });
  assert.deepEqual(thirdPage, { tasks: [], total: 2, totalRuns: 3, offset: 2, limit: 1 });
});

test('the assignee filter composes with repository, status, search, review and merge filters', async () => {
  const db = await createDatabase();
  await db('plan_issues').insert({ task_id: 'other-4', status: 'merged' });
  const octocat = filter('octocat');

  assert.deepEqual(ids(await list(db, { assignee: octocat, repository: 'acme/widget' })), ['issue-1-a']);
  assert.deepEqual(ids(await list(db, { assignee: octocat, repository: 'acme/widget', groupByTask: true })), ['issue-1-b', 'issue-1-a']);
  // Grouped, a task's state is its newest run's: task #1 is processing.
  assert.deepEqual(ids(await list(db, { assignee: octocat, status: 'completed', groupByTask: true })), ['other-4']);
  assert.deepEqual(ids(await list(db, { assignee: octocat, status: 'completed' })), ['other-4', 'issue-1-a']);
  assert.deepEqual(ids(await list(db, { assignee: octocat, search: 'other-4' })), ['other-4']);
  assert.deepEqual(ids(await list(db, { assignee: octocat, forReview: true })), ['other-4', 'issue-1-a']);
  assert.deepEqual(ids(await list(db, { assignee: octocat, excludeMerged: true })), ['issue-1-a']);
  assert.deepEqual(ids(await list(db, { assignee: filter('unassigned'), status: 'failed' })), ['issue-3']);
});

test('enrichment reads assignees in one query per page and never syncs from GitHub', async () => {
  const db = await createDatabase();
  const assigneeQueries: string[] = [];
  db.on('query', (query: { sql: string }) => {
    if (query.sql.includes('task_assignees')) assigneeQueries.push(query.sql);
  });
  const synced: string[] = [];
  const syncAssignees = async (taskId: string) => { synced.push(taskId); };

  await list(db, { syncAssignees });
  assert.equal(assigneeQueries.length, 1);
  await list(db, { groupByTask: true, syncAssignees });
  assert.equal(assigneeQueries.length, 2);
  assert.deepEqual(synced, []);

  // Only the detail view, naming one run, refreshes, and the refreshed set is what it reads.
  const detail = await list(db, {
    groupByTask: true,
    containsTask: 'issue-3',
    syncAssignees: async taskId => {
      synced.push(taskId);
      await db('task_assignees').insert({ task_id: taskId, github_user_id: HUBOT, synced_at: 'now', created_at: 'now' });
    },
  });
  assert.deepEqual(synced, ['issue-3']);
  assert.deepEqual((detail.tasks[0] as { assignees: Array<{ login: string }> }).assignees.map(user => user.login), ['hubot']);

  // A failed refresh still serves the stored set.
  const fallback = await list(db, { groupByTask: true, containsTask: 'issue-2', syncAssignees: async () => { throw new Error('GitHub down'); } });
  assert.equal((fallback.tasks[0] as { assignees: unknown[] }).assignees.length, 2);
});

test('a database without the assignee projection still lists tasks with empty assignees', async () => {
  const db = await createDatabase();
  await db.schema.dropTable('task_assignees');
  const page = await list(db);
  assert.equal(page.total, 6);
  assert.ok(page.tasks.every(task => Array.isArray((task as { assignees: unknown }).assignees) && (task as { assignees: unknown[] }).assignees.length === 0));
});

async function getTasks(db: Knex, query: Record<string, string>, user?: { id: string }): Promise<{ status: number; json: unknown }> {
  const result = { status: 200, json: undefined as unknown };
  const response = {
    status(code: number) { result.status = code; return this; },
    json(payload: unknown) { result.json = payload; return this; },
  } as unknown as Response;
  await createTaskRoutes({ db }).getTasks({ query, ...(user ? { user } : {}) } as unknown as Request, response);
  return result;
}

test('GET /api/tasks validates the assignee parameter', async () => {
  const db = await createDatabase();
  const malformed = await getTasks(db, { assignee: 'not a login' });
  assert.equal(malformed.status, 400);
  assert.match(String((malformed.json as { error: string }).error), /invalid GitHub login/);
  assert.equal((await getTasks(db, { assignee: 'octocat,-bad' })).status, 400);

  assert.deepEqual(await getTasks(db, { assignee: 'me' }), {
    status: 400,
    json: { error: 'assignee "me" requires an authenticated user' },
  });
  assert.deepEqual(await getTasks(db, { syncAssignees: 'true' }), {
    status: 400,
    json: { error: 'syncAssignees requires task' },
  });
});

test('GET /api/tasks resolves me from the session, not the query string', async () => {
  const db = await createDatabase();
  const mine = await getTasks(db, { assignee: 'me', actingUserId: OCTOCAT }, { id: HUBOT });
  assert.equal(mine.status, 200);
  assert.deepEqual(ids(mine.json as { tasks: unknown[] }), ['issue-2']);

  const grouped = await getTasks(db, { assignee: 'octocat', groupBy: 'task', limit: '1' });
  assert.equal(grouped.status, 200);
  assert.deepEqual({ ...(grouped.json as object), tasks: ids(grouped.json as { tasks: unknown[] }) }, {
    tasks: ['issue-1-b', 'issue-1-a'], total: 2, totalRuns: 3, offset: 0, limit: 1,
  });

  const unassigned = await getTasks(db, { assignee: 'unassigned' }, { id: HUBOT });
  assert.deepEqual(ids(unassigned.json as { tasks: unknown[] }), ['issue-1-b', 'issue-3']);
});

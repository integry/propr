import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import knex, { Knex } from 'knex';
import { getTasksFromDb } from '../routes/taskHelpers.js';
import {
  down as removeTaskHistoryLookupIndex,
  up as addTaskHistoryLookupIndex,
} from '../../core/src/db/migrations/20260914000000_optimize_task_history_lookup.js';

const databases: Knex[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => database.destroy()));
});

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
  });
  await database.schema.createTable('task_history', table => {
    table.increments('history_id').primary();
    table.string('task_id');
    table.string('state');
    table.timestamp('timestamp');
    table.text('reason');
    table.text('metadata');
    table.index('task_id');
    table.index('state');
    table.index('timestamp');
  });
  await database.schema.createTable('plan_issues', table => {
    table.increments('id').primary();
    table.string('task_id');
    table.string('status');
    table.index('task_id');
  });
  await database.schema.createTable('llm_executions', table => {
    table.increments('execution_id').primary();
    table.string('task_id');
    table.text('analysis_report');
    table.index('task_id');
  });
  return database;
}

test('task pages preserve filters and enrich only unique task identities', async () => {
  const database = await createDatabase();
  await addTaskHistoryLookupIndex(database);

  await database('tasks').insert([
    {
      task_id: 'newest', repository: 'acme/widget', task_type: 'issue', model_name: 'gpt',
      issue_number: 12, created_at: '2026-09-14T05:00:00.000Z',
      initial_job_data: JSON.stringify({ title: 'Needle performance work' }),
    },
    {
      task_id: 'tied', repository: 'acme/widget', task_type: null,
      issue_number: 11, created_at: '2026-09-14T04:00:00.000Z',
    },
    {
      task_id: 'valid-score', repository: 'other/repo', task_type: 'issue',
      issue_number: 10, created_at: '2026-09-14T03:00:00.000Z',
    },
    {
      task_id: 'missing-history', repository: 'acme/widget', task_type: 'issue',
      issue_number: 9, created_at: '2026-09-14T02:00:00.000Z',
    },
    {
      task_id: 'goal-task', repository: 'acme/widget', task_type: 'goal',
      issue_number: 8, created_at: '2026-09-14T01:00:00.000Z',
    },
  ]);
  await database('task_history').insert([
    { task_id: 'newest', state: 'processing', timestamp: '2026-09-14T05:01:00.000Z' },
    { task_id: 'newest', state: 'completed', timestamp: '2026-09-14T05:03:00.000Z' },
    { task_id: 'newest', state: 'post_processing', timestamp: '2026-09-14T05:02:00.000Z' },
    // ROW_NUMBER previously selected the first row encountered for equal
    // timestamps; the indexed lookup must still return exactly that row.
    { task_id: 'tied', state: 'failed', reason: 'first tie', timestamp: '2026-09-14T04:01:00.000Z' },
    { task_id: 'tied', state: 'completed', timestamp: '2026-09-14T04:01:00.000Z' },
    { task_id: 'valid-score', state: 'processing', timestamp: '2026-09-14T03:01:00.000Z' },
    { task_id: 'goal-task', state: 'completed', timestamp: '2026-09-14T01:01:00.000Z' },
  ]);
  await database('plan_issues').insert([
    { task_id: 'newest', status: 'merged' },
    { task_id: 'newest', status: 'closed' },
  ]);
  await database('llm_executions').insert([
    {
      task_id: 'newest',
      analysis_report: JSON.stringify({ report: '{"implementation_critique_score":7}' }),
    },
    // This is valid outer JSON and therefore remains the chosen execution,
    // but its embedded report is malformed and produces a null score.
    { task_id: 'newest', analysis_report: JSON.stringify({ report: 'notes {broken' }) },
    { task_id: 'newest', analysis_report: '{not outer json' },
    {
      task_id: 'valid-score',
      analysis_report: JSON.stringify({ report: 'Result:\n```json\n{"implementation_critique_score":"8.5"}\n```' }),
    },
  ]);

  const all = await getTasksFromDb({
    db: database, status: 'all', repository: 'all', limit: 10, offset: 0,
  });
  assert.equal(all.total, 3);
  assert.deepEqual((all.tasks as Array<{ id: string }>).map(task => task.id), ['newest', 'tied', 'valid-score']);

  const newest = (all.tasks as Array<Record<string, unknown>>)[0];
  assert.equal(newest.planIssueStatus, 'merged');
  assert.equal(newest.critiqueScore, null);
  assert.equal(newest.processedAt, '2026-09-14T05:01:00.000Z');
  assert.equal(newest.completedAt, '2026-09-14T05:03:00.000Z');
  const tied = (all.tasks as Array<Record<string, unknown>>)[1];
  assert.equal(tied.status, 'failed');
  assert.equal(tied.failedReason, 'first tie');
  assert.equal((all.tasks as Array<Record<string, unknown>>)[2].critiqueScore, 8.5);

  const openReview = await getTasksFromDb({
    db: database, status: 'all', repository: 'all', limit: 10, offset: 0,
    forReview: true, excludeMerged: true,
  });
  assert.equal(openReview.total, 2);
  assert.deepEqual((openReview.tasks as Array<Record<string, unknown>>).map(task => task.id), ['newest', 'tied']);
  assert.equal((openReview.tasks as Array<Record<string, unknown>>)[0].planIssueStatus, 'closed');

  const searched = await getTasksFromDb({
    db: database, status: 'completed', repository: 'acme/widget', limit: 10, offset: 0,
    search: 'Needle',
  });
  assert.equal(searched.total, 1);
  assert.equal((searched.tasks as Array<Record<string, unknown>>)[0].id, 'newest');

  const secondPage = await getTasksFromDb({
    db: database, status: 'all', repository: 'all', limit: 1, offset: 1,
  });
  assert.deepEqual((secondPage.tasks as Array<Record<string, unknown>>).map(task => task.id), ['tied']);
});

test('presentation enrichment queries are constrained to the selected page', async () => {
  const database = await createDatabase();
  await addTaskHistoryLookupIndex(database);
  await database('tasks').insert([
    { task_id: 'page-task', repository: 'acme/widget', task_type: 'issue', created_at: '2026-09-14T02:00:00.000Z' },
    { task_id: 'off-page-task', repository: 'acme/widget', task_type: 'issue', created_at: '2026-09-14T01:00:00.000Z' },
  ]);
  await database('task_history').insert([
    { task_id: 'page-task', state: 'completed', timestamp: '2026-09-14T02:01:00.000Z' },
    { task_id: 'off-page-task', state: 'completed', timestamp: '2026-09-14T01:01:00.000Z' },
  ]);

  const queries: Array<{ sql: string; bindings: readonly unknown[] }> = [];
  database.on('query', event => queries.push({ sql: event.sql, bindings: event.bindings ?? [] }));
  await getTasksFromDb({ db: database, status: 'all', repository: 'all', limit: 1, offset: 0 });

  assert.equal(queries.length, 6);
  assert.doesNotMatch(queries[0].sql, /ROW_NUMBER|processing_start_timestamp|analysis_report/i);
  assert.doesNotMatch(queries[1].sql, /ROW_NUMBER|processing_start_timestamp|analysis_report/i);
  for (const query of queries.slice(2)) {
    assert.ok(query.bindings.includes('page-task'));
    assert.ok(!query.bindings.includes('off-page-task'));
  }
});

test('task history migration replaces the redundant index and satisfies latest-state ordering', async () => {
  const database = await createDatabase();
  await addTaskHistoryLookupIndex(database);

  const indexes = await database.raw("PRAGMA index_list('task_history')") as Array<{ name: string }>;
  assert.ok(indexes.some(index => index.name === 'task_history_task_id_timestamp_index'));
  assert.ok(!indexes.some(index => index.name === 'task_history_task_id_index'));

  const plan = await database.raw(`
    EXPLAIN QUERY PLAN
    SELECT t.task_id, h.state
    FROM tasks AS t
    JOIN task_history AS h ON h.history_id = (
      SELECT latest_h.history_id
      FROM task_history AS latest_h
      WHERE latest_h.task_id = t.task_id
      ORDER BY latest_h.timestamp DESC
      LIMIT 1
    )
  `) as Array<{ detail: string }>;
  assert.ok(plan.some(row => row.detail.includes('task_history_task_id_timestamp_index')));
  assert.ok(!plan.some(row => row.detail.includes('USE TEMP B-TREE')));

  await removeTaskHistoryLookupIndex(database);
  const rolledBack = await database.raw("PRAGMA index_list('task_history')") as Array<{ name: string }>;
  assert.ok(rolledBack.some(index => index.name === 'task_history_task_id_index'));
  assert.ok(!rolledBack.some(index => index.name === 'task_history_task_id_timestamp_index'));
});

test('lifecycle filters map UI labels onto the worker states stored in history', async () => {
  const database = await createDatabase();
  await addTaskHistoryLookupIndex(database);

  await database('tasks').insert([
    { task_id: 'processing-task', repository: 'acme/widget', task_type: 'issue', created_at: '2026-09-14T06:00:00.000Z' },
    { task_id: 'claude-task', repository: 'acme/widget', task_type: 'issue', created_at: '2026-09-14T05:00:00.000Z' },
    { task_id: 'post-processing-task', repository: 'acme/widget', task_type: 'issue', created_at: '2026-09-14T04:00:00.000Z' },
    { task_id: 'queued-task', repository: 'acme/widget', task_type: 'issue', created_at: '2026-09-14T03:00:00.000Z' },
    { task_id: 'pending-task', repository: 'acme/widget', task_type: 'issue', created_at: '2026-09-14T02:00:00.000Z' },
    { task_id: 'completed-task', repository: 'acme/widget', task_type: 'issue', created_at: '2026-09-14T01:00:00.000Z' },
    { task_id: 'failed-task', repository: 'acme/widget', task_type: 'issue', created_at: '2026-09-14T00:00:00.000Z' },
    { task_id: 'blocked-task', repository: 'acme/widget', task_type: 'issue', created_at: '2026-09-13T23:00:00.000Z' },
  ]);
  await database('task_history').insert([
    // The completed task passed through an active state first; only its latest
    // state may decide whether the Active filter includes it.
    { task_id: 'completed-task', state: 'claude_execution', timestamp: '2026-09-14T01:01:00.000Z' },
    { task_id: 'completed-task', state: 'completed', timestamp: '2026-09-14T01:02:00.000Z' },
    { task_id: 'processing-task', state: 'processing', timestamp: '2026-09-14T06:01:00.000Z' },
    { task_id: 'claude-task', state: 'claude_execution', timestamp: '2026-09-14T05:01:00.000Z' },
    { task_id: 'post-processing-task', state: 'post_processing', timestamp: '2026-09-14T04:01:00.000Z' },
    { task_id: 'queued-task', state: 'queued', timestamp: '2026-09-14T03:01:00.000Z' },
    { task_id: 'pending-task', state: 'pending', timestamp: '2026-09-14T02:01:00.000Z' },
    { task_id: 'failed-task', state: 'failed', timestamp: '2026-09-14T00:01:00.000Z' },
    { task_id: 'blocked-task', state: 'action_required', timestamp: '2026-09-13T23:01:00.000Z' },
  ]);

  const idsFor = async (status: string) => {
    const page = await getTasksFromDb({
      db: database, status, repository: 'all', limit: 10, offset: 0,
    });
    return { total: page.total, ids: (page.tasks as Array<{ id: string }>).map(task => task.id) };
  };

  const activeIds = ['processing-task', 'claude-task', 'post-processing-task'];
  const active = await idsFor('active');
  assert.equal(active.total, 3);
  assert.deepEqual(active.ids, activeIds);
  // 'Implementing' is the label the task list renders for the same filter.
  assert.deepEqual(await idsFor('implementing'), active);
  assert.deepEqual(await idsFor('Implementing'), active);

  const waitingIds = ['queued-task', 'pending-task'];
  const waiting = await idsFor('waiting');
  assert.equal(waiting.total, 2);
  assert.deepEqual(waiting.ids, waitingIds);
  assert.deepEqual(await idsFor('pending'), waiting);

  // The dashboard's attention count opens this list, so it spans explicit
  // action-required work and unresolved failures.
  const attention = await idsFor('attention');
  assert.equal(attention.total, 2);
  assert.deepEqual(attention.ids, ['failed-task', 'blocked-task']);

  // Terminal and granular states keep matching exactly.
  assert.deepEqual((await idsFor('completed')).ids, ['completed-task']);
  assert.deepEqual((await idsFor('failed')).ids, ['failed-task']);
  assert.deepEqual((await idsFor('claude_execution')).ids, ['claude-task']);
  assert.equal((await idsFor('all')).total, 8);
});

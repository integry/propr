import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import knex, { Knex } from 'knex';
import { getTasksFromDb, type TaskQuery } from '../routes/taskHelpers.js';
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
    table.string('commit_hash');
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
    table.string('draft_id');
    table.string('repository');
    table.integer('issue_number');
    table.integer('pr_number');
    table.string('task_id');
    table.string('status');
    table.timestamp('created_at');
    table.timestamp('updated_at');
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
      issue_number: 12, created_at: '2026-09-14T05:00:00.000Z', commit_hash: 'abc1234def',
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
  assert.ok(!('critiqueScore' in newest));
  assert.equal(newest.processedAt, '2026-09-14T05:01:00.000Z');
  assert.equal(newest.completedAt, '2026-09-14T05:03:00.000Z');
  assert.equal(newest.commitHash, 'abc1234def');
  const tied = (all.tasks as Array<Record<string, unknown>>)[1];
  assert.equal(tied.status, 'failed');
  assert.equal(tied.failedReason, 'first tie');
  assert.equal(tied.commitHash, null);
  assert.ok((all.tasks as Array<Record<string, unknown>>).every(task => !('critiqueScore' in task)));

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
  assert.ok(queries.every(query => !/analysis_report/i.test(query.sql)));
  assert.doesNotMatch(queries[0].sql, /ROW_NUMBER|processing_start_timestamp|analysis_report/i);
  assert.doesNotMatch(queries[1].sql, /ROW_NUMBER|processing_start_timestamp|analysis_report/i);
  for (const query of queries.slice(2)) {
    assert.ok(query.bindings.includes('page-task'));
    assert.ok(!query.bindings.includes('off-page-task'));
  }
});

test('each run carries the score its latest completion recorded', async () => {
  const database = await createDatabase();
  await database('tasks').insert([
    { task_id: 'review', repository: 'acme/widget', task_type: 'pr_comment', created_at: '2026-09-14T04:00:00.000Z' },
    { task_id: 'ultrafix', repository: 'acme/widget', task_type: 'pr_comment', created_at: '2026-09-14T03:00:00.000Z' },
    { task_id: 'rerun', repository: 'acme/widget', task_type: 'pr_comment', created_at: '2026-09-14T02:00:00.000Z' },
    { task_id: 'fix', repository: 'acme/widget', task_type: 'pr_comment', created_at: '2026-09-14T01:00:00.000Z' },
  ]);
  await database('task_history').insert([
    { task_id: 'review', state: 'processing', timestamp: '2026-09-14T04:01:00.000Z' },
    // Two reviewers: the lower score decides.
    { task_id: 'review', state: 'completed', timestamp: '2026-09-14T04:02:00.000Z', metadata: JSON.stringify({ notificationRecap: 'Scores 8/10, 6/10 · 2 issues found' }) },
    { task_id: 'ultrafix', state: 'processing', timestamp: '2026-09-14T03:01:00.000Z' },
    { task_id: 'ultrafix', state: 'completed', timestamp: '2026-09-14T03:02:00.000Z', metadata: JSON.stringify({ ultrafixScore: 4 }) },
    // A score from before the task was started again does not describe the new run.
    { task_id: 'rerun', state: 'completed', timestamp: '2026-09-14T02:01:00.000Z', metadata: JSON.stringify({ notificationRecap: 'Score 9/10' }) },
    { task_id: 'rerun', state: 'processing', timestamp: '2026-09-14T02:02:00.000Z' },
    { task_id: 'fix', state: 'completed', timestamp: '2026-09-14T01:02:00.000Z', metadata: JSON.stringify({ notificationRecap: 'Fixed the seed test' }) },
  ]);

  const page = await getTasksFromDb({ db: database, status: 'all', repository: 'all', limit: 10, offset: 0 });
  const scores = Object.fromEntries((page.tasks as Array<Record<string, unknown>>).map(task => [task.id, task.score]));
  assert.deepEqual(scores, { review: 6, ultrafix: 4, rerun: null, fix: null });
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

  // Relative timestamps: the attention filter reads the same recency window as
  // the dashboard count it opens, so fixed dates would age out of that window.
  const hoursAgo = (hours: number, minutes = 0): string =>
    new Date(Date.now() - hours * 60 * 60 * 1000 + minutes * 60 * 1000).toISOString();

  await database('tasks').insert([
    { task_id: 'processing-task', repository: 'acme/widget', task_type: 'issue', created_at: hoursAgo(1) },
    { task_id: 'claude-task', repository: 'acme/widget', task_type: 'issue', created_at: hoursAgo(2) },
    { task_id: 'post-processing-task', repository: 'acme/widget', task_type: 'issue', created_at: hoursAgo(3) },
    { task_id: 'queued-task', repository: 'acme/widget', task_type: 'issue', created_at: hoursAgo(4) },
    { task_id: 'pending-task', repository: 'acme/widget', task_type: 'issue', created_at: hoursAgo(5) },
    { task_id: 'completed-task', repository: 'acme/widget', task_type: 'issue', created_at: hoursAgo(6) },
    { task_id: 'failed-task', repository: 'acme/widget', task_type: 'issue', created_at: hoursAgo(7) },
    { task_id: 'blocked-task', repository: 'acme/widget', task_type: 'issue', created_at: hoursAgo(8) },
  ]);
  await database('task_history').insert([
    // The completed task passed through an active state first; only its latest
    // state may decide whether the Active filter includes it.
    { task_id: 'completed-task', state: 'claude_execution', timestamp: hoursAgo(6, 1) },
    { task_id: 'completed-task', state: 'completed', timestamp: hoursAgo(6, 2) },
    { task_id: 'processing-task', state: 'processing', timestamp: hoursAgo(1, 1) },
    { task_id: 'claude-task', state: 'claude_execution', timestamp: hoursAgo(2, 1) },
    { task_id: 'post-processing-task', state: 'post_processing', timestamp: hoursAgo(3, 1) },
    { task_id: 'queued-task', state: 'queued', timestamp: hoursAgo(4, 1) },
    { task_id: 'pending-task', state: 'pending', timestamp: hoursAgo(5, 1) },
    { task_id: 'failed-task', state: 'failed', timestamp: hoursAgo(7, 1) },
    { task_id: 'blocked-task', state: 'action_required', timestamp: hoursAgo(8, 1) },
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

  // The dashboard's attention count opens this list, so it is that count's own
  // projection: action-required work and unresolved failures.
  const attention = await idsFor('attention');
  assert.equal(attention.total, 2);
  assert.deepEqual(attention.ids, ['failed-task', 'blocked-task']);

  // Terminal and granular states keep matching exactly.
  assert.deepEqual((await idsFor('completed')).ids, ['completed-task']);
  assert.deepEqual((await idsFor('failed')).ids, ['failed-task']);
  assert.deepEqual((await idsFor('claude_execution')).ids, ['claude-task']);
  assert.equal((await idsFor('all')).total, 8);

  // A retry of the failed thread is the system fixing it, so the failure
  // leaves the attention list exactly as it leaves the dashboard's count.
  await database('tasks').insert({
    task_id: 'retry-task', repository: 'acme/widget', task_type: 'issue',
    issue_number: 7, created_at: hoursAgo(0, -1),
  });
  await database('task_history').insert({ task_id: 'retry-task', state: 'queued', timestamp: hoursAgo(0, -1) });
  await database('tasks').where('task_id', 'failed-task').update({ issue_number: 7 });
  assert.deepEqual((await idsFor('attention')).ids, ['blocked-task']);

  // A completed run whose pull request is waiting on a decision is attention,
  // even though no lifecycle state says so.
  await database('plan_issues').insert({
    draft_id: 'draft-1', repository: 'acme/widget', issue_number: 6, pr_number: 61,
    status: 'under_review', task_id: 'completed-task',
    created_at: hoursAgo(6), updated_at: hoursAgo(5),
  });
  assert.deepEqual((await idsFor('attention')).ids, ['completed-task', 'blocked-task']);
});

test('task count covering index preserves repository lookups and rolls back', async () => {
  const database = await createDatabase();
  const migration = await import('../../core/src/db/migrations/20260929000000_cover_task_list_counts.js');
  await database.schema.alterTable('tasks', table => table.index('repository'));
  await migration.up(database);
  for (const suffix of ['', " AND t.repository = 'acme/widget'"]) {
    const plan = await database.raw(`EXPLAIN QUERY PLAN
      SELECT count(*) FROM tasks t
      WHERE (t.task_type IS NULL OR t.task_type <> 'goal')
        AND EXISTS (SELECT 1 FROM task_history h WHERE h.task_id = t.task_id) ${suffix}`) as Array<{ detail: string }>;
    assert.ok(plan.some(row => row.detail.includes('COVERING INDEX tasks_repository_type_identity_index')));
  }
  await migration.down(database);
  const indexes = await database.raw("PRAGMA index_list('tasks')") as Array<{ name: string }>;
  assert.ok(indexes.some(row => row.name === 'tasks_repository_index'));
  assert.ok(!indexes.some(row => row.name === 'tasks_repository_type_identity_index'));
});

test('task pages count and slice tasks, returning every run of each task on the page', async () => {
  const database = await createDatabase();
  await addTaskHistoryLookupIndex(database);
  const at = (minute: number) => `2026-10-04T08:${String(minute).padStart(2, '0')}:00.000Z`;
  await database('tasks').insert([
    // PR #20: three runs, one recorded only in the job data and one only in the result.
    { task_id: 'pr20-review', repository: 'acme/widget', task_type: 'pr', pr_number: 20, created_at: at(50) },
    { task_id: 'pr20-fix', repository: 'acme/widget', task_type: 'pr', created_at: at(40), initial_job_data: JSON.stringify({ pullRequestNumber: 20 }) },
    // Issue #7 opened PR #20; its run joins the pull request's task.
    { task_id: 'issue7', repository: 'acme/widget', task_type: 'issue', issue_number: 7, created_at: at(10), final_result: JSON.stringify({ postProcessing: { pr: { number: 20 } } }), initial_job_data: JSON.stringify({ issueNumber: 7 }) },
    // Issue #8: two runs, no pull request yet.
    { task_id: 'issue8-b', repository: 'acme/widget', task_type: 'issue', issue_number: 8, created_at: at(45) },
    { task_id: 'issue8-a', repository: 'acme/widget', task_type: 'issue', issue_number: 8, created_at: at(5) },
    // The same issue number in another repository is another task, and malformed JSON is ignored.
    { task_id: 'other8', repository: 'acme/other', task_type: 'issue', issue_number: 8, created_at: at(30), initial_job_data: '{not json' },
    { task_id: 'loose', repository: 'acme/widget', task_type: 'goal-step', created_at: at(20) },
  ]);
  await database('task_history').insert((await database('tasks').select('task_id', 'created_at'))
    .map(row => ({ task_id: row.task_id, state: 'completed', timestamp: row.created_at })));

  // Pull request runs would otherwise ask GitHub for their preview media.
  const previewReader = { project: async (sources: unknown[]) => sources.map(() => ({ previews: [] })) } as unknown as NonNullable<TaskQuery['previewReader']>;
  const page = async (offset: number, limit: number) => {
    const result = await getTasksFromDb({ db: database, previewReader, status: 'all', repository: 'all', limit, offset, groupByTask: true });
    return { ...result, ids: (result.tasks as Array<{ id: string }>).map(task => task.id) };
  };

  const first = await page(0, 2);
  assert.equal(first.total, 4);
  assert.equal(first.totalRuns, 7);
  assert.deepEqual(first.ids, ['pr20-review', 'issue8-b', 'pr20-fix', 'issue7', 'issue8-a']);
  const second = await page(2, 2);
  assert.deepEqual(second.ids, ['other8', 'loose']);
  assert.deepEqual((await page(4, 2)).ids, []);
  // Without grouping, the page still counts runs.
  const runs = await getTasksFromDb({ db: database, previewReader, status: 'all', repository: 'all', limit: 2, offset: 0 });
  assert.equal(runs.total, 7);
  assert.equal(runs.tasks.length, 2);
  assert.equal('totalRuns' in runs, false);
});

test('task pages select a task by its newest run and return every run of it', async () => {
  const database = await createDatabase();
  await addTaskHistoryLookupIndex(database);
  const at = (minute: number) => `2026-10-04T09:${String(minute).padStart(2, '0')}:00.000Z`;
  await database('tasks').insert([
    // PR #30: an older completed review, then a run still processing.
    { task_id: 'pr30-review', repository: 'acme/widget', task_type: 'pr', pr_number: 30, created_at: at(10), initial_job_data: JSON.stringify({ title: 'Review the retry budget' }) },
    { task_id: 'pr30-fix', repository: 'acme/widget', task_type: 'pr', pr_number: 30, created_at: at(40), initial_job_data: JSON.stringify({ title: 'Fix the flaky seed' }) },
    // PR #31: an older processing run that never finished, then a completed one.
    { task_id: 'pr31-old', repository: 'acme/widget', task_type: 'pr', pr_number: 31, created_at: at(20) },
    { task_id: 'pr31-new', repository: 'acme/widget', task_type: 'pr', pr_number: 31, created_at: at(30) },
    { task_id: 'pr32-queued', repository: 'acme/widget', task_type: 'pr', pr_number: 32, created_at: at(50) },
  ]);
  await database('task_history').insert([
    { task_id: 'pr30-review', state: 'completed', timestamp: at(11) },
    { task_id: 'pr30-fix', state: 'processing', timestamp: at(41) },
    { task_id: 'pr31-old', state: 'processing', timestamp: at(21) },
    { task_id: 'pr31-new', state: 'completed', timestamp: at(31) },
    { task_id: 'pr32-queued', state: 'queued', timestamp: at(51) },
  ]);
  const previewReader = { project: async (sources: unknown[]) => sources.map(() => ({ previews: [] })) } as unknown as NonNullable<TaskQuery['previewReader']>;
  const page = async (status: string, search?: string) => {
    const result = await getTasksFromDb({ db: database, previewReader, status, repository: 'all', limit: 10, offset: 0, search, groupByTask: true });
    return { total: result.total, totalRuns: result.totalRuns, ids: (result.tasks as Array<{ id: string }>).map(task => task.id) };
  };

  // Completed lists the task whose newest run completed, with its older run; not PR #30, still working.
  assert.deepEqual(await page('completed'), { total: 1, totalRuns: 2, ids: ['pr31-new', 'pr31-old'] });
  // Active lists PR #30 with its completed history, and not PR #31's stale processing run.
  assert.deepEqual(await page('active'), { total: 1, totalRuns: 2, ids: ['pr30-fix', 'pr30-review'] });
  assert.deepEqual(await page('waiting'), { total: 1, totalRuns: 1, ids: ['pr32-queued'] });
  // Text only an older run carries finds the task, and the page still carries its current run.
  assert.deepEqual(await page('all', 'retry budget'), { total: 1, totalRuns: 2, ids: ['pr30-fix', 'pr30-review'] });
  assert.deepEqual(await page('completed', 'retry budget'), { total: 0, totalRuns: 0, ids: [] });
  // By run, filters still pick runs.
  const runs = await getTasksFromDb({ db: database, previewReader, status: 'completed', repository: 'all', limit: 10, offset: 0 });
  assert.deepEqual((runs.tasks as Array<{ id: string }>).map(task => task.id), ['pr31-new', 'pr30-review']);
});

test('a task page asked for by one of its runs lists that whole task whatever the filters are', async () => {
  const database = await createDatabase();
  await addTaskHistoryLookupIndex(database);
  const at = (minute: number) => `2026-10-04T10:${String(minute).padStart(2, '0')}:00.000Z`;
  await database('tasks').insert([
    { task_id: 'pr40-review', repository: 'acme/widget', task_type: 'pr', pr_number: 40, created_at: at(10) },
    { task_id: 'pr40-fix', repository: 'acme/widget', task_type: 'pr', pr_number: 40, created_at: at(30) },
    { task_id: 'pr41', repository: 'acme/widget', task_type: 'pr', pr_number: 41, created_at: at(20) },
  ]);
  await database('task_history').insert([
    { task_id: 'pr40-review', state: 'completed', timestamp: at(11) },
    { task_id: 'pr40-fix', state: 'processing', timestamp: at(31) },
    { task_id: 'pr41', state: 'completed', timestamp: at(21) },
  ]);
  const previewReader = { project: async (sources: unknown[]) => sources.map(() => ({ previews: [] })) } as unknown as NonNullable<TaskQuery['previewReader']>;
  // The completed filter and a search that matches nothing would both exclude PR #40.
  const result = await getTasksFromDb({
    db: database, previewReader, status: 'completed', repository: 'all', limit: 1, offset: 0, search: 'nothing matches', groupByTask: true, containsTask: 'pr40-review',
  });
  assert.equal(result.total, 1);
  assert.deepEqual((result.tasks as Array<{ id: string; status: string }>).map(task => [task.id, task.status]), [['pr40-fix', 'processing'], ['pr40-review', 'completed']]);
});

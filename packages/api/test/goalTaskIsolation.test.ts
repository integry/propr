import assert from 'node:assert/strict';
import { test } from 'node:test';
import knex from 'knex';
import { getTasksFromDb } from '../routes/taskHelpers.js';
import { goalPreviewSource, previewMediaReader, projectNotificationPreviews } from '../services/previewMediaProjection.js';

test('identity-only goal previews and empty Inbox projections need no global services', async () => {
  const repository = 'acme/widget';
  const artifact = { type: 'pull_request', number: 8, url: `https://github.com/${repository}/pull/8` };
  for (const artifact_refs of [[artifact], JSON.stringify([artifact])]) {
    assert.deepEqual(goalPreviewSource({ repository, final_pr_number: 7, artifact_refs }), {
      repository, prNumbers: [7, 8],
    });
  }
  for (const artifact_refs of [null, undefined, '', '{invalid', '{}', 'null', []]) {
    const source = goalPreviewSource({ repository, final_pr_number: null, artifact_refs });
    assert.deepEqual(source, { repository, prNumbers: [] });
    assert.deepEqual(await previewMediaReader.project([source]), [{ previews: [] }]);
  }
  assert.deepEqual(await previewMediaReader.project([]), []);
  assert.deepEqual(await projectNotificationPreviews([]), []);
});

test('generic task lists exclude native goal backing tasks', async () => {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await database.schema.createTable('tasks', table => {
      table.string('task_id'); table.string('repository'); table.string('task_type');
      table.timestamp('created_at'); table.text('initial_job_data'); table.text('final_result');
      table.integer('issue_number'); table.integer('pr_number');
    });
    await database.schema.createTable('task_history', table => {
      table.increments('history_id'); table.string('task_id'); table.string('state'); table.timestamp('timestamp'); table.text('reason'); table.text('metadata');
    });
    await database.schema.createTable('plan_issues', table => {
      table.increments('id'); table.string('task_id'); table.string('status');
    });
    await database.schema.createTable('llm_executions', table => {
      table.increments('execution_id'); table.string('task_id'); table.text('analysis_report');
    });
    const now = new Date().toISOString();
    await database('tasks').insert([
      { task_id: 'ordinary-task', repository: 'acme/widget', task_type: 'issue', created_at: now },
      { task_id: 'legacy-task', repository: 'acme/widget', task_type: null, created_at: now },
      { task_id: 'goal-task', repository: 'acme/widget', task_type: 'goal', created_at: now },
    ]);
    await database('task_history').insert([
      { task_id: 'ordinary-task', state: 'processing', timestamp: now },
      { task_id: 'legacy-task', state: 'processing', timestamp: now },
      { task_id: 'goal-task', state: 'processing', timestamp: now },
    ]);

    const taskListSql: string[] = [];
    database.on('query', query => { taskListSql.push(query.sql); });

    const result = await getTasksFromDb({
      db: database, status: 'all', repository: 'all', limit: 100, offset: 0,
    });
    assert.equal(result.total, 2);
    assert.deepEqual(new Set((result.tasks as Array<{ id: string }>).map(task => task.id)), new Set(['ordinary-task', 'legacy-task']));
    assert.equal(taskListSql.length, 6);
    assert.match(taskListSql[0], /count\(\*\)/i);
    assert.doesNotMatch(taskListSql[0], /processing_start_timestamp|completion_timestamp|critique_score/i);
    assert.doesNotMatch(taskListSql[1], /processing_start_timestamp|completion_timestamp|critique_score/i);
    assert.match(taskListSql[2], /processing_start_timestamp/i);
    assert.match(taskListSql[4], /analysis_report/i);
    assert.match(taskListSql[5], /metadata. like/i);
  } finally {
    await database.destroy();
  }
});

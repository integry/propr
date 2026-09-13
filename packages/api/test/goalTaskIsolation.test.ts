import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import { closeConnection } from '@propr/core';
import { getTasksFromDb } from '../routes/taskHelpers.js';

// Task preview projection also initializes the shared core database connection.
after(closeConnection);

test('generic task lists exclude native goal backing tasks', async () => {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await database.schema.createTable('tasks', table => {
      table.string('task_id'); table.string('repository'); table.string('task_type');
      table.timestamp('created_at'); table.text('initial_job_data'); table.text('final_result');
      table.integer('issue_number'); table.integer('pr_number');
    });
    await database.schema.createTable('task_history', table => {
      table.string('task_id'); table.string('state'); table.timestamp('timestamp'); table.text('reason');
    });
    await database.schema.createTable('plan_issues', table => {
      table.string('task_id'); table.string('status');
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
    assert.equal(taskListSql.length, 2);
    assert.match(taskListSql[0], /count\(\*\)/i);
    assert.doesNotMatch(taskListSql[0], /processing_start_timestamp|completion_timestamp|critique_score/i);
    assert.match(taskListSql[1], /processing_start_timestamp/i);
    assert.match(taskListSql[1], /critique_score/i);
  } finally {
    await database.destroy();
  }
});

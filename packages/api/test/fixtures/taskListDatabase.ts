import { afterEach } from 'node:test';
import knex, { Knex } from 'knex';

const databases: Knex[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => database.destroy()));
});

export async function createTaskListTestDatabase(): Promise<Knex> {
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
  await database.schema.createTable('notification_pull_request_state', table => {
    table.text('repository').notNullable();
    table.integer('pr_number').notNullable();
    table.text('merged_at').nullable();
    table.primary(['repository', 'pr_number']);
  });
  await database.schema.createTable('llm_executions', table => {
    table.increments('execution_id').primary();
    table.string('task_id');
    table.text('analysis_report');
    table.string('model_name');
    table.timestamp('start_time');
    table.index('task_id');
  });
  await database.schema.createTable('task_assignees', table => {
    table.string('task_id');
    table.string('github_user_id');
  });
  await database.schema.createTable('github_user_profiles', table => {
    table.string('github_user_id').primary();
    table.string('login');
    table.string('display_name');
    table.text('avatar_url');
  });
  return database;
}

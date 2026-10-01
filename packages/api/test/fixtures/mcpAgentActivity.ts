import knex from 'knex';

/**
 * Goal activity database for get_agent_activity: one direct and one
 * orchestrated goal, each with a running goal task and no recorded output.
 */

export const directGoalId = '11111111-1111-4111-8111-111111111111';
export const orchestratedGoalId = '22222222-2222-4222-8222-222222222222';
export const repository = 'acme/repo';

export async function createActivityDatabase() {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('tasks', table => {
    table.string('task_id').primary();
    table.string('repository').notNullable();
    table.string('task_type').notNullable();
    table.timestamp('created_at');
  });
  await db.schema.createTable('goals', table => {
    table.string('goal_id').primary();
    table.string('owner_id').notNullable();
    table.string('repository').notNullable();
    table.string('current_task_id').notNullable();
    table.string('launch_strategy').notNullable();
    table.string('session_id');
    table.timestamp('started_at');
    table.timestamp('updated_at');
    table.timestamp('created_at');
  });
  await db.schema.createTable('task_history', table => {
    table.increments('history_id').primary();
    table.string('task_id').notNullable();
    table.string('state').notNullable();
    table.timestamp('timestamp');
    table.text('metadata');
  });
  await db.schema.createTable('llm_executions', table => {
    table.string('execution_id').primary();
    table.string('task_id');
    table.string('session_id');
    table.timestamp('start_time');
    table.integer('input_tokens');
    table.integer('output_tokens');
    table.integer('cache_creation_input_tokens');
    table.integer('cache_read_input_tokens');
  });
  await db.schema.createTable('llm_execution_details', table => {
    table.increments('detail_id').primary();
    table.string('execution_id');
    table.integer('sequence_number');
    table.string('event_type');
    table.timestamp('event_timestamp');
    table.text('content');
    table.boolean('is_error');
    table.string('tool_name');
    table.text('tool_input');
    table.text('metadata');
  });
  const createdAt = '2026-09-13T10:00:00.000Z';
  await db('tasks').insert([
    { task_id: 'goal-task-direct', repository, task_type: 'goal', created_at: createdAt },
    { task_id: 'goal-task-orchestrated', repository, task_type: 'goal', created_at: createdAt },
  ]);
  await db('goals').insert([
    { goal_id: directGoalId, owner_id: 'owner-1', repository, current_task_id: 'goal-task-direct', launch_strategy: 'direct', started_at: createdAt, updated_at: createdAt, created_at: createdAt },
    { goal_id: orchestratedGoalId, owner_id: 'owner-1', repository, current_task_id: 'goal-task-orchestrated', launch_strategy: 'orchestrate', started_at: createdAt, updated_at: createdAt, created_at: createdAt },
  ]);
  await db('task_history').insert([
    { task_id: 'goal-task-direct', state: 'codex_execution', timestamp: createdAt },
    { task_id: 'goal-task-orchestrated', state: 'claude_execution', timestamp: createdAt },
  ]);
  return db;
}

/**
 * Initial SQLite schema migration
 * This creates all tables from scratch for SQLite compatibility
 */
export async function up(knex) {
  // Tasks table
  await knex.schema.createTable('tasks', (table) => {
    table.string('task_id', 255).primary();
    table.string('job_id', 255).unique();
    table.string('correlation_id', 36);
    table.string('repository', 255).notNullable();
    table.integer('issue_number');
    table.string('task_type', 50).notNullable();
    table.string('model_name', 100);
    table.timestamp('created_at').defaultTo(knex.fn.now()).notNullable();
    table.json('initial_job_data');

    table.index('repository');
    table.index('issue_number');
    table.index('created_at');
    table.index('model_name');
    table.index('correlation_id');
    table.index('task_type');
  });

  // Task history table
  await knex.schema.createTable('task_history', (table) => {
    table.increments('history_id').primary();
    table.string('task_id', 255).notNullable();
    table.string('state', 50).notNullable();
    table.timestamp('timestamp').defaultTo(knex.fn.now()).notNullable();
    table.text('reason');
    table.json('metadata');

    table.foreign('task_id')
      .references('task_id')
      .inTable('tasks')
      .onDelete('CASCADE');

    table.index('task_id');
    table.index('state');
    table.index('timestamp');
  });

  // LLM executions table
  await knex.schema.createTable('llm_executions', (table) => {
    table.increments('execution_id').primary();
    table.string('task_id', 255).notNullable();
    table.integer('history_id').nullable();
    table.string('session_id', 255);
    table.string('conversation_id', 255);
    table.timestamp('start_time').notNullable();
    table.timestamp('end_time');
    table.integer('duration_ms');
    table.string('model_name', 100).notNullable();
    table.boolean('success').notNullable();
    table.integer('num_turns');
    table.decimal('cost_usd', 10, 6);
    table.text('error_message');
    table.integer('prompt_length');
    table.integer('output_length');
    table.json('analysis_report');

    table.foreign('task_id')
      .references('task_id')
      .inTable('tasks')
      .onDelete('CASCADE');

    table.foreign('history_id')
      .references('history_id')
      .inTable('task_history')
      .onDelete('SET NULL');

    table.index('task_id');
    table.index('model_name');
    table.index('start_time');
    table.index('success');
    table.index('session_id');
    table.index('conversation_id');
  });

  // LLM execution details table
  await knex.schema.createTable('llm_execution_details', (table) => {
    table.increments('detail_id').primary();
    table.integer('execution_id').notNullable();
    table.integer('sequence_number').notNullable();
    table.timestamp('event_timestamp').defaultTo(knex.fn.now()).notNullable();
    table.string('event_type', 50).notNullable();
    table.text('content');
    table.integer('duration_ms');
    table.integer('token_count_input');
    table.integer('token_count_output');
    table.decimal('cost_usd', 10, 8);
    table.boolean('is_error').defaultTo(false);
    table.string('tool_name', 100);
    table.json('tool_input');
    table.string('tool_use_id', 100);
    table.json('metadata');

    table.foreign('execution_id')
      .references('execution_id')
      .inTable('llm_executions')
      .onDelete('CASCADE');

    table.unique(['execution_id', 'sequence_number']);

    table.index('execution_id');
    table.index('event_type');
    table.index('event_timestamp');
    table.index('tool_name');
    table.index('is_error');
  });

  // Task drafts table
  await knex.schema.createTable('task_drafts', (table) => {
    table.uuid('draft_id').primary();
    table.string('user_id', 255).notNullable();
    table.string('repository', 255).notNullable();
    table.string('name', 255).defaultTo('Untitled Plan');
    table.text('initial_prompt');
    table.json('plan_json').defaultTo('[]');
    table.json('context_config').defaultTo('{}');
    table.string('status', 255).defaultTo('draft');
    table.timestamp('created_at').defaultTo(knex.fn.now()).notNullable();
    table.timestamp('updated_at').defaultTo(knex.fn.now()).notNullable();
    table.json('attachments').defaultTo('[]');
    table.json('generation_trace').defaultTo('{}');
    table.json('chat_history').defaultTo('[]');
    table.text('generated_context');

    table.index('user_id');
    table.index('repository');
    table.index('updated_at');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('llm_execution_details');
  await knex.schema.dropTableIfExists('llm_executions');
  await knex.schema.dropTableIfExists('task_history');
  await knex.schema.dropTableIfExists('task_drafts');
  await knex.schema.dropTableIfExists('tasks');
}

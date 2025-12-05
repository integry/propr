export async function up(knex) {
  await knex.schema.createTable('tasks', (table) => {
    table.string('task_id', 255).primary();
    table.string('job_id', 255).unique();
    table.string('correlation_id', 36).unique();
    table.string('repository', 255).notNullable();
    table.integer('issue_number');
    table.string('task_type', 50).notNullable();
    table.string('model_name', 100);
    table.timestamp('created_at').defaultTo(knex.fn.now()).notNullable();
    table.jsonb('initial_job_data');

    table.index('repository', 'idx_tasks_repository');
    table.index('issue_number', 'idx_tasks_issue_number');
    table.index('created_at', 'idx_tasks_created_at');
    table.index('model_name', 'idx_tasks_model_name');
    table.index('correlation_id', 'idx_tasks_correlation_id');
    table.index('task_type', 'idx_tasks_task_type');
  });

  await knex.schema.createTable('task_history', (table) => {
    table.increments('history_id').primary();
    table.string('task_id', 255).notNullable();
    table.string('state', 50).notNullable();
    table.timestamp('timestamp').defaultTo(knex.fn.now()).notNullable();
    table.text('reason');
    table.jsonb('metadata');

    table.foreign('task_id')
      .references('task_id')
      .inTable('tasks')
      .onDelete('CASCADE');

    table.index('task_id', 'idx_task_history_task_id');
    table.index('state', 'idx_task_history_state');
    table.index('timestamp', 'idx_task_history_timestamp');
  });

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

    table.foreign('task_id')
      .references('task_id')
      .inTable('tasks')
      .onDelete('CASCADE');

    table.foreign('history_id')
      .references('history_id')
      .inTable('task_history')
      .onDelete('SET NULL');

    table.index('task_id', 'idx_llm_executions_task_id');
    table.index('model_name', 'idx_llm_executions_model_name');
    table.index('start_time', 'idx_llm_executions_start_time');
    table.index('success', 'idx_llm_executions_success');
    table.index('session_id', 'idx_llm_executions_session_id');
    table.index('conversation_id', 'idx_llm_executions_conversation_id');
  });

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
    table.jsonb('tool_input');
    table.string('tool_use_id', 100);
    table.jsonb('metadata');

    table.foreign('execution_id')
      .references('execution_id')
      .inTable('llm_executions')
      .onDelete('CASCADE');

    table.unique(['execution_id', 'sequence_number'], 'llm_execution_details_sequence_unique');

    table.index('execution_id', 'idx_llm_execution_details_execution_id');
    table.index('event_type', 'idx_llm_execution_details_event_type');
    table.index('event_timestamp', 'idx_llm_execution_details_timestamp');
  });

  await knex.raw(`
    CREATE INDEX idx_llm_execution_details_tool_name
    ON llm_execution_details (tool_name)
    WHERE tool_name IS NOT NULL
  `);

  await knex.raw(`
    CREATE INDEX idx_llm_execution_details_is_error
    ON llm_execution_details (is_error)
  `);

  await knex.raw(`
    CREATE INDEX idx_llm_execution_details_tool_use_id
    ON llm_execution_details (tool_use_id)
    WHERE tool_use_id IS NOT NULL
  `);
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('llm_execution_details');
  await knex.schema.dropTableIfExists('llm_executions');
  await knex.schema.dropTableIfExists('task_history');
  await knex.schema.dropTableIfExists('tasks');
}

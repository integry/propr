/**
 * Durable storage for saved agent definitions and their runs.
 *
 * An agent run executes as an ordinary isolated task run, so `agent_runs` is a
 * thin receipt: it links the definition, the trigger and the produced report to
 * the underlying task ids (`report_task_id`, `action_task_id`) and never
 * duplicates task execution state. JSON columns are stored as text. Timestamps
 * are epoch milliseconds, like `epic_execution_queues` and `mcp_operations`.
 *
 * `next_run_at` is null unless the definition is enabled, scheduled and has a
 * cron expression, so the `(schedule_enabled, enabled, next_run_at)` sweep
 * index only covers definitions the scheduler can fire.
 */

export async function up(knex) {
  await knex.schema.createTable('agent_definitions', table => {
    table.uuid('id').primary();
    table.string('owner_id').notNullable();
    table.string('name').notNullable();
    table.text('description');
    table.text('repositories').notNullable().defaultTo('[]');
    table.text('prompt').notNullable();
    table.text('attachments').notNullable().defaultTo('[]');
    table.string('agent_alias');
    table.string('model_name');
    table.text('capabilities').notNullable().defaultTo('[]');
    table.boolean('include_previous_reports').notNullable().defaultTo(true);
    table.integer('previous_reports_limit').notNullable().defaultTo(1);
    table.string('schedule_cron');
    table.string('schedule_timezone').notNullable().defaultTo('UTC');
    table.boolean('schedule_enabled').notNullable().defaultTo(false);
    table.bigInteger('next_run_at');
    table.string('autonomy_mode', 20).notNullable();
    table.boolean('enabled').notNullable().defaultTo(true);
    table.integer('revision').notNullable().defaultTo(0);
    table.bigInteger('created_at').notNullable();
    table.bigInteger('updated_at').notNullable();

    table.index(['owner_id', 'updated_at']);
    table.index(['schedule_enabled', 'enabled', 'next_run_at']);
  });

  await knex.schema.createTable('agent_runs', table => {
    table.uuid('id').primary();
    table.uuid('definition_id').notNullable().references('id').inTable('agent_definitions').onDelete('CASCADE');
    table.string('owner_id').notNullable();
    table.string('trigger', 20).notNullable();
    table.string('trigger_source');
    table.string('idempotency_key');
    table.string('state', 32).notNullable();
    table.string('autonomy_mode', 20).notNullable();
    table.text('definition_snapshot').notNullable();
    table.string('report_task_id');
    table.string('action_task_id');
    table.text('report');
    table.boolean('report_truncated').notNullable().defaultTo(false);
    table.text('action_summary');
    table.text('skip_reason');
    table.text('failure_reason');
    table.string('approved_by');
    table.bigInteger('deferred_until');
    table.integer('deferrals').notNullable().defaultTo(0);
    table.bigInteger('created_at').notNullable();
    table.bigInteger('started_at');
    table.bigInteger('reported_at');
    table.bigInteger('finished_at');
    table.bigInteger('updated_at').notNullable();

    table.unique(['definition_id', 'idempotency_key']);
    table.index(['definition_id', 'created_at']);
    table.index(['owner_id', 'state']);
    table.index(['state', 'deferred_until']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('agent_runs');
  await knex.schema.dropTableIfExists('agent_definitions');
}

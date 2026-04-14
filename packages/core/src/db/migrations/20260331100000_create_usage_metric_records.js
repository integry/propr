/**
 * Migration to create usage_metric_records table for structured usage tracking.
 *
 * Each LLM call may produce multiple metric records — one per metric key.
 * This enables easy DB querying and report generation by storing individual
 * key => value pairs rather than a monolithic JSON blob.
 *
 * Example rows for a single LLM call:
 *   | llm_log_id | agent_name | metric_key  | metric_value |
 *   |------------|------------|-------------|--------------|
 *   | 42         | claude     | session     | 0.05         |
 *   | 42         | claude     | weeklyAll   | 0.01         |
 */
export async function up(knex) {
  await knex.schema.createTable('usage_metric_records', (table) => {
    table.increments('id').primary();
    table.integer('llm_log_id').notNullable()
      .references('log_id').inTable('llm_logs')
      .onDelete('CASCADE');
    table.text('agent_name').notNullable();
    table.text('metric_key').notNullable();
    table.decimal('metric_value', 10, 6).notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());

    // Indexes for common queries
    table.index('llm_log_id');
    table.index('agent_name');
    table.index('metric_key');
    table.index(['agent_name', 'metric_key']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('usage_metric_records');
}

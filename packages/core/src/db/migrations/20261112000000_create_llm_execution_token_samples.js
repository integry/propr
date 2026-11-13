// One row per recorded agent execution, keyed like the token-outlier baseline:
// repository (lowercased), model and execution type. The composite index lets
// the baseline (the last N successful executions for that key) be read with an
// index range scan, so recording an execution stays fast. `alerted_at` marks
// the execution that raised a token-outlier alert, for per-task deduplication
// and the optional automation pause (alerts per repository within a window).
const TABLE = 'llm_execution_token_samples';

export async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, table => {
    table.integer('execution_id').primary();
    table.string('task_id', 255).nullable();
    table.string('repository', 255).notNullable();
    table.string('model_name', 100).notNullable();
    table.string('execution_type', 64).notNullable();
    table.boolean('success').notNullable();
    table.bigInteger('total_tokens').notNullable();
    table.timestamp('recorded_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('alerted_at').nullable();

    table.foreign('execution_id').references('execution_id').inTable('llm_executions').onDelete('CASCADE');
    table.index(['repository', 'model_name', 'execution_type', 'success', 'execution_id'], 'llm_token_samples_baseline_idx');
    table.index(['repository', 'alerted_at'], 'llm_token_samples_repository_alerts_idx');
    table.index(['task_id', 'alerted_at'], 'llm_token_samples_task_alerts_idx');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
}

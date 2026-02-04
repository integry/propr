/**
 * Migration to add token usage columns to llm_executions table.
 * This stores input_tokens, output_tokens, cache_creation_input_tokens,
 * and cache_read_input_tokens for detailed token usage tracking.
 */
export async function up(knex) {
  await knex.schema.alterTable('llm_executions', (table) => {
    table.integer('input_tokens').nullable();
    table.integer('output_tokens').nullable();
    table.integer('cache_creation_input_tokens').nullable();
    table.integer('cache_read_input_tokens').nullable();
  });
}

export async function down(knex) {
  await knex.schema.alterTable('llm_executions', (table) => {
    table.dropColumn('input_tokens');
    table.dropColumn('output_tokens');
    table.dropColumn('cache_creation_input_tokens');
    table.dropColumn('cache_read_input_tokens');
  });
}

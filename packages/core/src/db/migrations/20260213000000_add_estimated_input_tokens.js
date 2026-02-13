/**
 * Migration to add estimated_input_tokens column to llm_logs table.
 *
 * This field stores our calculated token count from the prompt (using tiktoken),
 * which is reliable for single-turn operations and useful for duration estimation.
 *
 * The existing input_tokens field stores the agent-reported token usage,
 * which may be cumulative across multiple internal turns/retries.
 */
export async function up(knex) {
  await knex.schema.alterTable('llm_logs', (table) => {
    table.integer('estimated_input_tokens').nullable();
  });
}

export async function down(knex) {
  await knex.schema.alterTable('llm_logs', (table) => {
    table.dropColumn('estimated_input_tokens');
  });
}

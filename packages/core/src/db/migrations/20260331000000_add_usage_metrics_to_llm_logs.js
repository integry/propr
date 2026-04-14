/**
 * Migration to add usage_metrics JSON column to llm_logs table.
 *
 * Stores LLM usage values (pre-call, post-call, and delta) to track
 * how much allowance each call consumed for subscription billing models.
 */
export async function up(knex) {
  await knex.schema.alterTable('llm_logs', (table) => {
    table.json('usage_metrics').nullable();
  });
}

export async function down(knex) {
  await knex.schema.alterTable('llm_logs', (table) => {
    table.dropColumn('usage_metrics');
  });
}

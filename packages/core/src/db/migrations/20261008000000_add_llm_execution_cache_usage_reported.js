// Whether an execution's agent reported a prompt-cache breakdown. Before this
// column, `recordLLMMetrics` stored a zero cache count for an agent that never
// reported one, so a historical zero cannot tell "no cache reads" from "no
// cache telemetry". New rows record the answer here; historical rows stay null
// and are judged by whether they show any cache activity at all.
export async function up(knex) {
  if (await knex.schema.hasColumn('llm_executions', 'cache_usage_reported')) return;
  await knex.schema.alterTable('llm_executions', table => {
    table.boolean('cache_usage_reported').nullable();
  });
}

export async function down(knex) {
  if (!(await knex.schema.hasColumn('llm_executions', 'cache_usage_reported'))) return;
  await knex.schema.alterTable('llm_executions', table => {
    table.dropColumn('cache_usage_reported');
  });
}

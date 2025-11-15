export async function up(knex) {
  await knex.schema.table('llm_executions', (table) => {
    table.jsonb('deep_dive_analysis_report');
  });

  await knex.raw(`
    CREATE INDEX idx_llm_executions_deep_dive_analysis 
    ON llm_executions USING gin (deep_dive_analysis_report)
  `);
}

export async function down(knex) {
  await knex.schema.table('llm_executions', (table) => {
    table.dropIndex('deep_dive_analysis_report', 'idx_llm_executions_deep_dive_analysis');
    table.dropColumn('deep_dive_analysis_report');
  });
}

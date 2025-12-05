export async function up(knex) {
  await knex.schema.table('llm_executions', (table) => {
    table.jsonb('analysis_report');
  });

  await knex.raw(`
    CREATE INDEX idx_llm_executions_analysis_report
    ON llm_executions USING gin (analysis_report)
  `);
}

export async function down(knex) {
  await knex.schema.table('llm_executions', (table) => {
    table.dropIndex('analysis_report', 'idx_llm_executions_analysis_report');
    table.dropColumn('analysis_report');
  });
}

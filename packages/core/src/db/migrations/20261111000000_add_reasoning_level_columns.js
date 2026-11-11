// The effective reasoning level (effort) behind each agent execution, and behind
// the implementation a review score judges, so cost and quality can be reported
// by effort. Historical rows stay null: their level was never recorded here.
const COLUMNS = [
  ['llm_executions', 'reasoning_level'],
  ['review_scores', 'implementer_reasoning_level'],
];

export async function up(knex) {
  for (const [tableName, column] of COLUMNS) {
    if (!(await knex.schema.hasTable(tableName)) || await knex.schema.hasColumn(tableName, column)) continue;
    await knex.schema.alterTable(tableName, table => {
      table.string(column, 32).nullable();
    });
  }
}

export async function down(knex) {
  for (const [tableName, column] of COLUMNS) {
    if (!(await knex.schema.hasTable(tableName)) || !(await knex.schema.hasColumn(tableName, column))) continue;
    await knex.schema.alterTable(tableName, table => {
      table.dropColumn(column);
    });
  }
}

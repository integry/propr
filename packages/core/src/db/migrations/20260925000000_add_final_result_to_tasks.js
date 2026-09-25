/**
 * Add the task result payload consumed by dashboard and preview projections.
 *
 * Older SQLite databases predate these projections and do not have the column,
 * so selecting it causes the affected API routes to fail before their fallback
 * logic can run.
 */
export async function up(knex) {
  await knex.schema.alterTable('tasks', (table) => {
    table.json('final_result').nullable();
  });
}

export async function down(knex) {
  await knex.schema.alterTable('tasks', (table) => {
    table.dropColumn('final_result');
  });
}

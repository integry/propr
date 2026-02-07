/**
 * Add refinement_result column to task_drafts table
 * This stores the structured result from plan refinement including action type and summary
 */
export async function up(knex) {
  await knex.schema.alterTable('task_drafts', (table) => {
    table.json('refinement_result').defaultTo(null);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('task_drafts', (table) => {
    table.dropColumn('refinement_result');
  });
}

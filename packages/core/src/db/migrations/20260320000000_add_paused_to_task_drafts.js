/**
 * Migration to add paused column to task_drafts table.
 * This allows pausing plan execution so the next task doesn't start
 * until the plan is resumed.
 */
export async function up(knex) {
  await knex.schema.alterTable('task_drafts', (table) => {
    table.boolean('paused').defaultTo(false).notNullable();
    table.timestamp('paused_at').nullable();
  });
}

export async function down(knex) {
  await knex.schema.alterTable('task_drafts', (table) => {
    table.dropColumn('paused');
    table.dropColumn('paused_at');
  });
}

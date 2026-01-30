/**
 * Migration to add task_id column to plan_issues table.
 * This allows tracking which task execution is associated with a plan issue,
 * enabling users to view implementation progress for in-progress tasks.
 */
export async function up(knex) {
  await knex.schema.alterTable('plan_issues', (table) => {
    table.uuid('task_id').nullable();
    table.index('task_id');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('plan_issues', (table) => {
    table.dropIndex('task_id');
    table.dropColumn('task_id');
  });
}

/**
 * Migration to add pr_number column to tasks table.
 * This stores the pull request number created by a task, enabling easy querying
 * and grouping of tasks by PR without needing to parse JSON job data.
 */
export async function up(knex) {
  await knex.schema.alterTable('tasks', (table) => {
    table.integer('pr_number').nullable();
    table.index('pr_number');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('tasks', (table) => {
    table.dropIndex('pr_number');
    table.dropColumn('pr_number');
  });
}

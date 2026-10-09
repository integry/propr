// Receipt that a submission's to-dos were completed and linked to its issue.
// It commits with that to-do update, so replays of the same submission never
// reapply it over a later reopen or relaunch, while a failed update stays retryable.
export async function up(knex) {
  if (await knex.schema.hasColumn('task_submissions', 'todos_linked')) return;
  await knex.schema.alterTable('task_submissions', table => {
    table.boolean('todos_linked').notNullable().defaultTo(false);
  });
}

export async function down(knex) {
  if (!(await knex.schema.hasColumn('task_submissions', 'todos_linked'))) return;
  await knex.schema.alterTable('task_submissions', table => { table.dropColumn('todos_linked'); });
}

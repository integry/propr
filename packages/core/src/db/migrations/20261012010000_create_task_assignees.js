/**
 * Local projection of the GitHub assignees of the issue or pull request a task
 * is assigned through.
 *
 * GitHub is the source of truth for task assignment; this table only lets the
 * task list render and filter assignees without one GitHub call per row. It
 * stores the stable numeric user id (rendered through `github_user_profiles`)
 * and is replaced as a whole whenever GitHub's assignee set is observed.
 * `synced_at` records when that set was last confirmed against GitHub.
 *
 * There is deliberately no foreign key to `tasks`: task deletion removes rows
 * table by table inside a transaction, and a cascade would change that.
 * The `github_user_id` index backs the "assigned to me" filter.
 */
export async function up(knex) {
  await knex.schema.createTable('task_assignees', table => {
    table.string('task_id', 255).notNullable();
    table.string('github_user_id', 64).notNullable();
    table.text('synced_at').notNullable();
    table.text('created_at').notNullable();

    table.primary(['task_id', 'github_user_id']);
    table.index(['github_user_id'], 'task_assignees_github_user_id_index');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('task_assignees');
}

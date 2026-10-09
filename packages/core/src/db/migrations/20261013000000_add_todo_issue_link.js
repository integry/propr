// Records the GitHub issue a to-do produced when a task was launched from it,
// mirroring how linked_draft_id records the plan a to-do was turned into.
export async function up(knex) {
  if (await knex.schema.hasColumn('repo_todos', 'linked_issue_number')) return;
  await knex.schema.alterTable('repo_todos', table => {
    table.text('linked_issue_repository').nullable(); // owner/repo the issue was opened in
    table.integer('linked_issue_number').nullable();
    table.text('linked_task_id').nullable(); // Task started for the issue, when already known
    table.index(['linked_issue_repository', 'linked_issue_number'], 'repo_todos_linked_issue_index');
  });
}

export async function down(knex) {
  if (!(await knex.schema.hasColumn('repo_todos', 'linked_issue_number'))) return;
  await knex.schema.alterTable('repo_todos', table => {
    table.dropIndex(['linked_issue_repository', 'linked_issue_number'], 'repo_todos_linked_issue_index');
  });
  await knex.schema.alterTable('repo_todos', table => {
    table.dropColumn('linked_issue_repository');
    table.dropColumn('linked_issue_number');
    table.dropColumn('linked_task_id');
  });
}

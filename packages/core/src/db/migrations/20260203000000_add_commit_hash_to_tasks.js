/**
 * Migration to add commit_hash column to tasks table.
 * This stores the git commit hash when a task completes successfully,
 * enabling historic diff exploration even after the worktree is deleted.
 */
export async function up(knex) {
  await knex.schema.alterTable('tasks', (table) => {
    table.string('commit_hash', 64).nullable();
    table.index('commit_hash');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('tasks', (table) => {
    table.dropIndex('commit_hash');
    table.dropColumn('commit_hash');
  });
}

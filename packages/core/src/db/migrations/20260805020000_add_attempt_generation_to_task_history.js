/** Records the task generation and Redis state version on append-only history rows. */
export async function up(knex) {
  await knex.schema.alterTable('task_history', (table) => {
    table.string('attempt_generation', 64).nullable();
    table.bigInteger('task_version').nullable();
    table.index(
      ['task_id', 'attempt_generation', 'task_version'],
      'task_history_generation_version_idx',
    );
  });
}

export async function down(knex) {
  await knex.schema.alterTable('task_history', (table) => {
    table.dropIndex(
      ['task_id', 'attempt_generation', 'task_version'],
      'task_history_generation_version_idx',
    );
    table.dropColumn('task_version');
    table.dropColumn('attempt_generation');
  });
}

/**
 * Support latest-history and page-scoped history lookups without sorting each
 * task's history. The composite index also covers task_id-only lookups, so the
 * original single-column index would be redundant write amplification.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE INDEX task_history_task_id_timestamp_index
    ON task_history(task_id, timestamp DESC)
  `);
  await knex.raw('DROP INDEX task_history_task_id_index');
}

export async function down(knex) {
  await knex.raw(`
    CREATE INDEX task_history_task_id_index
    ON task_history(task_id)
  `);
  await knex.raw('DROP INDEX task_history_task_id_timestamp_index');
}

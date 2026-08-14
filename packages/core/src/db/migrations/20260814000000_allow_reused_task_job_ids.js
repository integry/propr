/**
 * BullMQ issue job IDs are deterministic deduplication keys and may be reused
 * after a completed/failed job is removed. Keep them searchable without
 * requiring one database task execution per queue identity.
 */
export async function up(knex) {
  await knex.schema.alterTable('tasks', table => {
    table.dropUnique(['job_id']);
    table.index(['job_id']);
  });
}

export async function down(knex) {
  // Rolling back restores the former one-task-per-job constraint. Preserve the
  // earliest task association deterministically and detach only later reused
  // associations; task and task_history rows remain intact.
  await knex.raw(`
    WITH ranked_job_associations AS (
      SELECT task_id,
        ROW_NUMBER() OVER (
          PARTITION BY job_id
          ORDER BY created_at ASC, task_id ASC
        ) AS association_rank
      FROM tasks
      WHERE job_id IS NOT NULL
    )
    UPDATE tasks
    SET job_id = NULL
    WHERE task_id IN (
      SELECT task_id
      FROM ranked_job_associations
      WHERE association_rank > 1
    )
  `);

  await knex.schema.alterTable('tasks', table => {
    table.dropIndex(['job_id']);
    table.unique(['job_id']);
  });
}

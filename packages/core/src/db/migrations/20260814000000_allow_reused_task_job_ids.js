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
  await knex.schema.alterTable('tasks', table => {
    table.dropIndex(['job_id']);
    table.unique(['job_id']);
  });
}

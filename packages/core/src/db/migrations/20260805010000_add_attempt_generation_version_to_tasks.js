/**
 * Redis assigns this revision while atomically acquiring an attempt's task
 * state slot. SQL creation upserts use it as a monotonic generation fence.
 */
export async function up(knex) {
  await knex.schema.alterTable('tasks', (table) => {
    table.bigInteger('attempt_generation_version').nullable();
  });
}

export async function down(knex) {
  await knex.schema.alterTable('tasks', (table) => {
    table.dropColumn('attempt_generation_version');
  });
}

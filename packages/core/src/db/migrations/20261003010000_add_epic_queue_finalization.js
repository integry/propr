export async function up(knex) {
  await knex.schema.alterTable('epic_execution_queues', table => {
    table.bigInteger('finalized_at').nullable();
    table.bigInteger('finalization_started_at').nullable();
  });
}

export async function down(knex) {
  await knex.schema.alterTable('epic_execution_queues', table => {
    table.dropColumn('finalized_at');
    table.dropColumn('finalization_started_at');
  });
}

export async function up(knex) {
  await knex.schema.alterTable('epic_execution_queues', table => {
    table.text('head_selection').nullable();
    table.boolean('owes_epic_finalization').notNullable().defaultTo(false);
  });
  await knex('epic_execution_queues').where({ use_epic: true }).whereNull('finalized_at')
    .update({ owes_epic_finalization: true });
}

export async function down(knex) {
  await knex.schema.alterTable('epic_execution_queues', table => {
    table.dropColumn('head_selection');
    table.dropColumn('owes_epic_finalization');
  });
}

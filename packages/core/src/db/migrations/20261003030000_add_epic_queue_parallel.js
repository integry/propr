export async function up(knex) {
  await knex.schema.alterTable('epic_execution_queues', table => {
    table.boolean('parallel').notNullable().defaultTo(false);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('epic_execution_queues', table => {
    table.dropColumn('parallel');
  });
}

export async function up(knex) {
  await knex.schema.alterTable('epic_execution_queues', table => {
    table.boolean('use_epic').notNullable().defaultTo(true);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('epic_execution_queues', table => {
    table.dropColumn('use_epic');
  });
}

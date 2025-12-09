export async function up(knex) {
  await knex.schema.alterTable('task_drafts', (table) => {
    table.jsonb('generation_trace').defaultTo('{}');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('task_drafts', (table) => {
    table.dropColumn('generation_trace');
  });
}

export async function up(knex) {
  await knex.schema.alterTable('task_drafts', (table) => {
    table.jsonb('attachments').defaultTo('[]');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('task_drafts', (table) => {
    table.dropColumn('attachments');
  });
}

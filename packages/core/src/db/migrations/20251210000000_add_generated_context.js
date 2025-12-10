export async function up(knex) {
  await knex.schema.alterTable('task_drafts', (table) => {
    table.text('generated_context');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('task_drafts', (table) => {
    table.dropColumn('generated_context');
  });
}

/** Persist files shared with the initial goal and later same-session inputs. */
export async function up(knex) {
  await knex.schema.alterTable('goals', table => {
    table.json('attachments').notNullable().defaultTo('[]');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('goals', table => {
    table.dropColumn('attachments');
  });
}

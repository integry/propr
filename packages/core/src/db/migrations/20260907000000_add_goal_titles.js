/** Store a concise presentation title separately from the user's full goal objective. */
export async function up(knex) {
  await knex.schema.alterTable('goals', table => {
    table.text('title');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('goals', table => {
    table.dropColumn('title');
  });
}

/**
 * Distinguish one-off direct tasks from long-running goals. Both use the same
 * goal execution machinery; the kind controls presentation and the stopping rule.
 */
export async function up(knex) {
  await knex.schema.alterTable('goals', table => {
    table.string('kind', 20).notNullable().defaultTo('goal');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('goals', table => {
    table.dropColumn('kind');
  });
}

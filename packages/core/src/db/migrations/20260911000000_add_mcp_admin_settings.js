export async function up(knex) {
  await knex.schema.createTable('mcp_admin_settings', table => {
    table.string('key', 64).notNullable().primary();
    table.text('value').notNullable();
    table.bigInteger('updated_at').notNullable();
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('mcp_admin_settings');
}

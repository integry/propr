/**
 * Add system_configs table for storing application configuration
 * This migrates configuration from the git-based system to local SQLite database
 */
export async function up(knex) {
  await knex.schema.createTable('system_configs', (table) => {
    table.string('key', 255).primary();
    table.json('value').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now()).notNullable();
    table.timestamp('updated_at').defaultTo(knex.fn.now()).notNullable();
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('system_configs');
}

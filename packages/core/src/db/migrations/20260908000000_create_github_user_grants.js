/**
 * Stores refreshable GitHub user grants for server-side use by desktop sessions.
 * Token material is encrypted by the application before it reaches SQLite.
 */
export async function up(knex) {
  await knex.schema.createTable('github_user_grants', table => {
    table.text('github_user_id').primary();
    table.text('github_username').notNullable();
    table.string('source', 32).notNullable();
    table.text('access_token_encrypted').notNullable();
    table.text('refresh_token_encrypted').nullable();
    table.bigInteger('access_token_expires_at_ms').nullable();
    table.bigInteger('refresh_token_expires_at_ms').nullable();
    table.string('status', 32).notNullable().defaultTo('active');
    table.string('last_error_code', 64).nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now()).notNullable();
    table.timestamp('updated_at').defaultTo(knex.fn.now()).notNullable();
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('github_user_grants');
}

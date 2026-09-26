/**
 * Stores the single GitHub user credential used for visual-preview uploads.
 * Token material is encrypted by the application before it reaches SQLite.
 */
export async function up(knex) {
  await knex.schema.createTable('visual_preview_oauth_credentials', table => {
    table.integer('id').primary();
    table.string('github_user_id', 255).notNullable();
    table.string('github_username', 255).notNullable();
    table.string('source', 32).notNullable();
    table.text('access_token_encrypted').notNullable();
    table.text('refresh_token_encrypted').nullable();
    table.bigInteger('access_token_expires_at_ms').nullable();
    table.bigInteger('refresh_token_expires_at_ms').nullable();
    table.string('status', 32).notNullable().defaultTo('active');
    table.string('last_error_code', 64).nullable();
    table.bigInteger('refresh_lease_until_ms').nullable();
    table.string('refresh_lease_owner', 64).nullable();
    table.timestamp('last_refreshed_at').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now()).notNullable();
    table.timestamp('updated_at').defaultTo(knex.fn.now()).notNullable();
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('visual_preview_oauth_credentials');
}
